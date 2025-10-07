export interface League {
  name: string;
  slug: string;
  url: string;
}

export interface Team {
  id: string;
  name: string;
  leagueSlug: string;
  scheduleUrl: string;
}

export interface Game {
  date: string;
  time: string;
  opponent: string;
  location?: string;
  result?: string;
  details: Record<string, string>;
}

export interface ScheduleResponse {
  team: Team;
  games: Game[];
  lastUpdated: string;
}

export interface ApiError {
  error: string;
}
