import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * Scrapes UBC Intramurals standings pages to extract:
 * - League name
 * - Tiers/Divisions
 * - Teams in each tier
 * 
 * The standings data is loaded dynamically from portal.recreation.ubc.ca
 */

/**
 * Map league slugs to activity IDs and display names for the portal API
 * Based on: https://recreation.ubc.ca/intramurals/leagues/
 */
const LEAGUE_CONFIG = {
  'nitobe-basketball': { id: 2, name: 'Nitobe Basketball' },
  'basketball': { id: 2, name: 'Nitobe Basketball' },
  'src-futsal': { id: 3, name: 'SRC Futsal' },
  'futsal': { id: 3, name: 'SRC Futsal' },
  'todd-ice-hockey': { id: 4, name: 'Todd Ice Hockey' },
  'hockey': { id: 4, name: 'Todd Ice Hockey' },
  'ice-hockey': { id: 4, name: 'Todd Ice Hockey' },
  'handley-cup-soccer': { id: 5, name: 'Handley Cup Soccer' },
  'soccer': { id: 5, name: 'Handley Cup Soccer' },
  'ultimate': { id: 6, name: 'Ultimate' },
  'cross-volleyball': { id: 7, name: 'Cross Volleyball' },
  'volleyball': { id: 7, name: 'Cross Volleyball' },
  'point-grey-cup-football': { id: 8, name: 'Point Grey Cup Flag Football' },
  'football': { id: 8, name: 'Point Grey Cup Flag Football' },
  'flag-football': { id: 8, name: 'Point Grey Cup Flag Football' },
  'badminton': { id: 13, name: 'Badminton' },
  'pickleball': { id: 14, name: 'Pickleball' },
  'roundnet-league': { id: 17, name: 'Roundnet' },
  'roundnet': { id: 17, name: 'Roundnet' },
  'dodgeball': { id: 20, name: 'Dodgeball' },
};

/**
 * Generic function to scrape a standings page
 * Works for all league types (same structure)
 */
async function scrapeStandingsPage(url) {
  try {
    console.log(`\n📥 Fetching: ${url}`);
    
    // Extract league slug from URL
    const leagueSlug = url.split('/').find((part, idx, arr) => 
      arr[idx - 1] === 'leagues'
    ) || 'unknown';
    
    // Get league config (try exact match first, then partial match)
    const config = LEAGUE_CONFIG[leagueSlug] || 
      Object.entries(LEAGUE_CONFIG).find(([key]) => leagueSlug.includes(key))?.[1];
    
    if (!config) {
      console.error(`❌ Unknown league: ${leagueSlug}`);
      return { league: 'Unknown League', url, tiers: [] };
    }
    
    const { id: activityId, name: leagueName } = config;
    
    // Determine term: Sept-Dec (months 9-12) -> term 1, Jan-Apr (months 1-4) -> term 2
    const month = new Date().getMonth() + 1;
    const term = month >= 9 ? 1 : (month <= 4 ? 2 : 1);
    
    // Fetch the actual standings data from the portal
    // The data is loaded via: portal.recreation.ubc.ca/intramurals/index.php?r=intramurals/leagues&term=X&activity=Y
    const portalUrl = `https://portal.recreation.ubc.ca/intramurals/index.php?r=intramurals/leagues&term=${term}&activity=${activityId}`;
    
    console.log(`📡 Fetching standings data from portal...`);
    const response = await axios.get(portalUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    // Parse HTML with cheerio
    const $ = cheerio.load(response.data);
    
    console.log(`\n🏀 League: ${leagueName}`);
    console.log('═'.repeat(60));
    
    const tiers = [];
    
    // The data structure uses Bootstrap accordions
    // Each tier is in a .accordion-group
    $('.accordion-group').each((groupIdx, group) => {
      const $group = $(group);
      
      // Find the tier name in the accordion heading
      const tierHeading = $group.find('.accordion-heading .accordion-toggle').text().trim();
      
      if (!tierHeading) return; // Skip if no heading found
      
      // Find the table inside the accordion-inner
      const $table = $group.find('.accordion-inner table.table');
      
      if ($table.length === 0) return; // Skip if no table found
      
      const teams = [];
      
      // Extract teams from table rows
      $table.find('tbody tr').each((rowIdx, row) => {
        const $row = $(row);
        
        // Skip header rows
        if ($row.find('th').length > 0) return;
        
        // Team name is in the second column (index 1) - after Rank
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
        tiers.push({ 
          name: tierHeading, 
          teams: teams 
        });
      }
    });
    
    // Display results
    if (tiers.length === 0) {
      console.log('⚠️  No tiers/divisions found.');
      console.log('💡 The page structure may have changed or no data is available.');
    } else {
      tiers.forEach(tier => {
        console.log(`\n📊 ${tier.name}`);
        console.log('─'.repeat(60));
        tier.teams.forEach((team, idx) => {
          console.log(`  ${idx + 1}. ${team.name}${team.url ? `\n      🔗 ${team.url}` : ''}`);
        });
      });
    }
    
    return { league: leagueName, url, tiers };
    
  } catch (error) {
    console.error(`❌ Error scraping ${url}:`, error.message);
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   URL: ${error.config?.url}`);
    }
    throw error;
  }
}

/**
 * Scrape all available leagues
 */
async function scrapeAllLeagues() {
  const urls = [
    'https://recreation.ubc.ca/intramurals/leagues/badminton/team-standings/',
    'https://recreation.ubc.ca/intramurals/leagues/cross-volleyball/term-1-standings/',
    'https://recreation.ubc.ca/intramurals/leagues/dodgeball/term-1-standings/',
    'https://recreation.ubc.ca/intramurals/leagues/handley-cup-soccer/term-1-standings/',
    'https://recreation.ubc.ca/intramurals/leagues/nitobe-basketball/term-1-standings/',
    'https://recreation.ubc.ca/intramurals/leagues/pickleball/fall-teams-standings/',
    'https://recreation.ubc.ca/intramurals/leagues/point-grey-cup-football/term-1-standings/',
    'https://recreation.ubc.ca/intramurals/leagues/roundnet-league/term-1-standings/',
    'https://recreation.ubc.ca/intramurals/leagues/src-futsal/term-1-standings/',
    'https://recreation.ubc.ca/intramurals/leagues/todd-ice-hockey/term-1-standings/',
    'https://recreation.ubc.ca/intramurals/leagues/ultimate/term-1-standings/'
  ];
  
  const results = [];
  
  for (const url of urls) {
    try {
      const result = await scrapeStandingsPage(url);
      results.push(result);
    } catch (error) {
      console.error(`Failed to scrape ${url}`);
    }
  }
  
  return results;
}

// Run the scraper if executed directly
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1])) {
  scrapeAllLeagues()
    .then(() => console.log('\n✅ Scraping complete!'))
    .catch(error => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

export { scrapeStandingsPage, scrapeAllLeagues };
