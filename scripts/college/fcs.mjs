// FCS football adapter -- ESPN college-football scoreboards, FCS = groups=81 (the same feed family as the CFB blueprint).
// Playoff games are flagged by their headline ("FCS Championship - First Round" ... "FCS Championship"); rounds 1-3
// sit in regular-season weeks 14-16, semis + final in seasontype 3. FBS opponents are pooled into one 'FBS' team and
// non-D1 opponents into 'ND' for the rating math.
import fs from 'node:fs';
import {fetchJson, cached, cacheFile, pool, addDays, tourney as baseTourney} from './lib.mjs';

const SB = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';
export const sport = 'fcs', label = 'FCS football', cmd = 'fcs-blueprint';
export const seasons = [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025];   // 2020 = spring-2021 COVID season, skipped
export const currentSeason = today => { const [y, m] = today.split('-').map(Number); return m >= 7 ? y : y - 1; };
export const asOfFor = (Y, mmdd) => `${Y}-${mmdd}`;
export const cfg = {cap: 28, topN: 24, minFrac: 0.4, priorAdj: 4};   // priorAdj: last season as a 4-game prior on adj offense/defense, in season only (lib.mjs board)
export const prevSeason = Y => Y === 2021 ? 2019 : Y - 1;   // 2020 (the spring-2021 COVID season) is skipped
// every-champion rule (2026-11-06 search, 15 champions 2010-25): each cutoff = the loosest champion's value, so every past champion clears all 5
export let crit = [{f: 'adjO', kind: 'rank'}, {f: 'wp', kind: 'rank'}, {f: 'def', kind: 'rank'}, {f: 'rpi', kind: 'value'}, {f: 'wpTop', kind: 'value'}];
export const cover = 1;
export let W = {adjO: 40, adjD: 60};   // 2026-11-07 backtest: beat {srs30 adjD20 rpi20 adjO15 wp15} in every half at bracket/Oct25/Nov1/Nov8 (325 playoff games + 15 champs, LOSO)
export const alias = {'penn': 'pennsylvania', 'central connecticut state': 'central connecticut', 'university at albany': 'ualbany', 'long island university': 'liu'};   // Kalshi name -> ESPN name (both normalised)
const PLAYOFF = /(FCS|DIVISION I) (FOOTBALL )?CHAMPIONSHIP|FCS PLAYOFF/i;   // 'FCS Championship - First Round', 'NCAA DIVISION I FOOTBALL CHAMPIONSHIP - SECOND ROUND', 'NCAA FCS FOOTBALL CHAMPIONSHIP ...'
export const isFinal = g => PLAYOFF.test(g.round) && !/round|quarter|semi/i.test(g.round);
const CHAMP_FALLBACK = {2016: 'James Madison', 2017: 'North Dakota State'};   // ESPN is missing the 2016 semis + final

function parse(j) {
  const rows = [];
  for (const e of (j?.events || [])) {
    const c = (e.competitions || [])[0];
    if (!c || !e.date || (c.competitors || []).length !== 2) continue;
    const [A, B] = c.competitors, head = ((c.notes || [])[0] || {}).headline || '';
    rows.push({id: e.id, d: (e.date || '').slice(0, 10), a: String(A.team.id), b: String(B.team.id),
      an: A.team.location || A.team.displayName, bn: B.team.location || B.team.displayName,
      as: A.score == null || A.score === '' ? null : +A.score, bs: B.score == null || B.score === '' ? null : +B.score,
      aw: !!A.winner, bw: !!B.winner, fin: !!c.status?.type?.completed, round: PLAYOFF.test(head) ? head : '', head});
  }
  return rows;
}
async function week(Y, st, w, today) {
  const f = cacheFile(sport, `sb_${Y}_${st}_${w ?? 'all'}`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const rows = parse(await fetchJson(`${SB}?dates=${Y}&seasontype=${st}${w != null ? '&week=' + w : ''}&groups=81&limit=400`));
  const done = Y < currentSeason(today) || (rows.length && rows.every(r => r.fin && r.d <= addDays(today, -2)));
  if (done) fs.writeFileSync(f, JSON.stringify(rows));
  return rows;
}
async function fbsIds(Y) {
  return new Set(await cached(sport, 'fbs_' + Y, async () => {
    const j = await fetchJson(`https://site.web.api.espn.com/apis/common/v3/sports/football/college-football/statistics/byteam?region=us&lang=en&contentorigin=espn&season=${Y}&seasontype=2&limit=300`);
    let ids = (j?.teams || []).map(t => String(t.team.id));
    if (ids.length < 100) {
      const cnt = new Map();
      for (const w of [3, 6, 9]) {
        const k = await fetchJson(`${SB}?dates=${Y}&seasontype=2&week=${w}&groups=80&limit=400`);
        for (const e of (k?.events || [])) for (const c of e.competitions[0].competitors) cnt.set(String(c.team.id), (cnt.get(String(c.team.id)) || 0) + 1);
      }
      ids = [...cnt].filter(([, n]) => n >= 2).map(([id]) => id);
    }
    return ids;
  }));
}
export async function load(Y, today) {
  const jobs = [...Array.from({length: 17}, (_, i) => [2, i + 1]), [3, null], [3, 1], [3, 2], [3, 3]];
  const rows = [];
  await pool(jobs, 6, async ([st, w]) => { rows.push(...await week(Y, st, w, today)); });
  const seen = new Set(), games = rows.filter(r => r.d >= `${Y}-08-01` && r.d <= `${Y + 1}-01-31` && !seen.has(r.id) && seen.add(r.id));
  const names = new Map();
  for (const g of games) { names.set(g.a, g.an); names.set(g.b, g.bn); }
  const fbs = await fbsIds(Y);
  return {Y, games, names, exclude: fbs, groupOf: id => fbs.has(id) ? 'FBS' : 'ND'};
}

// ESPN leaves some first rounds unlabeled (2011, 2016, 2017): the first round is then the unlabeled games a week before the
// first labeled round that involve a team from that round (first-round winners; seeds had byes).
export function tourney(S) {
  if (!S.games.some(g => g.round && /first round/i.test(g.round))) {
    const lab = S.games.filter(g => g.round).map(g => g.d).sort()[0];
    if (lab) {
      const r2 = new Set(S.games.filter(g => g.round && g.d < addDays(lab, 3)).flatMap(g => [g.a, g.b]));
      for (const g of S.games) if (!g.round && g.d >= addDays(lab, -9) && g.d <= addDays(lab, -5) && (r2.has(g.a) || r2.has(g.b))) g.round = 'FIRST ROUND (inferred)';
    }
  }
  const tr = baseTourney(S, isFinal);
  if (!tr.champ && CHAMP_FALLBACK[S.Y]) tr.champ = [...S.names].find(([, n]) => n === CHAMP_FALLBACK[S.Y])?.[0] || null;
  return tr;
}
