import 'dotenv/config';
import express from 'express';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'crypto';
import { google } from 'googleapis';
import { sendEmail, isEmailConfigured } from './email-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Use /data volume in production (Railway), local file in development
const DB_PATH = process.env.NODE_ENV === 'production'
  ? '/data/intramurals.db'
  : './intramurals.db';

// Google OAuth configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/v1/auth/calendar/callback';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Create OAuth2 client for Calendar API
function getCalendarOAuth2Client() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
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
    return;
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
          ${game.league_name} Intramurals -- ${game.tier_name}
        </p>
        <p style="margin: 0 0 8px 0; color: #374151;">
          ${game.team1_name} vs ${game.team2_name}
        </p>
        <p style="margin: 0; color: #6b7280; font-size: 14px;">
          📅 ${dateStr} at ${timeStr} · 📍 ${game.location}
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
        <h2 style="color: #002145; margin-top: 0;">Hey ${firstName}!</h2>
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
          You're receiving this because you subscribed to ${teamsStr} on UBC IM Notify.
        </p>
      </div>
    </div>
  `;

  const success = await sendEmail({
    to: user.email,
    subject: `🏆 ${gameCount} New Game${gameCount > 1 ? 's' : ''} Scheduled`,
    html: htmlContent,
  });

  if (success) {
    console.log(`Digest email sent to ${user.email} (${gameCount} games)`);
  }
}

// Notify all subscribers when a new game is added
async function notifySubscribersOfNewGame(game) {
  // Get both teams involved
  const team1 = await db.get('SELECT id, name FROM teams WHERE id = ?', [game.team1_id]);
  const team2 = await db.get('SELECT id, name FROM teams WHERE id = ?', [game.team2_id]);

  // Find all users subscribed to either team with notifications enabled
  const subscribers = await db.all(`
    SELECT DISTINCT u.id, u.email, u.name, u.calendar_refresh_token, s.team_id, np.channel, np.enabled
    FROM users u
    JOIN subscriptions s ON u.id = s.user_id
    JOIN notification_preferences np ON u.id = np.user_id
    WHERE s.team_id IN (?, ?)
      AND np.enabled = 1
  `, [game.team1_id, game.team2_id]);

  // Group by user to handle multiple channels
  const userMap = new Map();
  for (const sub of subscribers) {
    if (!userMap.has(sub.id)) {
      userMap.set(sub.id, {
        user: sub,
        team_id: sub.team_id,
        channels: new Set()
      });
    }
    userMap.get(sub.id).channels.add(sub.channel);
  }

  console.log(`Found ${userMap.size} subscriber(s) to notify for game ${game.id}`);

  for (const [userId, data] of userMap) {
    const team = data.team_id === team1.id ? team1 : team2;

    // Send email notification (uses digest format even for single game)
    if (data.channels.has('email')) {
      await sendDigestEmail(data.user, [{ game, team }]);
    }

    // Add to calendar
    if (data.channels.has('calendar') && data.user.calendar_refresh_token) {
      // Check if already added
      const existing = await db.get(
        'SELECT id FROM calendar_events WHERE user_id = ? AND game_id = ?',
        [userId, game.id]
      );

      if (!existing) {
        const eventId = await createCalendarEvent(data.user, game, team);
        if (eventId) {
          await db.run(
            'INSERT INTO calendar_events (user_id, game_id, calendar_event_id) VALUES (?, ?, ?)',
            [userId, game.id, eventId]
          );
        }
      }
    }
  }
}

// Create a calendar event for a game
async function createCalendarEvent(user, game, team) {
  if (!user.calendar_refresh_token) {
    console.log(`User ${user.email} has no calendar refresh token`);
    return null;
  }

  const oauth2Client = getCalendarOAuth2Client();
  oauth2Client.setCredentials({
    refresh_token: user.calendar_refresh_token
  });

  // Refresh access token before making API calls
  try {
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);
  } catch (refreshError) {
    console.error(`Failed to refresh token for ${user.email}:`, refreshError.message);
    return null;
  }

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const opponent = game.team1_name === team.name ? game.team2_name : game.team1_name;
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

  const event = {
    summary: `${game.league_name} Intramurals -- ${game.tier_name}`,
    description: `${game.team1_name} vs ${game.team2_name}`,
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

    console.log(`Calendar event created for ${user.email}: ${result.data.id}`);
    return result.data.id;
  } catch (error) {
    console.error(`Failed to create calendar event for ${user.email}:`, error.message);

    // Handle token expiration/revocation
    if (error.code === 401 || error.code === 403) {
      console.log(`Calendar token invalid for ${user.email}, clearing...`);
      await db.run(
        'UPDATE users SET calendar_refresh_token = NULL WHERE id = ?',
        [user.id]
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
    refresh_token: user.calendar_refresh_token
  });

  try {
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);
  } catch (refreshError) {
    console.error(`Failed to refresh token for ${user.email}:`, refreshError.message);
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
    console.error(`Error checking calendar event ${calendarEventId}:`, error.message);
    return true;
  }
}

// Add all existing games for a team to user's calendar
async function addTeamGamesToCalendar(userId, teamId) {
  const user = await db.get(
    'SELECT id, email, calendar_refresh_token FROM users WHERE id = ?',
    [userId]
  );

  if (!user?.calendar_refresh_token) {
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
    ORDER BY g.datetime
  `, [teamId, teamId]);

  let added = 0, skipped = 0;

  for (const game of games) {
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
        'INSERT INTO calendar_events (user_id, game_id, calendar_event_id) VALUES (?, ?, ?)',
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
        <h2 style="color: #002145; margin-top: 0;">Hey ${firstName}!</h2>
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
    </div>
  `;

  const success = await sendEmail({
    to: email,
    subject: 'Welcome to UBC IM Notify!',
    html: htmlContent,
  });

  if (success) {
    console.log(`Welcome email sent to ${email}`);
  }
}

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// COOP header for Google Sign-In popup support
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  next();
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../frontend')));

// Database connection
let db;

async function initDb() {
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });
  await db.exec('PRAGMA foreign_keys = ON');
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
    [userId, token, expiresAt.toISOString()]
  );

  return { token, expiresAt: expiresAt.toISOString() };
}

// Middleware to verify session token from Authorization header
async function authenticateSession(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  const token = authHeader.substring(7);
  try {
    // Find valid session
    const session = await db.get(
      `SELECT s.*, u.id as user_id, u.google_id, u.email, u.name, u.picture
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token = ? AND s.expires_at > datetime('now')`,
      [token]
    );

    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

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
  let isNewUser = false;

  if (!user) {
    // Create new user
    const result = await db.run(
      'INSERT INTO users (google_id, email, name, picture) VALUES (?, ?, ?, ?)',
      [googleId, email, name, picture]
    );
    user = { id: result.lastID, google_id: googleId, email, name, picture };
    isNewUser = true;
    console.log(`New user created: ${email} (id: ${user.id})`);

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
    console.log(`Sending welcome email to ${email}...`);
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
  }
});

// GET /api/v1/teams/:id/players - Get team roster
app.get('/api/v1/teams/:id/players', async (req, res) => {
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
    res.status(500).json({ error: error.message });
  }
});

// GET /api/v1/search/teams?q= - Search teams by name
app.get('/api/v1/search/teams', async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
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
    res.status(500).json({ error: error.message });
  }
});

// GET /api/v1/search/players?q= - Search players, returns their teams
app.get('/api/v1/search/players', async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
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
    res.status(500).json({ error: error.message });
  }
});

// ============ AUTH ENDPOINT ============

// POST /api/v1/auth/google - Authenticate with Google ID token
app.post('/api/v1/auth/google', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) {
    return res.status(400).json({ error: 'idToken required' });
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const googleUser = {
      googleId: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
    };

    const user = await findOrCreateUserByGoogle(googleUser);

    // Create a 30-day session
    const session = await createSession(user.id);

    // Get user preferences
    const preferences = await db.all(
      'SELECT channel, enabled FROM notification_preferences WHERE user_id = ?',
      [user.id]
    );

    res.json({
      success: true,
      user: {
        id: user.id,
        googleId: user.google_id,
        email: user.email,
        name: user.name,
        picture: user.picture,
      },
      sessionToken: session.token,
      expiresAt: session.expiresAt,
      preferences,
    });
  } catch (error) {
    console.error('Google auth error:', error.message);
    res.status(401).json({ error: 'Invalid Google token' });
  }
});

// POST /api/v1/auth/logout - Invalidate session
app.post('/api/v1/auth/logout', authenticateSession, async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader.substring(7);

  await db.run('DELETE FROM sessions WHERE token = ?', [token]);
  res.json({ success: true });
});

// DELETE /api/v1/account - Delete user account and all related data
app.delete('/api/v1/account', authenticateSession, async (req, res) => {
  const userId = req.user.id;
  const userEmail = req.user.email;

  try {
    // Foreign keys with ON DELETE CASCADE will handle related tables
    const result = await db.run('DELETE FROM users WHERE id = ?', [userId]);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    console.log(`Account deleted: ${userEmail} (id: ${userId})`);
    res.json({ success: true, message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Account deletion error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ CALENDAR OAUTH ENDPOINTS ============

// GET /api/v1/auth/calendar - Generate OAuth URL for calendar consent
app.get('/api/v1/auth/calendar', authenticateSession, async (req, res) => {
  if (!GOOGLE_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Calendar integration not configured' });
  }

  const oauth2Client = getCalendarOAuth2Client();

  // Generate state token to prevent CSRF
  const state = crypto.randomBytes(16).toString('hex');

  // Store state in a temporary way - we'll use a simple approach with user ID encoded
  const stateData = Buffer.from(JSON.stringify({
    userId: req.user.id,
    state: state,
    timestamp: Date.now()
  })).toString('base64');

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    state: stateData,
    prompt: 'consent',
    include_granted_scopes: true
  });

  res.json({ authUrl });
});

// GET /api/v1/auth/calendar/callback - Handle OAuth callback from Google
app.get('/api/v1/auth/calendar/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect('/?calendar_error=' + encodeURIComponent(error));
  }

  if (!code || !state) {
    return res.redirect('/?calendar_error=missing_params');
  }

  try {
    // Decode and verify state
    const stateData = JSON.parse(Buffer.from(state, 'base64').toString());

    // Check state is not too old (5 minutes max)
    if (Date.now() - stateData.timestamp > 5 * 60 * 1000) {
      return res.redirect('/?calendar_error=state_expired');
    }

    const userId = stateData.userId;

    // Verify user exists
    const user = await db.get('SELECT id FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.redirect('/?calendar_error=user_not_found');
    }

    // Exchange code for tokens
    const oauth2Client = getCalendarOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    // Store refresh token in database
    await db.run(
      'UPDATE users SET calendar_refresh_token = ? WHERE id = ?',
      [tokens.refresh_token, userId]
    );

    // Enable calendar preference
    await db.run(
      `INSERT INTO notification_preferences (user_id, channel, enabled)
       VALUES (?, 'calendar', 1)
       ON CONFLICT(user_id, channel) DO UPDATE SET enabled = 1`,
      [userId]
    );

    console.log(`Calendar connected for user ${userId}`);
    res.redirect('/?calendar_connected=true');
  } catch (err) {
    console.error('Calendar OAuth error:', err);
    res.redirect('/?calendar_error=token_exchange_failed');
  }
});

// POST /api/v1/auth/calendar/disconnect - Revoke calendar access
app.post('/api/v1/auth/calendar/disconnect', authenticateSession, async (req, res) => {
  try {
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
    res.status(500).json({ error: error.message });
  }
});

// ============ SUBSCRIPTION ENDPOINTS (requires session auth) ============

// POST /api/v1/subscribe - Subscribe to a team
app.post('/api/v1/subscribe', authenticateSession, async (req, res) => {
  try {
    const { teamId } = req.body;

    if (!teamId) {
      return res.status(400).json({ error: 'teamId required' });
    }

    // Verify team exists
    const team = await db.get('SELECT id, name FROM teams WHERE id = ?', [teamId]);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    // Add subscription (ignore if already exists)
    await db.run(
      'INSERT OR IGNORE INTO subscriptions (user_id, team_id) VALUES (?, ?)',
      [req.user.id, teamId]
    );

    // Check if calendar is enabled and add existing games
    const calendarPref = await db.get(
      `SELECT enabled FROM notification_preferences
       WHERE user_id = ? AND channel = 'calendar'`,
      [req.user.id]
    );

    let calendarResult = null;
    if (calendarPref?.enabled === 1) {
      calendarResult = await addTeamGamesToCalendar(req.user.id, teamId);
    }

    res.json({
      success: true,
      message: `Subscribed to ${team.name}`,
      userId: req.user.id,
      teamId: team.id,
      calendarEventsAdded: calendarResult?.added || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/v1/notifications/preferences - Update notification settings (auth required)
app.put('/api/v1/notifications/preferences', authenticateSession, async (req, res) => {
  try {
    const { channel, enabled } = req.body;

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
    res.status(500).json({ error: error.message });
  }
});

// ============ TEST ENDPOINTS (for development only) ============

// POST /api/v1/test/add-game - Mock add a game and notify subscribers
app.post('/api/v1/test/add-game', async (req, res) => {
  try {
    const { team1_id, team2_id, datetime, location } = req.body;

    // Get tier from team1
    const team1 = await db.get('SELECT tier_id FROM teams WHERE id = ?', [team1_id]);
    if (!team1) {
      return res.status(404).json({ error: 'Team 1 not found' });
    }

    // Check for duplicate game (same teams, same datetime)
    const existing = await db.get(
      `SELECT id FROM games
       WHERE ((team1_id = ? AND team2_id = ?) OR (team1_id = ? AND team2_id = ?))
         AND datetime = ?`,
      [team1_id, team2_id, team2_id, team1_id, datetime]
    );
    if (existing) {
      return res.status(409).json({ error: 'Game already exists', gameId: existing.id });
    }

    // Insert the game
    const result = await db.run(
      'INSERT INTO games (team1_id, team2_id, tier_id, datetime, location) VALUES (?, ?, ?, ?, ?)',
      [team1_id, team2_id, team1.tier_id, datetime, location]
    );

    // Get full game info for notifications
    const game = await db.get(`
      SELECT g.id, g.datetime, g.location,
             t1.id as team1_id, t1.name as team1_name,
             t2.id as team2_id, t2.name as team2_name,
             ti.name as tier_name, l.name as league_name
      FROM games g
      JOIN teams t1 ON g.team1_id = t1.id
      JOIN teams t2 ON g.team2_id = t2.id
      JOIN tiers ti ON g.tier_id = ti.id
      JOIN leagues l ON ti.league_id = l.id
      WHERE g.id = ?
    `, [result.lastID]);

    console.log(`New game added: ${game.team1_name} vs ${game.team2_name} on ${game.datetime}`);

    // Notify subscribers
    await notifySubscribersOfNewGame(game);

    res.json({ success: true, game });
  } catch (error) {
    console.error('Error adding test game:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== INTERNAL ENDPOINTS ====================

// Internal endpoint to trigger notifications for new games (called by scheduler)
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'dev-secret-change-in-production';

app.post('/api/internal/notify-games', async (req, res) => {
  const authHeader = req.headers['x-internal-secret'];
  if (authHeader !== INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { gameIds } = req.body;
  if (!Array.isArray(gameIds) || gameIds.length === 0) {
    return res.json({ success: true, notified: 0, emails: 0, calendarEvents: 0 });
  }

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
    if (data.channels.has('email')) {
      await sendDigestEmail(data.user, gamesWithTeams);
      emailsSent++;
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
              'INSERT INTO calendar_events (user_id, game_id, calendar_event_id) VALUES (?, ?, ?)',
              [userId, game.id, eventId]
            );
            calendarEventsCreated++;
          }
        }
      }
    }
  }

  console.log(`[Internal] Sent ${emailsSent} digest emails, created ${calendarEventsCreated} calendar events`);
  res.json({ success: true, notified: games.length, emails: emailsSent, calendarEvents: calendarEventsCreated });
});

// POST /api/internal/run-scraper - Manually trigger the scraping pipeline (for testing)
app.post('/api/internal/run-scraper', async (req, res) => {
  const secret = req.headers['x-internal-secret'];
  if (secret !== INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('[Internal] Manual scraper trigger requested');

  // Run asynchronously so we can respond immediately
  runScrapingPipeline()
    .then(() => console.log('[Internal] Manual scraper run completed'))
    .catch(err => console.error('[Internal] Manual scraper run failed:', err));

  res.json({ success: true, message: 'Scraping pipeline started. Check server logs for progress.' });
});

// ==================== SERVER STARTUP ====================

import { initScheduler, runScrapingPipeline } from './scheduler.js';

app.listen(port, () => {
  console.log(`✓ API listening on http://localhost:${port}`);

  // Initialize scheduler in production
  if (process.env.NODE_ENV === 'production') {
    initScheduler(false); // Don't run immediately on startup
  }
});
