#!/usr/bin/env node
/**
 * Gridiron Board - Waiver Wire Precompute Script
 *
 * Fetches per-period line-item transactions and box scores from the worker,
 * computes "best waiver pickup" per team per season, bakes compact results
 * into history-cache.json as season.computed.bestPickup.
 *
 * Usage:
 *   node scripts/precompute-waivers.js
 *   node scripts/precompute-waivers.js --base-url http://localhost:8787
 */

const fs = require('fs');
const path = require('path');

const LEAGUE_ID = '232506';
const SEASONS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
const MIN_WEEKS_ROSTERED = 3;
const RATE_LIMIT_MS = 600;
const BASE_URL = process.argv.includes('--base-url')
  ? process.argv[process.argv.indexOf('--base-url') + 1]
  : 'https://gridiron-board.rsauce.workers.dev';
const CACHE_PATH = path.resolve(__dirname, '../public/data/history-cache.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(urlPath, headers = {}) {
  const url = `${BASE_URL}${urlPath}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} for ${url}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function log(msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }

async function fetchTransactionsForPeriod(season, period) {
  // No X-Fantasy-Filter needed: scoringPeriodId alone scopes mTransactions2 results.
  // ESPN rejects the 'topics' filter field on the league endpoint (400 error).
  const data = await fetchJson(`/api/espn-proxy?leagueId=${LEAGUE_ID}&season=${season}&scoringPeriodId=${period}`);
  return data.transactions || [];
}

async function fetchBoxScoreForPeriod(season, period) {
  const data = await fetchJson(`/api/espn-proxy?leagueId=${LEAGUE_ID}&season=${season}&scoringPeriodId=${period}&roster=1`);
  return data.schedule || [];
}

function getFinalScoringPeriod(seasonData) {
  if (seasonData.status?.finalScoringPeriod) return seasonData.status.finalScoringPeriod;
  return (seasonData.schedule || []).reduce((max, m) => Math.max(max, m.matchupPeriodId || 0), 0) || 17;
}

function parseTransactionItems(txn) {
  const results = [];
  for (const item of (txn.items || [])) {
    if (!item.playerId) continue;
    results.push({ txnId: txn.id, playerId: item.playerId, playerName: item.playerPoolEntry?.player?.fullName || `Player ${item.playerId}`, fromTeamId: item.fromTeamId ?? -1, toTeamId: item.toTeamId ?? -1, type: item.type, scoringPeriodId: txn.scoringPeriodId, txnType: txn.type, bidAmount: txn.bidAmount || 0 });
  }
  return results;
}

function findPlayerPoints(schedule, teamId, playerId) {
  return findPlayerPointsAndName(schedule, teamId, playerId).points;
}

function findPlayerPointsAndName(schedule, teamId, playerId) {
  for (const matchup of schedule) {
    for (const side of ['home', 'away']) {
      const team = matchup[side];
      if (!team || team.teamId !== teamId) continue;
      const entries = team.rosterForCurrentScoringPeriod?.entries || team.rosterForMatchupPeriod?.entries || [];
      for (const entry of entries) {
        if (entry.playerId === playerId) {
          const name = entry.playerPoolEntry?.player?.fullName || null;
          const posId = entry.playerPoolEntry?.player?.defaultPositionId ?? null;
          return { points: entry.playerPoolEntry?.appliedStatTotal ?? 0, name, posId };
        }
      }
    }
  }
  return { points: 0, name: null, posId: null };
}

async function computeSeasonWaiverPickups(season, seasonData) {
  const finalPeriod = getFinalScoringPeriod(seasonData);
  log(`  Season ${season}: ${finalPeriod} scoring periods`);
  const allTxnItems = [], seenTxnIds = new Set();

  for (let period = 1; period <= finalPeriod; period++) {
    try {
      const txns = await fetchTransactionsForPeriod(season, period);
      for (const txn of txns) { if (seenTxnIds.has(txn.id)) continue; seenTxnIds.add(txn.id); if (txn.type === 'WAIVER' || txn.type === 'FREEAGENT') allTxnItems.push(...parseTransactionItems(txn)); }
      await sleep(RATE_LIMIT_MS);
    } catch (err) { log(`    WARN txns period ${period}: ${err.message}`); await sleep(RATE_LIMIT_MS); }
  }

  const adds = allTxnItems.filter(item => item.type === 'ADD' && item.toTeamId > 0);
  log(`  Found ${adds.length} waiver/FA adds`);
  if (adds.length === 0) return null;

  const drops = allTxnItems.filter(item => item.type === 'DROP');
  for (const add of adds) {
    const playerDrops = drops.filter(d => d.playerId === add.playerId && d.fromTeamId === add.toTeamId && d.scoringPeriodId >= add.scoringPeriodId).sort((a, b) => a.scoringPeriodId - b.scoringPeriodId);
    add.endPeriod = playerDrops.length > 0 ? playerDrops[0].scoringPeriodId - 1 : finalPeriod;
    add.startPeriod = add.scoringPeriodId;
    add.weeksRostered = add.endPeriod - add.startPeriod + 1;
  }

  const qualifiedAdds = adds.filter(a => a.weeksRostered >= MIN_WEEKS_ROSTERED);
  log(`  ${qualifiedAdds.length} qualify (>= ${MIN_WEEKS_ROSTERED} wks)`);
  if (qualifiedAdds.length === 0) return null;

  const boxScoreCache = {}, neededPeriods = new Set();
  for (const add of qualifiedAdds) { for (let p = add.startPeriod; p <= add.endPeriod; p++) neededPeriods.add(p); }
  log(`  Fetching ${neededPeriods.size} box-score periods...`);
  for (const period of [...neededPeriods].sort((a, b) => a - b)) {
    try { boxScoreCache[period] = await fetchBoxScoreForPeriod(season, period); await sleep(RATE_LIMIT_MS); }
    catch (err) { log(`    WARN box period ${period}: ${err.message}`); boxScoreCache[period] = []; await sleep(RATE_LIMIT_MS); }
  }

  for (const add of qualifiedAdds) {
    let pts = 0;
    for (let p = add.startPeriod; p <= add.endPeriod; p++) {
      const result = findPlayerPointsAndName(boxScoreCache[p] || [], add.toTeamId, add.playerId);
      pts += result.points;
      if (result.name && add.playerName.startsWith('Player ')) add.playerName = result.name;
      if (result.posId !== null && !add.posId) add.posId = result.posId;
    }
    add.totalPoints = parseFloat(pts.toFixed(1));
  }

  // Filter out quarterbacks (posId 1) from best-pickup consideration
  const nonQbAdds = qualifiedAdds.filter(a => a.posId !== 1);
  log(`  ${nonQbAdds.length} non-QB adds (excluded ${qualifiedAdds.length - nonQbAdds.length} QBs)`);
  if (nonQbAdds.length === 0) return null;

  const byTeam = {};
  for (const add of nonQbAdds) { if (!byTeam[add.toTeamId] || add.totalPoints > byTeam[add.toTeamId].totalPoints) byTeam[add.toTeamId] = add; }
  const perTeam = Object.values(byTeam).sort((a, b) => b.totalPoints - a.totalPoints);
  const overall = perTeam[0];

  const teamIdToOwnerKey = {};
  for (const t of (seasonData.teams || [])) teamIdToOwnerKey[t.id] = t.primaryOwner || `team-${t.id}`;

  // Compute LEAGUE-WIDE positional finish: rank each player against ALL players
  // at that position across the full season (from box-score totals).
  const POS_NAMES = { 1:'QB', 2:'RB', 3:'WR', 4:'TE', 5:'K', 16:'DST' };
  const allPlayerTotals = {}; // playerId -> { points, posId, name }
  for (const period of Object.keys(boxScoreCache).sort((a,b)=>a-b)) {
    const schedule = boxScoreCache[period] || [];
    for (const matchup of schedule) {
      for (const side of ['home', 'away']) {
        const team = matchup[side];
        if (!team) continue;
        const entries = team.rosterForCurrentScoringPeriod?.entries || team.rosterForMatchupPeriod?.entries || [];
        for (const entry of entries) {
          const pid = entry.playerId;
          const pts = entry.playerPoolEntry?.appliedStatTotal ?? 0;
          const posId = entry.playerPoolEntry?.player?.defaultPositionId ?? null;
          if (!pid || !posId) continue;
          if (!allPlayerTotals[pid]) allPlayerTotals[pid] = { points: 0, posId, name: entry.playerPoolEntry?.player?.fullName || null };
          allPlayerTotals[pid].points += pts;
        }
      }
    }
  }
  // Group all players by position, sort by total points
  const leagueByPos = {};
  Object.entries(allPlayerTotals).forEach(([pid, data]) => {
    if (!leagueByPos[data.posId]) leagueByPos[data.posId] = [];
    leagueByPos[data.posId].push({ playerId: +pid, points: data.points });
  });
  Object.values(leagueByPos).forEach(arr => arr.sort((a, b) => b.points - a.points));
  // Assign posLabel to each pickup based on their league-wide rank at position
  nonQbAdds.forEach(a => {
    if (a.posId && leagueByPos[a.posId]) {
      const rank = leagueByPos[a.posId].findIndex(p => p.playerId === a.playerId) + 1;
      a.posLabel = rank > 0 ? (POS_NAMES[a.posId] || 'POS') + rank : null;
    }
  });

  const fmt = (add) => ({ playerId: add.playerId, playerName: add.playerName, ownerKey: teamIdToOwnerKey[add.toTeamId] || `team-${add.toTeamId}`, teamId: add.toTeamId, weekAdded: add.startPeriod, weekDropped: add.endPeriod < finalPeriod ? add.endPeriod + 1 : null, totalPoints: add.totalPoints, weeksRostered: add.weeksRostered, bidAmount: add.bidAmount, posId: add.posId || null, posLabel: add.posLabel || null });
  return { overall: fmt(overall), perTeam: perTeam.map(fmt) };
}

async function main() {
  log('=== Gridiron Board Waiver Wire Precompute ===');
  log(`Base URL: ${BASE_URL}`);
  if (!fs.existsSync(CACHE_PATH)) { console.error('ERROR: cache not found at', CACHE_PATH); process.exit(1); }
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
  log(`Cache seasons: ${Object.keys(cache).join(', ')}`);

  for (const season of SEASONS) {
    const k = String(season);
    if (!cache[k]) { log(`${season}: not in cache`); continue; }
    log(`\n${season}...`);
    try {
      const result = await computeSeasonWaiverPickups(season, cache[k]);
      if (result) { if (!cache[k].computed) cache[k].computed = {}; cache[k].computed.bestPickup = result; log(`  OK ${result.overall.playerName} (${result.overall.totalPoints} pts, Wk ${result.overall.weekAdded})`); }
      else log(`  SKIP no qualifying pickups`);
    } catch (err) { log(`  ERROR: ${err.message}`); }
  }

  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache), 'utf-8');
  log(`\nDone!`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
