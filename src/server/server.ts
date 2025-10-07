import { createServer, IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import { promises as fs } from 'fs';
import { CacheStore } from './cache.js';
import { fetchLeagues, fetchSchedule, fetchTeams } from './fetcher.js';
import { League, ScheduleResponse, Team } from './types.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PUBLIC_DIR = path.join(process.cwd(), 'dist', 'public');

async function readStaticFile(filePath: string): Promise<any> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('NOT_FOUND');
    }
    throw error;
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function handleError(res: ServerResponse, error: unknown): void {
  console.error('[server] Error:', error);
  if ((error as Error).message === 'NOT_FOUND') {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  sendJson(res, 500, { error: 'Internal Server Error' });
}

class DataController {
  constructor(private cache: CacheStore) {}

  async getLeagues(): Promise<League[]> {
    const cached = this.cache.getLeagues();
    if (cached) {
      return cached;
    }
    const leagues = await fetchLeagues();
    await this.cache.setLeagues(leagues);
    return leagues;
  }

  async getTeams(leagueSlug: string): Promise<Team[]> {
    const cached = this.cache.getTeams(leagueSlug);
    if (cached) return cached;
    const leagues = await this.getLeagues();
    const league = leagues.find((l) => l.slug === leagueSlug);
    if (!league) {
      throw new Error('NOT_FOUND');
    }
    const teams = await fetchTeams(league);
    await this.cache.setTeams(leagueSlug, teams);
    return teams;
  }

  async getSchedule(leagueSlug: string, teamId: string): Promise<ScheduleResponse> {
    const teamKey = `${leagueSlug}:${teamId}`;
    const cached = this.cache.getSchedule(teamKey);
    if (cached) return cached;
    const teams = await this.getTeams(leagueSlug);
    const team = teams.find((t) => t.id === teamId);
    if (!team) {
      throw new Error('NOT_FOUND');
    }
    const games = await fetchSchedule(team);
    await this.cache.setSchedule(teamKey, team, games);
    return {
      team,
      games,
      lastUpdated: new Date().toISOString(),
    };
  }
}

async function bootstrap(): Promise<void> {
  const cache = new CacheStore();
  await cache.load();
  const controller = new DataController(cache);

  const server = createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/')) {
        await handleApiRequest(controller, req, res, url);
        return;
      }

      await handleStaticRequest(req, res, url);
    } catch (error) {
      handleError(res, error);
    }
  });

  server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

async function handleApiRequest(
  controller: DataController,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  if (url.pathname === '/api/leagues') {
    const leagues = await controller.getLeagues();
    sendJson(res, 200, { leagues });
    return;
  }

  if (url.pathname === '/api/teams') {
    const leagueSlug = url.searchParams.get('league');
    if (!leagueSlug) {
      sendJson(res, 400, { error: 'Missing league parameter' });
      return;
    }
    const teams = await controller.getTeams(leagueSlug);
    sendJson(res, 200, { teams });
    return;
  }

  if (url.pathname === '/api/schedule') {
    const leagueSlug = url.searchParams.get('league');
    const teamId = url.searchParams.get('team');
    if (!leagueSlug || !teamId) {
      sendJson(res, 400, { error: 'Missing league or team parameter' });
      return;
    }
    const schedule = await controller.getSchedule(leagueSlug, teamId);
    sendJson(res, 200, schedule);
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
}

async function handleStaticRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const requestedPath = decodeURIComponent(url.pathname);
  let filePath = path.join(PUBLIC_DIR, requestedPath);
  const normalized = path.resolve(filePath);
  const publicRoot = path.resolve(PUBLIC_DIR);
  if (!normalized.startsWith(publicRoot)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  filePath = normalized;
  try {
    const stat = await fs.stat(filePath).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        filePath = path.join(PUBLIC_DIR, 'index.html');
        return await fs.stat(filePath);
      }
      throw error;
    });

    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    const content = await readStaticFile(filePath);
    const ext = path.extname(filePath);
    const contentType = getContentType(ext);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (error) {
    handleError(res, error);
  }
}

function getContentType(ext: string): string {
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

bootstrap().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
