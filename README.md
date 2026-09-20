# UBC Intramurals Notifier

A web app that lets users follow UBC intramural teams and receive notifications (email + Google Calendar) when new games are scheduled.

## Features

- Browse teams by sport, tier, and team
- Search by team name or player name
- Subscribe to teams with Google Sign-In
- Email notifications when new games are scheduled
- Google Calendar integration - games automatically added to your calendar
- Daily automated scraping of UBC Recreation portal

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌──────────────────┐
│   Frontend  │────▶│   Express   │────▶│  SQLite Database │
│ (Vanilla JS)│     │   REST API  │     │                  │
└─────────────┘     └─────────────┘     └──────────────────┘
                          │
                    ┌─────┴─────┐
                    ▼           ▼
              ┌──────────┐ ┌──────────┐
              │ Scheduler│ │  Google  │
              │ (node-   │ │  OAuth   │
              │  cron)   │ │          │
              └────┬─────┘ └──────────┘
                   │
         ┌─────────┼─────────┐
         ▼         ▼         ▼
    ┌────────┐ ┌────────┐ ┌────────┐
    │ Teams  │ │ Games  │ │Notific-│
    │Scraper │ │Scraper │ │ations  │
    └────────┘ └────────┘ └────────┘
                              │
                         ┌────┴────┐
                         ▼         ▼
                      Email    Calendar
```

## Quick Start

Requires Node.js 24 or newer.

```bash
# Setup
cd backend
npm ci
cp .env.example .env     # Edit with your credentials

# Initialize and populate database
npm run init-db
npm run scrape-teams
npm run scrape-games

# Run server
npm start                # http://localhost:3000
```

## Environment Variables

Copy `backend/.env.example` to `backend/.env`. Generate two independent secrets with `openssl rand -hex 32` (internal API) and `openssl rand -base64 32` (token encryption). Configuration includes:

```env
# Google OAuth (required)
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret

# Calendar OAuth redirect
GOOGLE_REDIRECT_URI=http://localhost:3000/api/v1/auth/calendar/callback

# Email notifications (Gmail with app password)
EMAIL_PROVIDER=smtp
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# Internal API (change in production)
INTERNAL_SECRET=<random-64-character-hex-secret>
TOKEN_ENCRYPTION_KEY=<random-32-byte-key-encoded-as-base64>
APP_ORIGIN=http://localhost:3000
PUBLIC_ROSTERS=false
NODE_ENV=development
```

## API Endpoints

### Public
- `GET /api/v1/leagues` - List all leagues
- `GET /api/v1/leagues/:id/teams` - Teams grouped by tier
- `GET /api/v1/teams/:id/games` - Games for a team
- `GET /api/v1/search/teams?q=` - Search teams

### Authenticated
- `GET /api/v1/teams/:id/players` - Team roster
- `GET /api/v1/search/players?q=` - Search players
- `POST /api/v1/auth/google` - Login with Google ID token
- `POST /api/v1/subscribe` - Subscribe to a team
- `GET /api/v1/subscriptions` - List subscriptions
- `DELETE /api/v1/subscriptions/:id` - Unsubscribe
- `PUT /api/v1/notifications/preferences` - Update notification settings
- `GET /api/v1/auth/calendar` - Get Calendar OAuth URL
- `POST /api/v1/auth/calendar/disconnect` - Disconnect calendar
- `DELETE /api/v1/account` - Delete account

## Deployment (Railway)

1. **Push to GitHub**

2. **Create Railway project**
   - New Project → Deploy from GitHub
   - Select repo and branch

3. **Add environment variables**
   ```
   NODE_ENV=production
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=https://your-app.railway.app/api/v1/auth/calendar/callback
   EMAIL_PROVIDER=smtp
   SMTP_USER=...
   SMTP_PASS=...
   INTERNAL_SECRET=<random-64-character-hex-secret>
   TOKEN_ENCRYPTION_KEY=<random-32-byte-key-encoded-as-base64>
   APP_ORIGIN=https://your-app.railway.app
   PUBLIC_ROSTERS=false
   ```

4. **Add persistent volume**
   - Settings → Volumes → Mount at `/data`

5. **Initialize database inside the deployed container with its volume mounted**
   ```bash
   npm run init-db
   npm run scrape-teams
   npm run scrape-games
   ```

6. **Update Google Cloud Console**
   - Add production redirect URI to OAuth client
   - Add production domain to authorized origins

## Project Structure

```
backend/
├── app.js              # Express server + API routes
├── init-db.js          # Database schema
├── scheduler.js        # Daily cron job for scrapers
├── teams-scraper.js    # Scrape leagues/tiers/teams
├── games-scraper.js    # Scrape games/rosters
├── .env.example        # Environment template
└── package.json

frontend/
├── index.html          # Main SPA
├── styles.css          # Styles
└── js/
    ├── api.js          # API client
    └── browse.js       # UI logic
```

## How It Works

1. **Scrapers** run daily at midnight Pacific via `scheduler.js`
2. **teams-scraper** fetches league standings from UBC Recreation portal
3. **games-scraper** visits each team page for schedules and rosters
4. **New games** trigger notifications to subscribed users:
   - Email sent via nodemailer
   - Calendar event created via Google Calendar API
5. **Frontend** authenticates with Google, manages subscriptions

## Tech Stack

- **Backend:** Node.js, Express, SQLite
- **Frontend:** Vanilla JavaScript (no build step)
- **Auth:** Google OAuth 2.0
- **Notifications:** Nodemailer, Google Calendar API
- **Scraping:** Axios, Cheerio
- **Scheduling:** node-cron

## Security upgrade and operations

Before deploying this branch, configure `APP_ORIGIN`, `TOKEN_ENCRYPTION_KEY`, and a strong `INTERNAL_SECRET` in the hosting environment. The server deliberately refuses to start with missing/placeholder secrets or an invalid production origin. `GOOGLE_REDIRECT_URI` must use the same origin. The frontend reads the Google client ID from `/api/v1/config`.

- Node 24 is required; SQLite uses `node:sqlite`. Nixpacks installs Node 24 and runs `npm ci --omit=dev`.
- Back up the database before the upgrade. Startup migrates it in place: existing Google refresh tokens are AES-256-GCM encrypted, old plaintext sessions are deleted, and roster freshness/queue tables are added. Users must sign in again. Old backups may still contain plaintext credentials; restrict access and retire them according to your retention policy.
- Keep the encryption key stable across restarts, separate from database backups. A different key causes startup to fail rather than silently losing access. Key rotation needs a controlled decrypt/re-encrypt migration; do not simply replace the environment value.
- Production sessions use `__Host-` cookies (`Secure`, `HttpOnly`, `SameSite=Lax`). API writes require `X-CSRF-Protection: 1` and reject a mismatched Origin. No bearer tokens are returned or stored in browser storage.
- OAuth state is stored server-side, expires after five minutes, is tied to the current session, and is consumed once. Calendar consent uses PKCE. Disconnect/delete revokes Google's token before removing local credentials; transient revocation failures require retrying.
- Player APIs require sign-in by default. Set `PUBLIC_ROSTERS=true` only after explicitly accepting public name/team/schedule discovery. Team browsing stays public. Current-season rosters replace previous memberships only after successful parsing; memberships unseen for 180 days and orphaned names are removed during scheduled scraping. Account deletion removes app account data; it does not delete independently scraped public sports records.
- The scheduler enqueues notifications directly into SQLite; it no longer transmits the internal secret over HTTP. Both manual and scheduled scraping share a lease, with per-process deadlines and output limits. Portal requests verify certificates, reject redirects/off-origin URLs, and cap time/body size. If the host needs a custom CA, use `NODE_EXTRA_CA_CERTS`; do not disable verification.
- Calendar and notification jobs run through a persistent queue (maximum 1,000 jobs), serialized by a renewable lease. Calendar events have deterministic IDs to prevent duplicate creation. Email claims are persisted before sending: an ambiguous failure/crash may lose an email, but automatic retries cannot spam recipients. Review delivery-failure logs before any manual resend.
- Rate limits use the socket IP by default. Set `TRUST_PROXY_HOPS` only after verifying the exact proxy topology and preventing direct access around it. Run one public web replica for consistent in-memory rate limits; multi-replica deployments need a shared rate-limit store. All workers must share the same SQLite volume.
- The app does not log email addresses or OAuth error objects. Restrict production log/backup access and configure infrastructure retention. Hosting configuration and live Google consent cannot be verified by local tests.

Run regression checks from `backend/`:

```bash
npm ci
npm test
npm audit
```

Tests use a temporary SQLite database and mocked Google/email services; they do not send notifications or use real credentials.
