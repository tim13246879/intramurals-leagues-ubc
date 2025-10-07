import { cleanText, parseTable } from './html.js';
import { Game, League, Team } from './types.js';

const BASE_URL = 'https://recreation.ubc.ca';
const LEAGUES_PATH = '/intramurals/leagues/';
const USER_AGENT = 'UBC-IM-Aggregator/1.0 (+https://github.com/UBC)';

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const value = key(item);
    if (!seen.has(value)) {
      seen.add(value);
      result.push(item);
    }
  }
  return result;
}

export async function fetchLeagues(): Promise<League[]> {
  const html = await fetchHtml(BASE_URL + LEAGUES_PATH);
  const anchorRegex = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const leagues: League[] = [];
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html))) {
    const href = match[1];
    const text = cleanText(match[2]);
    if (!href.includes('/intramurals/leagues/')) continue;
    const url = href.startsWith('http') ? href : new URL(href, BASE_URL).toString();
    const slugMatch = url.match(/\/intramurals\/leagues\/([^\/#?]+)/i);
    if (!slugMatch) continue;
    const slug = slugMatch[1];
    if (!text || text.length < 2) continue;
    leagues.push({ name: text, slug, url });
  }
  return uniqueBy(leagues, (l) => l.slug).sort((a, b) => a.name.localeCompare(b.name));
}

function resolveUrl(base: string, relative: string): string {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

function extractTeamOptions(html: string, leagueSlug: string): Team[] {
  const optionRegex = /<option[^>]+value="([^"]*ID=\d+[^"]*)"[^>]*>([\s\S]*?)<\/option>/gi;
  const teams: Team[] = [];
  let match: RegExpExecArray | null;
  const base = `${BASE_URL}/intramurals/leagues/${leagueSlug}/`;
  while ((match = optionRegex.exec(html))) {
    const value = match[1];
    const name = cleanText(match[2]);
    if (!name) continue;
    const url = resolveUrl(base, value);
    const idMatch = url.match(/ID=(\d+)/i) ?? url.match(/team(?:-|=)(\d+)/i);
    const id = idMatch ? idMatch[1] : Buffer.from(url).toString('base64');
    teams.push({ id, name, leagueSlug, scheduleUrl: url });
  }
  if (teams.length > 0) {
    return uniqueBy(teams, (t) => t.scheduleUrl);
  }

  // fallback: parse anchors with ID query param
  const anchorRegex = /<a[^>]+href="([^"]*ID=\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = anchorRegex.exec(html))) {
    const href = match[1];
    const text = cleanText(match[2]);
    if (!text) continue;
    const url = resolveUrl(base, href);
    const idMatch = url.match(/ID=(\d+)/i);
    if (!idMatch) continue;
    teams.push({ id: idMatch[1], name: text, leagueSlug, scheduleUrl: url });
  }
  return uniqueBy(teams, (t) => t.scheduleUrl);
}

export async function fetchTeams(league: League): Promise<Team[]> {
  const html = await fetchHtml(league.url);
  return extractTeamOptions(html, league.slug).sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeHeader(header: string): string {
  const lower = header.toLowerCase();
  if (lower.includes('date')) return 'date';
  if (lower.includes('time')) return 'time';
  if (lower.includes('opponent') || lower.includes('match') || lower.includes('vs')) return 'opponent';
  if (lower.includes('location') || lower.includes('field') || lower.includes('court')) return 'location';
  if (lower.includes('result') || lower.includes('score')) return 'result';
  return lower.replace(/[^a-z0-9]+/g, '');
}

function extractPrimaryTable(html: string): Game[] {
  const tableRegex = /<table[\s\S]*?<\/table>/gi;
  const tables = html.match(tableRegex) ?? [];
  for (const table of tables) {
    const rows = parseTable(table);
    if (rows.length < 2) continue;
    const headers = rows[0].map(normalizeHeader);
    if (!headers.includes('date') || !headers.includes('opponent')) continue;
    const games: Game[] = [];
    for (const row of rows.slice(1)) {
      const record: Record<string, string> = {};
      headers.forEach((key, index) => {
        if (key) {
          record[key] = row[index] ?? '';
        }
      });
      const game: Game = {
        date: record['date'] ?? '',
        time: record['time'] ?? '',
        opponent: record['opponent'] ?? '',
        location: record['location'] || undefined,
        result: record['result'] || undefined,
        details: record,
      };
      games.push(game);
    }
    if (games.length > 0) {
      return games;
    }
  }
  return [];
}

export async function fetchSchedule(team: Team): Promise<Game[]> {
  const html = await fetchHtml(team.scheduleUrl);
  const games = extractPrimaryTable(html);
  if (games.length > 0) {
    return games;
  }

  // fallback: parse definition lists or paragraphs
  const listRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  const listGames: Game[] = [];
  let match: RegExpExecArray | null;
  while ((match = listRegex.exec(html))) {
    const text = cleanText(match[1]);
    if (!text) continue;
    listGames.push({
      date: text,
      time: '',
      opponent: '',
      details: { summary: text },
    });
  }
  if (listGames.length > 0) {
    return listGames;
  }

  return [];
}
