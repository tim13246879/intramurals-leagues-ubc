import axios from 'axios';
import * as cheerio from 'cheerio';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import https from 'https';

// HTTPS agent that ignores certificate errors (needed for Railway environment)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Use /data volume in production (Railway), local file in development
const DB_PATH = process.env.NODE_ENV === 'production'
  ? '/data/intramurals.db'
  : './intramurals.db';

/**
 * Scrapes team pages to extract:
 * - Games (schedule, results, scores)
 * - Players (roster)
 * 
 * Stores them in the database
 */

/**
 * Scrape a single team page to extract games and players
 */
async function scrapeTeamPage(teamUrl, teamId, tierId) {
  try {
    console.log(`\n📥 Fetching team page: ${teamUrl}`);
    
    const response = await axios.get(teamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      httpsAgent
    });
    
    const $ = cheerio.load(response.data);
    
    // Extract team name from the page (usually in an h1 or h2)
    const teamName = $('h1, h2').first().text().trim().split('(')[0].trim();
    
    console.log(`🏀 Team: ${teamName}`);
    
    const games = [];
    const players = [];
    
    // Extract games from the schedule table
    // Look for table with headers: Date, Time, Location, Match-up, Result, Total Score, Information
    $('table').each((tableIdx, table) => {
      const $table = $(table);
      const headers = [];
      
      // Get headers
      $table.find('thead tr th, tbody tr:first-child th').each((idx, th) => {
        headers.push($(th).text().trim());
      });
      
      // Check if this is the schedule table (has "Match-up" or "Date" column)
      const isScheduleTable = headers.some(h => 
        h.toLowerCase().includes('match-up') || 
        h.toLowerCase().includes('date') ||
        h.toLowerCase().includes('matchup')
      );
      
      if (!isScheduleTable) return;
      
      // Find date, time, location, match-up, result, score columns
      const dateIdx = headers.findIndex(h => h.toLowerCase().includes('date'));
      const timeIdx = headers.findIndex(h => h.toLowerCase().includes('time'));
      const locationIdx = headers.findIndex(h => h.toLowerCase().includes('location'));
      const matchupIdx = headers.findIndex(h => 
        h.toLowerCase().includes('match-up') || 
        h.toLowerCase().includes('matchup')
      );
      const resultIdx = headers.findIndex(h => h.toLowerCase().includes('result'));
      const scoreIdx = headers.findIndex(h => 
        h.toLowerCase().includes('score') || 
        h.toLowerCase().includes('total')
      );
      
      // Extract games from table rows
      $table.find('tbody tr').each((rowIdx, row) => {
        const $row = $(row);
        const cells = $row.find('td');
        
        if (cells.length === 0) return; // Skip header rows
        
        const date = dateIdx >= 0 ? cells.eq(dateIdx).text().trim() : '';
        const time = timeIdx >= 0 ? cells.eq(timeIdx).text().trim() : '';
        const location = locationIdx >= 0 ? cells.eq(locationIdx).text().trim() : '';
        const matchup = matchupIdx >= 0 ? cells.eq(matchupIdx).text().trim() : '';
        const result = resultIdx >= 0 ? cells.eq(resultIdx).text().trim() : '';
        const score = scoreIdx >= 0 ? cells.eq(scoreIdx).text().trim() : '';
        
        // Skip if no date or matchup
        if (!date || !matchup) return;
        
        // Parse date and time into datetime first
        // Date format: MM/DD/YYYY (e.g., 09/21/2025)
        // Time format: 12-hour format like 4:30PM or 4:30 PM
        let datetime = null;
        if (date && time) {
          try {
            const dateStr = date.trim();
            const timeStr = time.trim();
            
            // Parse date (MM/DD/YYYY format)
            let parsedDate;
            if (dateStr.includes('/')) {
              const parts = dateStr.split('/');
              if (parts.length === 3) {
                const [month, day, year] = parts;
                // Create date in YYYY-MM-DD format (ISO format)
                parsedDate = new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
              } else {
                parsedDate = new Date(dateStr);
              }
            } else if (dateStr.includes('-')) {
              parsedDate = new Date(dateStr);
            } else {
              parsedDate = new Date(dateStr);
            }
            
            // Parse time (12-hour format: 4:30PM, 4:30 PM, 12:00AM, etc.)
            let hours, minutes;
            // Match time with optional space before AM/PM (handles both "4:30PM" and "4:30 PM")
            const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
            if (timeMatch) {
              hours = parseInt(timeMatch[1]);
              minutes = parseInt(timeMatch[2]);
              const period = timeMatch[3].toUpperCase();
              
              // Convert to 24-hour format
              if (period === 'PM' && hours !== 12) {
                hours += 12;
              } else if (period === 'AM' && hours === 12) {
                hours = 0;
              }
            } else {
              // Fallback: try 24-hour format
              const timeMatch24 = timeStr.match(/^(\d{1,2}):(\d{2})$/);
              if (timeMatch24) {
                hours = parseInt(timeMatch24[1]);
                minutes = parseInt(timeMatch24[2]);
              }
            }
            
            if (parsedDate && !isNaN(parsedDate.getTime()) && hours !== undefined) {
              parsedDate.setHours(hours, minutes || 0, 0, 0);
              datetime = parsedDate.toISOString();
            }
          } catch (e) {
            console.warn(`⚠️  Could not parse datetime: ${date} ${time}`, e.message);
          }
        }
        
        // Parse matchup to extract team names
        // Format can be: "Team A vs. Team B", "Team A _vs._ Team B", or HTML with bold/links
        // Get text content from the matchup cell (handles HTML)
        const matchupText = $row.find('td').eq(matchupIdx).text().trim();
        
        // Try to match various formats
        const matchupMatch = matchupText.match(/(.+?)\s+(?:vs\.?|_vs\.?_)\s+(.+)/i);
        
        let team1Name, team2Name;
        
        if (!matchupMatch) {
          // Try alternative: look for bold tags or links
          const $matchupCell = $row.find('td').eq(matchupIdx);
          const team1El = $matchupCell.find('strong').first();
          const team2El = $matchupCell.find('strong').last();
          
          if (team1El.length && team2El.length) {
            team1Name = team1El.text().trim();
            team2Name = team2El.text().trim();
          } else {
            return; // Skip if we can't parse
          }
        } else {
          team1Name = matchupMatch[1].trim();
          team2Name = matchupMatch[2].trim();
        }
        
        // Clean up team names (remove any remaining markdown/HTML artifacts)
        team1Name = team1Name.replace(/\*\*/g, '').replace(/<[^>]*>/g, '').trim();
        team2Name = team2Name.replace(/\*\*/g, '').replace(/<[^>]*>/g, '').trim();
        
        if (!team1Name || !team2Name) return; // Skip if we don't have both team names
        
        games.push({
          datetime: datetime || `${date} ${time}`,
          location: location || '',
          team1Name,
          team2Name,
          result,
          score
        });
      });
    });
    
    // Extract players from the roster table
    // Look for table with "Player" column
    $('table').each((tableIdx, table) => {
      const $table = $(table);
      const headers = [];
      
      // Get headers
      $table.find('thead tr th, tbody tr:first-child th').each((idx, th) => {
        headers.push($(th).text().trim());
      });
      
      // Check if this is the roster table (has "Player" column)
      const isRosterTable = headers.some(h => 
        h.toLowerCase().includes('player')
      );
      
      if (!isRosterTable) return;
      
      const playerIdx = headers.findIndex(h => h.toLowerCase().includes('player'));
      
      // Extract players from table rows
      $table.find('tbody tr').each((rowIdx, row) => {
        const $row = $(row);
        const cells = $row.find('td');
        
        if (cells.length === 0) return; // Skip header rows
        
        let playerName = playerIdx >= 0 ? cells.eq(playerIdx).text().trim() : '';
        // Normalize whitespace (collapse multiple spaces to single space)
        playerName = playerName.replace(/\s+/g, ' ');

        if (playerName) {
          players.push(playerName);
        }
      });
    });
    
    console.log(`  📊 Found ${games.length} games`);
    console.log(`  👥 Found ${players.length} players`);
    
    return { games, players, teamName };
    
  } catch (error) {
    console.error(`❌ Error scraping team page ${teamUrl}:`, error.message);
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
    }
    throw error;
  }
}

/**
 * Store games and players in the database
 * Returns { newGames: number, existingGames: number, newPlayers: number }
 */
async function storeTeamData(db, teamId, tierId, games, players) {
  const stats = { newGames: 0, existingGames: 0, newPlayers: 0 };

  // Store players
  for (let playerName of players) {
    if (!playerName) continue;

    // Normalize whitespace (collapse multiple spaces, trim)
    playerName = playerName.replace(/\s+/g, ' ').trim();

    // Insert or get player
    let playerResult = await db.get('SELECT id FROM players WHERE name = ?', [playerName]);

    if (!playerResult) {
      const insertResult = await db.run('INSERT INTO players (name) VALUES (?)', [playerName]);
      const playerId = insertResult.lastID;
      stats.newPlayers++;

      // Link player to team
      await db.run(
        'INSERT OR IGNORE INTO team_players (team_id, player_id) VALUES (?, ?)',
        [teamId, playerId]
      );
    } else {
      const playerId = playerResult.id;

      // Link player to team
      await db.run(
        'INSERT OR IGNORE INTO team_players (team_id, player_id) VALUES (?, ?)',
        [teamId, playerId]
      );
    }
  }

  // Store games
  const newGameIds = [];
  for (const game of games) {
    // Find team1 and team2 IDs by name within the same tier
    const team1Result = await db.get(
      `SELECT t.id FROM teams t
       JOIN tiers ti ON t.tier_id = ti.id
       WHERE t.name = ? AND ti.id = ?`,
      [game.team1Name, tierId]
    );

    const team2Result = await db.get(
      `SELECT t.id FROM teams t
       JOIN tiers ti ON t.tier_id = ti.id
       WHERE t.name = ? AND ti.id = ?`,
      [game.team2Name, tierId]
    );

    // Skip if we can't find both teams
    if (!team1Result || !team2Result) {
      console.warn(`⚠️  Skipping game: Could not find teams "${game.team1Name}" or "${game.team2Name}"`);
      continue;
    }

    const team1Id = team1Result.id;
    const team2Id = team2Result.id;

    // Skip bye games or placeholders where team plays itself
    if (team1Id === team2Id) {
      continue;
    }

    // Check if game already exists (by datetime, teams, and tier)
    const existingGame = await db.get(
      `SELECT id FROM games
       WHERE datetime = ? AND team1_id = ? AND team2_id = ? AND tier_id = ?`,
      [game.datetime, team1Id, team2Id, tierId]
    );

    if (!existingGame) {
      const result = await db.run(
        `INSERT INTO games (datetime, location, team1_id, team2_id, tier_id)
         VALUES (?, ?, ?, ?, ?)`,
        [game.datetime, game.location, team1Id, team2Id, tierId]
      );
      stats.newGames++;
      newGameIds.push(result.lastID);
    } else {
      stats.existingGames++;
    }
  }

  return { ...stats, newGameIds };
}

/**
 * Scrape all teams from the database with parallel requests
 * Returns { teamsScraped, newGames, newPlayers, newGameIds }
 */
async function scrapeAllTeams(concurrency = 5) {
  const db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  const totals = {
    teamsScraped: 0,
    teamsFailed: 0,
    newGames: 0,
    existingGames: 0,
    newPlayers: 0,
    newGameIds: []
  };

  try {
    // Get all teams with their URLs and tier IDs
    const teams = await db.all(
      `SELECT t.id, t.name, t.url, t.tier_id
       FROM teams t
       WHERE t.url IS NOT NULL AND t.url != ''`
    );

    console.log(`\n📋 UBC Intramurals Games Scraper`);
    console.log(`📊 Found ${teams.length} teams to scrape (${concurrency} concurrent)`);
    console.log('═'.repeat(60));

    // Process teams in parallel batches
    for (let i = 0; i < teams.length; i += concurrency) {
      const batch = teams.slice(i, i + concurrency);

      const results = await Promise.allSettled(
        batch.map(async (team) => {
          const { games, players } = await scrapeTeamPage(
            team.url,
            team.id,
            team.tier_id
          );
          return { team, games, players };
        })
      );

      // Process results and store in DB (sequential to avoid DB locks)
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { team, games, players } = result.value;
          try {
            const stats = await storeTeamData(db, team.id, team.tier_id, games, players);
            totals.teamsScraped++;
            totals.newGames += stats.newGames;
            totals.existingGames += stats.existingGames;
            totals.newPlayers += stats.newPlayers;
            totals.newGameIds.push(...stats.newGameIds);

            const newIndicator = stats.newGames > 0 ? ` (${stats.newGames} NEW)` : '';
            console.log(`✅ ${team.name}: ${games.length} games${newIndicator}`);
          } catch (error) {
            console.error(`❌ Failed to store ${team.name}:`, error.message);
            totals.teamsFailed++;
          }
        } else {
          const team = batch[results.indexOf(result)];
          console.error(`❌ Failed to scrape team ${team.name}:`, result.reason?.message);
          totals.teamsFailed++;
        }
      }

      // Small delay between batches to be polite
      if (i + concurrency < teams.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    console.log('\n' + '═'.repeat(60));
    console.log(`✅ Scraping complete!`);
    console.log(`   Teams: ${totals.teamsScraped} succeeded, ${totals.teamsFailed} failed`);
    console.log(`   Games: ${totals.newGames} new, ${totals.existingGames} existing`);
    console.log(`   Players: ${totals.newPlayers} new`);

    if (totals.newGames > 0) {
      console.log(`\n🔔 ${totals.newGames} new games detected - ready for notifications`);
    }

    // Output JSON for scheduler to parse
    console.log(JSON.stringify({ newGameIds: totals.newGameIds }));

    return totals;

  } finally {
    await db.close();
  }
}

/**
 * Scrape a specific team by URL
 */
async function scrapeTeam(teamUrl) {
  const db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });
  
  try {
    // Find team in database
    const team = await db.get(
      `SELECT t.id, t.name, t.url, t.tier_id 
       FROM teams t 
       WHERE t.url = ?`,
      [teamUrl]
    );
    
    if (!team) {
      console.error(`❌ Team not found in database: ${teamUrl}`);
      return;
    }
    
    const { games, players } = await scrapeTeamPage(
      team.url,
      team.id,
      team.tier_id
    );
    
    await storeTeamData(db, team.id, team.tier_id, games, players);
    
    console.log(`✅ Stored data for ${team.name}`);
    
  } finally {
    await db.close();
  }
}

// Run the scraper if executed directly
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1])) {
  const teamUrl = process.argv[2];
  
  if (teamUrl) {
    scrapeTeam(teamUrl)
      .then(() => console.log('\n✅ Scraping complete!'))
      .catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
      });
  } else {
    scrapeAllTeams()
      .then(() => console.log('\n✅ Scraping complete!'))
      .catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
      });
  }
}

export { scrapeTeamPage, scrapeAllTeams, scrapeTeam, storeTeamData };

