import 'dotenv/config';
import crypto from 'node:crypto';

export const production = process.env.NODE_ENV === 'production';
export const cookieName = production ? '__Host-im_session' : 'im_session';
export const cookieOptions = { httpOnly: true, secure: production, sameSite: 'lax', path: '/' };
export const appOrigin = new URL(process.env.APP_ORIGIN || (production ? 'invalid:' : `http://localhost:${process.env.PORT || 3000}`)).origin;
if (production && !appOrigin.startsWith('https://')) throw new Error('APP_ORIGIN must be an HTTPS origin');
export const internalSecret = process.env.INTERNAL_SECRET;
if (!internalSecret || internalSecret.length < 32 || /change|generate|your.secret|dev-secret/i.test(internalSecret)) {
  throw new Error('Set INTERNAL_SECRET to a random secret of at least 32 characters');
}
const keyText = process.env.TOKEN_ENCRYPTION_KEY || '';
const key = Buffer.from(keyText, 'base64');
if (key.length !== 32 || key.toString('base64') !== keyText) {
  throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded random 32-byte key');
}
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export function encryptToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}
export function decryptToken(value) {
  const [version, iv, tag, ciphertext] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Invalid encrypted token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
export function sessionToken(req) {
  const entry = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`));
  const token = entry?.slice(cookieName.length + 1);
  return /^[a-f0-9]{64}$/.test(token || '') ? token : null;
}
export function internalAuth(req, res, next) {
  const supplied = req.get('x-internal-secret') || '';
  if (!crypto.timingSafeEqual(Buffer.from(hash(supplied)), Buffer.from(hash(internalSecret)))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
export function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-csrf-protection') !== '1' || (req.get('origin') && req.get('origin') !== appOrigin)) {
    return res.status(403).json({ error: 'Invalid request origin' });
  }
  next();
}
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
export function validId(value) {
  return ['string', 'number'].includes(typeof value) && /^(?:[1-9][0-9]{0,14})$/.test(String(value)) && Number.isSafeInteger(Number(value));
}

export function migrateSecurity(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS security_meta (key TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS oauth_states (
      state_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_hash TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS background_jobs (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );`);
  let migrated = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.all('PRAGMA table_info(team_players)').some(column => column.name === 'last_seen_at')) {
      db.exec('ALTER TABLE team_players ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0');
      db.run('UPDATE team_players SET last_seen_at=?', [Date.now()]);
    }
    // Recheck under the write lock so overlapping restarts cannot encrypt twice.
    if (!db.get("SELECT 1 FROM security_meta WHERE key='secure_credentials_v1'")) {
      db.run('DELETE FROM sessions');
      for (const user of db.all('SELECT id, calendar_refresh_token FROM users WHERE calendar_refresh_token IS NOT NULL')) {
        db.run('UPDATE users SET calendar_refresh_token=? WHERE id=?', [encryptToken(user.calendar_refresh_token), user.id]);
      }
      db.run("INSERT INTO security_meta VALUES ('secure_credentials_v1')");
      migrated = true;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  if (migrated) db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  // Verify the configured key before serving requests, including after restarts.
  for (const user of db.all('SELECT calendar_refresh_token FROM users WHERE calendar_refresh_token IS NOT NULL')) decryptToken(user.calendar_refresh_token);
}
