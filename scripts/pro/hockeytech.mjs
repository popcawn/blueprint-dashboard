// AHL (Calder Cup) + ECHL (Kelly Cup) engine (built 2026-11-24, same design as nll.mjs / rugby.mjs).
// Data: HockeyTech's public schedule feed (lscluster.hockeytech.com/feed/index.php, feed=modulekit&view=schedule&season_id=N), the JSON the
// AHL and ECHL websites call with the public client keys embedded in their pages (user: "go ahead with key feed"). Read-only game results;
// one request per season id (regular seasons and playoffs have separate ids, mapped by view=seasons), cached in %TEMP%\pro_bp_cache\<lg>,
// 1.2 s between requests, finished seasons never re-fetched, the live season at most every 6 hours. A refused request stops the run.
// Season Y = the year it ends (2026-27 = 2027). AHL: 2020 cancelled, 2021 no Calder Cup (Pacific-only playoff). ECHL: 2020 cancelled.
// Model: team ratings from game MARGINS (recency-weighted ridge regression, last season + this one; OT/shootout games count as +-otm goals)
// + one home edge; P(home win) = Phi(margin / sigma). Season sim: remaining regular-season games (OT/SO share calibrated: loser gets 1 point)
// -> standings (points %, then the era's tiebreakers) -> that season's playoff format (FMT below, every bracket verified with `check`).
//   node hockeytech.mjs <ahl|echl> check | backtest | dump | index | [live] [--log] [--book "Hershey:+500,..."] [--export file] [--sims N]
// NO KALSHI / Polymarket, no Odds API credits. Prices only from the user's DraftKings/FanDuel screenshot via --book.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {rankRows, cutoffs as tierCuts, score as tierScore, cutLabel} from './tiers.mjs';

// ---------- playoff formats (each verified series-by-series against the real brackets with `check`) ----------
// kind 'div': each division seeds its top n (number, or {division: n}); the division bracket produces a division champion; the two division
//   champions of a conference meet in the conference final; conference champions meet in the final. cross: the 5th team of a conference's
//   bigger division takes the smaller division's 4th spot when its points % is better.
// kind 'conf': each conference seeds its top n (division winners first when divTop), its bracket produces the conference champion -> final.
// Brackets: 2^R slots, byes to the top seeds, first round high v low; reseed: later rounds re-paired 1 v lowest remaining; else a fixed
//   bracket (1/8 v 4/5, 2/7 v 3/6). r = best-of length per round (group rounds, [conference final,] final).
const SET = a => new Set(a);
const CFG = {
  ahl: {label: 'AHL', cup: 'Calder Cup', key: 'ccb91f29d6744675', code: 'ahl', first: 2005, skip: [2020, 2021],
    conf: (dv, Y) => (Y >= 2016 ? SET(['Atlantic', 'North']) : Y >= 2012 ? SET(['Atlantic', 'Northeast', 'East']) : SET(['Atlantic', 'East'])).has(dv) ? 'East' : 'West',
    FMT: Y => Y >= 2022 ? {kind: 'div', n: {bySize: {7: 5, 8: 6, 9: 7, 10: 7}}, reseed: true, r: [3, 5, 5, 7, 7], txt: '23 teams: a 7-team division sends 5, an 8-team division 6, a 9-10-team division 7 · byes to the top seeds · reseeded · first round best-of-3, division semis + finals best-of-5, conference finals + Calder Cup Finals best-of-7'}
      : Y >= 2016 && Y <= 2019 ? {kind: 'div', n: 4, cross: true, r: [5, 7, 7, 7], txt: 'top 4 per division (crossover from a bigger division) · first round best-of-5, then best-of-7'}
      : Y >= 2012 && Y <= 2015 ? {kind: 'conf', n: 8, divTop: true, reseed: true, r: [5, 7, 7, 7], txt: 'top 8 per conference (division winners seeded first) · reseeded · first round best-of-5, then best-of-7'}
      : Y >= 2005 && Y <= 2011 ? {kind: 'div', n: 4, cross: true, r: [7, 7, 7, 7], txt: 'top 4 per division (crossover from a bigger division) · all best-of-7'} : null},
  echl: {label: 'ECHL', cup: 'Kelly Cup', key: '2c2b89ea7345cae8', code: 'echl', first: 2011, skip: [2020],
    conf: (dv, Y) => SET(['Mountain', 'Pacific', 'Central', 'West', 'Midwest']).has(dv) ? 'West' : 'East',
    FMT: Y => Y >= 2022 || (Y >= 2017 && Y <= 2019) || Y === 2015 ? {kind: 'div', n: 4, r: [7, 7, 7, 7], txt: 'top 4 per division · 1v4 / 2v3 · division finals, conference finals, Kelly Cup Finals · all best-of-7'}
      : Y === 2021 ? {kind: 'conf', n: 4, r: [5, 5, 5], txt: 'top 4 per conference (COVID season, points %) · all best-of-5'}
      : Y === 2016 || Y === 2013 || Y === 2014 ? {kind: 'conf', n: 8, divTop: true, r: [7, 7, 7, 7], txt: 'top 8 per conference (division winners seeded first) · fixed bracket · all best-of-7'}
      : Y === 2011 || Y === 2012 ? {kind: 'conf', n: {East: 8, West: 7}, divTop: true, r: [5, 7, 7, 7], txt: 'top 8 East / top 7 West (division winners seeded first, West #1 bye) · fixed bracket · first round best-of-5, then best-of-7'} : null},
};
// standings tiebreakers after points % (checked with `check`: the chain that reproduces the most real fields/brackets)
const CHAIN = {ahl: Y => Y >= 2022 ? ['rw', 'row', 'w', 'h2h', 'gd'] : ['row', 'h2h', 'gd'], echl: Y => ['row', 'gd', 'h2h']};
// P: tuned by `backtest` on the first half of the seasons (AHL 2005-14, ECHL 2011-18; written to the cache's params.json; these are the values
// it found, interior of the half-life/shrink grid; otm 1 = the real one-goal OT/SO margin)
const P0 = {ahl: {half: 90, lam: 12, otm: 0.5, sig: 2.8}, echl: {half: 90, lam: 12, otm: 1, sig: 2.4}};
// every-champion profiles (study/criteria.mjs <lg> on `dump`, 2026-11-24; end of the regular season, ranks among every team):
// AHL: all 20 champions 2005-26 cleared all 5; ~6.7 of the ~17.8 playoff teams do. Honest test (whole search re-run without each season): the hidden
//   champion cleared all 5 in 16/20 (9/10 | 7/10) and beat a coin flip over the field in both halves (log-loss 2.31 vs 2.77 | 2.77 vs 2.95).
//   Misses: 2011 Binghamton, 2016 Lake Erie, 2017 Grand Rapids, 2026 Toronto (15th seed). A loose profile -> context; the odds come from the sim.
// ECHL: all 15 champions 2011-26 cleared all 5; ~5.7 of the ~15.3 playoff teams do. Honest test: 11/15 (6/8 | 5/7), beat a coin flip in both halves
//   but barely in the 2nd (2.59 vs 2.76 | 2.65 vs 2.67). Misses: 2012 + 2022 + 2023 Florida, 2016 Allen. Context only.
const FEATSOF = {
  ahl: [{k: 'rtg', dir: 1, kind: 'rank', label: 'Rating'}, {k: 'form10', dir: 1, kind: 'value', label: 'Form (pts%, last 10)'}, {k: 'form20', dir: 1, kind: 'rank', label: 'Form (pts%, last 20)'},
    {k: 'hpp', dir: 1, kind: 'rank', label: 'Home points %'}, {k: 'app', dir: 1, kind: 'value', label: 'Away points %'}],
  echl: [{k: 'ptp', dir: 1, kind: 'value', label: 'Points %'}, {k: 'rwp', dir: 1, kind: 'rank', label: 'Regulation wins/game'}, {k: 'gfpg', dir: 1, kind: 'value', label: 'Goals for/game'},
    {k: 'gapg', dir: -1, kind: 'value', label: 'Goals against/game'}, {k: 'hpp', dir: 1, kind: 'value', label: 'Home points %'}]};
// index (`index` mode, ties = mid-rank): champion's rank in the playoff field. AHL rating 50 + goal diff/g 50: avg #4.05 (3.90 | 4.20), #1 7/20 vs rating alone
// #4.15 (3.90 | 4.40). ECHL same weights: avg #3.47 (3.00 | 4.00), #1 6/15 vs rating alone #3.67 (3.38 | 4.00) -> matched or beat the rating in both halves
const IDXWOF = {ahl: {rtg: 50, mgn: 50}, echl: {rtg: 50, mgn: 50}};

const [lk, mode0 = 'live', ...rest] = process.argv.slice(2);
const L = CFG[lk]; if (!L) { console.log('usage: node hockeytech.mjs <ahl|echl> [check|backtest|dump|index|live] [--log] [--book "..."] [--export f] [--sims N]'); process.exit(1); }
const mode = mode0.startsWith('--') ? 'live' : mode0; if (mode0.startsWith('--')) rest.unshift(mode0);
const arg = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
const CACHE = path.join(os.tmpdir(), 'pro_bp_cache', lk); fs.mkdirSync(CACHE, {recursive: true});
const today = process.env.BP_TODAY || new Date().toLocaleDateString('en-CA');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
const FEATS = FEATSOF[lk], IDXW = IDXWOF[lk];

// ---------- data: HockeyTech feed ----------
let lastReq = 0;
async function feed(view, extra = '') {
  const wait = lastReq + 1200 - Date.now(); if (wait > 0) await sleep(wait);
  const u = `https://lscluster.hockeytech.com/feed/index.php?feed=modulekit&view=${view}${extra}&key=${L.key}&client_code=${L.code}&fmt=json`;
  lastReq = Date.now();
  const r = await fetch(u, {headers: {'User-Agent': UA}, signal: AbortSignal.timeout(60e3)});
  if (!r.ok) { console.error(`HockeyTech feed refused the request (${view}${extra}): HTTP ${r.status} -- stopping (no workaround).`); process.exit(2); }
  return r.json();
}
async function seasonList() {
  const f = path.join(CACHE, 'seasons.json');
  if (!fs.existsSync(f) || Date.now() - fs.statSync(f).mtimeMs > 24 * 3600e3) { const j = await feed('seasons'); if (j?.SiteKit?.Seasons?.length) fs.writeFileSync(f, JSON.stringify(j)); }
  return JSON.parse(fs.readFileSync(f, 'utf8')).SiteKit.Seasons;
}
async function schedule(id, live) {   // compact copy of one season id's schedule
  const f = path.join(CACHE, `s${id}.json`);
  if (fs.existsSync(f) && (!live || Date.now() - fs.statSync(f).mtimeMs < 6 * 3600e3)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const j = await feed('schedule', `&season_id=${id}`), G = j?.SiteKit?.Schedule || [];
  const out = G.map(g => ({id: g.game_id, d: g.date_played, h: g.home_team, a: g.visiting_team, hc: g.home_team_code, ac: g.visiting_team_code, hn: g.home_team_name, an: g.visiting_team_name,
    hdv: g.home_team_division_short, adv: g.visiting_team_division_short, hs: +g.home_goal_count, as: +g.visiting_goal_count, ot: +g.overtime, so: +g.shootout, st: g.status, fin: g.final === '1',
    gs: g.game_status, L: g.game_letter, n: g.game_number, ifn: g.if_necessary, nt: g.schedule_notes || ''}));
  if (out.length) fs.writeFileSync(f, JSON.stringify(out)); else if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  return out;
}
const CURY = +today.slice(0, 4) + (+today.slice(5, 7) >= 8 ? 1 : 0);
const SEAS = {}, NAMES = {};
async function all() {
  const list = await seasonList(), S = {};
  const regs = list.filter(s => /Regular Season/i.test(s.season_name) && s.start_date <= today);
  for (const r of regs) {
    const Y = +r.end_date.slice(0, 4); if (Y < L.first - 1 || Y > CURY) continue;
    const po = list.find(s => s.playoff === '1' && +s.start_date.slice(0, 4) === Y), live = Y >= CURY;
    const R = await schedule(r.season_id, live), PO = po ? await schedule(po.season_id, live) : [];
    const mk = (g, final) => ({Y, id: g.id, d: g.d, h: g.h, a: g.a, hs: g.fin ? g.hs : null, as: g.fin ? g.as : null, ot: !!(g.ot || g.so), so: !!g.so, fin: g.fin && g.st !== '1', final, L: g.L});
    const reg = R.filter(g => g.h && g.a && g.d).map(g => mk(g, false)), pg = PO.filter(g => g.h && g.a && g.d).map(g => mk(g, true));
    const teams = new Map(), dvc = new Map();
    for (const g of R) for (const [t, n, c, dv] of [[g.h, g.hn, g.hc, g.hdv], [g.a, g.an, g.ac, g.adv]]) {
      if (!teams.has(t)) teams.set(t, {id: t, name: n, code: c}); const k = t + '|' + dv; dvc.set(k, (dvc.get(k) || 0) + 1); }
    for (const t of teams.values()) { let best = null; for (const [k, v] of dvc) { const [id, dv] = k.split('|'); if (id === t.id && (!best || v > best[1])) best = [dv, v]; } t.div = best?.[0] || '?'; t.conf = L.conf(t.div, Y); }
    for (const t of teams.values()) (NAMES[t.id] ||= {})[Y] = t.name;
    reg.sort((x, y) => x.d.localeCompare(y.d)); pg.sort((x, y) => x.d.localeCompare(y.d));
    S[Y] = {Y, reg, po: pg, teams};
  }
  return Object.assign(SEAS, S);
}
const nameOf = (id, Y) => NAMES[id]?.[Y] || Object.values(NAMES[id] || {}).pop() || id;
// real playoff series, keyed by the sorted pair: winner + games won
function realSeries(po) {
  const S = new Map();
  for (const g of po.filter(g => g.fin)) { const k = [g.h, g.a].sort().join('-'), s = S.get(k) || {k, L: g.L, d0: g.d, d1: g.d, w: {}}; s.d1 = g.d; const x = g.hs > g.as ? g.h : g.a; s.w[x] = (s.w[x] || 0) + 1; S.set(k, s); }
  for (const s of S.values()) { const e = Object.entries(s.w).sort((a, b) => b[1] - a[1]); s.win = e[0][0]; s.wins = e[0][1]; s.lose = e[1]?.[1] || 0; }
  return S;
}
function champion(Sy) {
  if (!Sy?.po.some(g => g.fin)) return null;
  const RS = realSeries(Sy.po), last = Sy.po.filter(g => g.fin).pop(), s = RS.get([last.h, last.a].sort().join('-')), need = Math.ceil((FMTY(Sy.Y)?.r.slice(-1)[0] || 7) / 2);
  return s && s.wins >= need ? s.win : null;
}
const FMTY = Y => L.FMT(Y);

// ---------- ratings (ridge on margins, one home edge) ----------
const margin = (g, P) => g.ot ? Math.sign(g.hs - g.as) * P.otm : g.hs - g.as;
function fit(games, asOf, P, warm = null) {
  const G = games.filter(g => g.fin && g.d < asOf), t0 = Date.parse(asOf + 'T12:00:00Z');
  const w = G.map(g => Math.pow(0.5, (t0 - Date.parse(g.d + 'T12:00:00Z')) / 864e5 / P.half)), m = G.map(g => margin(g, P));
  const T = [...new Set(G.flatMap(g => [g.h, g.a]))], r = new Map(T.map(t => [t, warm?.r.get(t) ?? 0])), idx = new Map();
  for (const [i, g] of G.entries()) for (const t of [g.h, g.a]) { if (!idx.has(t)) idx.set(t, []); idx.get(t).push(i); }
  let H = warm?.H ?? 0.2;
  for (let it = 0; it < (warm ? 12 : 40); it++) {
    for (const t of T) { let den = P.lam, n2 = 0; for (const i of idx.get(t)) { const g = G[i], s = g.h === t ? 1 : -1, other = r.get(g.h === t ? g.a : g.h); den += w[i]; n2 += w[i] * (s * (m[i] - H) + other); } r.set(t, n2 / den); }
    const mu = T.length ? mean([...r.values()]) : 0; for (const t of T) r.set(t, r.get(t) - mu);
    let ss = 0, ws = 0; for (const [i, g] of G.entries()) { ss += w[i] * (m[i] - (r.get(g.h) - r.get(g.a))); ws += w[i]; }
    H = ws ? ss / ws : 0;
  }
  return {r, H};
}
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
const Phi = x => 0.5 * (1 + erf(x / Math.SQRT2));
function PhiInv(p) { let lo = -8, hi = 8; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; }
const predMargin = (M, h, a) => (M.r.get(h) ?? 0) - (M.r.get(a) ?? 0) + M.H;
const pHome = (M, h, a, P) => Phi(predMargin(M, h, a) / P.sig);
const LLf = (p, y) => -(y * Math.log(Math.max(p, 1e-6)) + (1 - y) * Math.log(Math.max(1 - p, 1e-6)));
const randn = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// ---------- standings ----------
const ptp = t => t.gp ? t.pts / (2 * t.gp) : 0;
function table(reg, teams) {
  const T = new Map();
  for (const t of teams.values()) T.set(t.id, {id: t.id, div: t.div, conf: t.conf, gp: 0, w: 0, l: 0, otl: 0, rw: 0, row: 0, pts: 0, gf: 0, ga: 0});
  for (const g of reg) for (const t of [g.h, g.a]) if (!T.has(t)) T.set(t, {id: t, div: '?', conf: '?', gp: 0, w: 0, l: 0, otl: 0, rw: 0, row: 0, pts: 0, gf: 0, ga: 0});
  for (const g of reg.filter(g => g.fin)) { const H = T.get(g.h), A = T.get(g.a), hw = g.hs > g.as, W = hw ? H : A, Lo = hw ? A : H;
    H.gp++; A.gp++; H.gf += g.hs; H.ga += g.as; A.gf += g.as; A.ga += g.hs; W.w++; W.pts += 2; if (!g.ot) W.rw++; if (!g.so) W.row++;
    if (g.ot) { Lo.otl++; Lo.pts++; } else Lo.l++; }
  return T;
}
// rank by points %, ties broken by the era's chain; h2h = points % in the games among the tied teams (real tables only)
function ladder(rows, Y, games = null) {
  const s = rows.slice().sort((x, y) => ptp(y) - ptp(x) || y.w - x.w || (y.gf - y.ga) - (x.gf - x.ga));
  if (!games) return s;
  const chain = CHAIN[lk](Y);
  const keyv = (k, t, grp) => {
    if (k === 'h2h') { const S = new Set(grp.map(x => x.id)); let p = 0, n = 0; for (const g of games) if (g.fin && (g.h === t.id || g.a === t.id) && S.has(g.h) && S.has(g.a)) { n++; const won = (g.h === t.id) === (g.hs > g.as); p += won ? 2 : g.ot ? 1 : 0; } return n ? p / (2 * n) : 0.5; }
    return k === 'gd' ? t.gf - t.ga : t[k]; };
  const tie = (grp, ci) => { if (grp.length < 2 || ci >= chain.length) return grp; const v = new Map(grp.map(t => [t.id, keyv(chain[ci], t, grp)]));
    const vals = [...new Set([...v.values()].map(x => +x.toFixed(6)))].sort((a, b) => b - a);
    if (vals.length === 1) return tie(grp, ci + 1);
    return vals.flatMap(x => tie(grp.filter(t => Math.abs(v.get(t.id) - x) < 1e-6), chain[ci] === 'h2h' ? ci : ci + 1)); };
  const out = []; for (let i = 0; i < s.length;) { let j = i; while (j < s.length && Math.abs(ptp(s[j]) - ptp(s[i])) < 1e-9) j++; out.push(...tie(s.slice(i, j), 0)); i = j; }
  return out;
}
// h2h re-applies to a smaller still-tied subset; a guard stops an endless loop when h2h can't split a subset
// (tie() moves to the next key when every value is equal, so recursion on h2h always shrinks the group)

// ---------- playoff field + bracket ----------
// groups: [{conf, div, seeds: [ids]}]; lad = overall ladder (best first)
function fieldOf(lad, Y, games = null) {
  const mx = Math.max(...lad.map(t => t.gp)); lad = lad.filter(t => t.gp >= 0.6 * mx);   // clubs that folded mid-season (ECHL 2014 San Francisco) can't qualify
  const f = FMTY(Y), rowsBy = k => lad.filter(t => t[f.kind === 'div' ? 'div' : 'conf'] === k), out = [];
  const nOf = k => typeof f.n === 'number' ? f.n : f.n.bySize ? f.n.bySize[lad.filter(t => t.div === k).length] ?? 0 : f.n[k] ?? 0;   // bySize: AHL 2022+ qualifiers follow division size (Atlantic 8->6, North/Central 7->5, Pacific 9-10->7 in 2022-26; 2026-27 Atlantic 7 / North 8 after Bridgeport -> Hamilton = assumed 5 / 6)
  if (f.kind === 'div') {
    const divs = [...new Set(lad.map(t => t.div))].filter(d => d !== '?');
    const D = Object.fromEntries(divs.map(d => [d, ladder(rowsBy(d), Y, games)]));
    for (const d of divs) out.push({conf: L.conf(d, Y), div: d, seeds: D[d].slice(0, nOf(d)).map(t => t.id)});
    if (f.cross) for (const c of ['East', 'West']) { const g = out.filter(x => x.conf === c); if (g.length !== 2) continue;
      const [big, small] = D[g[0].div].length >= D[g[1].div].length ? g : [g[1], g[0]]; if (D[big.div].length === D[small.div].length) continue;
      const cand = D[big.div][nOf(big.div)], o = lad.find(t => t.id === small.seeds[nOf(small.div) - 1]);
      if (cand && o && ptp(cand) > ptp(o) + 1e-9) { small.seeds[nOf(small.div) - 1] = cand.id;   // the crossover team is seeded by its record (2011 Binghamton 3rd)
        const ids = new Set(small.seeds); small.seeds = ladder(lad.filter(t => ids.has(t.id)), Y, games).map(t => t.id); } }
  } else {
    for (const c of ['East', 'West']) { const C = ladder(rowsBy(c), Y, games); if (!C.length) continue; let seeds = C;
      if (f.divTop) { const divs = [...new Set(C.map(t => t.div))], winners = divs.map(d => ladder(C.filter(t => t.div === d), Y, games)[0]);
        const wset = new Set(winners.map(t => t.id)); seeds = C.filter(t => wset.has(t.id)).concat(C.filter(t => !wset.has(t.id))); }
      out.push({conf: c, div: null, seeds: seeds.slice(0, nOf(c)).map(t => t.id)}); }
  }
  return out;
}
const order = n => n <= 1 ? [1] : order(n / 2).flatMap(s => [s, n + 1 - s]);
// play one group's bracket: seeds best first; series(hi, lo, len) -> winner; returns the group champion
function playGroup(seeds, rl, reseed, series) {
  const n = seeds.length, R = Math.ceil(Math.log2(Math.max(2, n))), size = 1 << R;
  let cur = order(size).map(s => s <= n ? s : null);   // seed numbers in bracket order
  for (let r = 0; r < R; r++) {
    if (reseed && r > 0) { const alive = cur.filter(x => x != null).sort((a, b) => a - b), o = order(alive.length); cur = o.map(i => alive[i - 1]); }
    const nx = [];
    for (let i = 0; i < cur.length; i += 2) { const x = cur[i], y = cur[i + 1];
      if (x == null || y == null) { nx.push(x ?? y); continue; }
      const hi = Math.min(x, y), lo = Math.max(x, y); nx.push(series(seeds[hi - 1], seeds[lo - 1], rl[r]) === seeds[hi - 1] ? hi : lo); }
    cur = nx;
  }
  return seeds[cur[0] - 1];
}
const groupRounds = n => Math.ceil(Math.log2(Math.max(2, n)));
// whole playoffs: rank = overall ladder index (lower hosts across groups)
function playAll(groups, Y, rank, series) {
  const f = FMTY(Y), R0 = Math.max(...groups.map(g => groupRounds(g.seeds.length)));
  const champs = groups.map(g => ({conf: g.conf, id: playGroup(g.seeds, f.r.slice(R0 - groupRounds(g.seeds.length)), !!f.reseed, series)}));
  const meet = (a, b, len) => { const hi = rank.get(a) <= rank.get(b) ? a : b; return series(hi, hi === a ? b : a, len); };
  let confW;
  if (f.kind === 'div') confW = ['East', 'West'].map(c => { const x = champs.filter(z => z.conf === c); return x.length === 2 ? meet(x[0].id, x[1].id, f.r[R0]) : x[0]?.id; }).filter(Boolean);
  else confW = champs.map(z => z.id);
  return confW.length === 2 ? meet(confW[0], confW[1], f.r[f.r.length - 1]) : confW[0];
}
const HOSTS = {3: [1, 0, 1], 5: [1, 1, 0, 0, 1], 7: [1, 1, 0, 0, 1, 0, 1]};
function simSeries(game) { return (hi, lo, len) => { const need = (len + 1) / 2, pat = HOSTS[len]; let a = 0, b = 0;
  for (let i = 0; a < need && b < need; i++) { const w = pat[i] ? game(hi, lo) : game(lo, hi); if (w === hi) a++; else b++; } return a === need ? hi : lo; }; }
function simulate(M, P, Sy, N = 20000, fixedGroups = null, band = 0.7) {
  const reg = Sy.reg, base = table(reg, Sy.teams), left = reg.filter(g => !g.fin), cup = new Map(), field = new Map(), top = new Map();
  const game = (h, a) => Math.random() < Phi(predMargin(M, h, a) / P.sig) ? h : a, series = simSeries(game);
  const pm = left.map(g => predMargin(M, g.h, g.a)), realLad = ladder([...base.values()], Sy.Y, reg);
  for (let s = 0; s < N; s++) {
    let groups = fixedGroups, lad = realLad;
    if (!groups) {
      const T = new Map([...base].map(([k, v]) => [k, {...v}]));
      for (let i = 0; i < left.length; i++) { const g = left[i], mg = pm[i] + P.sig * randn(), H = T.get(g.h), A = T.get(g.a), ot = Math.abs(mg) < band, W = mg > 0 ? H : A, Lo = W === H ? A : H;
        const x = ot ? 1 : Math.max(1, Math.round(Math.abs(mg)));
        H.gp++; A.gp++; W.w++; W.pts += 2; if (!ot) W.rw++; W.row++; W.gf += x; Lo.ga += x; if (ot) { Lo.otl++; Lo.pts++; } else Lo.l++; }
      lad = ladder([...T.values()], Sy.Y); groups = fieldOf(lad, Sy.Y);
    }
    const rank = new Map(lad.map((t, i) => [t.id, i]));
    top.set(lad[0].id, (top.get(lad[0].id) || 0) + 1); for (const g of groups) for (const id of g.seeds) field.set(id, (field.get(id) || 0) + 1);
    const ch = playAll(groups, Sy.Y, rank, series); cup.set(ch, (cup.get(ch) || 0) + 1);
  }
  const out = new Map([...cup].map(([k, v]) => [k, v / N])); out.field = new Map([...field].map(([k, v]) => [k, v / N])); out.minor = new Map([...top].map(([k, v]) => [k, v / N])); return out;
}
// OT/SO band for simulated games: |margin draw| < band -> decided after regulation (loser gets a point); calibrated to the league's real OT share
const otBand = (S, P) => { const g = Object.values(S).flatMap(s => s.reg.filter(x => x.fin)), sh = mean(g.map(x => x.ot ? 1 : 0)); return P.sig * PhiInv(0.5 + sh / 2); };
const loadP = () => fs.existsSync(path.join(CACHE, 'params.json')) ? JSON.parse(fs.readFileSync(path.join(CACHE, 'params.json'), 'utf8')) : P0[lk];
const pool = (S, Y) => { let q = Y - 1; while (L.skip.includes(q) && !S[q]?.reg.length) q--; return [...(S[q]?.reg || []), ...(S[q]?.po || []), ...(S[Y]?.reg || []), ...(S[Y]?.po || [])]; };
const firstPO = Sy => Sy.po.map(g => g.d).sort()[0];
const playoffTeams = Sy => [...new Set(Sy.po.flatMap(g => [g.h, g.a]))];
const SEASONS = () => Object.keys(SEAS).map(Number).filter(Y => Y >= L.first && !L.skip.includes(Y)).sort((a, b) => a - b);
const endField = Sy => { const lad = ladder([...table(Sy.reg, Sy.teams).values()], Sy.Y, Sy.reg); return {lad, groups: fieldOf(lad, Sy.Y, Sy.reg)}; };

// ---------- champion profile (end of the regular season = the day before the first playoff game) ----------
function profile(Sy, pl, asOf, P) {
  const reg = Sy.reg.filter(g => g.fin && g.d < asOf), M = fit(pl, asOf, P), T = table(reg, Sy.teams), X = new Map();
  for (const g of reg) for (const [me, gf, ga, side] of [[g.h, g.hs, g.as, 1], [g.a, g.as, g.hs, -1]]) {
    const x = X.get(me) || {res: [], hp: 0, hn: 0, ap: 0, an: 0}, p = gf > ga ? 2 : g.ot ? 1 : 0;
    x.res.push([g.d, p]); if (side > 0) { x.hp += p; x.hn++; } else { x.ap += p; x.an++; } X.set(me, x); }
  const rows = ladder([...T.values()].filter(t => t.gp), Sy.Y, reg).map((t, i) => { const x = X.get(t.id), s = x.res.sort((a, b) => a[0].localeCompare(b[0])), f = n => mean(s.slice(-n).map(z => z[1])) / 2;
    return {id: t.id, div: t.div, conf: t.conf, pos: i + 1, gp: t.gp, w: t.w, l: t.l, otl: t.otl, pts: t.pts, gf: t.gf, ga: t.ga, ptp: ptp(t), wp: t.w / t.gp, rwp: t.rw / t.gp,
      pct: 100 * t.gf / Math.max(1, t.ga), gfpg: t.gf / t.gp, gapg: t.ga / t.gp, mgn: (t.gf - t.ga) / t.gp, rtg: M.r.get(t.id) ?? 0, form10: f(10), form20: f(20),
      hpp: x.hn ? x.hp / (2 * x.hn) : 0, app: x.an ? x.ap / (2 * x.an) : 0}; });
  return {rows: rankRows(rows, FEATS), M};
}
function addIndex(rows, W = IDXW) {
  const N = {}, tw = Object.values(W).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(W)) { const dir = k === 'gapg' || k === 'pos' ? -1 : 1, v = rows.map(r => +r[k]), lo = Math.min(...v), hi = Math.max(...v);
    N[k] = r => hi === lo ? 50 : 100 * (dir > 0 ? r[k] - lo : hi - r[k]) / (hi - lo); }
  for (const r of rows) r.idx = Object.entries(W).reduce((a, [k, w]) => a + w * N[k](r), 0) / tw;
}
const CANDS = [{k: 'pos', dir: -1, label: 'Standings position', value: true, rank: false, dec: 0}, {k: 'ptp', dir: 1, label: 'Points %', value: true}, {k: 'wp', dir: 1, label: 'Win%', value: true},
  {k: 'rwp', dir: 1, label: 'Regulation wins/game', value: true}, {k: 'pct', dir: 1, label: 'Goals for/against %', value: true}, {k: 'gfpg', dir: 1, label: 'Goals for/game', value: true},
  {k: 'gapg', dir: -1, label: 'Goals against/game', value: true}, {k: 'mgn', dir: 1, label: 'Goal diff/game', value: true}, {k: 'rtg', dir: 1, label: 'Rating', value: true},
  {k: 'form10', dir: 1, label: 'Form (points %, last 10)', value: true}, {k: 'form20', dir: 1, label: 'Form (points %, last 20)', value: true},
  {k: 'hpp', dir: 1, label: 'Home points %', value: true}, {k: 'app', dir: 1, label: 'Away points %', value: true}];
const yv = g => g.hs > g.as ? 1 : 0;
const done = S => SEASONS().filter(Y => FMTY(Y) && champion(S[Y]));

if (mode === 'dump') {   // every team's end-of-regular-season profile -> study/data/<lg>.json (input for study/criteria.mjs)
  const S = await all(), P = loadP(), K = CANDS.map(c => c.k);
  const out = {sport: lk, label: L.cup, when: 'end of the regular season', fieldLabel: 'the playoff teams', universeLabel: `every ${L.label} team`, cands: CANDS, seasons: []};
  for (const Y of done(S)) {
    const Sy = S[Y], ch = champion(Sy), {rows} = profile(Sy, pool(S, Y), firstPO(Sy), P);
    out.seasons.push({Y, champ: ch, champName: nameOf(ch, Y), field: playoffTeams(Sy), rows: rows.map(r => Object.fromEntries([['id', r.id], ['name', nameOf(r.id, Y)], ...K.map(k => [k, r[k]])]))});
  }
  fs.mkdirSync('C:/Users/User/baseball-blueprint/study/data', {recursive: true});
  fs.writeFileSync(`C:/Users/User/baseball-blueprint/study/data/${lk}.json`, JSON.stringify(out));
  console.log(`dumped ${out.seasons.length} seasons -> study/data/${lk}.json · champs: ${out.seasons.map(s => `${s.Y} ${s.champName} (#${s.rows.find(r => r.id === s.champ).pos} of ${s.rows.length}, field ${s.field.length})`).join(', ')}`);
  process.exit(0);
}
if (mode === 'check') {   // field + EVERY series of every bracket rebuilt from the standings (real winners fed forward) vs the real playoffs; rewind proof
  const S = await all(); let tf = 0, tfOK = 0, ts = 0, tsOK = 0;
  for (const Y of SEASONS()) {
    const Sy = S[Y], r = Sy.reg, f = FMTY(Y), ch = champion(Sy);
    let note = '';
    if (f && ch) {
      const {lad, groups} = endField(Sy), RS = realSeries(Sy.po), rank = new Map(lad.map((t, i) => [t.id, i])), mis = [];
      const want = groups.flatMap(g => g.seeds).sort().join(), real = playoffTeams(Sy).sort().join(), fOK = want === real;
      let n = 0, ok = 0;
      const oracle = (hi, lo, len) => { n++; const s = RS.get([hi, lo].sort().join('-')); if (s && s.wins === (len + 1) / 2) { ok++; return s.win; }
        mis.push(`${nameOf(hi, Y)}-${nameOf(lo, Y)} bo${len}${s ? ` (real: won ${s.wins})` : ' (no such series)'}`); return s ? s.win : hi; };
      const got = playAll(groups, Y, rank, oracle);
      tf++; if (fOK) tfOK++; ts += RS.size; tsOK += ok;
      note = ` · field ${fOK ? 'OK' : 'MISMATCH model ' + groups.flatMap(g => g.seeds).filter(x => !real.includes(x)).map(x => nameOf(x, Y)).join(',') + ' / real ' + playoffTeams(Sy).filter(x => !want.includes(x)).map(x => nameOf(x, Y)).join(',')} · series ${ok}/${RS.size} rebuilt${n !== RS.size ? ` (model played ${n})` : ''} · champion via bracket ${got === ch ? 'OK' : 'MISMATCH'}${mis.length ? ' · misses: ' + mis.join('; ') : ''}`;
    }
    const fin = r.filter(g => g.fin);
    console.log(`${Y}: ${r.length} regular (${fin.length} played, ${new Set(r.flatMap(g => [g.h, g.a])).size} teams, OT/SO ${(100 * mean(fin.map(g => g.ot ? 1 : 0))).toFixed(0)}%) · ${Sy.po.length} playoff games · champion ${ch ? nameOf(ch, Y) : '—'} · ${r[0]?.d ?? '—'} .. ${r[r.length - 1]?.d ?? '—'} | playoffs ${firstPO(Sy) ?? '—'}${f ? '' : ' · format not modelled'}${note}`);
  }
  console.log(`\nfields rebuilt from the standings: ${tfOK}/${tf} · series rebuilt: ${tsOK}/${ts}`);
  // rewind proof: BP_TODAY makes every later game unplayed (scores + standings)
  const Y = Math.max(...SEASONS()), Sy = S[Y], cut = Sy.reg.filter(g => g.fin).map(g => g.d)[Math.floor(Sy.reg.filter(g => g.fin).length / 2)];
  if (cut) { const rw = Sy.reg.map(g => g.d < cut ? g : {...g, fin: false, hs: null, as: null}), T0 = table(Sy.reg, Sy.teams), T1 = table(rw, Sy.teams);
    const by = (T, rr) => { const t = ladder([...T.values()], Y, rr)[0]; return `${nameOf(t.id, Y)} ${t.w}-${t.l}-${t.otl} (${t.gp} gp)`; };
    console.log(`rewind proof (${Y - 1}-${String(Y).slice(2)}, as of ${cut}): games played ${Sy.reg.filter(g => g.fin).length} -> ${rw.filter(g => g.fin).length}; later games with a result after rewinding: ${rw.filter(g => g.d >= cut && (g.fin || g.hs != null)).length}; GP total ${[...T0.values()].reduce((a, t) => a + t.gp, 0)} -> ${[...T1.values()].reduce((a, t) => a + t.gp, 0)}; leader ${by(T0, Sy.reg)} -> ${by(T1, rw)}`); }
  process.exit(0);
}
if (mode === 'backtest' || mode === 'index') {
  const S = await all(), D = done(S), half = Math.ceil(D.length / 2), H1 = D.slice(0, half), H2 = D.slice(half);
  if (mode === 'index') {   // index weights: champion's rank inside the playoff field at the end of the regular season (lower = better), by half
    const P = loadP(), SS = D.map(Y => { const Sy = S[Y], ch = champion(Sy), {rows} = profile(Sy, pool(S, Y), firstPO(Sy), P), F = new Set(playoffTeams(Sy)); return {Y, ch, rows: rows.filter(r => F.has(r.id))}; });
    const W = [{rtg: 100}, {ptp: 100}, {mgn: 100}, {rwp: 100}, {pct: 100}, {rtg: 70, ptp: 30}, {rtg: 60, ptp: 40}, {rtg: 50, ptp: 50}, {ptp: 70, rtg: 30}, {rtg: 80, form20: 20}, {rtg: 70, form10: 30},
      {rtg: 60, gapg: 40}, {rtg: 60, gfpg: 40}, {rtg: 70, app: 30}, {rtg: 70, hpp: 30}, {rtg: 60, rwp: 40}, {rwp: 60, rtg: 40}, {mgn: 60, ptp: 40}, {rtg: 50, mgn: 50}, {ptp: 60, form20: 40}, {rtg: 60, ptp: 20, app: 20}, {rtg: 80, ptp: 20}];
    for (const w of W) { const rk = SS.map(s => { addIndex(s.rows, w); const c = s.rows.find(r => r.id === s.ch); return 1 + s.rows.filter(r => r.idx > c.idx + 1e-9).length + 0.5 * s.rows.filter(r => r !== c && Math.abs(r.idx - c.idx) <= 1e-9).length; });
      const h = Ys => mean(rk.filter((_, i) => Ys.includes(D[i])));
      console.log(`  ${Object.entries(w).map(([k, v]) => k + ' ' + v).join(' · ').padEnd(30)} champ avg rank ${mean(rk).toFixed(2)} (${h(H1).toFixed(2)} | ${h(H2).toFixed(2)}) · #1 ${rk.filter(x => x === 1).length}/${rk.length} · top-3 ${rk.filter(x => x <= 3).length}`); }
    process.exit(0);
  }
  // matches: every regular-season game, ratings refit each week (warm-started) from games before that week
  const wk = d => { const t = Date.parse(d + 'T12:00:00Z'); return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10); };
  const fitsFor = P => { const F = new Map(); for (const Y of D) { let prev = null; for (const w of [...new Set(S[Y].reg.filter(g => g.fin).map(g => wk(g.d)))].sort()) { prev = fit(pool(S, Y), w, P, prev); F.set(Y + '|' + w, prev); } } return F; };
  const evalM = (P, F, Ys) => mean(Ys.flatMap(Y => S[Y].reg.filter(g => g.fin).map(g => LLf(pHome(F.get(Y + '|' + wk(g.d)), g.h, g.a, P), yv(g)))));
  let best = null; const cache = new Map();
  for (const hl of [45, 90, 180, 365]) for (const lam of [4, 12, 30, 60]) for (const otm of [0.5, 1]) { const F = fitsFor({half: hl, lam, otm}); cache.set([hl, lam, otm].join('|'), F);
    for (const sig of [1.6, 1.8, 2, 2.2, 2.4, 2.6, 2.8, 3, 3.3, 3.6]) { const P = {half: hl, lam, otm, sig}, ll = evalM(P, F, H1); if (!best || ll < best.ll) best = {P, ll}; } }
  const P = best.P, F = cache.get([P.half, P.lam, P.otm].join('|')), band = otBand(S, P);
  const hb = Ys => { const g = Ys.flatMap(Y => S[Y].reg.filter(x => x.fin)), hr = mean(g.map(yv)); return mean(g.map(x => LLf(hr, yv(x)))); };
  const hrate = Ys => mean(Ys.flatMap(Y => S[Y].reg.filter(x => x.fin)).map(yv));
  console.log(`${L.label} backtest -- ${D[0]}-${D[D.length - 1]}, ${D.length} seasons (halves ${H1[0]}-${H1[H1.length - 1]} / ${H2[0]}-${H2[H2.length - 1]})`);
  console.log(`MATCHES (regular season, refit every week): tuned on the 1st half -> half-life ${P.half} d, shrink ${P.lam}, OT/SO margin ${P.otm}, sigma ${P.sig} goals`);
  console.log(`  1st half LL ${evalM(P, F, H1).toFixed(4)} vs home-win base rate ${hb(H1).toFixed(4)} (home won ${(100 * hrate(H1)).toFixed(1)}%) · 2nd half (held out) LL ${evalM(P, F, H2).toFixed(4)} vs ${hb(H2).toFixed(4)} (${(100 * hrate(H2)).toFixed(1)}%) · coin 0.6931`);
  const acc = Ys => mean(Ys.flatMap(Y => S[Y].reg.filter(g => g.fin).map(g => (pHome(F.get(Y + '|' + wk(g.d)), g.h, g.a, P) > 0.5) === (g.hs > g.as))));
  console.log(`  picks right: ${(100 * acc(H1)).toFixed(1)}% | ${(100 * acc(H2)).toFixed(1)}%`);
  const fm = []; for (const Y of D) { const M = fit(pool(S, Y), firstPO(S[Y]), P); for (const g of S[Y].po.filter(g => g.fin)) fm.push({Y, ll: LLf(pHome(M, g.h, g.a, P), yv(g)), y: yv(g)}); }
  const hostLL = Ys => mean(fm.filter(x => Ys.includes(x.Y)).map(x => LLf(mean(fm.filter(z => z.Y !== x.Y).map(z => z.y)), x.y))), fl = Ys => mean(fm.filter(x => Ys.includes(x.Y)).map(x => x.ll));
  console.log(`\nPLAYOFF GAMES (${fm.length}, ratings frozen at the start of the playoffs): model LL ${fl(D).toFixed(4)} (${fl(H1).toFixed(4)} | ${fl(H2).toFixed(4)}) vs "home team wins" base rate ${hostLL(D).toFixed(4)} (${hostLL(H1).toFixed(4)} | ${hostLL(H2).toFixed(4)})`);
  const titles = [];
  for (const Y of D) {
    const Sy = S[Y], ch = champion(Sy), first = firstPO(Sy), {lad, groups} = endField(Sy), fieldIds = groups.flatMap(g => g.seeds);
    const seed = 1 + lad.filter(t => fieldIds.includes(t.id)).findIndex(t => t.id === ch);
    const Tf = simulate(fit(pool(S, Y), first, P), P, Sy, 20000, groups, band);
    const played = Sy.reg.filter(g => g.fin), ds = played.map(g => g.d).sort(), d75 = ds[Math.floor(0.75 * ds.length)];
    const S75 = {...Sy, reg: played.map(g => g.d < d75 ? g : {...g, fin: false, hs: null, as: null})};
    const T75 = simulate(fit(pool(S, Y).map(g => g.Y === Y && g.d >= d75 ? {...g, fin: false} : g), d75, P), P, S75, 6000, null, band);
    const lad75 = ladder([...table(S75.reg, Sy.teams).values()], Y, S75.reg), pos75 = 1 + lad75.findIndex(t => t.id === ch);
    const rk = (T, id) => 1 + [...T.values()].filter(v => v > (T.get(id) || 0)).length;
    titles.push({Y, nF: fieldIds.length, ch: nameOf(ch, Y), seed, pos: 1 + lad.findIndex(t => t.id === ch), pos75, p: Tf.get(ch) || 0, r: rk(Tf, ch), p75: T75.get(ch) || 0, r75: rk(T75, ch), nT: lad.length});
    process.stderr.write('.');
  }
  console.log(`\nTITLE ODDS -- start of the playoffs (field known) | at 75% of the regular season (rest simulated)`);
  for (const t of titles) console.log(`  ${t.Y} ${String(t.ch).padEnd(30)} seed ${String(t.seed).padStart(2)}/${t.nF} | playoffs start ${(100 * t.p).toFixed(1).padStart(5)}% (#${t.r}) | 75% ${(100 * t.p75).toFixed(1).padStart(5)}% (#${t.r75}, ${t.pos75}${['st', 'nd', 'rd'][t.pos75 - 1] || 'th'} of ${t.nT} then)`);
  const Lg = a => mean(a.map(p => -Math.log(Math.max(p, 1e-4))));
  // baselines (leave the season out): seed history = share of champions by overall seed inside the field (seeds past this field's size pooled
  // into its last seed, +0.5 smoothing); standings history = share of champions by league position at the 75% mark
  const seedLL = Ys => mean(titles.filter(t => Ys.includes(t.Y)).map(t => { const tf = titles.filter(z => z.Y !== t.Y), c = s => Math.min(s, t.nF); return -Math.log((tf.filter(z => c(z.seed) === t.seed).length + 0.5) / (tf.length + 0.5 * t.nF)); }));
  const posLL = Ys => mean(titles.filter(t => Ys.includes(t.Y)).map(t => { const tf = titles.filter(z => z.Y !== t.Y), c = s => Math.min(s, t.nT); return -Math.log((tf.filter(z => c(z.pos75) === t.pos75).length + 0.5) / (tf.length + 0.5 * t.nT)); }));
  for (const [lab, Ys] of [['ALL', D], ['1st half', H1], ['2nd half', H2]]) { const rs = titles.filter(t => Ys.includes(t.Y));
    console.log(`  ${lab.padEnd(9)} playoffs start: #1 ${rs.filter(t => t.r === 1).length}/${rs.length} · top-3 ${rs.filter(t => t.r <= 3).length} · champ avg rank ${mean(rs.map(t => t.r)).toFixed(2)} · LL ${Lg(rs.map(t => t.p)).toFixed(3)} vs equal ${mean(rs.map(t => Math.log(t.nF))).toFixed(3)} vs seed history ${seedLL(Ys).toFixed(3)}`);
    console.log(`  ${''.padEnd(9)} 75%:            #1 ${rs.filter(t => t.r75 === 1).length}/${rs.length} · top-3 ${rs.filter(t => t.r75 <= 3).length} · champ avg rank ${mean(rs.map(t => t.r75)).toFixed(2)} · LL ${Lg(rs.map(t => t.p75)).toFixed(3)} vs equal ${mean(rs.map(t => Math.log(t.nT))).toFixed(3)} vs standings history ${posLL(Ys).toFixed(3)}`); }
  console.log(`  1st overall seed won ${titles.filter(t => t.seed === 1).length}/${titles.length} · top-2 seed won ${titles.filter(t => t.seed <= 2).length}/${titles.length} · top-4 ${titles.filter(t => t.seed <= 4).length}/${titles.length} · best regular-season record won ${titles.filter(t => t.pos === 1).length}/${titles.length}`);
  fs.writeFileSync(path.join(CACHE, 'params.json'), JSON.stringify(P));
  process.exit(0);
}
// ---------- live board (+ --export; BP_TODAY=YYYY-MM-DD rewinds it to a past date) ----------
{
  const S0 = await all(), P = loadP(), asOf = new Date(Date.parse(today + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
  const rewind = G => G.map(g => g.d < asOf ? g : {...g, fin: false, hs: null, as: null});
  const S = Object.fromEntries(Object.entries(S0).map(([Y, s]) => [Y, {...s, reg: rewind(s.reg), po: rewind(s.po)}]));
  let Y = Math.max(...Object.keys(S).map(Number)); while (L.skip.includes(Y) || !S[Y].reg.length) Y--;
  const Sy = S[Y], reg = Sy.reg, first = firstPO(Sy), ch = champion(Sy), fmt = FMTY(Y) || FMTY(9999), N = +(arg('--sims') || 20000);
  const poStarted = Sy.po.some(g => g.fin), started = reg.some(g => g.fin);
  const stage = ch ? 'done' : poStarted ? 'playoffs' : started ? 'regular' : 'preseason';
  // title odds: before the playoffs = rest of the regular season + playoffs; once the playoffs start = FROZEN at the start of the playoffs
  // (ratings fit on games before the first playoff game, field from the final standings) -- the user never bets within the playoffs
  const fixed = poStarted ? endField(Sy).groups : null, band = otBand(S0, P);
  const M = fit(pool(S, Y), poStarted ? first : asOf, P), T = simulate(M, P, Sy, N, fixed, band);
  let PSy = Sy, PY = Y, pAsOf = poStarted ? first : asOf;
  if (stage === 'preseason') { let q = Y - 1; while (L.skip.includes(q)) q--; if (S[q]?.reg.length) { PSy = S[q]; PY = q; pAsOf = firstPO(PSy) || asOf; } }
  const {rows} = profile(PSy, pool(S, PY), pAsOf, P);
  const TS = done(S).filter(Yp => Yp < Y || (Yp === Y && ch)).map(Yp => { const Sp = S[Yp], c = champion(Sp); return profile(Sp, pool(S, Yp), firstPO(Sp), P).rows.find(r => r.id === c); }).filter(Boolean);
  const cuts = FEATS.length ? tierCuts(TS, FEATS, 1) : [];
  for (const r of rows) tierScore(r, FEATS, cuts);
  addIndex(rows);
  const prof = new Map(rows.map(r => [r.id, r])), played = reg.filter(g => g.fin).length;
  const lad = ladder([...table(reg, Sy.teams).values()], Y, reg);
  const fair = p => p < 0.001 ? '—' : p >= 0.5 ? '-' + Math.round(100 * p / (1 - p)) : '+' + Math.round(100 * (1 - p) / p);
  const fv = (k, v) => v == null || !isFinite(v) ? '—' : k === 'pos' ? String(v) : k === 'rtg' || k === 'mgn' ? (v >= 0 ? '+' : '') + v.toFixed(2) : k === 'pct' ? v.toFixed(1) : /ptp|wp|form|pp$/.test(k) ? v.toFixed(3) : v.toFixed(2);
  console.log(`${L.label} ${L.cup} odds -- ${Y - 1}-${String(Y).slice(2)} season, games through ${today} · ${played}/${reg.length} regular-season games played (${Math.round(100 * played / Math.max(1, reg.length))}%) · stage: ${stage}${ch ? ` · CHAMPION: ${nameOf(ch, Y)} (odds = frozen at the start of the playoffs)` : poStarted ? ' (odds frozen at the start of the playoffs)' : ''}`);
  if (PY !== Y) console.log(`tiers/index = ${PY - 1}-${String(PY).slice(2)} end of the regular season (this season hasn't started) -- odds are PRESEASON (untested stage)`);
  console.log(`format: ${fmt.txt} · model: half-life ${P.half} d, shrink ${P.lam}, OT/SO margin ${P.otm}, sigma ${P.sig} goals · home edge ${M.H.toFixed(2)} goals`);
  if (FEATS.length) console.log(`TIERS -- every-champion profile (${TS.length} champions): ${FEATS.map((f, i) => cutLabel(f, cuts[i], v => fv(f.k, +v))).join(' · ')}`);
  const LBL = {rtg: 'Rating', ptp: 'Points %', wp: 'Win%', rwp: 'Reg. wins/g', mgn: 'Goal diff/g', gapg: 'GA/g', gfpg: 'GF/g', app: 'Away pts%', hpp: 'Home pts%', form10: 'Form10', form20: 'Form20', pct: 'GF/GA%'};
  console.log(`index (0-100) = ${Object.entries(IDXW).map(([k, w]) => `${LBL[k] || k} ${w}`).join(' · ')}\n`);
  const tierOf = r => !r ? '⚪ —' : r.score >= FEATS.length ? `🏆 Best (${r.score}/${FEATS.length})` : r.score === FEATS.length - 1 ? `🔵 Great (${r.score}/${FEATS.length})` : r.score === FEATS.length - 2 ? `🟢 Good (${r.score}/${FEATS.length})` : `⚪ Longshot (${r.score}/${FEATS.length})`;
  const divPos = new Map(); for (const d of new Set(lad.map(t => t.div))) ladder(lad.filter(t => t.div === d), Y, reg).forEach((t, i) => divPos.set(t.id, i + 1));
  for (const t of lad.slice().sort((a, b) => (T.get(b.id) || 0) - (T.get(a.id) || 0) || (prof.get(b.id)?.idx ?? 0) - (prof.get(a.id)?.idx ?? 0))) {
    const p = T.get(t.id) || 0, r = prof.get(t.id), rec = `${t.w}-${t.l}-${t.otl}, ${(ptp(t)).toFixed(3)}, diff ${t.gf - t.ga >= 0 ? '+' : ''}${t.gf - t.ga}`;
    console.log(`  ${(FEATS.length ? tierOf(r) : '').padEnd(18)} ${String(nameOf(t.id, Y)).padEnd(30)} ${t.div.slice(0, 4)} #${String(divPos.get(t.id)).padEnd(2)} (${rec}) | idx ${r ? r.idx.toFixed(1).padStart(5) : '    —'} | rating ${(M.r.get(t.id) ?? 0) >= 0 ? '+' : ''}${(M.r.get(t.id) ?? 0).toFixed(2)} | playoffs ${(100 * (T.field.get(t.id) || 0)).toFixed(0).padStart(3)}% | Cup ${(100 * p).toFixed(1).padStart(5)}% (fair ${fair(p)})${r && FEATS.length ? ' | ' + FEATS.map((f, i) => `${r.q[i] ? '✓' : '✗'} ${f.label}`).join(' · ') : ''}`); }
  if (arg('--export')) {
    const out = {league: lk, label: L.label, cup: L.cup, season: Y, profile_season: PY, generated: new Date().toISOString(), today, stage, first_playoff: first || null, games_left: reg.length - played, sims: N,
      champion: ch ? nameOf(ch, Y) : null, champions: TS.length, sig: P.sig, hfa: +M.H.toFixed(2), format: fmt.txt,
      cats: FEATS.map((f, i) => cutLabel(f, cuts[i], v => fv(f.k, +v))), labels: FEATS.map(f => f.label),
      teams: lad.map(t => { const r = prof.get(t.id);
        return {id: t.id, name: nameOf(t.id, Y), div: t.div, conf: t.conf, gp: t.gp, w: t.w, l: t.l, otl: t.otl, pts: t.pts, ptp: +ptp(t).toFixed(3), gf: t.gf, ga: t.ga, p: T.get(t.id) || 0, playoffs: T.field.get(t.id) || 0,
          score: r ? r.score : 0, q: r ? r.q : FEATS.map(() => false), vals: FEATS.map(f => !r ? '—' : f.k === 'pos' ? fv('pos', r.pos) : `${fv(f.k, r[f.k])} #${r['r_' + f.k]}`),
          idx: r ? +r.idx.toFixed(1) : null, rtg: +(M.r.get(t.id) ?? 0).toFixed(2)}; })};
    fs.writeFileSync(arg('--export'), JSON.stringify(out)); console.log('\nexported -> ' + arg('--export'));
  }
  const bk = arg('--book');
  if (bk) { console.log('\nBOOK PRICES (pasted) -- EV = model p x decimal odds - 1');
    const names = lad.map(t => [t.id, nameOf(t.id, Y)]);
    for (const pair of bk.split(',')) { const m = pair.trim().match(/^(.*?):\s*([+-]?\d+)$/); if (!m) continue; const am = +m[2], dec = am > 0 ? 1 + am / 100 : 1 + 100 / -am, w = m[1].trim().toLowerCase();
      const id = names.find(([k, n]) => n.toLowerCase() === w)?.[0] ?? names.find(([k, n]) => n.toLowerCase().includes(w) || w.includes(n.toLowerCase()))?.[0], p = id ? (T.get(id) || 0) : null;
      console.log(`  ${m[1].padEnd(24)} ${m[2].padStart(6)} implied ${(100 / dec).toFixed(1)}% | model ${p == null ? 'n/a (name not matched)' : (100 * p).toFixed(1) + '% (fair ' + fair(p) + ') -> EV ' + (p * dec - 1 >= 0 ? '+' : '') + Math.round(100 * (p * dec - 1)) + '%'}`); } }
  if (rest.includes('--log')) {
    const file = `C:/Users/User/baseball-blueprint/${lk}-history.md`, head = `# ${L.label} ${L.cup} Blueprint — Run History\n\nEach run prepends a dated snapshot (engine: baseball-blueprint/pro/hockeytech.mjs ${lk}).\n\n---\n\n`;
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : head, i = old.indexOf('---\n\n');
    let body = i >= 0 ? old.slice(i + 5) : ''; if (body.startsWith(`## ${today} `)) { const nx = body.indexOf('\n## '); body = nx >= 0 ? body.slice(nx + 1) : ''; }
    const entry = `## ${today} (${Y - 1}-${String(Y).slice(2)} season, ${stage === 'preseason' ? 'preseason board, untested' : stage}, ${played}/${reg.length} games played${ch ? `, champion ${nameOf(ch, Y)}` : ''})\n\n${[...T].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, p]) => `- ${nameOf(id, Y)} ${prof.get(id) && FEATS.length ? prof.get(id).score + '/' + FEATS.length + ' · ' : ''}${(100 * p).toFixed(1)}% (fair ${fair(p)})`).join('\n')}\n\n`;
    fs.writeFileSync(file, i >= 0 ? old.slice(0, i + 5) + entry + body : old + entry); console.log('\nlogged to ' + file);
  }
}
