// European hockey title engine (built 2026-11-24, same design as nll.mjs / rugby.mjs): Liiga (Finland), SHL (Sweden), National League (Switzerland).
// One file, per-league config (LG below). Season Y = the year it ends (2026-27 = 2027).
// Data (all public JSON the leagues' own sites call; polite: one request at a time, cached in %TEMP%\pro_bp_cache\<lg>, finished seasons never re-fetched,
// the live season every 6 hours):
//   liiga   liiga.fi/api/v2/games?tournament=runkosarja|playoffs&season=Y (every game since 2000 with goals + finishedType = regulation / OT / shootout)
//   shl     www.shl.se/api/sports-v2/game-schedule?seasonUuid&seriesUuid&gameTypeUuid (uuids from .../season-series-game-types-filter, the list the
//           shl.se schedule page uses; every game since 1998-99, overtime/shootout flags). 2011-12 is short 63 regular-season games in the feed.
//   swissnl www.nationalleague.ch/api/games?season=Y (+ /api/games/playoffs for the playoff teams). The feed only has 2016-17 and 2018-19 on;
//           2015-16 and 2017-18 return nothing, and the old SIHF data API is closed to the public -> 8 title seasons only (2017, 2019, 2021-26).
// Model: team ratings from goal MARGINS (recency-weighted ridge regression, last two seasons + this one) + one home edge; P(home win) = Phi(margin/sigma);
// OT/shootout games count as one-goal margins. Season sim: remaining regular-season games (OT/SO share from the league's own history: 2 pts OT win,
// 1 pt OT loss) -> standings (points per game, then the league's tiebreak) -> that season's playoff format (FMT, verified with `check`).
//   node euhockey.mjs <liiga|shl|swissnl> check | backtest | dump | index | [live] [--log] [--book "Tappara:+300,..."] [--export file] [--sims N]
// VERDICTS (backtest 2026-11-24, title log-loss at the playoff start vs equal odds AND seed history, both halves):
//   liiga 🟡 fair (22 seasons 2004-26) · swissnl 🟡 fair on a thin sample (8 seasons) · shl ❌ (24 seasons 2000-26: beat both in the 2nd half, but in
//   2000-13 the top seed won 10/12 and seed history (0.947) beat the model (1.240); at 75% of the season it beat both baselines in both halves)
// NO KALSHI / Polymarket. No odds feed carries these titles (no Odds API credits used) -> prices only from the user's DraftKings/FanDuel screenshot (--book).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {rankRows, cutoffs as tierCuts, score as tierScore, cutLabel} from './tiers.mjs';

const [lg, mode0 = 'live', ...rest] = process.argv.slice(2);
const mode = mode0.startsWith('--') ? 'live' : mode0; if (mode0.startsWith('--')) rest.unshift(mode0);
const arg = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
const today = process.env.BP_TODAY || new Date().toLocaleDateString('en-CA');
const seasonOf = d => +d.slice(0, 4) + (+d.slice(5, 7) >= 7 ? 1 : 0);   // seasons run Aug/Sep -> Apr/May
const CURY = seasonOf(today);
const strip = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// ---------- playoff formats ----------
// pre: pre-playoff pairs by seed + series type · playin: Swiss play-in (7v8 -> 7th; loser v winner of 9v10 -> 8th; 2-game aggregate series)
// r: series type per round after that (QF, SF, F) · reseed: each round the best remaining seed meets the worst (else fixed bracket 1/8-4/5, 2/7-3/6)
// series: 'bo7' | 'bo5' | 'bo3' (higher seed hosts games 1, 3, 5, 7) · 'agg2' = two games, total goals, the higher seed hosts the 2nd (tie -> OT there)
const B7 = ['bo7', 'bo7', 'bo7'];
const LG = {
  liiga: {
    label: 'Liiga', title: 'Liiga title (Kanada-malja)', first: 2004, from: 2002, nodata: [],
    // 2004-24: top 6 + pre-playoffs 7v10, 8v9 best-of-3 · 2004-07 semis + final best-of-5 · 2021 (COVID): 2-game aggregate pre-playoffs, every round best-of-5
    // · 2025 on: top 4 + pre-playoffs 5v12, 6v11, 7v10, 8v9 best-of-5. 2026-27 (17 teams with Jokerit back): ASSUMED unchanged from 2025-26.
    fmt: Y => Y >= 2025 ? {pre: {pairs: [[5, 12], [6, 11], [7, 10], [8, 9]], k: 'bo5'}, top: 4, r: B7, reseed: true, txt: 'top 4 + pre-playoffs 5v12 6v11 7v10 8v9 (best of 5) · re-seeded best-of-7 rounds'}
      : Y === 2021 ? {pre: {pairs: [[7, 10], [8, 9]], k: 'agg2'}, top: 6, r: ['bo5', 'bo5', 'bo5'], reseed: true, txt: 'top 6 + 2-game pre-playoffs 7v10 8v9 · re-seeded best-of-5 rounds (COVID season)'}
      : Y === 2016 || Y === 2017 ? {pre: {pairs: [[7, 9], [8, 10]], k: 'bo3'}, top: 6, r: B7, reseed: true, txt: 'top 6 + pre-playoffs (7th chose its opponent: 7v9 8v10 both years) · re-seeded best-of-7 rounds'}
      : Y >= 2008 ? {pre: {pairs: [[7, 10], [8, 9]], k: 'bo3'}, top: 6, r: B7, reseed: true, txt: 'top 6 + pre-playoffs 7v10 8v9 (best of 3) · re-seeded best-of-7 rounds'}
      : Y >= 2004 ? {pre: {pairs: [[7, 10], [8, 9]], k: 'bo3'}, top: 6, r: ['bo7', 'bo5', 'bo5'], reseed: true, txt: 'top 6 + pre-playoffs 7v10 8v9 (best of 3) · re-seeded · QF best-of-7, SF + final best-of-5'}
      : {top: 8, r: ['bo7', 'bo5', 'bo5'], reseed: true, txt: 'top 8'},
    // points ties, searched over (wins, regulation wins, goal diff, goals for, head-to-head) against every real bracket 2004-26: goal difference then goals for
    // fits all but two: 2014 Blues above Jokerit (93 pts, worse goal diff; pinned below) and 2025 HPK above Sport (83 pts, worse goal diff, more regulation wins)
    // -> from 2025 regulation wins first (one case; assumed)
    tiebreak: Y => Y >= 2025 ? ['rw', 'gd', 'gf'] : ['gd', 'gf'], tiefix: {2014: ['blues', 'jokerit']},
  },
  shl: {
    label: 'SHL', title: 'SHL title (Le Mat Trophy)', first: 2000, from: 1999, nodata: [],
    // 2014 on: top 6 + eighth-finals 7v10, 8v9 best-of-3 (the feed is MISSING the 2014 + 2015 eighth-final games; the format shows in who reached the QF:
    // 9th + 10th both times), re-seeded best-of-7 rounds -- every bracket 2016-26 replays exactly. 2001-13 (12 teams, top 8): the higher seeds CHOSE their
    // opponents ("slutspelsval"), which no rule reproduces -> approximated by re-seeding (1v8 2v7 ...). 2000 + 2002: semis + final best of 5.
    fmt: Y => Y >= 2014 ? {pre: {pairs: [[7, 10], [8, 9]], k: 'bo3'}, top: 6, r: B7, reseed: true, txt: 'top 6 + eighth-finals 7v10 8v9 (best of 3) · re-seeded best-of-7 rounds'}
      : Y === 2000 || Y === 2002 ? {top: 8, r: ['bo7', 'bo5', 'bo5'], reseed: true, txt: 'top 8 · QF best of 7, semis + final best of 5 (the top seeds chose their opponents; modelled as re-seeding)'}
      : {top: 8, r: B7, reseed: true, txt: 'top 8 · best-of-7 rounds (the top seeds chose their opponents; modelled as re-seeding)'},
    tiebreak: () => ['gd', 'gf'],
    // title seasons left out: 2007 (the feed has no final series) and 2012 (63 of 330 regular-season games missing -> wrong standings/seeds)
    badTitle: [2007, 2012],
  },
  swissnl: {
    label: 'National League', title: 'National League title', first: 2017, from: 2017, nodata: [2018],
    // 2017-20: top 8 · 2021-23: top 6 + pre-playoffs 7v10 8v9 best-of-3 (2021, COVID: semis + final best of 5) · 2024 on: top 6 + play-in (7v8 two games,
    // total goals -> 7th; the loser v the winner of 9v10 -> 8th). From 2019 the top seeds PICK their quarter-final opponents (2019, 2021, 2024-26 picks
    // differ from re-seeding; 2022-23 matched) -> modelled as re-seeding. 2017, 2022, 2023 replay exactly.
    fmt: Y => Y >= 2024 ? {playin: 'agg2', top: 6, r: B7, reseed: true, txt: 'top 6 + play-in (7v8 -> 7th; loser v winner of 9v10 -> 8th; 2-game total-goals series) · best-of-7 rounds (top seeds pick QF opponents; modelled as re-seeding)'}
      : Y === 2021 ? {pre: {pairs: [[7, 10], [8, 9]], k: 'bo3'}, top: 6, r: ['bo7', 'bo5', 'bo5'], reseed: true, txt: 'top 6 + pre-playoffs 7v10 8v9 (best of 3) · QF best of 7, semis + final best of 5 (COVID season)'}
      : Y >= 2021 ? {pre: {pairs: [[7, 10], [8, 9]], k: 'bo3'}, top: 6, r: B7, reseed: true, txt: 'top 6 + pre-playoffs 7v10 8v9 (best of 3) · best-of-7 rounds (top seeds pick QF opponents; modelled as re-seeding)'}
      : {top: 8, r: B7, reseed: true, txt: 'top 8 · best-of-7 rounds'},
    tiebreak: () => ['gd', 'gf'],
  },
}[lg];
if (!LG) { console.error('usage: node euhockey.mjs <liiga|shl|swissnl> [check|backtest|dump|index|live] [--log] [--book "Team:+300,..."] [--export file]'); process.exit(1); }
const CACHE = path.join(os.tmpdir(), 'pro_bp_cache', lg); fs.mkdirSync(CACHE, {recursive: true});

// ---------- tuned values + every-champion profiles + index (see the notes per league) ----------
// P0 = what `backtest` found tuning on the first half of the seasons (also written to the cache's params.json); FEATS = the every-champion rule from
// study/criteria.mjs <lg> on `dump` (2026-11-24; each cutoff = the loosest champion); IDXW from `index` (champion's rank inside the playoff field).
const TUNE = {
  // Liiga: all 22 champions 2004-26 cleared all 5; ~3.8 of the ~10 playoff teams do. Honest test (whole search re-run without each season): the hidden
  // champion cleared all 5 in 18/22 (8/11 | 10/11); log-loss beat a coin flip over the field in both halves (2.270 vs 2.303 -- barely -- | 1.627 vs 2.336).
  // Misses: 2006 HPK, 2010 TPS, 2013 Ässät, 2019 HPK. Index: rating alone (champ avg rank #1.82, 1.91 | 1.73; #1 in 15/22); no blend beat it in both halves.
  liiga: {P0: {half: 120, lam: 10, sig: 2.4},
    FEATS: [{k: 'mgn', dir: 1, kind: 'rank', label: 'Goal diff/game'}, {k: 'gfpg', dir: 1, kind: 'value', label: 'Goals for/game'}, {k: 'rwp', dir: 1, kind: 'rank', label: 'Regulation wins/game'},
      {k: 'hppg', dir: 1, kind: 'rank', label: 'Home pts%'}, {k: 'appg', dir: 1, kind: 'value', label: 'Away pts%'}],
    IDXW: {rtg: 100}},
  // SHL: all 24 champions 2000-26 (minus 2007 + 2012, data gaps) cleared all 5; ~3.2 of the ~8.8 playoff teams do. Honest test: 19/24 (9/12 | 10/12);
  // log-loss beat a coin flip in both halves (2.052 vs 2.079 | 1.822 vs 2.265). Misses: 2006 + 2009 + 2022 Färjestad, 2010 HV71, 2021 Växjö.
  // Index: points % alone (champ avg rank #1.75, 1.33 | 2.17; #1 in 15/24) beat the rating (#2.50, 1.75 | 3.25) in both halves.
  shl: {P0: {half: 365, lam: 3, sig: 2.4},
    FEATS: [{k: 'gfpg', dir: 1, kind: 'value', label: 'Goals for/game'}, {k: 'rtg', dir: 1, kind: 'value', label: 'Rating'}, {k: 'rwp', dir: 1, kind: 'value', label: 'Regulation wins/game'},
      {k: 'form10', dir: 1, kind: 'rank', label: 'Form (pts%, last 10)'}, {k: 'appg', dir: 1, kind: 'value', label: 'Away pts%'}],
    IDXW: {ppg: 100}},
  // National League (8 seasons only): all 8 champions finished top-2 with a top-2 points % + goal diff and top-4 goals for (~1.5 of ~9.5 playoff teams).
  // Honest test FAILED: hidden champion 5/8 (3/4 | 2/4), log-loss worse than a coin flip in the 2nd half (2.502 vs 2.303) -> tiers are CONTEXT ONLY.
  // Index: goal diff/g 60 + points % 40 (champ avg rank #1.13, 1.00 | 1.25; #1 in 7/8) beat rating and points % alone in both halves.
  swissnl: {P0: {half: 365, lam: 10, sig: 2.2},
    FEATS: [{k: 'pos', dir: -1, kind: 'value', label: 'Standings position'}, {k: 'ppg', dir: 1, kind: 'rank', label: 'Points %'}, {k: 'mgn', dir: 1, kind: 'rank', label: 'Goal diff/game'},
      {k: 'gfpg', dir: 1, kind: 'rank', label: 'Goals for/game'}],
    IDXW: {mgn: 60, ppg: 40}},
}[lg];
const FEATS = TUNE.FEATS, IDXW = TUNE.IDXW;

// ---------- data ----------
async function getJSON(u, tries = 4) {
  for (let a = 0; a < tries; a++) { try { const r = await fetch(u, {headers: {'User-Agent': UA, Accept: 'application/json'}, signal: AbortSignal.timeout(60e3)}); if (r.ok) return await r.json(); } catch {} await sleep(1500 * (a + 1)); }
  return null;
}
const fresh = (f, Y) => fs.existsSync(f) && (Y < CURY || Date.now() - fs.statSync(f).mtimeMs < 6 * 3600e3);
const NAMES = {}, SHL_LONG = {};   // id -> display name (latest seen), aliases for --book matching
const LIIGA_FULL = {tappara: 'Tappara', ilves: 'Ilves', pelicans: 'Lahti Pelicans', 'kärpät': 'Oulun Kärpät', 'ässät': 'Porin Ässät', lukko: 'Rauman Lukko', tps: 'TPS Turku',
  jyp: 'JYP Jyväskylä', jukurit: 'Mikkelin Jukurit', sport: 'Vaasan Sport', 'k-espoo': 'Kiekko-Espoo', hpk: 'HPK Hämeenlinna', hifk: 'HIFK Helsinki', kalpa: 'KalPa Kuopio',
  saipa: 'SaiPa Lappeenranta', kookoo: 'KooKoo Kouvola', jokerit: 'Jokerit', blues: 'Espoo Blues'};

async function liigaSeason(Y) {
  const f = path.join(CACHE, `g${Y}.json`); if (fresh(f, Y)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const out = [];
  for (const t of ['runkosarja', 'playoffs']) {
    const raw = path.join(CACHE, `raw_${t}_${Y}.json`);
    let j = Y < CURY && fs.existsSync(raw) ? JSON.parse(fs.readFileSync(raw, 'utf8')) : null;
    if (!j) { j = await getJSON(`https://liiga.fi/api/v2/games?tournament=${t}&season=${Y}`); await sleep(400); }
    if (!Array.isArray(j)) { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); throw new Error(`liiga ${t} ${Y}: no data`); }
    for (const g of j) {
      if (t === 'playoffs' && g.serie !== 'PLAYOFFS') continue;   // leave out the relegation play-out / qualification series
      const H = g.homeTeam, A = g.awayTeam; if (!H?.teamId || !A?.teamId || !g.start) continue;
      const h = H.teamId.split(':')[1], a = A.teamId.split(':')[1], fin = !!g.ended;
      out.push({d: g.start.slice(0, 10), h, a, hn: H.teamName, an: A.teamName, hs: fin ? H.goals : null, as: fin ? A.goals : null, fin, final: t === 'playoffs', ot: fin && g.finishedType !== 'ENDED_DURING_REGULAR_GAME_TIME'});
    }
  }
  fs.writeFileSync(f, JSON.stringify(out)); return out;
}
let SHLF = null;
async function shlSeason(Y) {
  const f = path.join(CACHE, `g${Y}.json`); if (fresh(f, Y)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!SHLF) { const ff = path.join(CACHE, 'filter.json');
    SHLF = fs.existsSync(ff) && Date.now() - fs.statSync(ff).mtimeMs < 30 * 864e5 ? JSON.parse(fs.readFileSync(ff, 'utf8')) : await getJSON('https://www.shl.se/api/sports-v2/season-series-game-types-filter');
    if (!SHLF?.season) throw new Error('shl season list unavailable'); fs.writeFileSync(ff, JSON.stringify(SHLF)); }
  const sea = SHLF.season.find(s => +s.code === Y - 1), ser = SHLF.series.find(s => s.code === 'SHL'), GT = Object.fromEntries(SHLF.gameType.map(g => [g.code, g.uuid]));
  if (!sea) return [];
  const out = [];
  for (const t of ['regular', 'playoff']) {
    const raw = path.join(CACHE, `raw_${t}_${Y - 1}.json`);
    let j = Y < CURY && fs.existsSync(raw) ? JSON.parse(fs.readFileSync(raw, 'utf8')) : null;
    if (!j) { j = await getJSON(`https://www.shl.se/api/sports-v2/game-schedule?seasonUuid=${sea.uuid}&seriesUuid=${ser.uuid}&gameTypeUuid=${GT[t]}&gamePlace=all&played=all`); await sleep(500); }
    if (!j?.gameInfo) { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); throw new Error(`shl ${t} ${Y}: no data`); }
    for (const g of j.gameInfo) {
      const H = g.homeTeamInfo, A = g.awayTeamInfo; if (!H?.code || !A?.code || !H.names?.short || !A.names?.short || /TBD/i.test(H.code + A.code)) continue;
      const fin = g.state === 'post-game' && H.score != null && A.score != null;
      out.push({d: g.startDateTime.slice(0, 10), h: H.code, a: A.code, hn: H.names.short.trim(), an: A.names.short.trim(), hl: H.names.long, al: A.names.long, hs: fin ? +H.score : null, as: fin ? +A.score : null, fin, final: t === 'playoff', ot: fin && !!(g.overtime || g.shootout)});
    }
  }
  fs.writeFileSync(f, JSON.stringify(out)); return out;
}
async function nlSeason(Y) {
  if (LG.nodata.includes(Y) || Y < 2017) return [];
  const f = path.join(CACHE, `g${Y}.json`); if (fresh(f, Y)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const j = await getJSON(`https://www.nationalleague.ch/api/games?season=${Y}`); await sleep(400);
  if (!Array.isArray(j) || !j.length) { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); return []; }
  const po = await getJSON(`https://www.nationalleague.ch/api/games/playoffs?season=${Y}`); await sleep(400);
  const poTeams = new Set(); for (const r of (Array.isArray(po) ? po : [])) if (r.round !== 'final') for (const s of r.games || []) for (const g of s.games || []) { poTeams.add(g.homeTeamShortName); poTeams.add(g.awayTeamShortName); }
  // the season list can miss playoff games (2024: all six play-in games) -> add any game the playoff tree has that the list lacks
  const have = new Set(j.map(g => g.gameId));
  for (const r of (Array.isArray(po) ? po : [])) for (const s of r.games || []) for (const g of s.games || []) if (!have.has(g.gameId) && (r.round !== 'final' || (poTeams.has(g.homeTeamShortName) && poTeams.has(g.awayTeamShortName)))) { j.push(g); have.add(g.gameId); }
  const G = j.filter(g => !g.isExhibition).sort((x, y) => x.date.localeCompare(y.date));
  const cnt = {}; for (const g of G) for (const t of [g.homeTeamShortName, g.awayTeamShortName]) cnt[t] = (cnt[t] || 0) + 1;
  const NLT = new Set(Object.keys(cnt).filter(t => cnt[t] >= 30)), R = Y <= 2020 ? 50 : 52, seen = {}, out = [];
  for (const g of G) {
    const h = g.homeTeamShortName, a = g.awayTeamShortName; if (!NLT.has(h) || !NLT.has(a)) continue;   // league-qualification games v Swiss League clubs
    seen[h] = (seen[h] || 0) + 1; seen[a] = (seen[a] || 0) + 1;
    const post = seen[h] > R || seen[a] > R, fin = g.status === 'finished' && g.homeTeamResult != null;
    out.push({d: g.date.slice(0, 10), h, a, hn: g.homeTeamName, an: g.awayTeamName, hs: fin ? +g.homeTeamResult : null, as: fin ? +g.awayTeamResult : null, fin, final: post, ot: fin && !!(g.isOvertime || g.isShootout), post});
  }
  // postseason games = playoffs (both teams in the playoff tree from /api/games/playoffs) or play-outs (bottom teams; left out)
  let field = poTeams;
  if (!field.size) { const reg = out.filter(g => !g.post), T = {}; for (const g of reg.filter(g => g.fin)) for (const [me, gf, ga] of [[g.h, g.hs, g.as], [g.a, g.as, g.hs]]) { const t = T[me] ||= {id: me, p: 0, gd: 0}; t.p += pts(gf, ga, g.ot); t.gd += gf - ga; }
    field = new Set(Object.values(T).sort((x, y) => y.p - x.p || y.gd - x.gd).slice(0, LG.fmt(Y).top + (LG.fmt(Y).pre ? 4 : LG.fmt(Y).playin ? 4 : 0) || 8).map(t => t.id)); }
  const keep = out.filter(g => !g.post || (field.has(g.h) && field.has(g.a))).map(({post, ...g}) => g);
  fs.writeFileSync(f, JSON.stringify(keep)); return keep;
}
const loader = {liiga: liigaSeason, shl: shlSeason, swissnl: nlSeason}[lg];
const SEAS = {};
async function season(Y) {
  if (SEAS[Y]) return SEAS[Y];
  const G = (await loader(Y)).map(g => ({...g, Y}));
  for (const g of G) { if (g.hl) SHL_LONG[g.h] = g.hl; if (g.al) SHL_LONG[g.a] = g.al; }
  G.sort((x, y) => x.d.localeCompare(y.d) || (x.final - y.final));
  G.forEach((g, i) => { g.id = `${Y}-${i}`; const t = Date.parse(g.d + 'T12:00:00Z'), mon = t - ((new Date(t).getUTCDay() + 6) % 7) * 864e5; g.rn = g.final ? 'PO' : 'W' + new Date(mon).toISOString().slice(0, 10);
    for (const [id, n] of [[g.h, g.hn], [g.a, g.an]]) NAMES[id] = {name: String(n).trim(), alias: [lg === 'liiga' ? LIIGA_FULL[id] : id, ...(SHL_LONG[id] ? [SHL_LONG[id]] : [])]}; });
  return SEAS[Y] = G;
}
const nameOf = id => NAMES[id]?.name || id;

// ---------- points + standings ----------
// 3 regulation win · 2 OT/shootout win · 1 OT/shootout loss · old-era ties (Liiga <= 2004, SHL 2004-05..2009-10 after a scoreless OT) 1 each
function pts(gf, ga, ot) { return gf > ga ? (ot ? 2 : 3) : gf === ga ? 1 : (ot ? 1 : 0); }
function table(reg) {
  const T = new Map();
  for (const g of reg) for (const t of [g.h, g.a]) if (!T.has(t)) T.set(t, {id: t, w: 0, otw: 0, otl: 0, l: 0, t: 0, gp: 0, gf: 0, ga: 0, p: 0});
  for (const g of reg.filter(g => g.fin)) for (const [me, gf, ga] of [[g.h, g.hs, g.as], [g.a, g.as, g.hs]]) {
    const t = T.get(me), o = me === g.h ? g.a : g.h; t.gp++; t.gf += gf; t.ga += ga; t.p += pts(gf, ga, g.ot); (t.vs ||= {})[o] = (t.vs[o] || 0) + pts(gf, ga, g.ot);
    if (gf > ga) { if (g.ot) t.otw++; else t.w++; } else if (gf === ga) t.t++; else { if (g.ot) t.otl++; else t.l++; } }
  return T;
}
// standings: points per game (= points when everyone has played the same number of games), then the league's tiebreak list
// (rw = regulation wins, w = all wins, gd = goal difference, gf = goals for)
const TB = {rw: t => t.w, w: t => t.w + t.otw, gd: t => t.gf - t.ga, gf: t => t.gf};
function ladder(rows, Y) {
  const tb = LG.tiebreak(Y);
  const pg = t => t.p / Math.max(1, t.gp);
  const out = rows.slice().sort((x, y) => { const d = pg(y) - pg(x); if (Math.abs(d) > 1e-9) return d; for (const k of tb) { const e = k === 'h2h' ? (y.vs?.[x.id] || 0) - (x.vs?.[y.id] || 0) : TB[k](y) - TB[k](x); if (e) return e; } return 0; });
  const fix = LG.tiefix?.[Y];   // pinned real-world ties the tiebreak list can't reproduce
  if (fix) { const i = out.findIndex(t => t.id === fix[0]), j = out.findIndex(t => t.id === fix[1]); if (i > j && j >= 0 && out[i].p === out[j].p && out[i].gp === out[j].gp) [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
const rec = t => `${t.w + t.otw}-${t.l + t.otl}${t.t ? '-' + t.t : ''}, ${t.p} pts`;

// ---------- ratings ----------
function fit(games, asOf, P) {
  const G = games.filter(g => g.fin && g.d < asOf), t0 = Date.parse(asOf + 'T12:00:00Z');
  const w = G.map(g => Math.pow(0.5, (t0 - Date.parse(g.d + 'T12:00:00Z')) / 864e5 / P.half)), m = G.map(g => g.hs - g.as);
  const T = [...new Set(G.flatMap(g => [g.h, g.a]))], r = new Map(T.map(t => [t, 0])), idx = new Map();
  for (const [i, g] of G.entries()) for (const t of [g.h, g.a]) { if (!idx.has(t)) idx.set(t, []); idx.get(t).push(i); }
  let H = 0.2;
  for (let it = 0; it < 40; it++) {
    for (const t of T) { let den = P.lam, n2 = 0; for (const i of idx.get(t)) { const g = G[i], s = g.h === t ? 1 : -1, other = r.get(g.h === t ? g.a : g.h); den += w[i]; n2 += w[i] * (s * (m[i] - H) + other); } r.set(t, n2 / den); }
    const mu = T.length ? mean([...r.values()]) : 0; for (const t of T) r.set(t, r.get(t) - mu);
    let ss = 0, ws = 0; for (const [i, g] of G.entries()) { ss += w[i] * (m[i] - (r.get(g.h) - r.get(g.a))); ws += w[i]; }
    H = ws ? ss / ws : 0;
  }
  return {r, H};
}
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
const Phi = x => 0.5 * (1 + erf(x / Math.SQRT2));
const PhiInv = p => { let lo = -8, hi = 8; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
const predMargin = (M, h, a) => (M.r.get(h) ?? 0) - (M.r.get(a) ?? 0) + M.H;
const pHome = (M, h, a, P) => Phi(predMargin(M, h, a) / P.sig);
const LLf = (p, y) => -(y * Math.log(Math.max(p, 1e-6)) + (1 - y) * Math.log(Math.max(1 - p, 1e-6)));
const randn = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// ---------- playoffs ----------
// runPO(seeds, f, play): seeds = team ids in standings order; play(x, y, k) -> winner (x = the higher seed, hosts). Returns {champ, pairs: [[x, y], ...] in order}
function runPO(seeds, f, play) {
  const seed = new Map(seeds.map((id, i) => [id, i + 1])), pairs = [], go = (x, y, k) => { if (seed.get(y) < seed.get(x)) [x, y] = [y, x]; pairs.push([x, y]); return play(x, y, k); };
  let alive;
  if (f.playin) {
    const [s7, s8, s9, s10] = seeds.slice(6, 10), w78 = go(s7, s8, f.playin), l78 = w78 === s7 ? s8 : s7, w910 = go(s9, s10, f.playin), w8 = go(l78, w910, f.playin);
    seed.set(w78, 7); seed.set(w8, 8); alive = [...seeds.slice(0, 6), w78, w8];
  } else if (f.pre) alive = [...seeds.slice(0, f.top), ...f.pre.pairs.map(([x, y]) => go(seeds[x - 1], seeds[y - 1], f.pre.k))];
  else alive = seeds.slice(0, f.top);
  for (const k of f.r) {
    alive.sort((x, y) => seed.get(x) - seed.get(y));
    const nx = []; for (let i = 0; i < alive.length / 2; i++) nx.push(go(alive[i], alive[alive.length - 1 - i], k));
    alive = nx;
  }
  return {champ: alive[0], pairs};
}
const fieldSize = f => f.top + (f.pre ? 2 * f.pre.pairs.length : f.playin ? 4 : 0);
// simulated series between x (higher seed) and y
function seriesSim(M, P, x, y, k) {
  const g = (h, a) => Math.random() < Phi(predMargin(M, h, a) / P.sig);
  if (k === 'agg2') { let tot = 0; tot -= Math.round(predMargin(M, y, x) + P.sig * randn()); tot += Math.round(predMargin(M, x, y) + P.sig * randn());
    return tot > 0 ? x : tot < 0 ? y : (g(x, y) ? x : y); }
  const need = k === 'bo7' ? 4 : k === 'bo5' ? 3 : k === 'bo3' ? 2 : 1; let a = 0, b = 0;
  for (let i = 0; a < need && b < need; i++) { const xHome = i % 2 === 0; if (xHome ? g(x, y) : !g(y, x)) a++; else b++; }
  return a === need ? x : y;
}
// the real series of a season: unordered pair -> {w: wins by team, d0, n}
function realSeries(G) {
  const S = new Map();
  for (const g of G.filter(g => g.final && g.fin)) { const k = [g.h, g.a].sort().join('|'), s = S.get(k) || {k, w: {}, gd: {}, d0: g.d, n: 0}; s.n++;
    const x = g.hs > g.as ? g.h : g.a; if (g.hs !== g.as) s.w[x] = (s.w[x] || 0) + 1; s.gd[g.h] = (s.gd[g.h] || 0) + g.hs - g.as; s.gd[g.a] = (s.gd[g.a] || 0) + g.as - g.hs; S.set(k, s); }
  return S;
}
const seriesWinner = (s, k) => { if (k === 'agg2') { const [p, q] = s.k.split('|'), d = (s.gd[p] || 0) - (s.gd[q] || 0); if (d) return d > 0 ? p : q; } return Object.entries(s.w).sort((a, b) => b[1] - a[1])[0]?.[0]; };
// champion = the one team that won every series it played (everyone else lost one, incl. the bronze-game teams), once its last series reached the wins a final needs
function premier(G) {
  const S = [...realSeries(G).values()]; if (!S.length) return null;
  const f = LG.fmt(G[0].Y), byT = {};
  for (const s of S) { const [p, q] = s.k.split('|'), need = Math.max(...Object.values(s.w), 0), agg = s.n <= 2 && (f.pre?.k === 'agg2' || f.playin), w = agg ? seriesWinner(s, 'agg2') : seriesWinner(s);
    for (const t of [p, q]) { const o = byT[t] ||= {lost: 0, last: '', fin: 0}; if (t !== w) o.lost++; if (s.d0 > o.last) { o.last = s.d0; o.fin = need; } } }
  const needF = {bo7: 4, bo5: 3, bo3: 2}[f.r[2]] || 4, un = Object.entries(byT).filter(([, o]) => !o.lost);
  return un.length === 1 && un[0][1].fin >= needF ? un[0][0] : null;
}
// ---------- season sim ----------
function otShare(games) { const g = games.filter(x => x.fin && !x.final), ot = g.filter(x => x.ot); return {ot: g.length ? ot.length / g.length : 0.22, tie: ot.length ? ot.filter(x => x.hs === x.as).length / ot.length : 0}; }
function simulate(M, P, reg, Y, N = 20000, fixedSeeds = null, otr = {ot: 0.22, tie: 0}) {
  const f = LG.fmt(Y), base = table(reg), left = reg.filter(g => !g.fin), cup = new Map(), top = new Map(), field = new Map();
  const tOT = P.sig * PhiInv((1 + otr.ot) / 2), play = (x, y, k) => seriesSim(M, P, x, y, k);
  const realLad = ladder([...base.values()], Y);
  for (let s = 0; s < N; s++) {
    let lad = realLad;
    if (!fixedSeeds) {
      const T = new Map([...base].map(([k, v]) => [k, {...v}]));
      for (const g of left) { const mg = predMargin(M, g.h, g.a) + P.sig * randn(), H = T.get(g.h), A = T.get(g.a); H.gp++; A.gp++;
        if (Math.abs(mg) < tOT) { if (otr.tie && Math.random() < otr.tie) { H.p++; A.p++; continue; } const [W, L] = mg > 0 ? [H, A] : [A, H]; W.p += 2; L.p += 1; W.otw++; L.otl++; W.gf++; L.ga++; }
        else { const x = Math.max(1, Math.round(Math.abs(mg))), [W, L] = mg > 0 ? [H, A] : [A, H]; W.p += 3; W.w++; L.l++; W.gf += x; L.ga += x; } }
      lad = ladder([...T.values()], Y);
    }
    const seeds = fixedSeeds || lad.map(t => t.id);
    top.set(seeds[0], (top.get(seeds[0]) || 0) + 1); for (const id of seeds.slice(0, fieldSize(f))) field.set(id, (field.get(id) || 0) + 1);
    const ch = runPO(seeds, f, play).champ; cup.set(ch, (cup.get(ch) || 0) + 1);
  }
  const out = new Map([...cup].map(([k, v]) => [k, v / N])); out.minor = new Map([...top].map(([k, v]) => [k, v / N])); out.field = new Map([...field].map(([k, v]) => [k, v / N])); return out;
}
const loadP = () => fs.existsSync(path.join(CACHE, 'params.json')) ? JSON.parse(fs.readFileSync(path.join(CACHE, 'params.json'), 'utf8')) : TUNE.P0;
const SEASONS = Array.from({length: CURY - LG.first + 1}, (_, i) => LG.first + i).filter(Y => !LG.nodata.includes(Y));
const titleOK = (S, Y) => !!(S[Y]?.length && !(LG.badTitle || []).includes(Y) && premier(S[Y]));
async function all() { const S = {}; for (let Y = LG.from - 2; Y <= CURY; Y++) S[Y] = LG.nodata.includes(Y) || Y < LG.from ? [] : await season(Y).catch(e => { console.error(`season ${Y}: ${e.message}`); return []; }); return S; }
const pool = (S, Y) => [...(S[Y - 2] || []), ...(S[Y - 1] || []), ...(S[Y] || [])];
const firstFinal = G => G.filter(g => g.final).map(g => g.d).sort()[0];
const regOf = G => G.filter(g => !g.final);
const finalsField = G => [...new Set(G.filter(g => g.final).flatMap(g => [g.h, g.a]))];
const endSeeds = G => ladder([...table(regOf(G)).values()], G[0].Y).map(t => t.id);
// BP_TODAY rewind: every game on/after asOf becomes unplayed (scores wiped), so standings, ratings and the board are as of that date
const rewind = (G, asOf) => G.map(g => g.d < asOf ? g : {...g, fin: false, hs: null, as: null, ot: false});

// ---------- champion profile (end of the regular season = the day before the first playoff game) ----------
function profile(G, pl, asOf, P) {
  const reg = G.filter(g => !g.final && g.fin && g.d < asOf), M = fit(pl, asOf, P), T = new Map();
  for (const g of reg) for (const [me, gf, ga, side] of [[g.h, g.hs, g.as, 1], [g.a, g.as, g.hs, -1]]) {
    const t = T.get(me) || {id: me, gp: 0, gf: 0, ga: 0, p: 0, rw: 0, res: [], hp: 0, hn: 0, ap: 0, an: 0, w: 0, otw: 0, l: 0, otl: 0, t: 0}, p = pts(gf, ga, g.ot);
    t.gp++; t.gf += gf; t.ga += ga; t.p += p; if (gf > ga && !g.ot) t.rw++; t.res.push([g.d, p]);
    if (gf > ga) { if (g.ot) t.otw++; else t.w++; } else if (gf === ga) t.t++; else { if (g.ot) t.otl++; else t.l++; }
    if (side > 0) { t.hp += p; t.hn++; } else { t.ap += p; t.an++; } T.set(me, t); }
  const rows = ladder([...T.values()], G[0].Y).map((t, i) => { const s = t.res.sort((a, b) => a[0].localeCompare(b[0])), f = n => mean(s.slice(-n).map(x => x[1])) / 3;
    return {...t, res: undefined, pos: i + 1, ppg: t.p / t.gp / 3, gfpg: t.gf / t.gp, gapg: t.ga / t.gp, mgn: (t.gf - t.ga) / t.gp, rtg: M.r.get(t.id) ?? 0, rwp: t.rw / t.gp,
      form10: f(10), form20: f(20), hppg: t.hn ? t.hp / t.hn / 3 : 0, appg: t.an ? t.ap / t.an / 3 : 0}; });
  return {rows: rankRows(rows, FEATS), M};
}
function addIndex(rows, W = IDXW) {
  const N = {}, tw = Object.values(W).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(W)) { const dir = k === 'gapg' || k === 'pos' ? -1 : 1, v = rows.map(r => +r[k]), lo = Math.min(...v), hi = Math.max(...v);
    N[k] = r => hi === lo ? 50 : 100 * (dir > 0 ? r[k] - lo : hi - r[k]) / (hi - lo); }
  for (const r of rows) r.idx = Object.entries(W).reduce((a, [k, w]) => a + w * N[k](r), 0) / tw;
}
const CANDS = [{k: 'pos', dir: -1, label: 'Standings position', value: true, rank: false, dec: 0}, {k: 'ppg', dir: 1, label: 'Points %', value: true},
  {k: 'mgn', dir: 1, label: 'Goal diff/game', value: true}, {k: 'gfpg', dir: 1, label: 'Goals for/game', value: true}, {k: 'gapg', dir: -1, label: 'Goals against/game', value: true},
  {k: 'rtg', dir: 1, label: 'Rating', value: true}, {k: 'rwp', dir: 1, label: 'Regulation wins/game', value: true}, {k: 'form10', dir: 1, label: 'Form (pts%, last 10)', value: true},
  {k: 'form20', dir: 1, label: 'Form (pts%, last 20)', value: true}, {k: 'hppg', dir: 1, label: 'Home pts%', value: true}, {k: 'appg', dir: 1, label: 'Away pts%', value: true}];
const LBL = Object.fromEntries(CANDS.map(c => [c.k, c.label]));

if (mode === 'dump') {   // every team's end-of-regular-season profile -> study/data/<lg>.json (input for study/criteria.mjs)
  const S = await all(), P = loadP(), K = CANDS.map(c => c.k);
  const out = {sport: lg, label: LG.title, when: 'end of the regular season', fieldLabel: 'the playoff teams (incl. pre-playoff / play-in)', universeLabel: `every ${LG.label} team`, cands: CANDS, seasons: []};
  for (const Y of SEASONS) {
    const G = S[Y]; if (!titleOK(S, Y)) continue; const ch = premier(G);
    const {rows} = profile(G, pool(S, Y), firstFinal(G), P);
    out.seasons.push({Y, champ: ch, champName: nameOf(ch), field: finalsField(G), rows: rows.map(r => Object.fromEntries([['id', r.id], ['name', nameOf(r.id)], ...K.map(k => [k, r[k]])]))});
  }
  fs.mkdirSync('C:/Users/User/baseball-blueprint/study/data', {recursive: true});
  fs.writeFileSync(`C:/Users/User/baseball-blueprint/study/data/${lg}.json`, JSON.stringify(out));
  console.log(`dumped ${out.seasons.length} seasons -> study/data/${lg}.json · champs: ${out.seasons.map(s => `${s.Y} ${s.champName} (#${s.rows.find(r => r.id === s.champ).pos} of ${s.rows.length}, field ${s.field.length})`).join(', ')}`);
  process.exit(0);
}
if (mode === 'check') {   // data + format: games, champion, and whether the bracket replayed from the standings (with the real series winners) matches every real series
  const S = await all();
  for (let Y = LG.first; Y <= CURY; Y++) { const G = S[Y]; if (!G?.length) { console.log(`${Y}: no data`); continue; }
    const r = regOf(G), po = G.filter(g => g.final), f = LG.fmt(Y), ch = premier(G), T = table(r), gp = [...T.values()].map(t => t.gp);
    let note = '';
    if (po.some(g => g.fin)) {
      const RS = realSeries(G), seeds = endSeeds(G), miss = [];
      const inPO = new Set(po.flatMap(g => [g.h, g.a])), gap = [];
      const want = runPO(seeds, f, (x, y, k) => { const s = RS.get([x, y].sort().join('|'));
        if (!s && inPO.has(x) !== inPO.has(y)) { gap.push([x, y]); return inPO.has(x) ? x : y; }   // series missing from the feed: the team seen later went through
        if (!s) { miss.push(`${nameOf(x)}#${seeds.indexOf(x) + 1}-${nameOf(y)}#${seeds.indexOf(y) + 1}`); return x; } return seriesWinner(s, k); });
      const used = new Set(want.pairs.map(p => p.slice().sort().join('|'))), extra = [...RS.keys()].filter(k => !used.has(k));
      const fieldOk = seeds.slice(0, fieldSize(f)).sort().join() === [...new Set([...finalsField(G), ...gap.flat()])].sort().join();
      const needs = {}; for (const s of RS.values()) { const m = Math.max(...Object.values(s.w), 0); needs[m] = (needs[m] || 0) + 1; }
      note = ` · field ${fieldOk ? 'OK' : 'MISMATCH'}${gap.length ? ' (series missing from the feed: ' + gap.map(p => p.map(nameOf).join('-')).join(', ') + ')' : ''} · bracket ${miss.length ? 'MISMATCH (no such series: ' + miss.join(', ') + ')' : 'OK'}${extra.length ? ' · other series: ' + extra.map(k => k.split('|').map(t => nameOf(t) + '#' + (seeds.indexOf(t) + 1)).join('-')).join(', ') : ''} · series won with ${JSON.stringify(needs)} wins`;
      if (!fieldOk) note += ` [standings field ${seeds.slice(0, fieldSize(f)).map(nameOf).join(',')} vs real ${finalsField(G).map(nameOf).join(',')}]`;
    }
    console.log(`${Y}: ${r.length} regular (${r.filter(g => g.fin).length} played, ${T.size} teams, ${Math.min(...gp)}-${Math.max(...gp)} gp, OT/SO ${(100 * otShare(r).ot).toFixed(0)}%${otShare(r).tie ? `, ties ${(100 * otShare(r).tie).toFixed(0)}% of OT` : ''}) · ${po.length} playoff games · champion ${ch ? nameOf(ch) : '—'} · ${r[0]?.d} .. ${r[r.length - 1]?.d} | playoffs ${firstFinal(G) ?? '—'}${note}`);
  }
  // rewind proof: the last finished season as of mid-January -> later games unplayed, standings rebuilt from what had been played
  const Yl = SEASONS.filter(Y => titleOK(S, Y)).pop(), d = `${Yl}-01-15`, R = rewind(S[Yl], d), r0 = regOf(S[Yl]), r1 = regOf(R);
  const lad0 = ladder([...table(r0).values()], Yl), lad1 = ladder([...table(r1).values()], Yl);
  console.log(`\nREWIND TEST (BP_TODAY-style, as of ${d}, season ${Yl}): played games after the date = ${R.filter(g => g.fin && g.d >= d).length} (was ${S[Yl].filter(g => g.fin && g.d >= d).length}) · regular games played ${r1.filter(g => g.fin).length}/${r1.length} (full season ${r0.filter(g => g.fin).length}) · playoff games played ${R.filter(g => g.final && g.fin).length} · champion found ${premier(R) ? 'YES (bug)' : 'none (correct)'}`);
  console.log(`  standings then: ${lad1.slice(0, 4).map(t => `${nameOf(t.id)} ${t.p} pts/${t.gp} gp`).join(', ')}  |  final: ${lad0.slice(0, 4).map(t => `${nameOf(t.id)} ${t.p}/${t.gp}`).join(', ')}`);
  process.exit(0);
}
const yv = g => g.hs > g.as ? 1 : 0;
if (mode === 'backtest' || mode === 'index') {
  const S = await all(), done = SEASONS.filter(Y => Y < CURY && titleOK(S, Y));
  const half = Math.ceil(done.length / 2), H1 = done.slice(0, half), H2 = done.slice(half);
  if (mode === 'index') {   // index weights: champion's rank inside the playoff field at the end of the regular season (lower = better), by half
    const P = loadP(), SS = done.map(Y => { const G = S[Y], ch = premier(G), {rows} = profile(G, pool(S, Y), firstFinal(G), P), F = new Set(finalsField(G)); return {Y, ch, rows: rows.filter(r => F.has(r.id))}; });
    const W = [{rtg: 100}, {ppg: 100}, {mgn: 100}, {rwp: 100}, {rtg: 70, ppg: 30}, {rtg: 50, ppg: 50}, {ppg: 70, rtg: 30}, {rtg: 70, form20: 30}, {rtg: 70, form10: 30}, {rtg: 60, gapg: 40}, {rtg: 60, gfpg: 40},
      {rtg: 70, appg: 30}, {rtg: 70, hppg: 30}, {rtg: 60, ppg: 20, appg: 20}, {mgn: 60, ppg: 40}, {rtg: 70, rwp: 30}, {ppg: 70, form20: 30}, {rtg: 80, ppg: 20}, {rtg: 60, ppg: 20, gapg: 20}, {rtg: 50, mgn: 50}];
    for (const w of W) { const rk = SS.map(s => { addIndex(s.rows, w); const c = s.rows.find(r => r.id === s.ch); return 1 + s.rows.filter(r => r.idx > c.idx + 1e-9).length + 0.5 * s.rows.filter(r => r !== c && Math.abs(r.idx - c.idx) <= 1e-9).length; });
      const h = Ys => mean(rk.filter((_, i) => Ys.includes(done[i])));
      console.log(`  ${Object.entries(w).map(([k, v]) => k + ' ' + v).join(' · ').padEnd(30)} champ avg rank ${mean(rk).toFixed(2)} (${h(H1).toFixed(2)} | ${h(H2).toFixed(2)}) · #1 ${rk.filter(x => x === 1).length}/${rk.length} · top-3 ${rk.filter(x => x <= 3).length}`); }
    process.exit(0);
  }
  const rounds = Y => [...new Set(S[Y].filter(g => !g.final && g.fin).map(g => g.rn))];
  const fitsFor = P => { const F = new Map(); for (const Y of done) for (const rd of rounds(Y)) { const d0 = S[Y].filter(g => g.rn === rd && !g.final).map(g => g.d).sort()[0]; F.set(Y + '|' + rd, fit(pool(S, Y), d0, P)); } return F; };
  const evalM = (P, F, Ys) => mean(Ys.flatMap(Y => S[Y].filter(g => !g.final && g.fin && g.hs !== g.as).map(g => LLf(pHome(F.get(Y + '|' + g.rn), g.h, g.a, P), yv(g)))));
  let best = null; const cache = new Map();
  for (const hl of [60, 90, 120, 180, 240, 365, 540, 730]) for (const lam of [1, 3, 10, 30]) { const F = fitsFor({half: hl, lam}); cache.set(hl + '|' + lam, F);
    for (const sig of [1.8, 2, 2.2, 2.4, 2.6, 2.8, 3, 3.2, 3.5, 4, 4.5]) { const P = {half: hl, lam, sig}, ll = evalM(P, F, H1); if (!best || ll < best.ll) best = {P, ll}; } }
  const P = best.P, F = cache.get(P.half + '|' + P.lam);
  const decided = Ys => Ys.flatMap(Y => S[Y].filter(x => !x.final && x.fin && x.hs !== x.as));
  const hb = Ys => { const g = decided(Ys), hr = mean(g.map(yv)); return mean(g.map(x => LLf(hr, yv(x)))); };
  const hrate = Ys => mean(decided(Ys).map(yv));
  console.log(`${LG.label} backtest -- ${done[0]}-${done[done.length - 1]}, ${done.length} seasons (halves ${H1[0]}-${H1[H1.length - 1]} / ${H2[0]}-${H2[H2.length - 1]})`);
  console.log(`GAMES (regular season, refit every week, OT/SO games count for the winner): tuned on the 1st half -> half-life ${P.half} d, shrink ${P.lam}, sigma ${P.sig} goals${[60, 730].includes(P.half) || [1, 30].includes(P.lam) || [1.8, 4.5].includes(P.sig) ? ' (EDGE OF GRID)' : ''}`);
  console.log(`  1st half LL ${evalM(P, F, H1).toFixed(4)} vs home-win base rate ${hb(H1).toFixed(4)} (home won ${(100 * hrate(H1)).toFixed(1)}%) · 2nd half (held out) LL ${evalM(P, F, H2).toFixed(4)} vs ${hb(H2).toFixed(4)} (${(100 * hrate(H2)).toFixed(1)}%) · coin 0.6931`);
  const acc = Ys => mean(Ys.flatMap(Y => S[Y].filter(g => !g.final && g.fin && g.hs !== g.as).map(g => (pHome(F.get(Y + '|' + g.rn), g.h, g.a, P) > 0.5) === (g.hs > g.as))));
  console.log(`  picks right: ${(100 * acc(H1)).toFixed(1)}% | ${(100 * acc(H2)).toFixed(1)}%`);
  const fm = []; for (const Y of done) { const M = fit(pool(S, Y), firstFinal(S[Y]), P); for (const g of S[Y].filter(g => g.final && g.fin && g.hs !== g.as)) fm.push({Y, ll: LLf(pHome(M, g.h, g.a, P), yv(g)), y: yv(g)}); }
  const hostLL = Ys => mean(fm.filter(x => Ys.includes(x.Y)).map(x => LLf(mean(fm.filter(z => z.Y !== x.Y).map(z => z.y)), x.y)));
  const fl = Ys => mean(fm.filter(x => Ys.includes(x.Y)).map(x => x.ll));
  console.log(`\nPLAYOFF GAMES (${fm.length}, ratings frozen at the start of the playoffs): model LL ${fl(done).toFixed(4)} (${fl(H1).toFixed(4)} | ${fl(H2).toFixed(4)}) vs "host wins" base rate ${hostLL(done).toFixed(4)} (${hostLL(H1).toFixed(4)} | ${hostLL(H2).toFixed(4)})`);
  const titles = [];
  for (const Y of done) {
    const G = S[Y], reg = regOf(G), ch = premier(G), first = firstFinal(G), f = LG.fmt(Y), nF = fieldSize(f), otr = otShare(pool(S, Y).filter(g => g.d < first));
    const seeds = endSeeds(G), seed = 1 + seeds.indexOf(ch);
    const Tf = simulate(fit(pool(S, Y), first, P), P, reg, Y, 20000, seeds, otr);
    const ds = reg.map(g => g.d).sort(), d75 = ds[Math.floor(0.75 * ds.length)], reg75 = rewind(reg, d75);
    const T75 = simulate(fit(pool(S, Y), d75, P), P, reg75, Y, 6000, null, otShare(pool(S, Y).filter(g => g.d < d75)));
    const pos75 = 1 + ladder([...table(reg75).values()], Y).findIndex(t => t.id === ch);
    const rk = (T, id) => 1 + [...T.values()].filter(v => v > (T.get(id) || 0)).length;
    titles.push({Y, nF, ch: nameOf(ch), seed, pos75, p: Tf.get(ch) || 0, r: rk(Tf, ch), p75: T75.get(ch) || 0, r75: rk(T75, ch), nT: table(reg).size});
  }
  console.log(`\nTITLE ODDS -- start of the playoffs (seeds known) | at 75% of the regular season (rest simulated)`);
  for (const t of titles) console.log(`  ${t.Y} ${String(t.ch).padEnd(16)} seed ${String(t.seed).padStart(2)}/${t.nF} | playoffs start ${(100 * t.p).toFixed(1).padStart(5)}% (#${t.r}) | 75% ${(100 * t.p75).toFixed(1).padStart(5)}% (#${t.r75}, ${t.pos75}${['st', 'nd', 'rd'][t.pos75 - 1] || 'th'} then)`);
  const Lg = a => mean(a.map(p => -Math.log(Math.max(p, 1e-4))));
  // baselines (leave the season out): seed history = share of champions by seed among the other seasons with the same field size (+0.5 smoothing);
  // standings history at 75% = share of champions by position at the 75% mark
  const seedLL = Ys => mean(titles.filter(t => Ys.includes(t.Y)).map(t => { const tf = titles.filter(z => z.Y !== t.Y && z.nF === t.nF); return -Math.log((tf.filter(z => z.seed === t.seed).length + 0.5) / (tf.length + 0.5 * t.nF)); }));
  const posLL = Ys => mean(titles.filter(t => Ys.includes(t.Y)).map(t => { const tf = titles.filter(z => z.Y !== t.Y); return -Math.log((tf.filter(z => z.pos75 === t.pos75).length + 0.5) / (tf.length + 0.5 * t.nT)); }));
  const verdict = [];
  for (const [lab, Ys] of [['ALL', done], ['1st half', H1], ['2nd half', H2]]) { const rs = titles.filter(t => Ys.includes(t.Y));
    const ll = Lg(rs.map(t => t.p)), eq = mean(rs.map(t => Math.log(t.nF))), sh = seedLL(Ys), ll75 = Lg(rs.map(t => t.p75)), eq75 = mean(rs.map(t => Math.log(t.nT))), ph = posLL(Ys);
    if (lab !== 'ALL') verdict.push(ll < eq && ll < sh);
    console.log(`  ${lab.padEnd(9)} playoffs start: #1 ${rs.filter(t => t.r === 1).length}/${rs.length} · top-3 ${rs.filter(t => t.r <= 3).length} · champ avg rank ${mean(rs.map(t => t.r)).toFixed(2)} · LL ${ll.toFixed(3)} vs equal ${eq.toFixed(3)} vs seed history ${sh.toFixed(3)} ${ll < eq && ll < sh ? '✅' : '❌'}`);
    console.log(`  ${''.padEnd(9)} 75%:            #1 ${rs.filter(t => t.r75 === 1).length}/${rs.length} · top-3 ${rs.filter(t => t.r75 <= 3).length} · champ avg rank ${mean(rs.map(t => t.r75)).toFixed(2)} · LL ${ll75.toFixed(3)} vs equal ${eq75.toFixed(3)} vs standings history ${ph.toFixed(3)} ${ll75 < eq75 && ll75 < ph ? '✅' : '❌'}`); }
  console.log(`  1st seed won ${titles.filter(t => t.seed === 1).length}/${titles.length} · top-2 seed won ${titles.filter(t => t.seed <= 2).length}/${titles.length} · seed 7+ won ${titles.filter(t => t.seed >= 7).length}/${titles.length}`);
  console.log(`\nVERDICT: ${verdict.every(Boolean) ? '🟡 fair -- title odds at the playoff start beat equal odds AND seed history in both halves' : '❌ -- title odds at the playoff start did not beat both baselines in both halves'}`);
  fs.writeFileSync(path.join(CACHE, 'params.json'), JSON.stringify(P));
  process.exit(0);
}
// ---------- live board (+ --export; BP_TODAY=YYYY-MM-DD rewinds it to a past date) ----------
{
  const S0 = await all(), P = loadP(), asOf = new Date(Date.parse(today + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
  const S = Object.fromEntries(Object.entries(S0).map(([Y, G]) => [Y, rewind(G, asOf)]));
  let Y = CURY; if (!regOf(S[Y] || []).length) Y--;
  const G = S[Y], reg = regOf(G), first = firstFinal(G), done = G.some(g => g.final && g.fin) && !!premier(G), f = LG.fmt(Y), N = +(arg('--sims') || 20000);
  const finalsStarted = G.some(g => g.final && g.fin), started = reg.some(g => g.fin);
  const stage = done ? 'done' : finalsStarted ? 'playoffs' : started ? 'regular' : 'preseason';
  // title odds: before the playoffs = rest of the regular season + playoffs; once the playoffs start = FROZEN at the start of the playoffs
  // (ratings fit on games before the first playoff game, seeds from the final standings) -- the user never bets within the playoffs
  const pAt = finalsStarted ? first : asOf, otr = otShare(pool(S, Y).filter(g => g.d < pAt));
  const M = fit(pool(S, Y), pAt, P), T = simulate(M, P, reg, Y, N, finalsStarted ? endSeeds(G) : null, otr);
  // champion profile: this season as of today (start of the playoffs once they begin). Preseason: last season's end of the regular season
  let PG = G, PY = Y, pAsOf = pAt;
  if (stage === 'preseason') { let q = Y - 1; while (LG.nodata.includes(q)) q--; if (S[q]?.length) { PG = S[q]; PY = q; pAsOf = firstFinal(PG) || asOf; } }
  const {rows} = profile(PG, pool(S, PY), pAsOf, P);
  const TS = SEASONS.filter(Yp => Yp < Y && titleOK(S, Yp)).map(Yp => { const Gp = S[Yp], ch = premier(Gp); return profile(Gp, pool(S, Yp), firstFinal(Gp), P).rows.find(r => r.id === ch); }).filter(Boolean);
  const cuts = FEATS.length ? tierCuts(TS, FEATS, 1) : [];   // each cutoff = the loosest champion (every champion cleared all of them)
  for (const r of rows) if (FEATS.length) tierScore(r, FEATS, cuts);
  addIndex(rows);
  const prof = new Map(rows.map(r => [r.id, r])), left = reg.filter(g => !g.fin).length, curT = new Set(reg.flatMap(g => [g.h, g.a]));
  const lad = ladder([...table(reg).values()], Y);
  const fair = p => p < 0.001 ? '—' : p >= 0.5 ? '-' + Math.round(100 * p / (1 - p)) : '+' + Math.round(100 * (1 - p) / p);
  const fv = (k, v) => v == null || !isFinite(v) ? '—' : k === 'pos' ? String(v) : k === 'rtg' || k === 'mgn' ? (v >= 0 ? '+' : '') + v.toFixed(2) : /ppg|rwp|form/.test(k) ? v.toFixed(3) : v.toFixed(2);
  const played = reg.filter(g => g.fin).length, pctPlayed = Math.round(100 * played / Math.max(1, reg.length));
  console.log(`${LG.title} odds -- ${Y - 1}-${String(Y).slice(2)} season, games through ${today} · ${played}/${reg.length} regular-season games played (${pctPlayed}%) · stage: ${stage}${done ? ` · CHAMPION: ${nameOf(premier(G))} (odds = frozen at the start of the playoffs)` : finalsStarted ? ' (odds frozen at the start of the playoffs)' : ''}`);
  if (PY === Y && !finalsStarted && new Set(lad.map(t => t.gp)).size > 1) console.log(`positions = points per game (teams have played ${Math.min(...lad.map(t => t.gp))}-${Math.max(...lad.map(t => t.gp))} games; the official table sorts by points)`);
  if (PY !== Y) console.log(`tiers/index = ${PY - 1}-${String(PY).slice(2)} end of the regular season (${Y - 1}-${String(Y).slice(2)} hasn't started) -- title odds are PRESEASON: the whole schedule simulated from last season's ratings (untested stage)`);
  console.log(`format: ${f.txt} · model: half-life ${P.half} d, shrink ${P.lam}, sigma ${P.sig} goals · home edge ${M.H.toFixed(2)} goals · OT/SO share ${(100 * otr.ot).toFixed(0)}%`);
  if (FEATS.length) console.log(`TIERS -- every-champion profile (${TS.length} champions): ${FEATS.map((ft, i) => cutLabel(ft, cuts[i], v => fv(ft.k, +v))).join(' · ')}`);
  console.log(`index (0-100) = ${Object.entries(IDXW).map(([k, w]) => `${LBL[k] || k} ${w}`).join(' · ')}\n`);
  const tierOf = r => !r ? '⚪ —' : r.score >= FEATS.length ? `🏆 Best (${r.score}/${FEATS.length})` : r.score === FEATS.length - 1 ? `🔵 Great (${r.score}/${FEATS.length})` : r.score === FEATS.length - 2 ? `🟢 Good (${r.score}/${FEATS.length})` : `⚪ Longshot (${r.score}/${FEATS.length})`;
  const order = lad.slice().sort((a, b) => (T.get(b.id) || 0) - (T.get(a.id) || 0) || (prof.get(b.id)?.idx ?? 0) - (prof.get(a.id)?.idx ?? 0));
  for (const t of order) {
    const p = T.get(t.id) || 0, r = prof.get(t.id), pos = PY !== Y ? (r ? r.pos + ' last season' : '-') : lad.indexOf(t) + 1;
    console.log(`  ${(FEATS.length ? tierOf(r) : '').padEnd(18)} ${String(nameOf(t.id)).padEnd(20)} #${String(pos).padEnd(2)} (${rec(t)}, diff ${t.gf - t.ga >= 0 ? '+' : ''}${t.gf - t.ga}) | idx ${r ? r.idx.toFixed(1).padStart(5) : '    —'} | rating ${(M.r.get(t.id) ?? 0) >= 0 ? '+' : ''}${(M.r.get(t.id) ?? 0).toFixed(2)} | playoffs ${(100 * (T.field.get(t.id) || 0)).toFixed(0).padStart(3)}% | title ${(100 * p).toFixed(1).padStart(5)}% (fair ${fair(p)})${r && FEATS.length ? ' | ' + FEATS.map((ft, i) => `${r.q[i] ? '✓' : '✗'} ${ft.label}`).join(' · ') : ''}`); }
  if (arg('--export')) {
    const out = {league: lg, label: LG.label, season: Y, profile_season: PY, generated: new Date().toISOString(), today, stage, first_final: first || null, games_left: left, sims: N, pct_played: pctPlayed,
      premier: done ? nameOf(premier(G)) : null, champions: TS.length, sig: P.sig, hfa: +M.H.toFixed(2), format: f.txt,
      cats: FEATS.map((ft, i) => cutLabel(ft, cuts[i], v => fv(ft.k, +v))), labels: FEATS.map(ft => ft.label),
      teams: lad.map((t, i) => { const r = prof.get(t.id);
        return {id: t.id, name: nameOf(t.id), pos: PY !== Y ? (r?.pos ?? null) : i + 1, gp: t.gp, w: t.w + t.otw, l: t.l + t.otl, pts: t.p, gf: t.gf, ga: t.ga, p: T.get(t.id) || 0, playoffs: T.field.get(t.id) || 0, minor: T.minor.get(t.id) || 0,
          score: r?.score ?? 0, q: r?.q ?? FEATS.map(() => false), vals: FEATS.map(ft => !r ? '—' : `${fv(ft.k, r[ft.k])} #${r['r_' + ft.k]}`), idx: r ? +r.idx.toFixed(1) : null, rtg: +(M.r.get(t.id) ?? 0).toFixed(2)}; })};
    fs.writeFileSync(arg('--export'), JSON.stringify(out)); console.log('\nexported -> ' + arg('--export'));
  }
  const bk = arg('--book'), evs = new Map();
  if (bk) { console.log('\nBOOK PRICES (pasted screenshot) -- EV = model p x decimal odds - 1');
    const names = [...curT].map(id => [id, [nameOf(id), ...(NAMES[id]?.alias || [])].filter(Boolean).map(strip)]);
    for (const pair of bk.split(',')) { const m = pair.trim().match(/^(.*?):\s*([+-]?\d+)$/); if (!m) continue; const am = +m[2], dec = am > 0 ? 1 + am / 100 : 1 + 100 / -am, w = strip(m[1].trim());
      const id = names.find(([k, ns]) => strip(k) === w || ns.some(n => n === w))?.[0] || names.find(([, ns]) => ns.some(n => n.includes(w) || w.includes(n)))?.[0], p = id ? (T.get(id) || 0) : null;
      if (id) evs.set(id, {am, ev: p * dec - 1});
      console.log(`  ${m[1].padEnd(22)} ${m[2].padStart(6)} implied ${(100 / dec).toFixed(1)}% | ${id ? nameOf(id) + ' ' : ''}model ${p == null ? 'n/a (name not matched)' : (100 * p).toFixed(1) + '% (fair ' + fair(p) + ') -> EV ' + (p * dec - 1 >= 0 ? '+' : '') + Math.round(100 * (p * dec - 1)) + '%'}`); } }
  if (rest.includes('--log')) {
    const file = `C:/Users/User/baseball-blueprint/${lg}-history.md`, head = `# ${LG.title} Blueprint — Run History\n\nEach run prepends a dated snapshot (engine: baseball-blueprint/pro/euhockey.mjs ${lg}).\n\n---\n\n`;
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : head, i = old.indexOf('---\n\n');
    let body = i >= 0 ? old.slice(i + 5) : ''; if (body.startsWith(`## ${today} `)) { const nx = body.indexOf('\n## '); body = nx >= 0 ? body.slice(nx + 1) : ''; }
    const entry = `## ${today} (${Y - 1}-${String(Y).slice(2)} season, ${stage === 'preseason' ? 'preseason board, untested' : stage}, ${pctPlayed}% of the regular season played${done ? `, champion ${nameOf(premier(G))}` : ''})\n\n${[...T].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, p]) => `- ${nameOf(id)} ${prof.get(id) && FEATS.length ? prof.get(id).score + '/' + FEATS.length + ' · ' : ''}idx ${prof.get(id)?.idx?.toFixed(0) ?? '—'} · ${(100 * p).toFixed(1)}% (fair ${fair(p)})${evs.has(id) ? ` · book ${evs.get(id).am > 0 ? '+' : ''}${evs.get(id).am} → EV ${evs.get(id).ev >= 0 ? '+' : ''}${Math.round(100 * evs.get(id).ev)}%` : ''}`).join('\n')}\n\n`;
    fs.writeFileSync(file, i >= 0 ? old.slice(0, i + 5) + entry + body : old + entry); console.log('\nlogged to ' + file);
  }
}
