import axios from 'axios';
import * as cheerio from 'cheerio';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

/**
 * Scrapes UBC Intramurals standings pages to extract:
 * - League name
 * - Tiers/Divisions
 * - Teams in each tier
 *
 * Stores data in SQLite database.
 */

/**
 * Map league slugs to activity IDs and display names for the portal API
 */
const LEAGUE_CONFIG = {
  'nitobe-basketball': { id: 2, name: 'Nitobe Basketball' },
  'src-futsal': { id: 3, name: 'SRC Futsal' },
  'todd-ice-hockey': { id: 4, name: 'Todd Ice Hockey' },
  'handley-cup-soccer': { id: 5, name: 'Handley Cup Soccer' },
  'ultimate': { id: 6, name: 'Ultimate' },
  'cross-volleyball': { id: 7, name: 'Cross Volleyball' },
  'point-grey-cup-football': { id: 8, name: 'Point Grey Cup Flag Football' },
  'badminton': { id: 13, name: 'Badminton' },
  'pickleball': { id: 14, name: 'Pickleball' },
  'roundnet-league': { id: 17, name: 'Roundnet' },
  'dodgeball': { id: 20, name: 'Dodgeball' },
};

/**
 * Get current academic year and term
 * Academic year: Sept 2025 - Aug 2026 = "2025-2026"
 * Term 1: Sept-Dec, Term 2: Jan-Apr
 */
function getCurrentYearAndTerm() {
  // Force Term 1 for now since Term 2 has no data yet
  return { year: '2025-2026', term: '1' };
}

/**
 * Scrape standings for a single league and store in database
 */
async function scrapeAndStoreLeague(db, activityId, leagueName, year, term) {
  try {
    // Determine API term parameter (1 or 2, summer uses 2)
    const apiTerm = term === 'summer' ? 2 : parseInt(term);

    const portalUrl = `https://portal.recreation.ubc.ca/intramurals/index.php?r=intramurals/leagues&term=${apiTerm}&activity=${activityId}`;

    console.log(`\n📥 Fetching: ${leagueName}`);
    console.log(`   URL: ${portalUrl}`);

    const response = await axios.get(portalUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const $ = cheerio.load(response.data);

    // Insert or get league
    let league = await db.get(
      'SELECT id FROM leagues WHERE name = ? AND year = ? AND term = ?',
      [leagueName, year, term]
    );

    if (!league) {
      const result = await db.run(
        'INSERT INTO leagues (name, year, term) VALUES (?, ?, ?)',
        [leagueName, year, term]
      );
      league = { id: result.lastID };
      console.log(`   ✓ Created league: ${leagueName} (${year} Term ${term})`);
    } else {
      console.log(`   ✓ Found existing league: ${leagueName}`);
    }

    const leagueId = league.id;

    // First pass: collect all tiers and teams from HTML
    const tiersData = [];

    $('.accordion-group').each((groupIdx, group) => {
      const $group = $(group);
      const tierName = $group.find('.accordion-heading .accordion-toggle').text().trim();

      if (!tierName) return;

      const $table = $group.find('.accordion-inner table.table');
      if ($table.length === 0) return;

      const teams = [];

      $table.find('tbody tr').each((rowIdx, row) => {
        const $row = $(row);
        if ($row.find('th').length > 0) return; // Skip header rows

        const teamCell = $row.find('td').eq(1);
        const teamName = teamCell.text().trim();

        if (teamName) {
          const href = teamCell.find('a').attr('href');
          const teamUrl = href
            ? `https://portal.recreation.ubc.ca/intramurals/index.php${href}`
            : null;
          teams.push({ name: teamName, url: teamUrl });
        }
      });

      if (teams.length > 0) {
        tiersData.push({ tierName, teams });
      }
    });

    // Second pass: store tiers and teams in database (properly awaited)
    let tierCount = 0;
    let teamCount = 0;

    for (const tierData of tiersData) {
      // Insert or get tier
      let tier = await db.get(
        'SELECT id FROM tiers WHERE name = ? AND league_id = ?',
        [tierData.tierName, leagueId]
      );

      if (!tier) {
        const result = await db.run(
          'INSERT INTO tiers (name, league_id) VALUES (?, ?)',
          [tierData.tierName, leagueId]
        );
        tier = { id: result.lastID };
      }

      const tierId = tier.id;
      tierCount++;

      // Insert or update teams
      for (const team of tierData.teams) {
        const existingTeam = await db.get(
          'SELECT id, url FROM teams WHERE name = ? AND tier_id = ?',
          [team.name, tierId]
        );

        if (!existingTeam) {
          await db.run(
            'INSERT INTO teams (name, url, tier_id) VALUES (?, ?, ?)',
            [team.name, team.url || '', tierId]
          );
        } else if (team.url && existingTeam.url !== team.url) {
          // Update URL if it changed
          await db.run(
            'UPDATE teams SET url = ? WHERE id = ?',
            [team.url, existingTeam.id]
          );
        }
        teamCount++;
      }
    }

    console.log(`   📊 ${tierCount} tiers, ${teamCount} teams`);

    return { success: true, tiers: tierCount, teams: teamCount };

  } catch (error) {
    console.error(`❌ Error scraping ${leagueName}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Scrape all leagues and store in database
 */
async function scrapeAllLeagues() {
  const db = await open({
    filename: './intramurals.db',
    driver: sqlite3.Database
  });

  // Enable foreign keys
  await db.exec('PRAGMA foreign_keys = ON');

  const { year, term } = getCurrentYearAndTerm();
  console.log(`\n🏀 UBC Intramurals Scraper`);
  console.log(`📅 Academic Year: ${year}, Term: ${term}`);
  console.log('═'.repeat(60));

  const results = {
    success: 0,
    failed: 0,
    totalTiers: 0,
    totalTeams: 0
  };

  // Get unique leagues (avoid duplicates from alias mappings)
  const uniqueLeagues = new Map();
  for (const [slug, config] of Object.entries(LEAGUE_CONFIG)) {
    if (!uniqueLeagues.has(config.id)) {
      uniqueLeagues.set(config.id, config);
    }
  }

  for (const [activityId, config] of uniqueLeagues) {
    const result = await scrapeAndStoreLeague(db, activityId, config.name, year, term);

    if (result.success) {
      results.success++;
      results.totalTiers += result.tiers;
      results.totalTeams += result.teams;
    } else {
      results.failed++;
    }

    // Rate limiting: 500ms between requests
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  await db.close();

  console.log('\n' + '═'.repeat(60));
  console.log(`✅ Scraping complete!`);
  console.log(`   Leagues: ${results.success} succeeded, ${results.failed} failed`);
  console.log(`   Tiers: ${results.totalTiers}`);
  console.log(`   Teams: ${results.totalTeams}`);

  return results;
}

/**
 * Scrape a single league by name or activity ID
 */
async function scrapeLeague(identifier) {
  const db = await open({
    filename: './intramurals.db',
    driver: sqlite3.Database
  });

  await db.exec('PRAGMA foreign_keys = ON');

  // Find league config
  let config;
  if (typeof identifier === 'number') {
    config = Object.values(LEAGUE_CONFIG).find(c => c.id === identifier);
  } else {
    config = LEAGUE_CONFIG[identifier.toLowerCase()];
  }

  if (!config) {
    console.error(`❌ Unknown league: ${identifier}`);
    await db.close();
    return null;
  }

  const { year, term } = getCurrentYearAndTerm();
  const result = await scrapeAndStoreLeague(db, config.id, config.name, year, term);

  await db.close();
  return result;
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1])) {
  const leagueArg = process.argv[2];

  if (leagueArg) {
    scrapeLeague(leagueArg)
      .catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
      });
  } else {
    scrapeAllLeagues()
      .catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
      });
  }
}

export { scrapeAllLeagues, scrapeLeague, getCurrentYearAndTerm, LEAGUE_CONFIG };
