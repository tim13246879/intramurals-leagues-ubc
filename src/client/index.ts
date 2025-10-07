type League = {
  name: string;
  slug: string;
  url: string;
};

type Team = {
  id: string;
  name: string;
  leagueSlug: string;
  scheduleUrl: string;
};

type Game = {
  date: string;
  time: string;
  opponent: string;
  location?: string;
  result?: string;
  details: Record<string, string>;
};

type ScheduleResponse = {
  team: Team;
  games: Game[];
  lastUpdated: string;
};

type ApiError = {
  error: string;
};

const leagueSelect = document.getElementById('league-select') as HTMLSelectElement;
const teamSelect = document.getElementById('team-select') as HTMLSelectElement;
const addTeamButton = document.getElementById('add-team') as HTMLButtonElement;
const selectedTeamsList = document.getElementById('selected-teams') as HTMLUListElement;
const schedulesContainer = document.getElementById('schedules') as HTMLDivElement;
const statusElement = document.getElementById('status') as HTMLElement;

const leaguesCache = new Map<string, League>();
const teamsCache = new Map<string, Team[]>();
const selectedTeams = new Map<string, Team>();

function getTeamKey(team: Team): string {
  return `${team.leagueSlug}:${team.id}`;
}

function showStatus(message: string, isError = false) {
  statusElement.textContent = message;
  statusElement.classList.toggle('error', isError);
}

async function fetchJson<T extends object>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed: ${response.status} ${text}`);
  }
  const data = (await response.json()) as T | ApiError;
  if ('error' in data) {
    throw new Error(data.error);
  }
  return data as T;
}

function populateLeagueSelect(leagues: League[]) {
  leagueSelect.innerHTML = '<option value="" disabled selected>Select a league</option>';
  for (const league of leagues) {
    const option = document.createElement('option');
    option.value = league.slug;
    option.textContent = league.name;
    leagueSelect.appendChild(option);
    leaguesCache.set(league.slug, league);
  }
  leagueSelect.disabled = false;
}

function populateTeamSelect(teams: Team[]) {
  teamSelect.innerHTML = '<option value="" disabled selected>Select a team</option>';
  for (const team of teams) {
    const option = document.createElement('option');
    option.value = team.id;
    option.textContent = team.name;
    teamSelect.appendChild(option);
  }
  teamSelect.disabled = teams.length === 0;
  addTeamButton.disabled = true;
}

function renderSelectedTeams() {
  selectedTeamsList.innerHTML = '';
  for (const team of selectedTeams.values()) {
    const item = document.createElement('li');
    const leagueName = leaguesCache.get(team.leagueSlug)?.name ?? team.leagueSlug;
    item.textContent = `${team.name} (${leagueName})`;

    const removeButton = document.createElement('button');
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', () => {
      selectedTeams.delete(getTeamKey(team));
      renderSelectedTeams();
      renderSchedules();
    });

    item.appendChild(removeButton);
    selectedTeamsList.appendChild(item);
  }
}

async function renderSchedules() {
  schedulesContainer.innerHTML = '';
  if (selectedTeams.size === 0) {
    showStatus('Select a team to see their schedule.');
    return;
  }

  showStatus('Loading schedules...');

  for (const team of selectedTeams.values()) {
    const card = document.createElement('article');
    card.className = 'schedule-card';
    const header = document.createElement('h3');
    header.textContent = team.name;
    card.appendChild(header);

    try {
      const schedule = await fetchJson<ScheduleResponse>(`/api/schedule?league=${team.leagueSlug}&team=${encodeURIComponent(team.id)}`);
      card.appendChild(renderScheduleTable(schedule));
      const updated = document.createElement('p');
      updated.className = 'last-updated';
      updated.textContent = `Last updated ${new Date(schedule.lastUpdated).toLocaleString()}`;
      card.appendChild(updated);
    } catch (error) {
      const message = document.createElement('p');
      message.textContent = `Unable to load schedule: ${(error as Error).message}`;
      card.appendChild(message);
    }

    schedulesContainer.appendChild(card);
  }

  showStatus('');
}

function renderScheduleTable(schedule: ScheduleResponse): HTMLElement {
  if (schedule.games.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'No upcoming games found.';
    return empty;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const headers = ['Date', 'Time', 'Opponent', 'Location', 'Result'];
  for (const heading of headers) {
    const th = document.createElement('th');
    th.textContent = heading;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const game of schedule.games) {
    const row = document.createElement('tr');
    row.appendChild(createCell(game.date));
    row.appendChild(createCell(game.time));
    row.appendChild(createCell(game.opponent));
    row.appendChild(createCell(game.location ?? ''));
    row.appendChild(createCell(game.result ?? ''));
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  return table;
}

function createCell(text: string): HTMLTableCellElement {
  const cell = document.createElement('td');
  cell.textContent = text;
  return cell;
}

async function handleLeagueChange() {
  const slug = leagueSelect.value;
  if (!slug) {
    populateTeamSelect([]);
    return;
  }
  try {
    showStatus('Loading teams...');
    const data = await fetchJson<{ teams: Team[] }>(`/api/teams?league=${slug}`);
    teamsCache.set(slug, data.teams);
    populateTeamSelect(data.teams);
    showStatus(`Loaded ${data.teams.length} teams.`);
  } catch (error) {
    populateTeamSelect([]);
    showStatus(`Failed to load teams: ${(error as Error).message}`, true);
  }
}

function handleTeamSelection() {
  const teamId = teamSelect.value;
  const leagueSlug = leagueSelect.value;
  addTeamButton.disabled = !teamId || !leagueSlug;
}

function handleAddTeam() {
  const teamId = teamSelect.value;
  const leagueSlug = leagueSelect.value;
  if (!teamId || !leagueSlug) return;

  const teams = teamsCache.get(leagueSlug) ?? [];
  const team = teams.find((t) => t.id === teamId);
  if (!team) return;

  const key = getTeamKey(team);
  if (!selectedTeams.has(key)) {
    selectedTeams.set(key, team);
    renderSelectedTeams();
    renderSchedules();
  }
}

async function bootstrap() {
  try {
    showStatus('Loading leagues...');
    const data = await fetchJson<{ leagues: League[] }>('/api/leagues');
    populateLeagueSelect(data.leagues);
    showStatus('Choose a league to begin.');
  } catch (error) {
    showStatus(`Failed to load leagues: ${(error as Error).message}`, true);
  }
}

leagueSelect.addEventListener('change', () => {
  handleLeagueChange();
});

teamSelect.addEventListener('change', () => {
  handleTeamSelection();
});

addTeamButton.addEventListener('click', () => {
  handleAddTeam();
});

bootstrap();
