# intramurals-leagues-ubc

A web app that lets users follow specific UBC intramural league teams and receive notifications when new games are scheduled.

## Features

- **Browse teams** by sport → tier → team
- **Search by player name** to find all teams a person plays on
- **Search by team name** for direct lookup
- **Subscribe to teams** to get notified of new games
- **Notifications** via email, SMS, or Google Calendar (extensible)

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌──────────────────┐
│   Frontend  │────▶│  Express    │────▶│  SQLite Database │
│   (React?)  │     │  REST API   │     │                  │
└─────────────┘     └─────────────┘     └──────────────────┘
                          │
                          ▼
                    ┌─────────────┐
                    │  Scraper    │ (scheduled)
                    │  Service    │
                    └─────────────┘
                          │
                          ▼
                    ┌─────────────┐
                    │ Notification│
                    │  Service    │
                    └─────────────┘
                     ╱     │     ╲
                    ▼      ▼      ▼
                 Email   SMS   Google
                              Calendar
```

## Data Model

### Existing Tables
- `leagues` - Sports (Basketball, Soccer, etc.)
- `tiers` - Divisions within each league
- `teams` - Teams within each tier
- `games` - Scheduled games between teams
- `players` - Player names
- `team_players` - Links players to teams

### New Tables (TODO)
- `users` - User accounts (email and/or phone, optional google_id)
- `subscriptions` - Which teams a user follows
- `notification_preferences` - Per-user notification settings (email/sms/calendar)
- `game_notifications` - Log of sent notifications (prevent duplicates)

## Authentication Strategy

**Two-tier approach:**

1. **No-account mode (default):** User provides email or phone number to subscribe. No password needed - subscriptions are tied to that contact method. Unsubscribe link included in notifications.

2. **Google Sign-In (optional):** Required only for Google Calendar integration. OAuth flow grants calendar write access. User can still use email/SMS alongside calendar.

```
User provides email/phone
         │
         ▼
    ┌─────────┐
    │Subscribe│──────────────────────────────┐
    │to teams │                              │
    └─────────┘                              │
         │                                   │
         ▼                                   ▼
   Want calendar sync?              Email/SMS notifications
         │                                (no auth needed)
         ▼
   Google OAuth ──▶ Calendar events
```

## API Endpoints

### Public
- `GET /api/v1/leagues` - List all leagues
- `GET /api/v1/leagues/:leagueId/teams` - Teams in a league (grouped by tier)
- `GET /api/v1/leagues/:leagueId/teams/:teamId/games` - Games for a team
- `GET /api/v1/search/teams?q=` - Search teams by name
- `GET /api/v1/search/players?q=` - Search players, returns their teams

### Authenticated (TODO)
- `POST /api/v1/subscriptions` - Subscribe to a team
- `DELETE /api/v1/subscriptions/:teamId` - Unsubscribe
- `GET /api/v1/subscriptions` - List user's subscriptions
- `PUT /api/v1/notifications/preferences` - Update notification settings

## Notification Strategy

Abstract notification delivery behind an interface to support multiple channels:

```javascript
// NotificationService interface
notify(user, game) → Promise<void>

// Implementations
EmailNotifier    - Send email via SendGrid/SES/etc.
SMSNotifier      - Send SMS via Twilio (future)
CalendarNotifier - Add event via Google Calendar API (future)
```

**Change detection:** Compare newly scraped games against existing DB. New games trigger notifications to subscribed users.

## Frontend

Static HTML + vanilla JavaScript served from Express.

```
frontend/
├── index.html      # Landing page + browse teams by sport/tier
├── search.html     # Search by player or team name
├── manage.html     # Manage subscriptions + notification preferences
├── styles.css      # Shared styles
└── js/
    ├── api.js      # Fetch wrappers for API calls
    ├── browse.js   # Browse page logic
    ├── search.js   # Search page logic
    └── manage.js   # Subscription management logic
```

No build step required. Express serves static files via `express.static('frontend')`.

### Security Notes
- Use `textContent` (not `innerHTML`) when rendering user-provided data to prevent XSS
- All input validation happens on the backend - frontend validation is UX only
- No secrets in frontend code (Google OAuth client ID is fine, it's public)
- Serve over HTTPS in production

## Setup

```bash
cd backend
npm install
node init-db.js        # Initialize database schema
node teams-scraper.js  # Scrape all teams/standings
node games-scraper.js  # Scrape game schedules
node app.js            # Start server on :3000
```

## TODO

- [ ] Wire API routes to database
- [ ] Add user authentication
- [ ] Implement subscription system
- [ ] Build notification service (start with email)
- [ ] Add scheduled scraper (cron)
- [ ] Build frontend
- [ ] Add team name search endpoint
- [ ] Add player search endpoint
