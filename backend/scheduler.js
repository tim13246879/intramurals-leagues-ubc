/**
 * Scheduled tasks for scraping and notifications
 * Runs both scrapers at midnight Pacific time
 */

import 'dotenv/config';
import cron from 'node-cron';
import { open } from './database.js';
import { enqueueJob } from './jobs.js';
import crypto from 'node:crypto';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DB_PATH || (process.env.NODE_ENV === 'production' ? '/data/intramurals.db' : './intramurals.db');

/**
 * Run a scraper script and return promise with result
 */
function runScraper(scriptName) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, scriptName);
    console.log(`[Scheduler] Starting ${scriptName}...`);

    const proc = spawn('node', [scriptPath], {
      cwd: __dirname,
      env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV || 'development', DB_PATH, ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const timeout = setTimeout(() => proc.kill('SIGKILL'), 10 * 60000);
    let outputBytes = 0;
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      outputBytes += data.length;
      if (outputBytes > 4 * 1024 * 1024) { proc.kill('SIGKILL'); return; }
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      outputBytes += data.length;
      if (outputBytes > 4 * 1024 * 1024) { proc.kill('SIGKILL'); return; }
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
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
      clearTimeout(timeout);
      console.error(`[Scheduler] Failed to start ${scriptName}:`, err);
      reject(err);
    });
  });
}

/**
 * Persist notification jobs for new games without exposing an HTTP credential
 */
async function triggerNotifications(gameIds) {
  if (!gameIds?.length) return;
  const db = await open({ filename: DB_PATH });
  try {
    const ids = [...new Set(gameIds)].sort((a,b) => a-b);
    for (let i=0; i<ids.length; i+=100) {
      const batch = ids.slice(i,i+100);
      const key = crypto.createHash('sha256').update(JSON.stringify(batch)).digest('hex');
      enqueueJob(db, 'notify', {gameIds: batch}, `notify:${key}`);
    }
  } finally { db.close(); }
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
let pipelineRunning = false;
async function runScrapingPipeline() {
  if (pipelineRunning) return false;
  pipelineRunning = true;
  let lockDb;
  const owner = crypto.randomUUID();
  try {
    lockDb = await open({ filename: DB_PATH });
    lockDb.exec('CREATE TABLE IF NOT EXISTS scraper_lease (id INTEGER PRIMARY KEY, owner TEXT, expires_at INTEGER)');
    const now = Date.now();
    const claim = lockDb.run(`INSERT INTO scraper_lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at WHERE scraper_lease.expires_at < ?`, [owner, now+25*60000, now]);
    if (!claim.changes) return false;
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
      console.error('[Scheduler] Pipeline failed');
    }
  } finally {
    if (lockDb) {
      lockDb.run('DELETE FROM scraper_lease WHERE owner=?', [owner]);
      lockDb.close();
    }
    pipelineRunning = false;
  }
}

/**
 * Initialize the scheduler
 * @param {boolean} runImmediately - If true, run the pipeline immediately on startup
 */
export { runScrapingPipeline };

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
