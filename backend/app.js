import 'dotenv/config';
import express from 'express';
import { open } from './database.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'crypto';
import { google } from 'googleapis';
import { sendEmail, isEmailConfigured } from './email-service.js';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { production, appOrigin, cookieName, cookieOptions, sessionToken, hash, encryptToken, decryptToken, internalAuth, csrfProtection, escapeHtml, validId, migrateSecurity } from './security.js';
import { createJobQueue } from './jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Use /data volume in production (Railway), local file in development
const DB_PATH = process.env.DB_PATH || (process.env.NODE_ENV === 'production'
  ? '/data/intramurals.db'
  : './intramurals.db');

// Google OAuth configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/v1/auth/calendar/callback';
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) throw new Error('Google OAuth configuration is required');
if (new URL(GOOGLE_REDIRECT_URI).origin !== appOrigin) throw new Error('GOOGLE_REDIRECT_URI must match APP_ORIGIN');
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
googleClient.transporter.defaults = { ...googleClient.transporter.defaults, timeout: 15000, retry: false };

// Create OAuth2 client for Calendar API
function getCalendarOAuth2Client() {
  const client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
  client.transporter.defaults = { ...client.transporter.defaults, timeout: 15000, retry: false };
  return client;
}

// Get game duration in minutes based on league/sport type
function getGameDurationMinutes(leagueName) {
  const name = (leagueName || '').toLowerCase();
  if (name.includes('badminton') || name.includes('dodgeball') || name.includes('pickleball')) {
    return 30;
  }
  if (name.includes('volleyball') || name.includes('roundnet')) {
    return 45;
  }
  return 60; // Default: 1 hour for basketball, soccer, hockey, football, ultimate, futsal
}

// Send digest email with multiple games
async function sendDigestEmail(user, gamesWithTeams) {
  if (!isEmailConfigured()) {
    console.log('Email not configured, skipping digest email');
    return false;
  }

  const firstName = user.name ? user.name.split(' ')[0] : 'there';
  const gameCount = gamesWithTeams.length;

  // Sort games by date
  gamesWithTeams.sort((a, b) => new Date(a.game.datetime) - new Date(b.game.datetime));

  // Build game cards HTML
  const gameCardsHtml = gamesWithTeams.map(({ game, team }) => {
    const gameDate = new Date(game.datetime);
    const dateStr = gameDate.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    const timeStr = gameDate.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });

    return `
      <div style="background: white; border-radius: 8px; padding: 15px; margin: 10px 0; border-left: 4px solid #002145;">
        <p style="margin: 0 0 4px 0; color: #002145; font-weight: bold;">
          ${escapeHtml(game.league_name)} Intramurals -- ${escapeHtml(game.tier_name)}
        </p>
        <p style="margin: 0 0 8px 0; color: #374151;">
          ${escapeHtml(game.team1_name)} vs ${escapeHtml(game.team2_name)}
        </p>
        <p style="margin: 0; color: #6b7280; font-size: 14px;">
          📅 ${dateStr} at ${timeStr} · 📍 ${escapeHtml(game.location)}
        </p>
      </div>
    `;
  }).join('');

  // Get unique team names for subject/footer
  const teamNames = [...new Set(gamesWithTeams.map(g => g.team.name))];
  const teamsStr = teamNames.length > 2
    ? `${teamNames.slice(0, 2).join(', ')} +${teamNames.length - 2} more`
    : teamNames.join(' & ');

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #002145; color: white; padding: 20px; text-align: center;">
        <h1 style="margin: 0; font-size: 24px;">UBC IM Notify</h1>
      </div>
      <div style="padding: 30px; background: #f9fafb;">
        <h2 style="color: #002145; margin-top: 0;">Hey ${escapeHtml(firstName)}!</h2>
        <p style="color: #374151; line-height: 1.6;">
          ${gameCount > 1
            ? `<strong>${gameCount} new games</strong> have been scheduled for your teams!`
            : `A new game has been scheduled for your team!`}
        </p>
        ${gameCardsHtml}
        <p style="color: #374151; line-height: 1.6; margin-top: 20px;">
          Good luck and have fun!
        </p>
        <p style="color: #6b7280; font-size: 14px; margin-top: 30px;">
          Go Thunderbirds! 🏆
        </p>
      </div>
      <div style="padding: 15px; background: #e5e7eb; text-align: center;">
        <p style="margin: 0; color: #6b7280; font-size: 12px;">
          You're receiving this because you subscribed to ${escapeHtml(teamsStr)} on <a href="${escapeHtml(appOrigin)}" style="color: #002145;">UBC IM Notify</a>.
        </p>
      </div>
    </div>
  `;

  const success = await sendEmail({
    to: user.email,
    subject: `🏆 ${gameCount} New Game${gameCount > 1 ? 's' : ''} Scheduled`,
    html: htmlContent,
  });

  return success;
}

// Create a calendar event for a game
async function createCalendarEvent(user, game, team) {
  if (!user.calendar_refresh_token) {
    console.log('Operation completed');
    return null;
  }

  const oauth2Client = getCalendarOAuth2Client();
  oauth2Client.setCredentials({
    refresh_token: decryptToken(user.calendar_refresh_token)
  });

  // Refresh access token before making API calls
  try {
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);
  } catch (refreshError) {
    console.error('Operation failed');
    return null;
  }

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const durationMinutes = getGameDurationMinutes(game.league_name);

  // game.datetime is stored as Pacific time without timezone (e.g., "2025-09-21T21:30:00")
  // Calculate end time by adding duration while keeping in Pacific time
  // Parse the datetime components manually to avoid timezone conversion
  const match = game.datetime.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):?(\d{2})?/);
  if (!match) {
    console.error(`Invalid datetime format: ${game.datetime}`);
    return null;
  }
  const [, year, month, day, hour, minute] = match;
  const startDateTime = `${year}-${month}-${day}T${hour}:${minute}:00`;

  const startMinutes = parseInt(hour) * 60 + parseInt(minute);
  const endTotalMinutes = startMinutes + durationMinutes;
  const endHour = Math.floor(endTotalMinutes / 60) % 24;
  const endMinute = endTotalMinutes % 60;
  // Note: This doesn't handle games crossing midnight, but intramural games don't run that late
  const endDateTime = `${year}-${month}-${day}T${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}:00`;

  console.log('Creating calendar event:', { startDateTime, endDateTime, league: game.league_name, tier: game.tier_name });

  const appUrl = appOrigin;
  const eventId = hash(`calendar:${user.id}:${game.id}:${user.calendar_refresh_token}`);
  const event = {
    id: eventId,
    summary: `${game.league_name} Intramurals -- ${game.tier_name}`,
    description: `${escapeHtml(game.team1_name)} vs ${escapeHtml(game.team2_name)}\n\nEvent created: ${new Date().toLocaleString('en-US', { timeZone: 'America/Vancouver', dateStyle: 'medium', timeStyle: 'short' })}\nCreated by <a href="${appUrl}">UBC IM Notify</a>`,
    location: game.location,
    start: {
      dateTime: startDateTime,
      timeZone: 'America/Vancouver',
    },
    end: {
      dateTime: endDateTime,
      timeZone: 'America/Vancouver',
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 },
        { method: 'popup', minutes: 1440 }, // 24 hours
      ],
    },
  };

  try {
    const result = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
    });

    console.log('Operation completed');
    return result.data.id;
  } catch (error) {
    if (error.code === 409) return eventId;
    console.error('Calendar event creation failed');

    // Handle token expiration/revocation
    if (error.code === 401) {
      console.log('Operation completed');
      await db.run(
        'UPDATE users SET calendar_refresh_token = NULL WHERE id = ? AND calendar_refresh_token = ?',
        [user.id, user.calendar_refresh_token]
      );
    }

    return null;
  }
}

// Check if a calendar event still exists in Google Calendar
async function calendarEventExists(user, calendarEventId) {
  if (!user.calendar_refresh_token || !calendarEventId) {
    return false;
  }

  const oauth2Client = getCalendarOAuth2Client();
  oauth2Client.setCredentials({
    refresh_token: decryptToken(user.calendar_refresh_token)
  });

  try {
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);
  } catch (refreshError) {
    console.error('Operation failed');
    return false;
  }

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  try {
    const response = await calendar.events.get({
      calendarId: 'primary',
      eventId: calendarEventId
    });
    // Check if event is cancelled (deleted but not purged)
    return response.data.status !== 'cancelled';
  } catch (error) {
    if (error.code === 404 || error.code === 410) {
      return false;
    }
    // For other errors, assume it exists to avoid re-creating
    console.error('Operation failed');
    return true;
  }
}

// Add all existing games for a team to user's calendar
async function addTeamGamesToCalendar(userId, teamId) {
  const user = await db.get(
    'SELECT id, email, calendar_refresh_token FROM users WHERE id = ?',
    [userId]
  );

  const pref = await db.get("SELECT enabled FROM notification_preferences WHERE user_id=? AND channel='calendar'", [userId]);
  if (!user?.calendar_refresh_token || pref?.enabled !== 1) {
    return { added: 0, skipped: 0 };
  }

  const team = await db.get('SELECT id, name FROM teams WHERE id = ?', [teamId]);
  if (!team) return { added: 0, skipped: 0 };

  // Get all upcoming games for this team
  const games = await db.all(`
    SELECT g.id, g.datetime, g.location,
           t1.name as team1_name, t2.name as team2_name,
           ti.name as tier_name, l.name as league_name
    FROM games g
    JOIN teams t1 ON g.team1_id = t1.id
    JOIN teams t2 ON g.team2_id = t2.id
    JOIN tiers ti ON g.tier_id = ti.id
    JOIN leagues l ON ti.league_id = l.id
    WHERE (g.team1_id = ? OR g.team2_id = ?)
      AND g.datetime > datetime('now')
    ORDER BY g.datetime LIMIT 100
  `, [teamId, teamId]);

  let added = 0, skipped = 0;

  for (const game of games) {
    if (!(await db.get('SELECT 1 FROM subscriptions WHERE user_id=? AND team_id=?', [userId, teamId]))) break;
    // Check if we have a record of this event
    const existing = await db.get(
      'SELECT id, calendar_event_id FROM calendar_events WHERE user_id = ? AND game_id = ?',
      [userId, game.id]
    );

    if (existing) {
      // Verify the event still exists in Google Calendar
      const stillExists = await calendarEventExists(user, existing.calendar_event_id);
      if (stillExists) {
        skipped++;
        continue;
      }
      // Event was deleted from calendar, remove stale record
      await db.run('DELETE FROM calendar_events WHERE id = ?', [existing.id]);
    }

    const eventId = await createCalendarEvent(user, game, team);

    if (eventId) {
      await db.run(
        'INSERT OR IGNORE INTO calendar_events (user_id, game_id, calendar_event_id) VALUES (?, ?, ?)',
        [userId, game.id, eventId]
      );
      added++;
    } else {
      console.error(`Failed to create calendar event for game ${game.id}`);
    }
  }

  return { added, skipped };
}

// Send welcome email to new users
async function sendWelcomeEmail(email, name) {
  if (!isEmailConfigured()) {
    console.log('Email not configured, skipping welcome email');
    return;
  }

  const firstName = name ? name.split(' ')[0] : 'there';

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #002145; color: white; padding: 20px; text-align: center;">
        <h1 style="margin: 0; font-size: 24px;">UBC IM Notify</h1>
      </div>
      <div style="padding: 30px; background: #f9fafb;">
        <h2 style="color: #002145; margin-top: 0;">Hey ${escapeHtml(firstName)}!</h2>
        <p style="color: #374151; line-height: 1.6;">
          Welcome to UBC IM Notify! You're all set to receive notifications for your intramural games.
        </p>
        <p style="color: #374151; line-height: 1.6;">
          <strong>Here's what you can do:</strong>
        </p>
        <ul style="color: #374151; line-height: 1.8;">
          <li>Search for your name to find your teams</li>
          <li>Subscribe to teams to get game reminders</li>
          <li>Enable Google Calendar integration in Settings</li>
        </ul>
        <p style="color: #374151; line-height: 1.6;">
          You can manage your notification preferences anytime in the Settings menu.
        </p>
        <p style="color: #6b7280; font-size: 14px; margin-top: 30px;">
          Go Thunderbirds! 🏆
        </p>
      </div>
      <div style="padding: 15px; background: #e5e7eb; text-align: center;">
        <p style="margin: 0; color: #6b7280; font-size: 12px;">
          Sent from <a href="${escapeHtml(appOrigin)}" style="color: #002145;">UBC IM Notify</a>
        </p>
      </div>
    </div>
  `;

  const success = await sendEmail({
    to: email,
    subject: 'Welcome to UBC IM Notify!',
    html: htmlContent,
  });

  if (success) {
    console.log('Operation completed');
  }
}

const app = express();
const port = process.env.PORT || 3000;

// Security headers precede static files, including a CSP without inline scripts.
app.disable('x-powered-by');
if (process.env.TRUST_PROXY_HOPS) {
  const hops = Number(process.env.TRUST_PROXY_HOPS);
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) throw new Error('Invalid TRUST_PROXY_HOPS');
  app.set('trust proxy', hops);
}
app.use(helmet({
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'", 'https://accounts.google.com/gsi/client'],
    scriptSrcAttr: ["'none'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com/gsi/style'],
    imgSrc: ["'self'", 'data:', 'https://*.googleusercontent.com'],
    connectSrc: ["'self'", 'https://accounts.google.com/gsi/'],
    frameSrc: ['https://accounts.google.com/gsi/'], frameAncestors: ["'none'"],
    objectSrc: ["'none'"], baseUri: ["'none'"], formAction: ["'self'"],
    upgradeInsecureRequests: production ? [] : null,
  } },
  strictTransportSecurity: production ? { maxAge: 31536000 } : false,
  referrerPolicy: { policy: 'no-referrer' },
}));
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api', rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use('/api/internal', internalAuth, rateLimit({ windowMs: 60000, limit: 5 }));
app.use('/api/v1', csrfProtection);
app.use(express.json({ limit: '16kb', strict: true }));
app.use('/api/v1/auth/google', rateLimit({ windowMs: 15 * 60000, limit: 20 }));
app.use(express.static(path.join(__dirname, '../frontend')));

// Database connection
let db;

async function initDb() {
  db = await open({
    filename: DB_PATH
  });
  migrateSecurity(db);
  console.log('✓ Connected to database');
}

// Initialize DB before starting server
await initDb();

// ============ SESSION AUTH ============

const SESSION_DURATION_DAYS = 30;

// Generate secure session token
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Create session for user (30-day expiration)
async function createSession(userId) {
  const token = generateSessionToken();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_DURATION_DAYS);

  await db.run(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)',
    [userId, hash(token), expiresAt.getTime()]
  );

  return { token, expiresAt: expiresAt.toISOString() };
}

// Verify the HttpOnly cookie against a stored hash and numeric expiry.
async function authenticateSession(req, res, next) {
  const token = sessionToken(req);
  if (!token) return res.status(401).json({ error: 'Sign in required' });
  try {
    // Find valid session
    const session = await db.get(
      `SELECT s.*, u.id as user_id, u.google_id, u.email, u.name, u.picture
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token = ? AND CAST(s.expires_at AS INTEGER) > ?`,
      [hash(token), Date.now()]
    );

    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    req.sessionHash = hash(token);
    req.user = {
      id: session.user_id,
      googleId: session.google_id,
      email: session.email,
      name: session.name,
      picture: session.picture,
    };
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

// Helper: find or create user by Google ID
async function findOrCreateUserByGoogle(googleUser) {
  const { googleId, email, name, picture } = googleUser;

  // Try to find existing user
  let user = await db.get('SELECT * FROM users WHERE google_id = ?', [googleId]);

  if (!user) {
    // Create new user
    const result = await db.run(
      'INSERT INTO users (google_id, email, name, picture) VALUES (?, ?, ?, ?)',
      [googleId, email, name, picture]
    );
    user = { id: result.lastID, google_id: googleId, email, name, picture };
    console.log('Operation completed');

    // Set default notification preferences (email enabled, calendar disabled)
    await db.run(
      'INSERT INTO notification_preferences (user_id, channel, enabled) VALUES (?, ?, 1)',
      [user.id, 'email']
    );
    await db.run(
      'INSERT INTO notification_preferences (user_id, channel, enabled) VALUES (?, ?, 0)',
      [user.id, 'calendar']
    );

    // Send welcome email (async, don't wait)
    console.log('Operation completed');
    sendWelcomeEmail(email, name);
  } else {
    // Update email/name/picture if changed
    await db.run(
      'UPDATE users SET email = ?, name = ?, picture = ? WHERE google_id = ?',
      [email, name, picture, googleId]
    );
  }

  return user;
}

const publicRosters = process.env.PUBLIC_ROSTERS === 'true';
app.get('/api/v1/config', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID, publicRosters }));
const rosterAccess = (req, res, next) => publicRosters ? next() : authenticateSession(req, res, next);
const userWorkLimit = rateLimit({ windowMs: 60000, limit: 15, keyGenerator: req => String(req.user.id) });
app.param('id', (req, res, next, id) => validId(id) ? next() : res.status(400).json({ error: 'Invalid ID' }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'UBC Intramurals API' });
});

// GET /api/v1/leagues - List all leagues
app.get('/api/v1/leagues', async (req, res) => {
  try {
    const leagues = await db.all(`
      SELECT id, name, year, term
      FROM leagues
      ORDER BY year DESC, term DESC, name
    `);
    res.json(leagues);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status === 502 ? 'Unable to revoke Calendar access. Please retry.' : 'Request failed' });
  }
});

// GET /api/v1/leagues/:id/teams - Teams in a league grouped by tier
app.get('/api/v1/leagues/:id/teams', async (req, res) => {
  try {
    const { id } = req.params;

    // Get league info
    const league = await db.get('SELECT * FROM leagues WHERE id = ?', [id]);
    if (!league) {
      return res.status(404).json({ error: 'League not found' });
    }

    // Get tiers with their teams
    const tiers = await db.all(`
      SELECT t.id, t.name
      FROM tiers t
      WHERE t.league_id = ?
      ORDER BY t.name
    `, [id]);

    // Get teams for each tier
    for (const tier of tiers) {
      tier.teams = await db.all(`
        SELECT id, name
        FROM teams
        WHERE tier_id = ?
        ORDER BY name
      `, [tier.id]);
    }

    res.json({
      league,
      tiers
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status === 502 ? 'Unable to revoke Calendar access. Please retry.' : 'Request failed' });
  }
});

// GET /api/v1/teams/:id/games - Games for a team
app.get('/api/v1/teams/:id/games', async (req, res) => {
  try {
    const { id } = req.params;
    const { upcoming } = req.query; // ?upcoming=true for only future games

    // Get team info
    const team = await db.get(`
      SELECT t.id, t.name, t.tier_id, ti.name as tier_name, l.name as league_name
      FROM teams t
      JOIN tiers ti ON t.tier_id = ti.id
      JOIN leagues l ON ti.league_id = l.id
      WHERE t.id = ?
    `, [id]);

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    // Build query for games
    let query = `
      SELECT g.id, g.datetime, g.location,
             t1.id as team1_id, t1.name as team1_name,
             t2.id as team2_id, t2.name as team2_name
      FROM games g
      JOIN teams t1 ON g.team1_id = t1.id
      JOIN teams t2 ON g.team2_id = t2.id
      WHERE (g.team1_id = ? OR g.team2_id = ?)
    `;
    const params = [id, id];

    if (upcoming === 'true') {
      query += ` AND g.datetime > datetime('now')`;
    }

    query += ` ORDER BY g.datetime`;

    const games = await db.all(query, params);

    res.json({
      team,
      games
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status === 502 ? 'Unable to revoke Calendar access. Please retry.' : 'Request failed' });
  }
});

// GET /api/v1/teams/:id/players - Get team roster
app.get('/api/v1/teams/:id/players', rosterAccess, async (req, res) => {
  try {
    const { id } = req.params;

    // Get team info
    const team = await db.get('SELECT id, name FROM teams WHERE id = ?', [id]);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    // Get players
    const players = await db.all(`
      SELECT p.id, p.name
      FROM players p
      JOIN team_players tp ON p.id = tp.player_id
      WHERE tp.team_id = ?
      ORDER BY p.name
    `, [id]);

    res.json({ team, players });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status === 502 ? 'Unable to revoke Calendar access. Please retry.' : 'Request failed' });
  }
});

// GET /api/v1/search/teams?q= - Search teams by name
app.get('/api/v1/search/teams', async (req, res) => {
  try {
    const { q } = req.query;

    if (typeof q !== 'string' || q.trim().length < 2 || q.length > 100 || /[%_]/.test(q)) {
      return res.status(400).json({ error: 'Query must be 2–100 characters without wildcard characters' });
    }

    const teams = await db.all(`
      SELECT t.id, t.name, ti.name as tier_name, l.name as league_name
      FROM teams t
      JOIN tiers ti ON t.tier_id = ti.id
      JOIN leagues l ON ti.league_id = l.id
      WHERE t.name LIKE ?
      ORDER BY t.name
      LIMIT 50
    `, [`%${q}%`]);

    res.json(teams);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status === 502 ? 'Unable to revoke Calendar access. Please retry.' : 'Request failed' });
  }
});

// GET /api/v1/search/players?q= - Search players, returns their teams
app.get('/api/v1/search/players', rosterAccess, async (req, res) => {
  try {
    const { q } = req.query;

    if (typeof q !== 'string' || q.trim().length < 2 || q.length > 100 || /[%_]/.test(q)) {
      return res.status(400).json({ error: 'Query must be 2–100 characters without wildcard characters' });
    }

    // Find players matching query
    const players = await db.all(`
      SELECT DISTINCT p.id, p.name
      FROM players p
      WHERE p.name LIKE ?
      ORDER BY p.name
      LIMIT 20
    `, [`%${q}%`]);

    // Get teams for each player
    for (const player of players) {
      player.teams = await db.all(`
        SELECT t.id, t.name, ti.name as tier_name, l.name as league_name
        FROM teams t
        JOIN team_players tp ON t.id = tp.team_id
        JOIN tiers ti ON t.tier_id = ti.id
        JOIN leagues l ON ti.league_id = l.id
        WHERE tp.player_id = ?
        ORDER BY l.name, t.name
      `, [player.id]);
    }

    res.json(players);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status === 502 ? 'Unable to revoke Calendar access. Please retry.' : 'Request failed' });
  }
});

// ============ AUTH ENDPOINT ============

// POST /api/v1/auth/google - Authenticate with Google ID token
app.post('/api/v1/auth/google', async (req, res) => {
  const { idToken } = req.body || {};
  if (typeof idToken !== 'string' || idToken.length > 10000) {
    return res.status(400).json({ error: 'idToken required' });
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || payload.email_verified !== true) throw new Error('Verified Google email required');
    const googleUser = {
      googleId: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
    };

    const user = await findOrCreateUserByGoogle(googleUser);

    // Replace this browser's previous session; discard expired rows.
    const oldToken = sessionToken(req);
    if (oldToken) await db.run('DELETE FROM sessions WHERE token=?', [hash(oldToken)]);
    await db.run('DELETE FROM sessions WHERE CAST(expires_at AS INTEGER) <= ?', [Date.now()]);
    const session = await createSession(user.id);

    // Get user preferences
    const preferences = await db.all(
      'SELECT channel, enabled FROM notification_preferences WHERE user_id = ?',
      [user.id]
    );

    res.cookie(cookieName, session.token, { ...cookieOptions, maxAge: SESSION_DURATION_DAYS * 86400000 });
    res.json({
      success: true,
      user: {
        id: user.id,
        googleId: user.google_id,
        email: user.email,
        name: user.name,
        picture: user.picture,
      },
      expiresAt: session.expiresAt,
      preferences,
    });
  } catch (error) {
    console.error('Operation failed');
    res.status(401).json({ error: 'Invalid Google token' });
  }
});

// POST /api/v1/auth/logout - Invalidate session
app.post('/api/v1/auth/logout', async (req, res) => {
  const token = sessionToken(req);
  if (token) {
    await db.run('DELETE FROM sessions WHERE token=?', [hash(token)]);
    await db.run('DELETE FROM oauth_states WHERE session_hash=?', [hash(token)]);
  }
  res.clearCookie(cookieName, cookieOptions);
  res.json({ success: true });
});

async function revokeCalendar(userId) {
  const user = await db.get('SELECT calendar_refresh_token FROM users WHERE id=?', [userId]);
  if (user?.calendar_refresh_token) {
    try { await getCalendarOAuth2Client().revokeToken(decryptToken(user.calendar_refresh_token)); }
    catch (error) {
      // Google returns invalid_token when a grant has already been revoked.
      if (!(error.response?.status === 400 && error.response?.data?.error === 'invalid_token')) {
        const failure = new Error('Unable to revoke Calendar access. Please retry.'); failure.status = 502; throw failure;
      }
    }
  }
}

// DELETE /api/v1/account - Delete user account and all related data
app.delete('/api/v1/account', authenticateSession, async (req, res) => {
  const userId = req.user.id;

  try {
    await revokeCalendar(userId);
    // Foreign keys with ON DELETE CASCADE will handle related tables
    const result = await db.run('DELETE FROM users WHERE id = ?', [userId]);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.clearCookie(cookieName, cookieOptions);
    console.log('Account deleted');
    res.json({ success: true, message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Account deletion failed');
    res.status(error.status || 500).json({ error: error.status === 502 ? 'Unable to revoke Calendar access. Please retry.' : 'Request failed' });
  }
});

// ============ CALENDAR OAUTH ENDPOINTS ============

// GET /api/v1/auth/calendar - Generate OAuth URL for calendar consent
app.get('/api/v1/auth/calendar', authenticateSession, userWorkLimit, async (req, res) => {
  if (req.get('x-csrf-protection') !== '1') return res.status(403).json({ error: 'Invalid request' });
  if ((await db.get('SELECT calendar_refresh_token FROM users WHERE id=?', [req.user.id]))?.calendar_refresh_token) {
    return res.status(409).json({ error: 'Disconnect the current Calendar before connecting another' });
  }
  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  await db.run('DELETE FROM oauth_states WHERE expires_at <= ? OR session_hash=?', [Date.now(), req.sessionHash]);
  await db.run('INSERT INTO oauth_states VALUES(?,?,?,?,?)', [hash(state), req.user.id, req.sessionHash, verifier, Date.now()+300000]);
  const authUrl = getCalendarOAuth2Client().generateAuthUrl({
    access_type: 'offline', scope: ['https://www.googleapis.com/auth/calendar.events'],
    state, prompt: 'consent',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  });
  res.json({ authUrl });
});

app.get('/api/v1/auth/calendar/callback', authenticateSession, async (req, res) => {
  const { code, state, error } = req.query;
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) return res.redirect('/?calendar_error=invalid_state');
  // Atomic consumption, bound to the authenticated browser session and user.
  const pending = await db.get(`DELETE FROM oauth_states WHERE state_hash=? AND session_hash=? AND user_id=? AND expires_at>? RETURNING *`,
    [hash(state), req.sessionHash, req.user.id, Date.now()]);
  if (!pending) return res.redirect('/?calendar_error=invalid_state');
  if (error || typeof code !== 'string' || code.length > 4096) return res.redirect('/?calendar_error=consent_failed');
  try {
    const client = getCalendarOAuth2Client();
    const { tokens } = await client.getToken({ code, codeVerifier: pending.verifier });
    if (!tokens.refresh_token) throw new Error('Missing offline grant');
    const result = await db.run('UPDATE users SET calendar_refresh_token=? WHERE id=? AND calendar_refresh_token IS NULL', [encryptToken(tokens.refresh_token), req.user.id]);
    if (!result.changes) return res.redirect('/?calendar_error=already_connected');
    await db.run(`INSERT INTO notification_preferences(user_id,channel,enabled) VALUES(?,'calendar',1)
      ON CONFLICT(user_id,channel) DO UPDATE SET enabled=1`, [req.user.id]);
    await db.run('DELETE FROM calendar_events WHERE user_id=?', [req.user.id]);
    for (const sub of await db.all('SELECT team_id FROM subscriptions WHERE user_id=?', [req.user.id])) {
      jobs.enqueue('calendar', { userId: req.user.id, teamId: sub.team_id }, `calendar:${req.user.id}:${sub.team_id}`);
    }
    res.redirect('/?calendar_connected=true');
  } catch {
    console.error('Calendar connection failed');
    res.redirect('/?calendar_error=connection_failed');
  }
});

// POST /api/v1/auth/calendar/disconnect - Revoke calendar access
app.post('/api/v1/auth/calendar/disconnect', authenticateSession, userWorkLimit, async (req, res) => {
  try {
    await revokeCalendar(req.user.id);
    // Clear refresh token
    await db.run(
      'UPDATE users SET calendar_refresh_token = NULL WHERE id = ?',
      [req.user.id]
    );

    // Disable calendar preference
    await db.run(
      `UPDATE notification_preferences SET enabled = 0
       WHERE user_id = ? AND channel = 'calendar'`,
      [req.user.id]
    );

    // Delete all calendar event records (events remain in user's calendar)
    await db.run(
      'DELETE FROM calendar_events WHERE user_id = ?',
      [req.user.id]
    );

    console.log(`Calendar disconnected for user ${req.user.id}`);
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status === 502 ? 'Unable to revoke Calendar access. Please retry.' : 'Request failed' });
  }
});

// ============ SUBSCRIPTION ENDPOINTS (requires session auth) ============

// POST /api/v1/subscribe - Subscribe to a team
app.post('/api/v1/subscribe', authenticateSession, userWorkLimit, async (req, res) => {
  try {
    const { teamId } = req.body || {};

    if (!validId(teamId)) {
      return res.status(400).json({ error: 'teamId required' });
    }

    // Verify team exists
    const team = await db.get('SELECT id, name FROM teams WHERE id = ?', [teamId]);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const existingSubscription = db.get('SELECT id FROM subscriptions WHERE user_id=? AND team_id=?', [req.user.id, teamId]);
    if (!existingSubscription && db.get('SELECT count(*) n FROM subscriptions WHERE user_id=?', [req.user.id]).n >= 100) {
      return res.status(400).json({ error: 'Subscription limit reached' });
    }
    // Avoid redoing external work for an existing subscription.
    const inserted = await db.run(
      'INSERT OR IGNORE INTO subscriptions (user_id, team_id) VALUES (?, ?)',
      [req.user.id, teamId]
    );

    if (inserted.changes) {
      try { jobs.enqueue('calendar', { userId: req.user.id, teamId: Number(teamId) }, `calendar:${req.user.id}:${teamId}`); }
      catch (error) { db.run('DELETE FROM subscriptions WHERE id=?', [inserted.lastID]); throw error; }
    }

    res.json({
      success: true,
      message: `Subscribed to ${team.name}`,
      userId: req.user.id,
      teamId: team.id,
      calendarSyncQueued: !!inserted.changes
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status === 502 ? 'Unable to revoke Calendar access. Please retry.' : 'Request failed' });
  }
});

// GET /api/v1/subscriptions - List user's subscriptions (auth required)
app.get('/api/v1/subscriptions', authenticateSession, async (req, res) => {
  try {
    // Get subscriptions with team details
    const subscriptions = await db.all(`
      SELECT s.id, s.created_at,
             t.id as team_id, t.name as team_name,
             ti.name as tier_name, l.name as league_name
      FROM subscriptions s
      JOIN teams t ON s.team_id = t.id
      JOIN tiers ti ON t.tier_id = ti.id
      JOIN leagues l ON ti.league_id = l.id
      WHERE s.user_id = ?
      ORDER BY l.name, t.name
    `, [req.user.id]);

    // Get notification preferences
    const preferences = await db.all(
      'SELECT channel, enabled FROM notification_preferences WHERE user_id = ?',
      [req.user.id]
    );

    // Check if calendar is connected (has refresh token)
    const user = await db.get(
      'SELECT calendar_refresh_token FROM users WHERE id = ?',
      [req.user.id]
    );

    res.json({
      user: { id: req.user.id, email: req.user.email, name: req.user.name, picture: req.user.picture },
      subscriptions,
      preferences,
      calendarConnected: !!user?.calendar_refresh_token
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status === 502 ? 'Unable to revoke Calendar access. Please retry.' : 'Request failed' });
  }
});

// DELETE /api/v1/subscriptions/:id - Unsubscribe (auth required)
app.delete('/api/v1/subscriptions/:id', authenticateSession, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify subscription belongs to user and delete
    const result = await db.run(
      'DELETE FROM subscriptions WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    res.json({ success: true, message: 'Unsubscribed' });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status === 502 ? 'Unable to revoke Calendar access. Please retry.' : 'Request failed' });
  }
});

// PUT /api/v1/notifications/preferences - Update notification settings (auth required)
app.put('/api/v1/notifications/preferences', authenticateSession, async (req, res) => {
  try {
    const { channel, enabled } = req.body || {};

    if (!channel || !['email', 'calendar'].includes(channel)) {
      return res.status(400).json({ error: 'channel must be email or calendar' });
    }
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be boolean' });
    }

    // Upsert preference
    await db.run(`
      INSERT INTO notification_preferences (user_id, channel, enabled)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, channel) DO UPDATE SET enabled = ?
    `, [req.user.id, channel, enabled ? 1 : 0, enabled ? 1 : 0]);

    res.json({ success: true, channel, enabled });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status === 502 ? 'Unable to revoke Calendar access. Please retry.' : 'Request failed' });
  }
});

// ==================== INTERNAL ENDPOINTS ====================

// Internal endpoint to trigger notifications for new games (called by scheduler)
app.post('/api/internal/notify-games', (req, res) => {
  const gameIds = req.body?.gameIds;
  if (!Array.isArray(gameIds) || gameIds.length < 1 || gameIds.length > 100 || !gameIds.every(validId)) {
    return res.status(400).json({ error: 'Provide 1–100 valid game IDs' });
  }
  const ids = [...new Set(gameIds.map(Number))].sort((a,b) => a-b);
  jobs.enqueue('notify', { gameIds: ids }, `notify:${hash(JSON.stringify(ids))}`);
  res.status(202).json({ success: true, queued: ids.length });
});

async function notifyGames(gameIds) {
  console.log(`[Internal] Processing notifications for ${gameIds.length} new games`);

  // Load all games with team info
  const games = [];
  for (const gameId of gameIds) {
    const game = await db.get(`
      SELECT g.*, t1.name as team1_name, t2.name as team2_name,
             ti.name as tier_name, l.name as league_name
      FROM games g
      JOIN teams t1 ON g.team1_id = t1.id
      JOIN teams t2 ON g.team2_id = t2.id
      JOIN tiers ti ON g.tier_id = ti.id
      JOIN leagues l ON ti.league_id = l.id
      WHERE g.id = ?
    `, gameId);
    if (game) games.push(game);
  }

  if (!games.length) return;
  // Collect all team IDs involved
  const teamIds = [...new Set(games.flatMap(g => [g.team1_id, g.team2_id]))];

  // Find all subscribers to any of these teams with notifications enabled
  const placeholders = teamIds.map(() => '?').join(',');
  const subscribers = await db.all(`
    SELECT DISTINCT u.id, u.email, u.name, u.calendar_refresh_token, s.team_id, np.channel, np.enabled
    FROM users u
    JOIN subscriptions s ON u.id = s.user_id
    JOIN notification_preferences np ON u.id = np.user_id
    WHERE s.team_id IN (${placeholders})
      AND np.enabled = 1
  `, teamIds);

  // Group subscribers by user
  const userMap = new Map();
  for (const sub of subscribers) {
    if (!userMap.has(sub.id)) {
      userMap.set(sub.id, {
        user: { id: sub.id, email: sub.email, name: sub.name, calendar_refresh_token: sub.calendar_refresh_token },
        subscribedTeamIds: new Set(),
        channels: new Set()
      });
    }
    userMap.get(sub.id).subscribedTeamIds.add(sub.team_id);
    userMap.get(sub.id).channels.add(sub.channel);
  }

  // For each user, find their relevant games and send notifications
  let emailsSent = 0;
  let calendarEventsCreated = 0;

  for (const [userId, data] of userMap) {
    // Find games where user is subscribed to team1 or team2
    const userGames = games.filter(g =>
      data.subscribedTeamIds.has(g.team1_id) || data.subscribedTeamIds.has(g.team2_id)
    );

    if (userGames.length === 0) continue;

    // Build games with team info for this user
    const gamesWithTeams = userGames.map(game => {
      // Determine which team the user is subscribed to
      const teamId = data.subscribedTeamIds.has(game.team1_id) ? game.team1_id : game.team2_id;
      const teamName = teamId === game.team1_id ? game.team1_name : game.team2_name;
      return { game, team: { id: teamId, name: teamName } };
    });

    // Send digest email
    if (data.channels.has('email') && isEmailConfigured()) {
      const unsent = gamesWithTeams.filter(({game}) => db.run(
        "INSERT OR IGNORE INTO game_notifications(user_id,game_id,channel) VALUES(?,?,'email')", [userId,game.id]).changes);
      // Claim before sending: retries/crashes cannot duplicate a delivered digest.
      if (unsent.length) {
        if (await sendDigestEmail(data.user, unsent)) emailsSent++;
        else console.error('Digest delivery failed; claim retained to prevent duplicate sends');
      }
    }

    // Create calendar events (still individual)
    if (data.channels.has('calendar') && data.user.calendar_refresh_token) {
      for (const { game, team } of gamesWithTeams) {
        const existing = await db.get(
          'SELECT id FROM calendar_events WHERE user_id = ? AND game_id = ?',
          [userId, game.id]
        );

        if (!existing) {
          const eventId = await createCalendarEvent(data.user, game, team);
          if (eventId) {
            await db.run(
              'INSERT OR IGNORE INTO calendar_events (user_id, game_id, calendar_event_id) VALUES (?, ?, ?)',
              [userId, game.id, eventId]
            );
            calendarEventsCreated++;
          }
        }
      }
    }
  }

  console.log(`[Internal] Sent ${emailsSent} digest emails, created ${calendarEventsCreated} calendar events`);
}

// POST /api/internal/run-scraper - Manually trigger the scraping pipeline (for testing)
app.post('/api/internal/run-scraper', async (req, res) => {
  console.log('[Internal] Manual scraper trigger requested');

  // Run asynchronously so we can respond immediately
  runScrapingPipeline()
    .then(() => console.log('[Internal] Manual scraper run completed'))
    .catch(() => console.error('[Internal] Manual scraper run failed'));

  res.json({ success: true, message: 'Scraping pipeline started. Check server logs for progress.' });
});

// ==================== SERVER STARTUP ====================

import { initScheduler, runScrapingPipeline } from './scheduler.js';

const jobs = createJobQueue(db, {
  calendar: ({ userId, teamId }) => addTeamGamesToCalendar(userId, teamId),
  notify: ({ gameIds }) => notifyGames(gameIds),
});
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = [400, 413, 429, 503].includes(error.status) ? error.status : 500;
  res.status(status).json({ error: status === 500 ? 'Request failed' : 'Invalid or temporarily unavailable request' });
});
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(port, () => {
    console.log(`API listening on port ${port}`);
    if (production) initScheduler(false);
  });
}
export { app, db, jobs };
