import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open } from '../database.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'im-security-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DB_PATH: path.join(temp, 'test.db'), APP_ORIGIN: 'http://localhost:3000',
  GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-only',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/v1/auth/calendar/callback',
  INTERNAL_SECRET: crypto.randomBytes(32).toString('hex'), TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  EMAIL_PROVIDER: 'smtp', SMTP_USER: 'test@example.invalid', SMTP_PASS: 'test-only', PUBLIC_ROSTERS: 'false',
});
const setup = await open({ filename: process.env.DB_PATH });
const schema = fs.readFileSync(new URL('../init-db.js', import.meta.url), 'utf8').match(/const schema = `([\s\S]*?)`;/)[1];
setup.exec(schema);
setup.exec(`INSERT INTO leagues VALUES(1,'League','2026-2027','1'); INSERT INTO tiers VALUES(1,'Tier',1);
  INSERT INTO teams VALUES(1,'Alpha','https://portal.recreation.ubc.ca/intramurals/index.php?team=1',1),(2,'Beta','https://portal.recreation.ubc.ca/intramurals/index.php?team=2',1);
  INSERT INTO users(id,google_id,email,name,calendar_refresh_token) VALUES(1,'legacy','legacy@example.invalid','Legacy','legacy-refresh');
  INSERT INTO sessions(user_id,token,expires_at) VALUES(1,'legacy-token','2099-01-01T00:00:00Z');
  INSERT INTO games VALUES(1,'2099-12-01T12:00:00','<a href="https://evil.invalid">Fake</a>',1,2,1);`);
setup.close();
const security = await import('../security.js');
const { OAuth2Client } = await import('google-auth-library');
const { google } = await import('googleapis');
const { SmtpEmailService } = await import('../email-service.js');
let googleSubject = 'alice';
let tokenExchangeCount = 0;
let revokeFails = false;
const messages = [];
const calendarEvents = [];
mock.method(OAuth2Client.prototype, 'verifyIdToken', async () => ({ getPayload: () => ({ sub: googleSubject, email: `${googleSubject}@example.invalid`, email_verified: true, name: 'Alice' }) }));
mock.method(google.auth.OAuth2.prototype, 'getToken', async options => {
  tokenExchangeCount++;
  assert.equal(typeof options.codeVerifier, 'string');
  return { tokens: { refresh_token: 'mock-google-refresh' } };
});
mock.method(google.auth.OAuth2.prototype, 'revokeToken', async () => { if (revokeFails) throw new Error('mock failure'); return {}; });
mock.method(google.auth.OAuth2.prototype, 'refreshAccessToken', async () => ({ credentials: { access_token: 'mock-access' } }));
mock.method(google, 'calendar', () => ({ events: {
  insert: async options => { calendarEvents.push(options.resource); return { data: { id: options.resource.id } }; },
  get: async () => ({ data: { status: 'confirmed' } }),
} }));
mock.method(SmtpEmailService.prototype, 'sendEmail', async message => { messages.push(message); return true; });
const { app, db, jobs } = await import('../app.js');
let server, base, alice, bob, aliceId;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { jobs.close(); await new Promise(resolve => server.close(resolve)); db.close(); mock.restoreAll(); fs.rmSync(temp, { recursive: true }); });
async function request(route, { method = 'GET', cookie, body, headers = {} } = {}) {
  return fetch(base + route, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-CSRF-Protection': '1', ...(cookie ? {Cookie:cookie} : {}), ...headers }, ...(body ? {body:JSON.stringify(body)} : {}) });
}
async function login(subject) {
  googleSubject = subject;
  const response = await request('/api/v1/auth/google', {method:'POST',body:{idToken:'mock-id-token'}});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.sessionToken, undefined);
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Lax/);
  return { cookie: setCookie.split(';')[0], user:body.user };
}

test('migration encrypts existing refresh tokens and invalidates legacy sessions', () => {
  assert.equal(db.get('SELECT count(*) n FROM sessions').n, 0);
  const stored = db.get('SELECT calendar_refresh_token token FROM users WHERE id=1').token;
  assert.notEqual(stored, 'legacy-refresh'); assert.equal(security.decryptToken(stored), 'legacy-refresh');
  assert.throws(() => security.decryptToken(stored.slice(0,-3)+'xyz'));
});
test('cookie login stores only a token hash; privacy and headers apply', async () => {
  const loginResult = await login('alice'); alice = loginResult.cookie; aliceId = loginResult.user.id;
  bob = (await login('bob')).cookie;
  const rawToken = alice.split('=')[1];
  assert.equal(db.get('SELECT count(*) n FROM sessions WHERE token=?',[rawToken]).n,0);
  assert.equal(db.get('SELECT count(*) n FROM sessions WHERE token=?',[security.hash(rawToken)]).n,1);
  assert.equal((await request('/api/v1/teams/1/players')).status,401);
  assert.equal((await request('/api/v1/teams/1/players',{cookie:alice})).status,200);
  const page = await request('/');
  assert.match(page.headers.get('content-security-policy'), /script-src-attr 'none'/);
  assert.equal(page.headers.get('x-frame-options'),'SAMEORIGIN');
  assert.equal((await request('/api/v1/subscriptions',{cookie:alice})).headers.get('cache-control'),'no-store');
});
test('public game creation is removed and internal endpoint requires secret', async () => {
  assert.equal((await request('/api/v1/test/add-game',{method:'POST',body:{team1_id:1,team2_id:2}})).status,404);
  assert.equal((await request('/api/internal/notify-games',{method:'POST',body:{gameIds:[1]},headers:{'x-internal-secret':'dev-secret-change-in-production'}})).status,401);
  assert.equal(db.get('SELECT count(*) n FROM games').n,1);
});
test('cookie mutations reject cross-origin and missing CSRF header', async () => {
  assert.equal((await request('/api/v1/subscribe',{method:'POST',cookie:alice,body:{teamId:1},headers:{Origin:'https://evil.invalid'}})).status,403);
  assert.equal((await request('/api/v1/subscribe',{method:'POST',cookie:alice,body:{teamId:1},headers:{'x-csrf-protection':''}})).status,403);
});
test('Calendar state is opaque, session bound, PKCE protected and consumed once', async () => {
  let response=await request('/api/v1/auth/calendar',{cookie:alice});
  const url = new URL((await response.json()).authUrl);
  const state=url.searchParams.get('state');
  assert.equal(state.length,43); assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  const pending=db.get('SELECT * FROM oauth_states WHERE state_hash=?',[security.hash(state)]);
  assert.equal(url.searchParams.get('code_challenge'),crypto.createHash('sha256').update(pending.verifier).digest('base64url'));
  response=await request(`/api/v1/auth/calendar/callback?state=${state}&code=mock`,{cookie:bob});
  assert.match(response.headers.get('location'),/invalid_state/); assert.equal(tokenExchangeCount,0);
  const forged=Buffer.from(JSON.stringify({userId:aliceId})).toString('base64');
  response=await request(`/api/v1/auth/calendar/callback?state=${encodeURIComponent(forged)}&code=mock`,{cookie:alice});
  assert.match(response.headers.get('location'),/invalid_state/); assert.equal(tokenExchangeCount,0);
  response=await request(`/api/v1/auth/calendar/callback?state=${state}&code=mock`,{cookie:alice});
  assert.match(response.headers.get('location'),/calendar_connected=true/); assert.equal(tokenExchangeCount,1);
  const stored=db.get('SELECT calendar_refresh_token t FROM users WHERE id=?',[aliceId]).t;
  assert.notEqual(stored,'mock-google-refresh'); assert.equal(security.decryptToken(stored),'mock-google-refresh');
  response=await request(`/api/v1/auth/calendar/callback?state=${state}&code=mock`,{cookie:alice});
  assert.match(response.headers.get('location'),/invalid_state/); assert.equal(tokenExchangeCount,1);
});
test('duplicate subscriptions enqueue once; ownership checks remain enforced', async () => {
  const options={method:'POST',cookie:alice,body:{teamId:1}};
  assert.equal((await request('/api/v1/subscribe',options)).status,200);
  assert.equal((await (await request('/api/v1/subscribe',options)).json()).calendarSyncQueued,false);
  const sub=db.get('SELECT id FROM subscriptions WHERE user_id=?',[aliceId]);
  assert.equal((await request(`/api/v1/subscriptions/${sub.id}`,{method:'DELETE',cookie:bob})).status,404);
  await jobs.tick();
  assert.equal(calendarEvents.length,1);
  assert.match(calendarEvents[0].id,/^[a-f0-9]{64}$/);
});
test('digest payloads are escaped and repeated notification jobs do not resend', async () => {
  messages.length=0;
  jobs.enqueue('notify',{gameIds:[1]},'test-notify-1'); await jobs.tick();
  assert.equal(messages.length,1);
  assert.match(messages[0].html,/&lt;a href=&quot;https:\/\/evil.invalid&quot;&gt;Fake&lt;\/a&gt;/);
  jobs.enqueue('notify',{gameIds:[1]},'test-notify-2'); await jobs.tick();
  assert.equal(messages.length,1);
});
test('failed revocation preserves credentials for retry; successful disconnect removes grant', async () => {
  revokeFails=true;
  assert.equal((await request('/api/v1/auth/calendar/disconnect',{method:'POST',cookie:alice})).status,502);
  assert.ok(db.get('SELECT calendar_refresh_token t FROM users WHERE id=?',[aliceId]).t);
  revokeFails=false;
  assert.equal((await request('/api/v1/auth/calendar/disconnect',{method:'POST',cookie:alice})).status,200);
  assert.equal(db.get('SELECT calendar_refresh_token t FROM users WHERE id=?',[aliceId]).t,null);
});
test('expired sessions are rejected immediately and logout revokes copied credentials', async () => {
  const expired=crypto.randomBytes(32).toString('hex');
  db.run('INSERT INTO sessions(user_id,token,expires_at) VALUES(?,?,?)',[aliceId,security.hash(expired),Date.now()-3600000]);
  assert.equal((await request('/api/v1/subscriptions',{cookie:`im_session=${expired}`})).status,401);
  assert.equal((await request('/api/v1/auth/logout',{method:'POST',cookie:alice})).status,200);
  assert.equal((await request('/api/v1/subscriptions',{cookie:alice})).status,401);
});
test('search validation rejects wildcard enumeration and oversized queries', async () => {
  assert.equal((await request('/api/v1/search/teams?q=%25%25')).status,400);
  assert.equal((await request('/api/v1/search/teams?q='+ 'a'.repeat(101))).status,400);
});
test('scrapers reject non-portal URLs without issuing a network request', async () => {
  const { fetchPortal } = await import('../scraper-http.js');
  await assert.rejects(fetchPortal('http://127.0.0.1/admin'), /outside allowed portal/);
  await assert.rejects(fetchPortal('https://portal.recreation.ubc.ca.evil.invalid/intramurals/'), /outside allowed portal/);
});
test('successful roster replacement removes old memberships, absent roster preserves them', async () => {
  const { storeTeamData } = await import('../games-scraper.js');
  await storeTeamData(db,1,1,[],['Old Player'],true);
  await storeTeamData(db,1,1,[],[],false);
  assert.ok(db.get("SELECT id FROM players WHERE name='Old Player'"));
  await storeTeamData(db,1,1,[],['New Player'],true);
  assert.equal(db.get("SELECT id FROM players WHERE name='Old Player'"),undefined);
  assert.ok(db.get("SELECT id FROM players WHERE name='New Player'"));
});

test('expired OAuth state cannot exchange a code', async () => {
  const response=await request('/api/v1/auth/calendar',{cookie:bob});
  const url=new URL((await response.json()).authUrl);
  const state=url.searchParams.get('state');
  db.run('UPDATE oauth_states SET expires_at=? WHERE state_hash=?',[Date.now()-1,security.hash(state)]);
  const previousCount=tokenExchangeCount;
  const result=await request(`/api/v1/auth/calendar/callback?state=${state}&code=mock`,{cookie:bob});
  assert.match(result.headers.get('location'),/invalid_state/); assert.equal(tokenExchangeCount,previousCount);
});
test('queue is bounded and duplicate jobs do not grow it', () => {
  jobs.enqueue('notify',{gameIds:[1]},'bounded-test');
  jobs.enqueue('notify',{gameIds:[1]},'bounded-test');
  assert.equal(db.get('SELECT count(*) n FROM background_jobs').n,1);
  for(let i=0;i<999;i++) jobs.enqueue('notify',{gameIds:[1]},`bounded-${i}`);
  assert.throws(()=>jobs.enqueue('notify',{gameIds:[1]},'over-capacity'),/Queue is full/);
  db.run('DELETE FROM background_jobs');
});
test('missing production secrets fail closed and production cookies are secure', async () => {
  const { spawnSync }=await import('node:child_process');
  const script=`import {cookieName,cookieOptions} from './security.js'; console.log(JSON.stringify({cookieName,cookieOptions}));`;
  const cwd=new URL('..',import.meta.url);
  const env={...process.env,NODE_ENV:'production',APP_ORIGIN:'https://example.invalid'};
  const ok=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd,env,encoding:'utf8'});
  assert.equal(ok.status,0);
  const config=JSON.parse(ok.stdout); assert.equal(config.cookieName,'__Host-im_session'); assert.equal(config.cookieOptions.secure,true);
  const bad=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd,env:{...env,INTERNAL_SECRET:''},encoding:'utf8'});
  assert.notEqual(bad.status,0); assert.match(bad.stderr,/Set INTERNAL_SECRET/);
});
