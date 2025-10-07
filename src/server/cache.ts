import { promises as fs } from 'fs';
import path from 'path';
import { Game, League, ScheduleResponse, Team } from './types.js';

const SIX_HOURS_MS = 1000 * 60 * 60 * 6;

interface CachedEntry<T> {
  timestamp: number;
  data: T;
}

interface CacheSchema {
  leagues?: CachedEntry<League[]>;
  teams: Record<string, CachedEntry<Team[]>>;
  schedules: Record<string, CachedEntry<{ team: Team; games: Game[] }>>;
}

const CACHE_FILE = path.join(process.cwd(), 'data', 'cache.json');

export class CacheStore {
  private cache: CacheSchema = { teams: {}, schedules: {} };

  constructor() {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(CACHE_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as CacheSchema;
      this.cache = {
        leagues: parsed.leagues,
        teams: parsed.teams ?? {},
        schedules: parsed.schedules ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[cache] Failed to load cache:', error);
      }
      this.cache = { teams: {}, schedules: {} };
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(this.cache, null, 2), 'utf-8');
  }

  private isFresh(entry?: CachedEntry<unknown>): boolean {
    if (!entry) return false;
    return Date.now() - entry.timestamp < SIX_HOURS_MS;
  }

  getLeagues(): League[] | undefined {
    const entry = this.cache.leagues;
    if (this.isFresh(entry)) {
      return entry!.data;
    }
    return undefined;
  }

  async setLeagues(leagues: League[]): Promise<void> {
    this.cache.leagues = { data: leagues, timestamp: Date.now() };
    await this.persist();
  }

  getTeams(leagueSlug: string): Team[] | undefined {
    const entry = this.cache.teams[leagueSlug];
    if (this.isFresh(entry)) {
      return entry!.data;
    }
    return undefined;
  }

  async setTeams(leagueSlug: string, teams: Team[]): Promise<void> {
    this.cache.teams[leagueSlug] = { data: teams, timestamp: Date.now() };
    await this.persist();
  }

  getSchedule(teamKey: string): ScheduleResponse | undefined {
    const entry = this.cache.schedules[teamKey];
    if (this.isFresh(entry)) {
      const { team, games } = entry!.data;
      return {
        team,
        games,
        lastUpdated: new Date(entry!.timestamp).toISOString(),
      };
    }
    return undefined;
  }

  async setSchedule(teamKey: string, team: Team, games: Game[]): Promise<void> {
    this.cache.schedules[teamKey] = {
      timestamp: Date.now(),
      data: { team, games },
    };
    await this.persist();
  }
}
