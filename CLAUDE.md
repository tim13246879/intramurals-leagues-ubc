# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

UBC Intramurals notification app - users can browse/search UBC intramural teams, subscribe to teams, and receive email notifications when new games are scheduled.

## Commands

```bash
# Backend setup and development
cd backend
npm install
node init-db.js           # Initialize SQLite database schema
node teams-scraper.js     # Scrape all leagues/tiers/teams from UBC portal
node games-scraper.js     # Scrape game schedules and rosters from team pages
node app.js               # Start Express server on :3000

# Scrape a specific league or team
node teams-scraper.js nitobe-basketball
node games-scraper.js <team-url>
```

## Architecture

### Backend (Express + SQLite)

- **app.js** - Express server with REST API endpoints. Handles Google OAuth authentication (verifies ID tokens, creates 30-day sessions), team subscriptions, and email notifications via nodemailer. Uses ES modules.

- **init-db.js** - Database schema initialization. Tables: `leagues`, `tiers`, `teams`, `players`, `team_players`, `games`, `users`, `subscriptions`, `notification_preferences`, `sessions`, `game_notifications`.

- **teams-scraper.js** - Scrapes UBC recreation portal for league standings. Maps league slugs to activity IDs (`LEAGUE_CONFIG`). Stores leagues, tiers, and teams with URLs.

- **games-scraper.js** - Scrapes individual team pages for game schedules and player rosters. Runs with configurable concurrency (default 5). Returns new game IDs for notification triggers.

### Frontend (Static files served by Express)

Located in `frontend/`. No build step - vanilla JS with ES modules.

- **js/api.js** - API client with session token management. Stores auth in localStorage (`ubc_intramurals_session`, `ubc_intramurals_user`).
- **js/browse.js** - League/team browsing UI logic
- **index.html** - Main page with search, league browser, and overlays for My Teams/Settings

### Data Flow

1. `teams-scraper.js` populates leagues/tiers/teams from portal standings pages
2. `games-scraper.js` scrapes each team's page for games and rosters
3. New games trigger `notifySubscribersOfNewGame()` which emails users subscribed to either team
4. Frontend authenticates via Google Sign-In, receives session token, uses for protected API calls

### Authentication

- Google OAuth only - frontend sends ID token, backend verifies and creates session
- Sessions stored in DB with 30-day expiration
- Bearer token in Authorization header for protected endpoints
- New users get default notification preferences (email enabled, calendar disabled)

## Key Patterns

- All scrapers use axios + cheerio for HTML parsing
- Rate limiting: 500ms between league requests, 200ms between team batch requests
- Database uses foreign keys with ON DELETE CASCADE
- Game deduplication by datetime + teams + tier
