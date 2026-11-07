// AFL premiership engine (built 2026-11-07, user: "can you create an afl blueprint?"). Data: Squiggle (api.squiggle.com.au, free).
// Model: team ratings from game MARGINS (recency-weighted ridge regression over the last two seasons + this one) with a home
// edge split by travel (both teams from the same state vs an interstate visitor). P(home win) = Phi(predicted margin / sigma).
// Season sim: the remaining home-and-away games (ladder: 4 points a win, 2 a draw, then percentage = PF/PA), then the finals --
// the AFL final eight (2000-25), with the wildcard round in front from 2026 (7 v 10, 8 v 9; winners take the 8th/7th spots).
//   node afl.mjs check                     seasons, premiers, finals counts
//   node afl.mjs backtest                  match level (tuned on 2001-13, tested 2014-26), finals matches, premiership odds
//   node afl.mjs dump                      every team's profile at the end of the home-and-away season -> study/data/afl.json
//   node afl.mjs tiers                     champion-profile tiers: cutoffs + held-out premier check
//   node afl.mjs [live] [--log] [--book "Brisbane Lions:+450,..."]   current board (+ EV vs a pasted DraftKings/FanDuel screenshot)
// NO KALSHI (user, 2026-11-06). No odds feed carries AFL premiership futures (the Odds API has AFL game lines only).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {TIER_NAME, rankRows, cutoffs as tierCuts, score as tierScore, cutLabel, tierBacktest} from './tiers.mjs';

const CACHE = path.join(os.tmpdir(), 'pro_bp_cache', 'afl'); fs.mkdirSync(CACHE, {recursive: true});
const UA = 'blueprint-research/1.0 (personal sports model)';   // Squiggle asks for a descriptive user agent
const sleep = ms => new Promise(r => setTimeout(r, ms));
const [mode0 = 'live', ...rest] = process.argv.slice(2);
const mode = mode0.startsWith('--') ? 'live' : mode0; if (mode0.startsWith('--')) rest.unshift(mode0);
const arg = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
const today = process.env.BP_TODAY || new Date().toLocaleDateString('en-CA');
const SEASONS = Array.from({length: 26}, (_, i) => 2000 + i).concat([2026]);   // completed seasons with finals
const H1 = SEASONS.filter(Y => Y <= 2013), H2 = SEASONS.filter(Y => Y >= 2014);
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

// ---------- data ----------
const STATE = {Adelaide: 'SA', 'Port Adelaide': 'SA', Fremantle: 'WA', 'West Coast': 'WA', 'Brisbane Lions': 'QLD', 'Gold Coast': 'QLD',
  Sydney: 'NSW', 'Greater Western Sydney': 'NSW'};   // everyone else is Victorian
const stateOf = n => STATE[n] || 'VIC';
async function getJson(u) { for (let a = 0; a < 5; a++) { try { const r = await fetch(u, {headers: {'User-Agent': UA}, signal: AbortSignal.timeout(40e3)}); if (r.ok) return await r.json(); } catch {} await sleep(1500 * (a + 1)); } throw new Error('fetch failed ' + u); }
async function season(Y) {
  const f = path.join(CACHE, `g${Y}.json`);
  let j = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  const done = j && j.games?.length && j.games.every(g => g.complete === 100) && j.games.some(g => g.is_grand_final);
  if (!done) { j = await getJson(`https://api.squiggle.com.au/?q=games;year=${Y}`); if (j?.games?.length && j.games.every(g => g.complete === 100)) fs.writeFileSync(f, JSON.stringify(j)); await sleep(800); }
  return (j?.games || []).map(g => ({id: g.id, Y, d: String(g.date).slice(0, 10), rd: g.round, rn: g.roundname, h: g.hteamid, a: g.ateamid, hn: g.hteam, an: g.ateam,
    hs: g.complete === 100 ? g.hscore : null, as: g.complete === 100 ? g.ascore : null, fin: g.complete === 100, final: !!g.is_final, gf: !!g.is_grand_final, venue: g.venue}))
    .filter(g => g.h && g.a).sort((x, y) => x.d.localeCompare(y.d) || x.id - y.id);
}
const premier = G => { const gf = G.filter(g => g.gf && g.fin).sort((x, y) => x.d.localeCompare(y.d)).pop(); return gf ? (gf.hs > gf.as ? gf.h : gf.a) : null; };

// ---------- ratings: recency-weighted ridge regression on margins ----------
// margin = r_home - r_away + Hs*[same state] + Hi*[interstate visitor]; GF = neutral (no edge)
function fit(games, asOf, P) {
  const G = games.filter(g => g.fin && g.d < asOf), t0 = Date.parse(asOf + 'T12:00:00Z');
  const w = G.map(g => Math.pow(0.5, (t0 - Date.parse(g.d + 'T12:00:00Z')) / 864e5 / P.half));
  const inter = G.map(g => stateOf(g.hn) !== stateOf(g.an)), m = G.map(g => g.hs - g.as);
  const T = [...new Set(G.flatMap(g => [g.h, g.a]))], r = new Map(T.map(t => [t, 0])), idx = new Map();
  for (const [i, g] of G.entries()) for (const t of [g.h, g.a]) { if (!idx.has(t)) idx.set(t, []); idx.get(t).push(i); }
  let Hs = 3, Hi = 10;
  const edge = i => G[i].gf ? 0 : inter[i] ? Hi : Hs;
  for (let it = 0; it < 60; it++) {
    for (const t of T) {
      let den = P.lam; for (const i of idx.get(t)) den += w[i];
      // residual for team t: s*(m - edge) + other's rating contribution: m = r_h - r_a + edge  ->  r_t = s*(m - edge) + r_other
      let n2 = 0; for (const i of idx.get(t)) { const g = G[i], s = g.h === t ? 1 : -1, other = r.get(g.h === t ? g.a : g.h); n2 += w[i] * (s * (m[i] - edge(i)) + other); }
      r.set(t, n2 / den);
    }
    const mu = mean([...r.values()]); for (const t of T) r.set(t, r.get(t) - mu);
    let ss = 0, ws = 0, si = 0, wi = 0;
    for (const [i, g] of G.entries()) { if (g.gf) continue; const res = m[i] - (r.get(g.h) - r.get(g.a)); if (inter[i]) { si += w[i] * res; wi += w[i]; } else { ss += w[i] * res; ws += w[i]; } }
    Hs = ws ? ss / ws : 0; Hi = wi ? si / wi : 0;
  }
  return {r, Hs, Hi};
}
const Phi = x => 0.5 * (1 + erf(x / Math.SQRT2));
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
const predMargin = (M, h, a, hn, an, neutral) => (M.r.get(h) ?? 0) - (M.r.get(a) ?? 0) + (neutral ? 0 : stateOf(hn) !== stateOf(an) ? M.Hi : M.Hs);
const pHome = (M, h, a, hn, an, neutral, P) => Phi(predMargin(M, h, a, hn, an, neutral) / P.sig);
const LLf = (p, y) => -(y * Math.log(Math.max(p, 1e-6)) + (1 - y) * Math.log(Math.max(1 - p, 1e-6)));   // y = 1 home win, 0 loss, 0.5 draw

// ---------- ladder + season simulation ----------
function ladder(rows) {   // rows: [{id, pts, pf, pa}] -> sorted by points then percentage
  return rows.slice().sort((x, y) => y.pts - x.pts || (y.pf / Math.max(1, y.pa)) - (x.pf / Math.max(1, x.pa)));
}
const randn = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
// title odds: simulate the remaining home-and-away games (if any) + the finals. names: id -> name (for states)
function simulate(M, P, Y, reg, names, N = 20000, fixedSeeds = null) {
  const played = reg.filter(g => g.fin), left = reg.filter(g => !g.fin);
  const base = new Map();
  for (const g of reg) for (const t of [g.h, g.a]) if (!base.has(t)) base.set(t, {id: t, pts: 0, pf: 0, pa: 0, w: 0, gp: 0});
  for (const g of played) { const H = base.get(g.h), A = base.get(g.a); H.pf += g.hs; H.pa += g.as; A.pf += g.as; A.pa += g.hs; H.gp++; A.gp++;
    if (g.hs > g.as) { H.pts += 4; H.w++; } else if (g.hs < g.as) { A.pts += 4; A.w++; } else { H.pts += 2; A.pts += 2; } }
  const avgTot = played.length ? mean(played.map(g => g.hs + g.as)) : 165;
  const win = (x, y, neutral) => Math.random() < Phi(predMargin(M, x, y, names.get(x), names.get(y), neutral) / P.sig) ? x : y;   // x hosts
  const cup = new Map(), top = new Map(), nFin = Y >= 2026 ? 10 : 8;
  for (let s = 0; s < N; s++) {
    let seeds;
    if (fixedSeeds) seeds = fixedSeeds;
    else {
      const T = new Map([...base].map(([k, v]) => [k, {...v}]));
      for (const g of left) { const mu = predMargin(M, g.h, g.a, names.get(g.h), names.get(g.a), false), mg = mu + P.sig * randn(), tot = avgTot + 27 * randn();
        const H = T.get(g.h), A = T.get(g.a), hs = Math.max(0, (tot + mg) / 2), as = Math.max(0, (tot - mg) / 2); H.pf += hs; H.pa += as; A.pf += as; A.pa += hs;
        if (mg > 0.5) H.pts += 4; else if (mg < -0.5) A.pts += 4; else { H.pts += 2; A.pts += 2; } }
      seeds = ladder([...T.values()]).slice(0, nFin).map(t => t.id);
    }
    top.set(seeds[0], (top.get(seeds[0]) || 0) + 1);
    let e5 = seeds[7], e6 = seeds[6];   // classic final eight: EF 5 v 8, 6 v 7
    // 2026+: wildcard round 7 v 10 and 8 v 9 (higher seed hosts); the 7-v-10 winner plays 5th, the 8-v-9 winner plays 6th (fixed 2026-11-07 -- it was
    // the other way round; the real 2026 finals: Carlton (10th) beat Melbourne and met Geelong (5th), the Bulldogs (8th) met Adelaide (6th))
    if (nFin === 10) { e5 = win(seeds[6], seeds[9]); e6 = win(seeds[7], seeds[8]); }
    const [s1, s2, s3, s4, s5, s6] = seeds;
    const qf1 = win(s1, s4), qf2 = win(s2, s3), ef1 = win(s5, e5), ef2 = win(s6, e6);
    const l1 = qf1 === s1 ? s4 : s1, l2 = qf2 === s2 ? s3 : s2;
    const sf1 = win(l1, ef1), sf2 = win(l2, ef2);
    const pf1 = win(qf1, sf2), pf2 = win(qf2, sf1);
    const ch = win(pf1, pf2, true);   // Grand Final: neutral
    cup.set(ch, (cup.get(ch) || 0) + 1);
  }
  return {cup: new Map([...cup].map(([k, v]) => [k, v / N])), minor: new Map([...top].map(([k, v]) => [k, v / N]))};
}
// actual end-of-home-and-away ladder (finals seeds) for a completed season
function finalLadder(G) {
  const reg = G.filter(g => !g.final && g.fin), T = new Map();
  for (const g of reg) for (const [me, pf, pa] of [[g.h, g.hs, g.as], [g.a, g.as, g.hs]]) { const t = T.get(me) || {id: me, pts: 0, pf: 0, pa: 0, w: 0, l: 0, d: 0, gp: 0}; t.gp++; t.pf += pf; t.pa += pa;
    if (pf > pa) { t.pts += 4; t.w++; } else if (pf < pa) t.l++; else { t.pts += 2; t.d++; } T.set(me, t); }
  return ladder([...T.values()]);
}

// ---------- champion profile (end of the home-and-away season) ----------
// every-champion rule (2026-11-07, study/criteria.mjs on `afl.mjs dump`): all 27 premiers 2000-26 cleared all 5 at the end of the
// home-and-away season; ~3.3 of the 8 finals teams do. Honest test (search re-run without the hidden season): the hidden premier
// cleared all 5 in 20/27 -- 13/14 in 2000-13 but only 7/13 in 2014-26 (Brisbane 2024-26, Richmond 2019-20, Bulldogs 2016 broke it),
// so the tiers are context; the odds come from the simulation.
const FEATS = [
  {k: 'pct', dir: 1, kind: 'value', label: 'Percentage'}, {k: 'rtg', dir: 1, kind: 'rank', label: 'Rating'}, {k: 'form8', dir: 1, kind: 'value', label: 'Form (win%, last 8)'},
  {k: 'hwp', dir: 1, kind: 'rank', label: 'Home win%'}, {k: 'awp', dir: 1, kind: 'rank', label: 'Away win%'}];
// index (0-100, display + sub-rank): premier's rank in the finals field avg #2.22, #1 in 11/27, top-3 in 24/27 (random #4.5);
// matched or beat the rating alone in both halves (2000-13 #1.79, 2014-26 #2.69 vs #2.92).
const IDXW = {rtg: 60, form8: 20, awp: 20};
function profile(G, pool, asOf, P) {
  const reg = G.filter(g => !g.final && g.fin && g.d < asOf), M = fit(pool, asOf, P), lad = (() => {
    const T = new Map();
    for (const g of reg) for (const [me, pf, pa, home] of [[g.h, g.hs, g.as, 1], [g.a, g.as, g.hs, 0]]) {
      const t = T.get(me) || {id: me, pts: 0, pf: 0, pa: 0, w: 0, gp: 0, res: [], hw: 0, hn: 0, aw: 0, an: 0}; t.gp++; t.pf += pf; t.pa += pa;
      const r = pf > pa ? 1 : pf < pa ? 0 : 0.5; t.w += r; t.pts += 4 * r; t.res.push([g.d, r]); if (home) { t.hw += r; t.hn++; } else { t.aw += r; t.an++; } T.set(me, t); }
    return ladder([...T.values()]); })();
  const rows = lad.map((t, i) => { const s = t.res.sort((a, b) => a[0].localeCompare(b[0])), f = n => mean(s.slice(-n).map(x => x[1]));
    return {id: t.id, pos: i + 1, pts: t.pts, gp: t.gp, wp: t.w / t.gp, pct: 100 * t.pf / t.pa, pfpg: t.pf / t.gp, papg: t.pa / t.gp, mgn: (t.pf - t.pa) / t.gp,
      rtg: M.r.get(t.id) ?? 0, form8: f(8), form5: f(5), hwp: t.hn ? t.hw / t.hn : 0, awp: t.an ? t.aw / t.an : 0}; });
  return {rows: rankRows(rows, FEATS), M};
}
function addIndex(rows) {
  const N = {};
  for (const k of Object.keys(IDXW)) { const f = FEATS.find(x => x.k === k), dir = f ? f.dir : 1, v = rows.map(r => +r[k]), lo = Math.min(...v), hi = Math.max(...v);
    N[k] = r => hi === lo ? 50 : 100 * (dir > 0 ? r[k] - lo : hi - r[k]) / (hi - lo); }
  const tw = Object.values(IDXW).reduce((a, b) => a + b, 0);
  for (const r of rows) r.idx = Object.entries(IDXW).reduce((a, [k, w]) => a + w * N[k](r), 0) / tw;
}
const loadP = () => fs.existsSync(path.join(CACHE, 'params.json')) ? JSON.parse(fs.readFileSync(path.join(CACHE, 'params.json'), 'utf8')) : {half: 120, lam: 3, sig: 33};   // = what `backtest` tunes on 2000-13
async function allSeasons() { const S = {}; for (const Y of [1998, 1999, ...SEASONS]) S[Y] = await season(Y); return S; }
const pool = (S, Y) => [...(S[Y - 2] || []), ...(S[Y - 1] || []), ...(S[Y] || [])];
const nameMap = S => { const n = new Map(); for (const Y in S) for (const g of S[Y]) { n.set(g.h, g.hn); n.set(g.a, g.an); } return n; };

// ---------------------------------------------------------------- check
if (mode === 'check') {
  const S = await allSeasons(), names = nameMap(S);
  for (const Y of SEASONS) { const G = S[Y], fin = G.filter(g => g.final); console.log(`${Y}: ${G.filter(g => !g.final).length} home-and-away games · ${fin.length} finals · premier ${names.get(premier(G))}`); }
  process.exit(0);
}

// ---------------------------------------------------------------- dump (input for study/criteria.mjs)
if (mode === 'dump') {
  const S = await allSeasons(), names = nameMap(S), P = loadP();
  const K = ['pos', 'pts', 'wp', 'pct', 'pfpg', 'papg', 'mgn', 'rtg', 'form8', 'form5', 'hwp', 'awp'];
  const out = {sport: 'afl', label: 'AFL premiership', when: 'end of the home-and-away season', fieldLabel: 'the finals teams', universeLabel: 'every AFL team',
    cands: [{k: 'pos', dir: -1, label: 'Ladder position', value: true, rank: false, dec: 0}, {k: 'pts', dir: 1, label: 'Ladder points', value: true}, {k: 'wp', dir: 1, label: 'Win%', value: true},
      {k: 'pct', dir: 1, label: 'Percentage', value: true}, {k: 'pfpg', dir: 1, label: 'Points for/game', value: true}, {k: 'papg', dir: -1, label: 'Points against/game', value: true},
      {k: 'mgn', dir: 1, label: 'Margin/game', value: true}, {k: 'rtg', dir: 1, label: 'Rating', value: true}, {k: 'form8', dir: 1, label: 'Form (win%, last 8)', value: true},
      {k: 'form5', dir: 1, label: 'Form (win%, last 5)', value: true}, {k: 'hwp', dir: 1, label: 'Home win%', value: true}, {k: 'awp', dir: 1, label: 'Away win%', value: true}],
    seasons: []};
  for (const Y of SEASONS) {
    const G = S[Y], first = G.filter(g => g.final).map(g => g.d).sort()[0], {rows} = profile(G, pool(S, Y), first, P), nFin = Y >= 2026 ? 10 : 8;
    out.seasons.push({Y, champ: premier(G), champName: names.get(premier(G)), field: rows.slice(0, nFin).map(r => r.id), rows: rows.map(r => Object.fromEntries([['id', r.id], ['name', names.get(r.id)], ...K.map(k => [k, r[k]])]))});
  }
  fs.mkdirSync('C:/Users/User/baseball-blueprint/study/data', {recursive: true});
  fs.writeFileSync('C:/Users/User/baseball-blueprint/study/data/afl.json', JSON.stringify(out));
  console.log(`dumped ${out.seasons.length} seasons -> study/data/afl.json`);
  process.exit(0);
}

// ---------------------------------------------------------------- backtest
if (mode === 'backtest') {
  const S = await allSeasons(), names = nameMap(S);
  // 1. match level: every home-and-away game predicted from a fit on everything before its round
  const rounds = Y => [...new Set(S[Y].filter(g => !g.final && g.fin).map(g => g.rd))];
  const fitsFor = P => { const F = new Map(); for (const Y of SEASONS) for (const rd of rounds(Y)) { const gs = S[Y].filter(g => !g.final && g.fin && g.rd === rd), d0 = gs.map(g => g.d).sort()[0]; F.set(Y + '|' + rd, fit(pool(S, Y), d0, P)); } return F; };
  const evalM = (P, F, Ys) => { const out = []; for (const Y of Ys) for (const g of S[Y].filter(g => !g.final && g.fin)) { const M = F.get(Y + '|' + g.rd), p = pHome(M, g.h, g.a, g.hn, g.an, false, P); out.push(LLf(p, g.hs > g.as ? 1 : g.hs < g.as ? 0 : 0.5)); } return mean(out); };
  let best = null; const cache = new Map();
  for (const half of [120, 240, 365, 100000]) for (const lam of [0, 3, 10]) {
    const F = fitsFor({half, lam}); cache.set(half + '|' + lam, F);
    for (const sig of [33, 35, 37, 39, 41, 43]) { const P = {half, lam, sig}, ll = evalM(P, F, H1); if (!best || ll < best.ll) best = {P, ll}; }
  }
  const P = best.P, F = cache.get(P.half + '|' + P.lam);
  const hb = Ys => { const g = Ys.flatMap(Y => S[Y].filter(x => !x.final && x.fin)), hr = mean(g.map(x => x.hs > x.as ? 1 : x.hs < x.as ? 0 : 0.5)); return mean(g.map(x => LLf(hr, x.hs > x.as ? 1 : x.hs < x.as ? 0 : 0.5))); };
  console.log(`AFL backtest -- seasons ${SEASONS[0]}-${SEASONS[SEASONS.length - 1]} (halves 2000-13 / 2014-26)`);
  console.log(`MATCHES (home-and-away, refit every round): settings tuned on 2000-13 -> half-life ${P.half >= 1e5 ? 'none' : P.half + ' d'}, shrink ${P.lam}, sigma ${P.sig} pts`);
  console.log(`  2000-13 (tuned here) LL ${evalM(P, F, H1).toFixed(4)} vs home-win base rate ${hb(H1).toFixed(4)} · 2014-26 (held out) LL ${evalM(P, F, H2).toFixed(4)} vs ${hb(H2).toFixed(4)} · coin 0.6931`);
  // 2. finals matches (fit as of each final's date); host = listed home team
  const fm = []; for (const Y of SEASONS) for (const g of S[Y].filter(g => g.final && g.fin)) { const M = fit(pool(S, Y), g.d, P), p = pHome(M, g.h, g.a, g.hn, g.an, g.gf, P); fm.push({Y, ll: LLf(p, g.hs > g.as ? 1 : g.hs < g.as ? 0 : 0.5), y: g.hs > g.as ? 1 : 0, gf: g.gf}); }
  const hostRate = mean(fm.filter(x => !x.gf).map(x => x.y));
  const hostLL = Ys => mean(fm.filter(x => Ys.includes(x.Y)).map(x => { if (x.gf) return Math.log(2); const tr = mean(fm.filter(z => !z.gf && z.Y !== x.Y).map(z => z.y)); return LLf(tr, x.y); }));
  console.log(`\nFINALS MATCHES (${fm.length}): model LL ${mean(fm.map(x => x.ll)).toFixed(4)} (2000-13 ${mean(fm.filter(x => x.Y <= 2013).map(x => x.ll)).toFixed(4)} | 2014-26 ${mean(fm.filter(x => x.Y >= 2014).map(x => x.ll)).toFixed(4)}) · host won ${(100 * hostRate).toFixed(0)}% of non-GF finals · "host wins" baseline ${hostLL(SEASONS).toFixed(4)} (${hostLL(H1).toFixed(4)} | ${hostLL(H2).toFixed(4)}) · coin 0.6931`);
  // 3. premiership odds at the start of the finals (seeds known) and at ~75% of the home-and-away season
  const titles = [];
  for (const Y of SEASONS) {
    const G = S[Y], reg = G.filter(g => !g.final), first = G.filter(g => g.final).map(g => g.d).sort()[0], ch = premier(G), nFin = Y >= 2026 ? 10 : 8;
    const seeds = finalLadder(G).slice(0, nFin).map(t => t.id);
    const M = fit(pool(S, Y), first, P), T = simulate(M, P, Y, reg, names, 20000, seeds).cup;
    const dates = reg.map(g => g.d).sort(), d75 = dates[Math.floor(0.75 * dates.length)];
    const M75 = fit(pool(S, Y), d75, P), reg75 = reg.map(g => g.d < d75 ? g : {...g, fin: false, hs: null, as: null}), T75 = simulate(M75, P, Y, reg75, names, 8000).cup;
    const rank = (T, id) => 1 + [...T.values()].filter(v => v > (T.get(id) || 0)).length;
    titles.push({Y, ch: names.get(ch), seed: seeds.indexOf(ch) + 1, p: T.get(ch) || 0, r: rank(T, ch), n: nFin, p75: T75.get(ch) || 0, r75: rank(T75, ch)});
  }
  console.log(`\nPREMIERSHIP ODDS -- at the start of the finals (seeds known) and at 75% of the home-and-away season`);
  for (const t of titles) console.log(`  ${t.Y} ${String(t.ch).padEnd(24)} seed ${String(t.seed).padStart(2)} | start of finals ${(100 * t.p).toFixed(1).padStart(5)}% (#${t.r}) | at 75% ${(100 * t.p75).toFixed(1).padStart(5)}% (#${t.r75})`);
  for (const [lab, Ys] of [['ALL', SEASONS], ['2000-13', H1], ['2014-26', H2]]) {
    const rs = titles.filter(t => Ys.includes(t.Y)), L = a => mean(a.map(p => -Math.log(Math.max(p, 1e-4))));
    console.log(`  ${lab.padEnd(8)} start of finals: #1 ${rs.filter(t => t.r === 1).length}/${rs.length} · top-3 ${rs.filter(t => t.r <= 3).length} · LL ${L(rs.map(t => t.p)).toFixed(3)} vs equal ${mean(rs.map(t => Math.log(t.n))).toFixed(3)} | at 75%: #1 ${rs.filter(t => t.r75 === 1).length} · top-3 ${rs.filter(t => t.r75 <= 3).length} · LL ${L(rs.map(t => t.p75)).toFixed(3)} vs equal ${Math.log(18).toFixed(3)}`);
  }
  console.log(`  minor premier won ${titles.filter(t => t.seed === 1).length}/${titles.length} · a top-4 seed won ${titles.filter(t => t.seed <= 4).length}/${titles.length}`);
  // baseline: title odds from how often each finishing position won (leave the season out, +0.5 smoothing)
  const seedLL = Ys => mean(titles.filter(t => Ys.includes(t.Y)).map(t => { const tr = titles.filter(z => z.Y !== t.Y), k = t.seed, n = t.n; return -Math.log((tr.filter(z => z.seed === k).length + 0.5) / (tr.length + 0.5 * n)); }));
  console.log(`  "finishing-position history" baseline at the start of the finals: LL ${seedLL(SEASONS).toFixed(3)} (2000-13 ${seedLL(H1).toFixed(3)} | 2014-26 ${seedLL(H2).toFixed(3)})`);
  fs.writeFileSync(path.join(CACHE, 'params.json'), JSON.stringify(P));
  process.exit(0);
}

// ---------------------------------------------------------------- tiers
if (mode === 'tiers') {
  const S = await allSeasons(), names = nameMap(S), P = loadP(), TS = [];
  for (const Y of SEASONS) { const G = S[Y], first = G.filter(g => g.final).map(g => g.d).sort()[0], {rows} = profile(G, pool(S, Y), first, P), ch = premier(G), nFin = Y >= 2026 ? 10 : 8;
    TS.push({Y, rows, champ: rows.find(r => r.id === ch), champName: names.get(ch), field: rows.slice(0, nFin)}); }
  console.log(`AFL champion-profile tiers -- ${TS.length} seasons`);
  for (const line of tierBacktest(TS, FEATS, 1, v => (+v).toFixed(v > 10 ? 1 : 3))) console.log(line);
  process.exit(0);
}

// ---------------------------------------------------------------- live (+ --export for the blueprint dashboard; BP_TODAY=YYYY-MM-DD rewinds it)
{
  const S0 = await allSeasons(), P = loadP(), CURY = +today.slice(0, 4), N = +(arg('--sims') || 20000);
  for (let y = SEASONS[SEASONS.length - 1] + 1; y <= CURY; y++) { try { S0[y] = await season(y); } catch { S0[y] = []; } }   // seasons after the built-in list
  const asOf = new Date(Date.parse(today + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
  const rewind = G => G.map(g => g.d < asOf ? g : {...g, fin: false, hs: null, as: null});   // games on/after asOf count as unplayed
  const S = Object.fromEntries(Object.entries(S0).map(([y, G]) => [y, rewind(G)]));
  let Y = CURY; while (Y > 2000 && !S[Y]?.length) Y--;
  // offseason: once this season is decided, switch to next season's fixture as soon as it is published in full (a preseason board)
  if (premier(S[Y]) && !process.env.BP_TODAY) { try { const nx = await season(Y + 1), creg = S[Y].filter(g => !g.final).length;
    if (nx.filter(g => !g.final).length >= 0.9 * creg) { S0[Y + 1] = nx; S[Y + 1] = rewind(nx); Y++; } } catch {} }
  const names = nameMap(S0), G = S[Y], reg = G.filter(g => !g.final), done = !!premier(G), started = reg.some(g => g.fin);
  const finalsStarted = G.some(g => g.final && g.fin), first = G.filter(g => g.final).map(g => g.d).sort()[0], nFin = Y >= 2026 ? 10 : 8;
  const stage = done ? 'done' : finalsStarted ? 'finals' : started ? 'regular' : 'preseason';
  // title odds: before the finals = simulate the rest of the season + finals; once the finals start = FROZEN at the start of the finals
  // (ratings fit on games before the first final, actual seeds) -- the user never bets within the finals
  const M = fit(pool(S, Y), finalsStarted ? first : asOf, P);
  const seeds = finalsStarted ? finalLadder(G).slice(0, nFin).map(t => t.id) : null;
  const T = simulate(M, P, Y, reg, names, N, seeds);
  // tiers: every completed season's premier sets the cutoffs (the loosest premier, as in study/criteria.mjs)
  const comp = Object.keys(S).map(Number).filter(y => y >= 2000 && y <= Y && premier(S[y]));
  const TS = comp.map(y => { const Gp = S[y], f0 = Gp.filter(g => g.final).map(g => g.d).sort()[0]; return profile(Gp, pool(S, y), f0, P).rows.find(r => r.id === premier(Gp)); }).filter(Boolean);
  const cuts = tierCuts(TS, FEATS, 1);
  // profile: this season (as of today; the start of the finals once they begin). Preseason: last season's end-of-home-and-away profile
  let PG = G, PY = Y, pAsOf = finalsStarted ? first : asOf;
  if (!started && S[Y - 1]?.length) { PG = S[Y - 1]; PY = Y - 1; pAsOf = PG.filter(g => g.final).map(g => g.d).sort()[0] || asOf; }
  const {rows} = profile(PG, pool(S, PY), pAsOf, P);
  for (const r of rows) tierScore(r, FEATS, cuts);
  addIndex(rows);
  const prof = new Map(rows.map(r => [r.id, r]));
  // ladder shown: this season's; preseason = last season's final home-and-away ladder (this season's clubs only; a new club shows zeros)
  const curT = new Set(reg.flatMap(g => [g.h, g.a])), lad = finalLadder(PY !== Y ? PG : G).filter(t => curT.has(t.id)), seen = new Set(lad.map(t => t.id));
  for (const t of curT) if (!seen.has(t)) { seen.add(t); lad.push({id: t, pts: 0, pf: 0, pa: 0, w: 0, l: 0, d: 0, gp: 0}); }
  const posOf = t => PY !== Y ? (prof.get(t.id)?.pos ?? null) : lad.indexOf(t) + 1;
  const fv = (k, v) => v == null || !isFinite(v) ? '—' : k === 'rtg' || k === 'mgn' ? (v >= 0 ? '+' : '') + v.toFixed(1) : k === 'pct' ? v.toFixed(1) : /wp|form/.test(k) ? v.toFixed(3) : v.toFixed(1);
  console.log(`AFL premiership odds -- ${Y} season, games through ${today} · ${reg.filter(g => g.fin).length}/${reg.length} home-and-away games played · stage: ${stage}${done ? ` · PREMIER: ${names.get(premier(G))} (odds = frozen at the start of the finals)` : finalsStarted ? ' (odds frozen at the start of the finals)' : ''}`);
  if (PY !== Y) console.log(`tiers/index = ${PY} end of home-and-away (${Y} hasn't started) -- premiership odds are preseason, from ratings that fade toward average (untested stage)`);
  console.log(`model: half-life ${P.half >= 1e5 ? 'none' : P.half + ' d'}, shrink ${P.lam}, sigma ${P.sig} pts · home edge ${M.Hs.toFixed(1)} pts (same state) / ${M.Hi.toFixed(1)} pts (interstate)`);
  console.log(`\nTIERS -- every-champion profile (${TS.length} premiers): ${FEATS.map((f, i) => cutLabel(f, cuts[i], v => fv(f.k, +v))).join(' · ')}`);
  console.log(`index (0-100) = ${Object.entries(IDXW).map(([k, w]) => `${FEATS.find(f => f.k === k)?.label || k} ${w}%`).join(' · ')}\n`);
  const fair = p => p < 0.001 ? '—' : p >= 0.5 ? '-' + Math.round(100 * p / (1 - p)) : '+' + Math.round(100 * (1 - p) / p);
  for (const t of lad.slice().sort((a, b) => (T.cup.get(b.id) || 0) - (T.cup.get(a.id) || 0) || (prof.get(b.id)?.idx ?? 0) - (prof.get(a.id)?.idx ?? 0))) {
    const p = T.cup.get(t.id) || 0, r = prof.get(t.id);
    console.log(`  ${TIER_NAME(r ? r.score : 0).padEnd(18)} ${String(names.get(t.id)).padEnd(24)} #${String(posOf(t) ?? '-').padEnd(2)} ${String(t.pts).padStart(3)} pts ${(100 * t.pf / Math.max(1, t.pa)).toFixed(1).padStart(6)}% | idx ${r ? r.idx.toFixed(1).padStart(5) : '    —'} | rating ${(M.r.get(t.id) ?? 0) >= 0 ? '+' : ''}${(M.r.get(t.id) ?? 0).toFixed(1)} | premiership ${(100 * p).toFixed(1).padStart(5)}% (fair ${fair(p)})${r ? ' | ' + FEATS.map((f, i) => `${r.q[i] ? '✓' : '✗'} ${f.label}`).join(' · ') : ''}`);
  }
  if (arg('--export')) {   // board JSON for the blueprint dashboard (blueprint-dashboard/scripts/build.py build_footy)
    const SHORT = {pct: 'Pct', rtg: 'Rating', form8: 'Form 8', hwp: 'Home W%', awp: 'Away W%'};
    const gpNow = finalLadder(G).map(t => t.gp);
    const out = {league: 'afl', label: 'AFL', season: Y, profile_season: PY, rec_season: PY, gp_now: [gpNow.length ? Math.min(...gpNow) : 0, gpNow.length ? Math.max(...gpNow) : 0], generated: new Date().toISOString(), today, stage, first_final: first || null,
      games_left: reg.filter(g => !g.fin).length, sims: N, premier: done ? names.get(premier(G)) : null, champions: TS.length, sig: P.sig,
      hfa: {same: +M.Hs.toFixed(2), inter: +M.Hi.toFixed(2)}, cats: FEATS.map((f, i) => cutLabel(f, cuts[i], v => fv(f.k, +v))), labels: FEATS.map(f => SHORT[f.k] || f.label),
      teams: lad.map((t, i) => { const r = prof.get(t.id), nm = names.get(t.id) || String(t.id);
        return {id: t.id, name: nm, reg: stateOf(nm), pos: posOf(t), gp: t.gp, w: t.w, l: t.l, d: t.d, pts: t.pts, pf: t.pf, pa: t.pa, pct: t.pa ? +(100 * t.pf / t.pa).toFixed(1) : null,
          p: T.cup.get(t.id) || 0, minor: T.minor.get(t.id) || 0, score: r ? r.score : 0, q: r ? r.q : FEATS.map(() => false),
          vals: FEATS.map(f => !r ? '—' : `${fv(f.k, r[f.k])} #${r['r_' + f.k]}`), idx: r ? +r.idx.toFixed(1) : null, rtg: +(M.r.get(t.id) ?? 0).toFixed(2)}; })};
    fs.writeFileSync(arg('--export'), JSON.stringify(out));
    console.log('\nexported -> ' + arg('--export'));
  }
  const bk = arg('--book');
  if (bk) { console.log('\nBOOK PRICES (pasted) -- EV = model p x decimal odds - 1');
    for (const pair of bk.split(',')) { const m = pair.trim().match(/^(.*?):\s*([+-]?\d+)$/); if (!m) continue; const am = +m[2], dec = am > 0 ? 1 + am / 100 : 1 + 100 / -am, w = m[1].trim().toLowerCase();
      const id = [...names].find(([, n]) => n.toLowerCase() === w || n.toLowerCase().includes(w) || w.includes(n.toLowerCase()))?.[0], p = id ? (T.cup.get(id) || 0) : null;
      console.log(`  ${m[1].padEnd(24)} ${m[2].padStart(6)} implied ${(100 / dec).toFixed(1)}% | model ${p == null ? 'n/a' : (100 * p).toFixed(1) + '% -> EV ' + (p * dec - 1 >= 0 ? '+' : '') + Math.round(100 * (p * dec - 1)) + '%'}`); } }
  if (rest.includes('--log')) {
    const file = 'C:/Users/User/baseball-blueprint/afl-history.md', head = '# AFL Premiership Blueprint — Run History\n\nEach run prepends a dated snapshot (engine: baseball-blueprint/pro/afl.mjs).\n\n---\n\n';
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : head, i = old.indexOf('---\n\n');
    let body = i >= 0 ? old.slice(i + 5) : ''; if (body.startsWith(`## ${today} `)) { const nx = body.indexOf('\n## '); body = nx >= 0 ? body.slice(nx + 1) : ''; }
    const entry = `## ${today} (${Y} season${done ? `, premier ${names.get(premier(G))}` : ''})\n\n${rows.slice().sort((a, b) => (T.cup.get(b.id) || 0) - (T.cup.get(a.id) || 0)).slice(0, 10).map(r => `- ${names.get(r.id)} ${r.score}/5 idx ${r.idx.toFixed(1)} · ${(100 * (T.cup.get(r.id) || 0)).toFixed(1)}%`).join('\n')}\n\n`;
    fs.writeFileSync(file, i >= 0 ? old.slice(0, i + 5) + entry + body : old + entry); console.log('\nlogged to ' + file);
  }
}
