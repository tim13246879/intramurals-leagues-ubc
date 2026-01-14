/**
 * Scheduled tasks for scraping and notifications
 * Runs both scrapers at midnight Pacific time
 */

import cron from 'node-cron';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const API_BASE = process.env.API_BASE_URL || `http://localhost:${PORT}`;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'dev-secret-change-in-production';

/**
 * Run a scraper script and return promise with result
 */
function runScraper(scriptName) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, scriptName);
    console.log(`[Scheduler] Starting ${scriptName}...`);

    const proc = spawn('node', [scriptPath], {
      cwd: __dirname,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`[Scheduler] ${scriptName} completed successfully`);
        resolve({ success: true, stdout, stderr });
      } else {
        console.error(`[Scheduler] ${scriptName} failed with code ${code}`);
        console.error(stderr);
        resolve({ success: false, stdout, stderr, code });
      }
    });

    proc.on('error', (err) => {
      console.error(`[Scheduler] Failed to start ${scriptName}:`, err);
      reject(err);
    });
  });
}

/**
 * Trigger notifications for new games via internal API
 */
async function triggerNotifications(gameIds) {
  if (!gameIds || gameIds.length === 0) {
    console.log('[Scheduler] No new games to notify');
    return;
  }

  console.log(`[Scheduler] Triggering notifications for ${gameIds.length} new games`);

  try {
    const response = await fetch(`${API_BASE}/api/internal/notify-games`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': INTERNAL_SECRET
      },
      body: JSON.stringify({ gameIds })
    });

    const result = await response.json();
    console.log(`[Scheduler] Notifications triggered: ${result.notified} games notified`);
  } catch (error) {
    console.error('[Scheduler] Failed to trigger notifications:', error.message);
  }
}

/**
 * Parse new game IDs from scraper output
 * Looks for JSON output line: {"newGameIds": [...]}
 */
function parseNewGameIds(stdout) {
  const lines = stdout.split('\n');
  for (const line of lines) {
    if (line.includes('"newGameIds"')) {
      try {
        const data = JSON.parse(line);
        return data.newGameIds || [];
      } catch (e) {
        // Not valid JSON, continue
      }
    }
  }
  return [];
}

/**
 * Run the full scraping pipeline
 */
async function runScrapingPipeline() {
  console.log(`[Scheduler] Starting scraping pipeline at ${new Date().toISOString()}`);

  try {
    // Step 1: Scrape teams (leagues, tiers, teams)
    const teamsResult = await runScraper('teams-scraper.js');
    if (!teamsResult.success) {
      console.error('[Scheduler] Teams scraper failed, skipping games scraper');
      return;
    }

    // Step 2: Scrape games (schedules, rosters)
    const gamesResult = await runScraper('games-scraper.js');

    // Step 3: Trigger notifications for any new games
    if (gamesResult.success) {
      const newGameIds = parseNewGameIds(gamesResult.stdout);
      if (newGameIds.length > 0) {
        await triggerNotifications(newGameIds);
      }
    }

    console.log(`[Scheduler] Pipeline completed at ${new Date().toISOString()}`);
  } catch (error) {
    console.error('[Scheduler] Pipeline error:', error);
  }
}

/**
 * Initialize the scheduler
 * @param {boolean} runImmediately - If true, run the pipeline immediately on startup
 */
export function initScheduler(runImmediately = false) {
  // Schedule for midnight Pacific time (America/Los_Angeles)
  // Cron format: minute hour day month weekday
  cron.schedule('0 0 * * *', runScrapingPipeline, {
    timezone: 'America/Los_Angeles'
  });

  console.log('[Scheduler] Initialized - scrapers will run daily at midnight Pacific');

  if (runImmediately) {
    console.log('[Scheduler] Running initial scrape...');
    runScrapingPipeline();
  }
}

// Allow running directly for testing
if (process.argv[1] && process.argv[1].endsWith('scheduler.js')) {
  console.log('[Scheduler] Running in standalone mode');
  runScrapingPipeline().then(() => {
    console.log('[Scheduler] Standalone run complete');
  });
}
