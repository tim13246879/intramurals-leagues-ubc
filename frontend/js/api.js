/**
 * API client for UBC Intramurals backend
 */

const API_BASE = '/api/v1';

/**
 * Fetch wrapper with error handling and session token
 */
async function apiFetch(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  // Add session token if user is logged in
  const session = getStoredSession();
  if (session && session.token) {
    headers['Authorization'] = `Bearer ${session.token}`;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers,
    ...options,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    // If session expired, clear stored data
    if (response.status === 401) {
      clearStoredSession();
    }
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

// ============ PUBLIC ENDPOINTS ============

/**
 * Get all leagues
 * @returns {Promise<Array<{id, name, year, term}>>}
 */
function getLeagues() {
  return apiFetch('/leagues');
}

/**
 * Get teams in a league grouped by tier
 * @param {number} leagueId
 * @returns {Promise<{league, tiers: Array<{id, name, teams}>}>}
 */
function getLeagueTeams(leagueId) {
  return apiFetch(`/leagues/${leagueId}/teams`);
}

/**
 * Get games for a team
 * @param {number} teamId
 * @param {boolean} upcomingOnly - Only return future games
 * @returns {Promise<{team, games}>}
 */
function getTeamGames(teamId, upcomingOnly = false) {
  const query = upcomingOnly ? '?upcoming=true' : '';
  return apiFetch(`/teams/${teamId}/games${query}`);
}

/**
 * Get team roster (players)
 * @param {number} teamId
 * @returns {Promise<{team, players: Array<{id, name}>}>}
 */
function getTeamPlayers(teamId) {
  return apiFetch(`/teams/${teamId}/players`);
}

/**
 * Search teams by name
 * @param {string} query - Min 2 characters
 * @returns {Promise<Array<{id, name, tier_name, league_name}>>}
 */
function searchTeams(query) {
  return apiFetch(`/search/teams?q=${encodeURIComponent(query)}`);
}

/**
 * Search players by name
 * @param {string} query - Min 2 characters
 * @returns {Promise<Array<{id, name, teams}>>}
 */
function searchPlayers(query) {
  return apiFetch(`/search/players?q=${encodeURIComponent(query)}`);
}

// ============ AUTH ENDPOINTS ============

/**
 * Authenticate with Google ID token
 * @param {string} idToken - Google ID token from GIS
 * @returns {Promise<{success, user, preferences}>}
 */
function authenticateWithGoogle(idToken) {
  return apiFetch('/auth/google', {
    method: 'POST',
    body: JSON.stringify({ idToken }),
  });
}

// ============ SUBSCRIPTION ENDPOINTS ============

/**
 * Subscribe to a team (requires auth)
 * @param {number} teamId
 * @returns {Promise<{success, message, userId, teamId}>}
 */
function subscribe(teamId) {
  return apiFetch('/subscribe', {
    method: 'POST',
    body: JSON.stringify({ teamId }),
  });
}

/**
 * Get user's subscriptions (requires auth)
 * @returns {Promise<{user, subscriptions, preferences}>}
 */
function getSubscriptions() {
  return apiFetch('/subscriptions');
}

/**
 * Unsubscribe from a team (requires auth)
 * @param {number} subscriptionId
 * @returns {Promise<{success, message}>}
 */
function unsubscribe(subscriptionId) {
  return apiFetch(`/subscriptions/${subscriptionId}`, {
    method: 'DELETE',
  });
}

/**
 * Update notification preferences (requires auth)
 * @param {string} channel - 'email' or 'calendar'
 * @param {boolean} enabled
 * @returns {Promise<{success, channel, enabled}>}
 */
function updateNotificationPreference(channel, enabled) {
  return apiFetch('/notifications/preferences', {
    method: 'PUT',
    body: JSON.stringify({ channel, enabled }),
  });
}

/**
 * Get calendar OAuth URL for consent flow (requires auth)
 * @returns {Promise<{authUrl: string}>}
 */
function getCalendarAuthUrl() {
  return apiFetch('/auth/calendar');
}

/**
 * Disconnect calendar integration (requires auth)
 * @returns {Promise<{success: boolean}>}
 */
function disconnectCalendar() {
  return apiFetch('/auth/calendar/disconnect', {
    method: 'POST',
  });
}

/**
 * Delete user account and all related data (requires auth)
 * @returns {Promise<{success, message}>}
 */
function deleteAccount() {
  return apiFetch('/account', {
    method: 'DELETE',
  });
}

// ============ STORAGE HELPERS ============

const SESSION_KEY = 'ubc_intramurals_session';
const USER_KEY = 'ubc_intramurals_user';

/**
 * Save session and user info to localStorage
 * @param {Object} user - User object from API
 * @param {string} sessionToken - Server session token
 * @param {string} expiresAt - Session expiration timestamp
 */
function saveSession(user, sessionToken, expiresAt) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ token: sessionToken, expiresAt }));
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/**
 * Get stored session
 * @returns {{token, expiresAt}|null}
 */
function getStoredSession() {
  const stored = localStorage.getItem(SESSION_KEY);
  if (!stored) return null;

  const session = JSON.parse(stored);
  // Check if session is expired
  if (new Date(session.expiresAt) <= new Date()) {
    clearStoredSession();
    return null;
  }
  return session;
}

/**
 * Get stored user
 * @returns {{id, googleId, email, name, picture}|null}
 */
function getStoredUser() {
  if (!getStoredSession()) return null;
  const stored = localStorage.getItem(USER_KEY);
  return stored ? JSON.parse(stored) : null;
}

/**
 * Clear stored session and user (logout)
 */
function clearStoredSession() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(USER_KEY);
}

/**
 * Check if user is logged in with valid session
 * @returns {boolean}
 */
function isLoggedIn() {
  return getStoredSession() !== null;
}
