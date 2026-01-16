/**
 * Browse page - Browse leagues, tiers, and teams with integrated search
 */

let searchTimeout = null;
let subscribedTeamIds = new Set(); // Track subscribed teams for UI state
let pendingTeams = {}; // Teams added locally before sign-in: {id: {id, name, tierName}}
let playerTeamsCache = {}; // Cache player teams for popup
let currentUser = null;

const PENDING_TEAMS_KEY = 'ubc_intramurals_pending_teams';

// Google OAuth Client ID
const GOOGLE_CLIENT_ID = '520367712600-vkaoqvgjsef6v65nuc4a6h2r5rikbser.apps.googleusercontent.com';

// Initialize on page load
document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Check for calendar OAuth callback
  checkCalendarCallback();

  // Initialize Google Sign-In
  initGoogleSignIn();

  // Load pending teams from localStorage
  loadPendingTeams();

  // Load existing user session
  currentUser = getStoredUser();
  if (currentUser) {
    await loadSubscribedTeams();
  }

  // Setup search (pre-fill with user's name if signed in)
  setupSearch();
  prefillSearchWithUserName();

  // Load leagues
  await loadLeagues();
}

// Check for calendar OAuth redirect callback
function checkCalendarCallback() {
  const params = new URLSearchParams(window.location.search);

  if (params.has('calendar_connected')) {
    showToast('Google Calendar connected successfully!');
    // Clean URL
    window.history.replaceState({}, '', window.location.pathname);
  } else if (params.has('calendar_error')) {
    const error = params.get('calendar_error');
    showToast('Calendar connection failed: ' + error, true);
    window.history.replaceState({}, '', window.location.pathname);
  }
}

function initGoogleSignIn() {
  if (typeof google !== 'undefined' && google.accounts) {
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleSignIn,
      auto_select: false,
    });
  }
}

async function handleGoogleSignIn(response) {
  try {
    const result = await authenticateWithGoogle(response.credential);
    currentUser = result.user;
    saveSession(result.user, result.sessionToken, result.expiresAt);
    await loadSubscribedTeams();
    // Sync any pending teams that were added before sign-in
    await syncPendingTeams();
    renderMyTeamsContent();
    // Pre-fill search with user's name
    prefillSearchWithUserName();
    showToast(`Welcome, ${result.user.name || result.user.email}!`);
  } catch (error) {
    showToast('Sign-in failed: ' + error.message, true);
  }
}

function prefillSearchWithUserName() {
  if (!currentUser || !currentUser.name) return;

  const input = document.getElementById('search-input');
  const dropdown = document.getElementById('search-dropdown');

  input.value = currentUser.name;
  dropdown.innerHTML = '<div class="search-dropdown-loading"><div class="spinner"></div></div>';
  dropdown.classList.remove('hidden');

  // Perform search
  performSearch(currentUser.name);
}

// ============ Pending Teams (before sign-in) ============

function loadPendingTeams() {
  const stored = localStorage.getItem(PENDING_TEAMS_KEY);
  if (stored) {
    pendingTeams = JSON.parse(stored);
  }
}

function savePendingTeams() {
  localStorage.setItem(PENDING_TEAMS_KEY, JSON.stringify(pendingTeams));
}

function clearPendingTeams() {
  pendingTeams = {};
  localStorage.removeItem(PENDING_TEAMS_KEY);
}

function getPendingTeamIds() {
  return Object.keys(pendingTeams).map(id => parseInt(id));
}

function hasPendingTeam(teamId) {
  return pendingTeams.hasOwnProperty(teamId);
}

function addPendingTeam(teamId, teamName, tierName = '') {
  pendingTeams[teamId] = { id: teamId, name: teamName, tierName };
  savePendingTeams();
}

function removePendingTeamById(teamId) {
  delete pendingTeams[teamId];
  savePendingTeams();
}

async function syncPendingTeams() {
  const teamIds = getPendingTeamIds();
  if (teamIds.length === 0) return;

  let syncedCount = 0;

  for (const teamId of teamIds) {
    if (!subscribedTeamIds.has(teamId)) {
      try {
        await subscribe(teamId);
        subscribedTeamIds.add(teamId);
        syncedCount++;
      } catch (error) {
        console.error('Failed to sync team:', teamId, error);
      }
    }
  }

  clearPendingTeams();
  if (syncedCount > 0) {
    showToast(`Synced ${syncedCount} team${syncedCount !== 1 ? 's' : ''} to your account`);
  }
}

// ============ Subscription State ============

async function loadSubscribedTeams() {
  if (!isLoggedIn()) return;

  try {
    const data = await getSubscriptions();
    subscribedTeamIds = new Set(data.subscriptions.map(s => s.team_id));
  } catch (error) {
    console.error('Failed to load subscriptions:', error);
  }
}

async function subscribeToTeam(teamId, button, teamName = '', tierName = '') {
  // If not logged in, add to pending teams
  if (!isLoggedIn()) {
    const wasPending = hasPendingTeam(teamId);
    if (wasPending) {
      removePendingTeamById(teamId);
      button.textContent = '+';
      button.className = 'btn btn-small btn-primary';
      updateTeamButtons(teamId, false);
      showToast(`Removed ${teamName || 'team'} from your list`);
    } else {
      addPendingTeam(teamId, teamName, tierName);
      button.textContent = '✓';
      button.className = 'btn btn-small btn-success';
      updateTeamButtons(teamId, true);
      showToast(`Added ${teamName || 'team'}. Sign in to get notifications!`);
    }
    return;
  }

  const wasSubscribed = subscribedTeamIds.has(teamId);
  button.disabled = true;
  button.textContent = '...';

  try {
    if (wasSubscribed) {
      // Need to get subscription ID first
      const data = await getSubscriptions();
      const sub = data.subscriptions.find(s => s.team_id === teamId);
      if (sub) {
        await unsubscribe(sub.id);
        subscribedTeamIds.delete(teamId);
        button.textContent = '+';
        button.className = 'btn btn-small btn-primary';
        button.disabled = false;
        showToast(`Unsubscribed from ${teamName || 'team'}`, true);
        // Update other buttons for this team
        updateTeamButtons(teamId, false);
      }
    } else {
      await subscribe(teamId);
      subscribedTeamIds.add(teamId);
      button.textContent = '✓';
      button.className = 'btn btn-small btn-success';
      button.disabled = false;
      showToast(`Subscribed to ${teamName || 'team'}`);
      // Update other buttons for this team
      updateTeamButtons(teamId, true);
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = wasSubscribed ? '✓' : '+';
    button.className = `btn btn-small ${wasSubscribed ? 'btn-success' : 'btn-primary'}`;
    showToast('Error: ' + error.message, true);
  }
}

function updateTeamButtons(teamId, subscribed) {
  document.querySelectorAll(`[data-team-subscribe="${teamId}"]`).forEach(btn => {
    btn.textContent = subscribed ? '✓' : '+';
    btn.className = `btn btn-small ${subscribed ? 'btn-success' : 'btn-primary'}`;
    btn.disabled = false;
  });
}

function showToast(message, isError = false) {
  // Remove existing toast
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${isError ? 'toast-error' : 'toast-success'}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => toast.classList.add('show'));

  // Auto remove
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

async function subscribeToAllTeams(teams, button) {
  // teams is array of {id, name, tierName}
  const toAdd = teams.filter(t => !subscribedTeamIds.has(t.id) && !hasPendingTeam(t.id));
  const allAdded = toAdd.length === 0;

  // If all teams are already added, remove them all
  if (allAdded) {
    await unsubscribeFromAllTeams(teams, button);
    return;
  }

  // If not logged in, add to pending teams
  if (!isLoggedIn()) {
    toAdd.forEach(team => {
      addPendingTeam(team.id, team.name, team.tierName || '');
      updateTeamButtons(team.id, true);
    });
    button.textContent = '✓ Added All';
    button.className = 'btn btn-success';
    showToast(`Added ${toAdd.length} team${toAdd.length !== 1 ? 's' : ''}. Sign in to get notifications!`);
    return;
  }

  button.disabled = true;
  button.textContent = 'Adding...';

  try {
    // Subscribe to all teams in parallel
    await Promise.all(toAdd.map(team => subscribe(team.id)));

    // Update state and UI for all teams at once
    toAdd.forEach(team => {
      subscribedTeamIds.add(team.id);
      updateTeamButtons(team.id, true);
    });

    button.textContent = '✓ Added All';
    button.className = 'btn btn-success';
    button.disabled = false;
    showToast(`Subscribed to ${toAdd.length} team${toAdd.length !== 1 ? 's' : ''}`);
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Add All Teams';
    showToast('Error: ' + error.message, true);
  }
}

async function unsubscribeFromAllTeams(teams, button) {
  // If not logged in, remove from pending teams
  if (!isLoggedIn()) {
    teams.forEach(team => {
      if (hasPendingTeam(team.id)) {
        removePendingTeamById(team.id);
        updateTeamButtons(team.id, false);
      }
    });
    button.textContent = 'Add All Teams';
    button.className = 'btn btn-primary';
    showToast(`Removed ${teams.length} team${teams.length !== 1 ? 's' : ''}`);
    return;
  }

  button.disabled = true;
  button.textContent = 'Removing...';

  try {
    // Get all subscriptions to find IDs
    const data = await getSubscriptions();
    const subMap = {};
    data.subscriptions.forEach(s => { subMap[s.team_id] = s.id; });

    // Unsubscribe from all teams that are subscribed
    const toRemove = teams.filter(t => subMap[t.id]);
    await Promise.all(toRemove.map(team => unsubscribe(subMap[team.id])));

    // Update state and UI
    toRemove.forEach(team => {
      subscribedTeamIds.delete(team.id);
      updateTeamButtons(team.id, false);
    });

    button.textContent = 'Add All Teams';
    button.className = 'btn btn-primary';
    button.disabled = false;
    showToast(`Removed ${toRemove.length} team${toRemove.length !== 1 ? 's' : ''}`, true);
  } catch (error) {
    button.disabled = false;
    button.textContent = '✓ Added All';
    button.className = 'btn btn-success';
    showToast('Error: ' + error.message, true);
  }
}

function isSubscribed(teamId) {
  return subscribedTeamIds.has(teamId) || hasPendingTeam(teamId);
}

// ============ Search ============

function setupSearch() {
  const input = document.getElementById('search-input');
  const dropdown = document.getElementById('search-dropdown');

  input.addEventListener('input', (e) => {
    const query = e.target.value.trim();

    if (searchTimeout) clearTimeout(searchTimeout);

    if (query.length < 2) {
      dropdown.classList.add('hidden');
      return;
    }

    dropdown.innerHTML = '<div class="search-dropdown-loading"><div class="spinner"></div></div>';
    dropdown.classList.remove('hidden');

    searchTimeout = setTimeout(() => performSearch(query), 300);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrapper')) {
      dropdown.classList.add('hidden');
    }
  });

  // Hide dropdown on scroll
  window.addEventListener('scroll', () => {
    dropdown.classList.add('hidden');
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      dropdown.classList.add('hidden');
      input.blur();
    }
    // Enter key triggers immediate search
    if (e.key === 'Enter') {
      e.preventDefault();
      const query = input.value.trim();
      if (query.length >= 2) {
        if (searchTimeout) clearTimeout(searchTimeout);
        dropdown.innerHTML = '<div class="search-dropdown-loading"><div class="spinner"></div></div>';
        dropdown.classList.remove('hidden');
        performSearch(query);
      }
    }
  });
}

async function performSearch(query) {
  const dropdown = document.getElementById('search-dropdown');

  try {
    const [teams, players] = await Promise.all([
      searchTeams(query),
      searchPlayers(query)
    ]);

    if (teams.length === 0 && players.length === 0) {
      dropdown.innerHTML = '<div class="search-dropdown-empty">No results found</div>';
      return;
    }

    let html = '';

    // Teams section
    if (teams.length > 0) {
      html += `
        <div class="search-dropdown-section">
          <div class="search-dropdown-header">Teams</div>
          ${teams.map(team => renderTeamSearchItem(team)).join('')}
        </div>
      `;
    }

    // Players section
    if (players.length > 0) {
      html += `
        <div class="search-dropdown-section">
          <div class="search-dropdown-header">Players</div>
          ${players.map(player => renderPlayerSearchItem(player)).join('')}
        </div>
      `;
    }

    dropdown.innerHTML = html;

  } catch (error) {
    dropdown.innerHTML = `<div class="search-dropdown-empty">Error: ${escapeHtml(error.message)}</div>`;
  }
}

function renderTeamSearchItem(team) {
  const subscribed = isSubscribed(team.id);
  const escapedName = escapeHtml(team.name).replace(/'/g, "\\'");
  const escapedTier = escapeHtml(team.tier_name || '').replace(/'/g, "\\'");
  return `
    <div class="search-dropdown-item">
      <div class="search-dropdown-item-info">
        <div class="search-dropdown-item-title">${escapeHtml(team.name)}</div>
        <div class="search-dropdown-item-subtitle">${escapeHtml(team.tier_name)} - ${escapeHtml(team.league_name)}</div>
      </div>
      <div class="search-dropdown-item-actions">
        <button class="btn btn-small btn-secondary btn-icon" onclick="showTeamRoster(${team.id}, '${escapedName}'); event.stopPropagation();" title="View roster">
          👥
        </button>
        <button
          class="btn btn-small ${subscribed ? 'btn-success' : 'btn-primary'}"
          data-team-subscribe="${team.id}"
          onclick="subscribeToTeam(${team.id}, this, '${escapedName}', '${escapedTier}'); event.stopPropagation();"
          title="${subscribed ? 'Click to unsubscribe' : 'Subscribe'}"
        >
          ${subscribed ? '✓' : '+'}
        </button>
      </div>
    </div>
  `;
}

function renderPlayerSearchItem(player) {
  const teamCount = player.teams.length;
  const escapedName = escapeHtml(player.name).replace(/'/g, "\\'");
  // Cache teams data for use in popup
  playerTeamsCache[player.id] = player.teams;
  return `
    <div class="search-dropdown-item search-dropdown-item-clickable" onclick="showPlayerTeamsFromCache(${player.id}, '${escapedName}')">
      <div class="search-dropdown-item-info">
        <div class="search-dropdown-item-title">${escapeHtml(player.name)}</div>
        <div class="search-dropdown-item-subtitle">${teamCount} team${teamCount !== 1 ? 's' : ''}</div>
      </div>
      <div class="search-dropdown-item-actions">
        <span class="text-muted">→</span>
      </div>
    </div>
  `;
}

// ============ Popup ============

function showPopup(title, content) {
  document.getElementById('popup-title').textContent = title;
  document.getElementById('popup-content').innerHTML = content;
  document.getElementById('popup-overlay').classList.remove('hidden');
}

function closePopup(event) {
  if (!event || event.target === event.currentTarget) {
    document.getElementById('popup-overlay').classList.add('hidden');
  }
}

async function showTeamRoster(teamId, teamName) {
  showPopup(`${teamName} Roster`, '<div class="search-dropdown-loading"><div class="spinner"></div></div>');

  try {
    const data = await getTeamPlayers(teamId);

    if (data.players.length === 0) {
      document.getElementById('popup-content').innerHTML = '<div class="search-dropdown-empty">No players found</div>';
      return;
    }

    document.getElementById('popup-content').innerHTML = data.players.map(player => `
      <div class="popup-item">
        <span class="popup-item-name">${escapeHtml(player.name)}</span>
      </div>
    `).join('');

  } catch (error) {
    document.getElementById('popup-content').innerHTML = `<div class="search-dropdown-empty">Error: ${escapeHtml(error.message)}</div>`;
  }
}

function showPlayerTeamsFromCache(playerId, playerName) {
  const teams = playerTeamsCache[playerId] || [];
  showPlayerTeams(playerId, playerName, teams);
}

function showPlayerTeams(playerId, playerName, teams) {
  // Prepare teams data for Add All button
  const teamsJson = JSON.stringify(teams.map(t => ({id: t.id, name: t.name, tierName: t.tier_name}))).replace(/'/g, "\\'");

  let content = teams.map(team => {
    const subscribed = isSubscribed(team.id);
    const escapedName = escapeHtml(team.name).replace(/'/g, "\\'");
    const escapedTier = escapeHtml(team.tier_name || '').replace(/'/g, "\\'");
    return `
      <div class="popup-item">
        <div>
          <div class="popup-item-name">${escapeHtml(team.name)}</div>
          <div class="popup-item-subtitle">${escapeHtml(team.tier_name)}${team.league_name ? ' - ' + escapeHtml(team.league_name) : ''}</div>
        </div>
        <div style="display: flex; gap: 0.25rem;">
          <button class="btn btn-small btn-secondary btn-icon" onclick="showTeamRoster(${team.id}, '${escapedName}')" title="View roster">
            👥
          </button>
          <button
            class="btn btn-small ${subscribed ? 'btn-success' : 'btn-primary'}"
            data-team-subscribe="${team.id}"
            onclick="subscribeToTeam(${team.id}, this, '${escapedName}', '${escapedTier}')"
            title="${subscribed ? 'Click to unsubscribe' : 'Subscribe'}"
          >
            ${subscribed ? '✓' : '+'}
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Always show Add All button - it toggles between add/remove
  if (teams.length > 0) {
    const allSubscribed = teams.every(t => isSubscribed(t.id));
    content += `
      <div class="popup-actions">
        <button class="btn ${allSubscribed ? 'btn-success' : 'btn-primary'}" onclick='subscribeToAllTeams(${teamsJson}, this)'>
          ${allSubscribed ? '✓ Added All' : 'Add All Teams'}
        </button>
      </div>
    `;
  }

  showPopup(`${playerName}'s Teams`, content);
}

// ============ Browse Leagues ============

async function loadLeagues() {
  const container = document.getElementById('leagues-container');

  try {
    const leagues = await getLeagues();

    if (leagues.length === 0) {
      container.innerHTML = '<div class="empty">No leagues found.</div>';
      return;
    }

    // Group leagues by term (term 2 first, then term 1)
    const term2Leagues = leagues.filter(l => l.term === '2' || l.term === 2);
    const term1Leagues = leagues.filter(l => l.term === '1' || l.term === 1);

    let html = '';

    if (term2Leagues.length > 0) {
      html += `<div class="term-section">
        <h3 class="term-header">Term 2</h3>
        ${term2Leagues.map(league => renderLeagueAccordion(league)).join('')}
      </div>`;
    }

    if (term1Leagues.length > 0) {
      html += `<div class="term-section">
        <h3 class="term-header">Term 1</h3>
        ${term1Leagues.map(league => renderLeagueAccordion(league)).join('')}
      </div>`;
    }

    container.innerHTML = html;

  } catch (error) {
    container.innerHTML = `<div class="message message-error">Error loading leagues: ${escapeHtml(error.message)}</div>`;
  }
}

function renderLeagueAccordion(league) {
  return `
    <div class="accordion" data-league-id="${league.id}">
      <div class="accordion-header" onclick="toggleLeague(${league.id})">
        <span>${escapeHtml(league.name)}</span>
      </div>
      <div class="accordion-content" id="league-${league.id}-content">
        <div class="loading"><div class="spinner"></div></div>
      </div>
    </div>
  `;
}

async function toggleLeague(leagueId) {
  const accordion = document.querySelector(`[data-league-id="${leagueId}"]`);
  const content = document.getElementById(`league-${leagueId}-content`);

  if (accordion.classList.contains('open')) {
    accordion.classList.remove('open');
    return;
  }

  accordion.classList.add('open');

  if (content.querySelector('.loading')) {
    await loadLeagueTiers(leagueId);
  }
}

async function loadLeagueTiers(leagueId) {
  const content = document.getElementById(`league-${leagueId}-content`);

  try {
    const data = await getLeagueTeams(leagueId);

    if (data.tiers.length === 0) {
      content.innerHTML = '<div class="empty text-small">No tiers found.</div>';
      return;
    }

    content.innerHTML = data.tiers.map(tier => `
      <div class="accordion" data-tier-id="${tier.id}">
        <div class="accordion-header" onclick="toggleTier(${tier.id}, event)">
          <span>${escapeHtml(tier.name)} <span class="badge badge-secondary">${tier.teams.length} teams</span></span>
        </div>
        <div class="accordion-content" id="tier-${tier.id}-content">
          ${renderTeamsList(tier.teams, tier.name)}
        </div>
      </div>
    `).join('');

  } catch (error) {
    content.innerHTML = `<div class="message message-error">Error loading tiers: ${escapeHtml(error.message)}</div>`;
  }
}

function toggleTier(tierId, event) {
  event.stopPropagation();
  const accordion = document.querySelector(`[data-tier-id="${tierId}"]`);
  accordion.classList.toggle('open');
}

function renderTeamsList(teams, tierName = '') {
  if (teams.length === 0) {
    return '<div class="empty text-small">No teams in this tier.</div>';
  }

  const escapedTier = escapeHtml(tierName).replace(/'/g, "\\'");

  return `
    <ul class="list">
      ${teams.map(team => {
        const subscribed = isSubscribed(team.id);
        const escapedName = escapeHtml(team.name).replace(/'/g, "\\'");
        return `
          <li class="list-item">
            <span class="list-item-title">${escapeHtml(team.name)}</span>
            <div style="display: flex; gap: 0.25rem;">
              <button class="btn btn-small btn-secondary btn-icon" onclick="showTeamRoster(${team.id}, '${escapedName}'); event.stopPropagation();" title="View roster">
                👥
              </button>
              <button
                class="btn btn-small ${subscribed ? 'btn-success' : 'btn-primary'}"
                data-team-subscribe="${team.id}"
                onclick="subscribeToTeam(${team.id}, this, '${escapedName}', '${escapedTier}'); event.stopPropagation();"
                title="${subscribed ? 'Click to unsubscribe' : 'Subscribe'}"
              >
                ${subscribed ? '✓' : '+'}
              </button>
            </div>
          </li>
        `;
      }).join('')}
    </ul>
  `;
}

// ============ My Teams Overlay ============

function openMyTeamsOverlay() {
  document.getElementById('myteams-overlay').classList.remove('hidden');
  renderMyTeamsContent();
}

function closeMyTeamsOverlay(event) {
  if (!event || event.target === event.currentTarget) {
    document.getElementById('myteams-overlay').classList.add('hidden');
  }
}

function renderMyTeamsContent() {
  const container = document.getElementById('myteams-content');
  currentUser = getStoredUser();

  if (!isLoggedIn()) {
    // Show pending teams + Google Sign-In button
    let html = '';
    const pendingCount = Object.keys(pendingTeams).length;

    // Show pending teams if any
    if (pendingCount > 0) {
      html += `<div class="popup-item" style="background: var(--gray-50); border-bottom: 1px solid var(--gray-200);">
        <span class="text-muted text-small">Teams added (${pendingCount}) - sign in to get notifications</span>
      </div>`;

      // Render pending teams directly from stored data
      for (const teamId in pendingTeams) {
        const team = pendingTeams[teamId];
        html += `
          <div class="popup-item" data-pending-team="${teamId}">
            <div>
              <div class="popup-item-name">${escapeHtml(team.name)}</div>
              ${team.tierName ? `<div class="popup-item-subtitle">${escapeHtml(team.tierName)}</div>` : ''}
            </div>
            <button class="btn btn-small btn-danger" onclick="removePendingTeam(${teamId})">×</button>
          </div>
        `;
      }
    }

    html += `
      <div style="padding: 1.5rem; text-align: center;">
        <p class="text-muted" style="margin-bottom: 1rem;">Sign in with Google to receive game notifications.</p>
        <div id="google-signin-button" style="display: flex; justify-content: center;"></div>
      </div>
    `;
    container.innerHTML = html;

    // Render Google Sign-In button (with retry for async load)
    renderGoogleButton();
  } else {
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    loadMyTeamsData();
  }
}

function removePendingTeam(teamId) {
  removePendingTeamById(teamId);
  updateTeamButtons(teamId, false);

  const item = document.querySelector(`[data-pending-team="${teamId}"]`);
  if (item) item.remove();

  // Update the count or re-render if empty
  const pendingCount = Object.keys(pendingTeams).length;
  if (pendingCount === 0) {
    renderMyTeamsContent();
  } else {
    const countEl = document.querySelector('#myteams-content .popup-item .text-muted');
    if (countEl) {
      countEl.textContent = `Teams added (${pendingCount}) - sign in to get notifications`;
    }
  }

  showToast('Removed from your list');
}

function renderGoogleButton() {
  const buttonContainer = document.getElementById('google-signin-button');
  if (!buttonContainer) return;

  if (typeof google !== 'undefined' && google.accounts && google.accounts.id) {
    // Initialize if not already done
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleSignIn,
      auto_select: false,
    });
    google.accounts.id.renderButton(
      buttonContainer,
      { theme: 'outline', size: 'large', width: 250 }
    );
  } else {
    // Google library not loaded yet, retry after a delay
    buttonContainer.innerHTML = '<div class="spinner"></div>';
    setTimeout(renderGoogleButton, 500);
  }
}

async function loadMyTeamsData() {
  const container = document.getElementById('myteams-content');

  try {
    const data = await getSubscriptions();
    renderMyTeamsLoaded(data);
  } catch (error) {
    container.innerHTML = `<div class="message message-error" style="margin: 1rem;">${escapeHtml(error.message)}</div>`;
  }
}

function renderMyTeamsLoaded(data) {
  const container = document.getElementById('myteams-content');

  let html = '';

  if (data.subscriptions.length === 0) {
    html += '<div class="empty text-small">No subscriptions yet. Browse leagues below to subscribe to teams!</div>';
  } else {
    html += data.subscriptions.map(sub => `
      <div class="popup-item" data-myteams-sub="${sub.id}">
        <div>
          <div class="popup-item-name">${escapeHtml(sub.team_name)}</div>
          <div class="popup-item-subtitle">${escapeHtml(sub.tier_name)} - ${escapeHtml(sub.league_name)}</div>
        </div>
        <button class="btn btn-small btn-danger" onclick="handleMyTeamsUnsubscribe(${sub.id}, ${sub.team_id}, '${escapeHtml(sub.team_name).replace(/'/g, "\\'")}')">
          ×
        </button>
      </div>
    `).join('');
  }

  container.innerHTML = html;
}

function handleSignOut() {
  if (typeof google !== 'undefined' && google.accounts) {
    google.accounts.id.disableAutoSelect();
  }
  clearStoredSession();
  currentUser = null;
  subscribedTeamIds.clear();
  renderMyTeamsContent();
  showToast('Signed out');
}

async function handleMyTeamsUnsubscribe(subscriptionId, teamId, teamName) {
  try {
    await unsubscribe(subscriptionId);
    subscribedTeamIds.delete(teamId);
    updateTeamButtons(teamId, false);

    const item = document.querySelector(`[data-myteams-sub="${subscriptionId}"]`);
    if (item) item.remove();

    showToast(`Unsubscribed from ${teamName}`, true);
  } catch (error) {
    showToast('Failed to unsubscribe', true);
  }
}

// ============ Settings Overlay ============

function openSettingsOverlay() {
  document.getElementById('settings-overlay').classList.remove('hidden');
  renderSettingsContent();
}

function closeSettingsOverlay(event) {
  if (!event || event.target === event.currentTarget) {
    document.getElementById('settings-overlay').classList.add('hidden');
  }
}

function renderSettingsContent() {
  const container = document.getElementById('settings-content');

  if (!isLoggedIn()) {
    container.innerHTML = `
      <div style="padding: 1rem;">
        <p class="text-muted text-small">Sign in with Google first via "My Teams" to manage settings.</p>
      </div>
    `;
  } else {
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    loadSettingsData();
  }
}

async function loadSettingsData() {
  const container = document.getElementById('settings-content');

  try {
    const data = await getSubscriptions();
    renderSettingsLoaded(data);
  } catch (error) {
    container.innerHTML = `<div class="message message-error" style="margin: 1rem;">${escapeHtml(error.message)}</div>`;
  }
}

function renderSettingsLoaded(data) {
  const container = document.getElementById('settings-content');
  const prefMap = {};
  data.preferences.forEach(p => { prefMap[p.channel] = p.enabled; });
  const user = getStoredUser();
  const calendarConnected = data.calendarConnected;
  const calendarEnabled = prefMap['calendar'] === 1;

  container.innerHTML = `
    <div style="padding: 1rem; border-bottom: 1px solid var(--gray-200);">
      <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem;">
        ${user.picture ? `<img src="${user.picture}" alt="" style="width: 40px; height: 40px; border-radius: 50%;">` : ''}
        <div>
          <div style="font-weight: 500;">${escapeHtml(user.name || 'User')}</div>
          <div class="text-muted text-small">${escapeHtml(user.email)}</div>
        </div>
      </div>
      <button class="btn btn-secondary" onclick="handleSignOut(); closeSettingsOverlay();">Sign Out</button>
    </div>
    <div style="padding: 1rem;">
      <p class="text-muted text-small" style="margin: 0 0 1rem 0;">Notifications</p>
      <div style="display: flex; flex-direction: column; gap: 1rem;">
        <label style="display: flex; align-items: flex-start; gap: 0.5rem; cursor: pointer;">
          <input type="checkbox" ${prefMap['email'] === 1 ? 'checked' : ''}
            onchange="handlePrefChange('email', this.checked)"
            style="margin-top: 4px;">
          <div>
            <div>Email Notifications ✉️</div>
            <div class="text-muted text-small">Receive game reminders via email</div>
          </div>
        </label>

        <!-- Calendar integration section -->
        ${calendarConnected ? `
          <label style="display: flex; align-items: flex-start; gap: 0.5rem; cursor: pointer;">
            <input type="checkbox" ${calendarEnabled ? 'checked' : ''}
              onchange="handleCalendarToggle(this.checked)"
              style="margin-top: 4px;">
            <div>
              <div>Google Calendar 📅</div>
              <div class="text-muted text-small">Automatically add games to your Google Calendar</div>
              <button class="btn btn-small btn-secondary" style="margin-top: 0.5rem;"
                onclick="event.preventDefault(); handleDisconnectCalendar()">
                Disconnect Calendar
              </button>
            </div>
          </label>
        ` : `
          <label style="display: flex; align-items: flex-start; gap: 0.5rem;">
            <input type="checkbox" disabled style="margin-top: 4px; visibility: hidden;">
            <div>
              <div>Google Calendar 📅</div>
              <div class="text-muted text-small">Connect your Google Calendar to automatically add games</div>
              <button class="btn btn-primary" style="margin-top: 0.5rem;" onclick="handleConnectCalendar()">
                Connect Google Calendar
              </button>
            </div>
          </label>
        `}
      </div>
    </div>
    <div style="padding: 1rem; border-top: 1px solid var(--gray-200);">
      <p class="text-muted text-small" style="margin: 0 0 0.75rem 0;">Danger Zone</p>
      <button class="btn btn-danger" onclick="confirmDeleteAccount()">Delete Account</button>
    </div>
  `;
}

function confirmDeleteAccount() {
  const user = getStoredUser();
  const confirmed = confirm(
    `Are you sure you want to delete your account?\n\n` +
    `This will permanently remove:\n` +
    `• Your account (${user.email})\n` +
    `• All your team subscriptions\n` +
    `• Your notification preferences\n\n` +
    `This action cannot be undone.`
  );

  if (confirmed) {
    handleDeleteAccount();
  }
}

async function handleDeleteAccount() {
  try {
    await deleteAccount();

    // Clear local data
    if (typeof google !== 'undefined' && google.accounts) {
      google.accounts.id.disableAutoSelect();
    }
    clearStoredSession();
    clearPendingTeams();
    currentUser = null;
    subscribedTeamIds.clear();

    closeSettingsOverlay();
    showToast('Account deleted successfully');
  } catch (error) {
    showToast('Failed to delete account: ' + error.message, true);
  }
}

async function handlePrefChange(channel, enabled) {
  try {
    await updateNotificationPreference(channel, enabled);
    const label = channel === 'calendar' ? 'Google Calendar' : 'Email';
    showToast(`${label} notifications ${enabled ? 'enabled' : 'disabled'}`);
  } catch (error) {
    showToast('Failed to update preference', true);
    renderSettingsContent(); // Reload to reset checkbox
  }
}

// Calendar connection handlers
async function handleConnectCalendar() {
  try {
    const { authUrl } = await getCalendarAuthUrl();
    // Redirect to Google OAuth consent
    window.location.href = authUrl;
  } catch (error) {
    showToast('Failed to connect calendar: ' + error.message, true);
  }
}

async function handleDisconnectCalendar() {
  if (!confirm('Disconnect Google Calendar? Existing calendar events will remain in your calendar.')) {
    return;
  }

  try {
    await disconnectCalendar();
    showToast('Calendar disconnected');
    renderSettingsContent(); // Refresh UI
  } catch (error) {
    showToast('Failed to disconnect: ' + error.message, true);
  }
}

async function handleCalendarToggle(enabled) {
  try {
    await updateNotificationPreference('calendar', enabled);
    showToast(`Calendar notifications ${enabled ? 'enabled' : 'disabled'}`);
  } catch (error) {
    showToast('Failed to update preference', true);
    renderSettingsContent(); // Reload to reset checkbox
  }
}

// ============ Helpers ============

function escapeHtml(text) {
  if (typeof text !== 'string') return text;
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
