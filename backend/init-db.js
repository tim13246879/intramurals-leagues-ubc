import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

// Use /data volume in production (Railway), local file in development
const DB_PATH = process.env.NODE_ENV === 'production'
  ? '/data/intramurals.db'
  : './intramurals.db';

// Open database with promise support
const db = await open({
  filename: DB_PATH,
  driver: sqlite3.Database
});

console.log('✓ Connected to SQLite database');

// Enable foreign keys
await db.exec('PRAGMA foreign_keys = ON');

// Create tables
const schema = `
-- League table
CREATE TABLE IF NOT EXISTS leagues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  year TEXT NOT NULL,
  term TEXT NOT NULL,
  UNIQUE(name, year, term)
);

-- Tier table
CREATE TABLE IF NOT EXISTS tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  league_id INTEGER NOT NULL,
  FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE,
  UNIQUE(name, league_id)
);

-- Team table
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  tier_id INTEGER NOT NULL,
  FOREIGN KEY (tier_id) REFERENCES tiers(id) ON DELETE CASCADE,
  UNIQUE(name, tier_id)
);

-- Player table
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

-- Junction table: Players on Teams
CREATE TABLE IF NOT EXISTS team_players (
  team_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  PRIMARY KEY (team_id, player_id),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);

-- Game table
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  datetime TEXT NOT NULL,
  location TEXT NOT NULL,
  team1_id INTEGER NOT NULL,
  team2_id INTEGER NOT NULL,
  tier_id INTEGER NOT NULL,
  FOREIGN KEY (team1_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (team2_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (tier_id) REFERENCES tiers(id) ON DELETE CASCADE,
  CHECK (team1_id != team2_id)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_tiers_league ON tiers(league_id);
CREATE INDEX IF NOT EXISTS idx_teams_tier ON teams(tier_id);
CREATE INDEX IF NOT EXISTS idx_games_tier ON games(tier_id);
CREATE INDEX IF NOT EXISTS idx_games_teams ON games(team1_id, team2_id);
CREATE INDEX IF NOT EXISTS idx_games_datetime ON games(datetime);
CREATE INDEX IF NOT EXISTS idx_team_players_player ON team_players(player_id);

-- Users table (Google OAuth required)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT,
  picture TEXT,
  calendar_refresh_token TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Subscriptions (which teams a user follows)
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  UNIQUE(user_id, team_id)
);

-- Notification preferences per user (email or calendar)
CREATE TABLE IF NOT EXISTS notification_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'calendar')),
  enabled INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, channel)
);

-- Log of sent notifications (prevent duplicates)
CREATE TABLE IF NOT EXISTS game_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  game_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  sent_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  UNIQUE(user_id, game_id, channel)
);

-- Sessions table for persistent login (30 day sessions)
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Calendar events tracking (prevents duplicates, enables updates)
CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  game_id INTEGER NOT NULL,
  calendar_event_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  UNIQUE(user_id, game_id)
);

-- Additional indexes for subscriptions
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_team ON subscriptions(team_id);
CREATE INDEX IF NOT EXISTS idx_game_notifications_user ON game_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_game_notifications_game ON game_notifications(game_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_user ON calendar_events(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_game ON calendar_events(game_id);
`;

// Execute schema
await db.exec(schema);
console.log('✓ All tables created successfully');

// Close database
await db.close();
console.log('\n✓ Database initialized successfully!');
console.log(`Database file: ${DB_PATH}`);

// thoughts: remove league table and combine into tiers table