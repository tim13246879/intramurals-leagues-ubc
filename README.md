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

```bash
# Setup
cd backend
npm install
cp .env.example .env     # Edit with your credentials

# Initialize and populate database
npm run init-db
npm run scrape-teams
npm run scrape-games

# Run server
npm start                # http://localhost:3000
```

## Environment Variables

Create `backend/.env` with:

```env
# Google OAuth (required)
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret

# Calendar OAuth redirect
GOOGLE_REDIRECT_URI=http://localhost:3000/api/v1/auth/calendar/callback

# Email notifications (Gmail with app password)
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password

# Internal API (change in production)
INTERNAL_SECRET=your-secret-key
NODE_ENV=development
```

## API Endpoints

### Public
- `GET /api/v1/leagues` - List all leagues
- `GET /api/v1/leagues/:id/teams` - Teams grouped by tier
- `GET /api/v1/teams/:id/games` - Games for a team
- `GET /api/v1/teams/:id/players` - Team roster
- `GET /api/v1/search/teams?q=` - Search teams
- `GET /api/v1/search/players?q=` - Search players

### Authenticated
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
   EMAIL_USER=...
   EMAIL_PASS=...
   INTERNAL_SECRET=...
   ```

4. **Add persistent volume**
   - Settings → Volumes → Mount at `/app/backend`

5. **Initialize database**
   ```bash
   railway run npm run init-db
   railway run npm run scrape-teams
   railway run npm run scrape-games
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
