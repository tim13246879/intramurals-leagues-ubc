import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

// Open database with promise support
const db = await open({
  filename: './intramurals.db',
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
  name TEXT NOT NULL UNIQUE
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
`;

// Execute schema
await db.exec(schema);
console.log('✓ All tables created successfully');

// Insert sample data
console.log('\nInserting sample data...');

// Insert leagues
const basketball = await db.run(`INSERT INTO leagues (name) VALUES ('Basketball 2025')`);
const basketballLeagueId = basketball.lastID;
console.log('✓ Created league: Basketball 2025');

const soccer = await db.run(`INSERT INTO leagues (name) VALUES ('Soccer 2025')`);
console.log('✓ Created league: Soccer 2025');

// Insert tiers
const div1 = await db.run(`INSERT INTO tiers (name, league_id) VALUES ('Division 1', ?)`, [basketballLeagueId]);
const div1Id = div1.lastID;
console.log('✓ Created tier: Division 1');

const div2 = await db.run(`INSERT INTO tiers (name, league_id) VALUES ('Division 2', ?)`, [basketballLeagueId]);
console.log('✓ Created tier: Division 2');

// Insert teams
await db.run(`INSERT INTO teams (name, tier_id) VALUES ('Lakers', ?)`, [div1Id]);
console.log('✓ Created team: Lakers');

await db.run(`INSERT INTO teams (name, tier_id) VALUES ('Warriors', ?)`, [div1Id]);
console.log('✓ Created team: Warriors');

// Insert players
const players = ['Alice Johnson', 'Bob Smith', 'Charlie Brown', 'Diana Prince'];
for (const name of players) {
  await db.run(`INSERT INTO players (name) VALUES (?)`, [name]);
  console.log(`✓ Created player: ${name}`);
}

// Close database
await db.close();
console.log('\n✓ Database initialized successfully!');
console.log('Database file: ./intramurals.db');

