# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

UBC Intramurals notification app - users can browse/search UBC intramural teams, subscribe to teams, and receive notifications (email + Google Calendar) when new games are scheduled.

## Commands

```bash
# Backend setup and development
cd backend
npm ci
npm run init-db           # Initialize SQLite database schema
npm run scrape-teams      # Scrape all leagues/tiers/teams from UBC portal
npm run scrape-games      # Scrape game schedules and rosters from team pages
npm start                 # Start Express server on :3000

# Individual scripts
node teams-scraper.js nitobe-basketball   # Scrape specific league
node games-scraper.js <team-url>          # Scrape specific team
node scheduler.js                          # Run scraping pipeline manually
```

## Architecture

### Backend (Express + SQLite)

- **app.js** - Express server with REST API endpoints. Handles Google OAuth authentication, team subscriptions, email notifications via nodemailer, and Google Calendar integration. Initializes scheduler in production.

- **init-db.js** - Database schema initialization. Tables: `leagues`, `tiers`, `teams`, `players`, `team_players`, `games`, `users`, `subscriptions`, `notification_preferences`, `sessions`, `game_notifications`, `calendar_events`.

- **teams-scraper.js** - Scrapes UBC recreation portal for league standings. Maps league slugs to activity IDs (`LEAGUE_CONFIG`). Stores leagues, tiers, and teams with URLs.

- **games-scraper.js** - Scrapes individual team pages for game schedules and player rosters. Runs with configurable concurrency (default 5). Outputs JSON with new game IDs for scheduler.

- **scheduler.js** - Cron-based scheduler that runs scrapers daily at midnight Pacific. Enqueues notifications for new games directly in SQLite.

### Frontend (Static files served by Express)

Located in `frontend/`. No build step - vanilla JS.

- **js/api.js** - API client with session token management. Stores only non-secret UI state in localStorage; authentication uses HttpOnly cookies.
- **js/browse.js** - Main UI: league browser, search, My Teams overlay, Settings overlay
- **index.html** - Single-page app with all functionality

### Data Flow

1. `teams-scraper.js` populates leagues/tiers/teams from portal standings pages
2. `games-scraper.js` scrapes each team's page for games and rosters
3. New games trigger notifications (email + calendar) to subscribed users
4. Frontend authenticates via Google Sign-In, receives an HttpOnly session cookie for protected API calls

### Authentication

- Google OAuth only - frontend sends ID token, backend verifies and creates 30-day session
- Sessions stored as SHA-256 hashes in DB; raw tokens travel only in HttpOnly cookies
- Calendar integration uses separate OAuth flow for calendar.events scope
- Refresh tokens encrypted with AES-256-GCM for offline calendar access

### Notifications

Two channels supported:
- **Email** - Sent via nodemailer (Gmail app password)
- **Google Calendar** - Events created via Calendar API with 1hr and 24hr reminders

## Key Patterns

- All scrapers use axios + cheerio for HTML parsing
- Rate limiting: 500ms between league requests, 200ms between team batch requests
- Database uses foreign keys with ON DELETE CASCADE
- Game deduplication by datetime + teams + tier
- Calendar token refresh before each API call

## Environment Variables

See `backend/.env.example` for required configuration:
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` - OAuth credentials
- `GOOGLE_REDIRECT_URI` - Calendar OAuth callback URL
- `SMTP_USER` / `SMTP_PASS` - Gmail credentials for notifications
- `INTERNAL_SECRET` - Required strong secret for internal admin endpoints
- `TOKEN_ENCRYPTION_KEY` - Required stable base64 32-byte key
- `APP_ORIGIN` - Canonical HTTPS production origin
- `NODE_ENV` - Set to `production` to enable scheduler

## Deployment

Designed for Railway deployment:
- `npm start` runs the Express server
- Scheduler initializes automatically when `NODE_ENV=production`
- Requires persistent volume for SQLite database
- See README.md for full deployment steps

## Security constraints

Use Node 24+. Read README security upgrade notes before deployment. Do not reintroduce inline event handlers, plaintext tokens, unsigned OAuth state, public game-writing endpoints, or disabled TLS verification. Run `npm test` and `npm audit` from backend after security changes.
