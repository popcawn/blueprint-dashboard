// Men's college hockey (D1) adapter -- ESPN mens-college-hockey scoreboards, one file per day (ESPN matched NCAA.com's
// game counts 247 vs 246 on a 10-day check; NCAA.com's own feed has no hockey before 2014 and skips 2016-17).
// Season Y = the season ending in April of Y (2026 = 2025-26). Equal scores = tie (NCAA records shootouts as ties).
// ESPN only labels NCAA-tournament games from ~2022, so the tournament is found by date: the season's last game (April)
// is the final, and every game in the 16 days before it is the 16-team NCAA tournament (conference finals end ~3 weeks
// before the final). Conference tournaments count as pre-bracket games.
import {fetchJson, cached, pool, dayList, addDays} from './lib.mjs';

const SB = 'https://site.api.espn.com/apis/site/v2/sports/hockey/mens-college-hockey/scoreboard';
export const sport = 'chk', label = "Men's college hockey", cmd = 'college-hockey-blueprint';
export const seasons = [2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026];   // 2020 tournament cancelled
export const currentSeason = today => { const [y, m] = today.split('-').map(Number); return m >= 7 ? y + 1 : y; };
export const asOfFor = (Y, mmdd) => (+mmdd.slice(0, 2) >= 7 ? `${Y - 1}-${mmdd}` : `${Y}-${mmdd}`);
// rating (2026-11-10, user: "improve from weak to fair"; chk-study.py): margins capped at 5 (was 4), 0.2 goals of home ice removed, and last season's
// final rating (halved) counts as 12 games -- walk-forward log-loss on 5,238 late-season games and title odds at Nov 10 / Dec 15 / Jan 31 / Mar 1 / the
// bracket all better in BOTH halves (2009-17, 2018-26)
export const cfg = {cap: 5, topN: 16, minFrac: 0.4, hfa: 0.2, priorW: 12};
// the prior is simply last season (Y - 1): 2019-20 had no tournament, but its games are on file, so 2020-21 starts from them

export const dec = 2;
// every-champion rule (2026-11-06 search, 17 champions 2009-26): each cutoff = the loosest champion's value, so every past champion clears all 5
export let crit = [{f: 'adjD', kind: 'rank'}, {f: 'wp', kind: 'rank'}, {f: 'off', kind: 'rank'}, {f: 'def', kind: 'rank'}, {f: 'rpi', kind: 'value'}];
export const cover = 1;
export let W = {srs: 30, rpi: 25, adjD: 15, adjO: 15, wp: 15};
export const oddsModel = 'srs';
export const alias = {'augustana': 'augustana sd', 'connecticut': 'uconn', 'umass': 'massachusetts', 'miami ohio': 'miami oh', 'union college': 'union', 'alaska fairbanks': 'alaska'};   // Kalshi name -> ESPN name (both normalised)   // backtest 2026-11-05: profile odds tied/lost to the plain rating at the bracket (LL 2.440 vs 2.429; 1st half worse)

async function day(d, today) {
  return cached(sport, 'espn_' + d, async () => {
    const j = await fetchJson(`${SB}?dates=${d.replace(/-/g, '')}&limit=300`);
    const rows = [];
    for (const e of (j?.events || [])) {
      const c = (e.competitions || [])[0];
      if (!c || (c.competitors || []).length !== 2) continue;
      const [A, B] = c.competitors;
      rows.push({id: e.id, d, a: String(A.team.id), b: String(B.team.id), an: A.team.location || A.team.displayName, bn: B.team.location || B.team.displayName,
        as: A.score == null || A.score === '' ? null : +A.score, bs: B.score == null || B.score === '' ? null : +B.score,
        aw: !!A.winner, bw: !!B.winner, fin: !!c.status?.type?.completed, round: '', head: ((c.notes || [])[0] || {}).headline || ''});
    }
    return rows;
  }, d <= addDays(today, -2));
}
export async function load(Y, today) {
  const to = `${Y}-04-16` < today ? `${Y}-04-16` : today;
  const rows = [];
  await pool(dayList(`${Y - 1}-09-25`, to), 8, async d => { rows.push(...await day(d, today)); });
  const seen = new Set(), games = rows.filter(r => !seen.has(r.id) && seen.add(r.id)).sort((x, y) => x.d.localeCompare(y.d));
  const names = new Map();
  for (const g of games) { names.set(g.a, g.an); names.set(g.b, g.bn); }
  return {Y, games, names};
}
export function tourney(S) {
  const done = S.games.filter(g => g.fin && g.as != null);
  const fin = done[done.length - 1];
  if (!fin || +fin.d.slice(5, 7) !== 4 || +fin.d.slice(0, 4) !== S.Y) return {field: new Set(), champ: null, start: null, final: null};
  const from = addDays(fin.d, -16), T = S.games.filter(g => g.d >= from);
  for (const g of T) g.round = g === fin ? 'Championship' : 'NCAA tournament';
  const start = T.map(g => g.d).sort()[0];
  return {field: new Set(T.flatMap(g => [g.a, g.b])), champ: fin.as > fin.bs ? fin.a : fin.bs > fin.as ? fin.b : (fin.aw ? fin.a : fin.b), start, final: fin};
}
