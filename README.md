# UBC Intramurals Schedule Aggregator

This project provides a lightweight TypeScript-powered website that aggregates game schedules for teams that participate in UBC intramural leagues. It combines data from multiple leagues into a single view so students can easily see when all of their teams are playing.

## Features

- Fetches league, team, and schedule information directly from the [UBC Recreation intramurals website](https://recreation.ubc.ca/intramurals/leagues/).
- Client-side interface for selecting leagues and teams across all sports.
- Combined schedule cards for every selected team.
- Six-hour server-side cache to avoid repeatedly scraping the source website.
- Zero external npm dependencies — everything is implemented with TypeScript and Node.js standard libraries.

## Getting Started

### Prerequisites

- Node.js 18 or later (provides native `fetch`).

### Installation

1. Install dependencies (none are required beyond Node.js itself).
2. Build the project:

   ```bash
   npm run build
   ```

3. Start the server:

   ```bash
   npm start
   ```

4. Open your browser to [http://localhost:3000](http://localhost:3000).

### Development Workflow

- **Build assets**: `npm run build`
- **Start server**: `npm start`

The build step compiles the TypeScript sources to JavaScript and copies the static files into the `dist/` directory. The Node.js server serves the compiled front end and provides JSON endpoints under `/api/*`.

### Caching Behaviour

All fetched data (leagues, teams, and individual schedules) are cached on disk in `data/cache.json`. Entries are refreshed at most once every six hours, ensuring we are respectful of upstream resources. Delete the cache file if you need to force a refresh.

### Notes

- Due to upstream rate limiting or network restrictions, some schedule requests may fail. The user interface will surface these errors for individual teams without affecting others.
- If the structure of the UBC Recreation website changes, you may need to update the HTML parsing logic in `src/server/fetcher.ts`.

## Project Structure

```
public/             # Static assets (HTML, CSS)
src/
  client/           # Browser-side TypeScript
  server/           # Node.js server, caching, and scraping logic
tsconfig.json       # TypeScript compiler configuration
```

## License

MIT
