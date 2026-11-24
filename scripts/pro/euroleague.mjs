// EuroLeague (men's basketball) title engine (built 2026-11-24, same house pattern as rugby.mjs / afl.mjs).
// Data: the EuroLeague's own public game feed (feeds.incrowdsports.com/provider/euroleague-feeds/v2/competitions/E/seasons/E<Y>/games?limit=1000),
// one JSON per season with phase codes RS (regular season / old first group stage), TS (old Top 16 groups, 2001-15), PI (play-in, 2023+),
// PO (best-of-5 playoffs; best-of-3 up to 2007), FF (Final Four), plus venue -> cached in %TEMP%/pro_bp_cache/euroleague.
// Model: team ratings from game MARGINS (recency-weighted ridge regression over the last two seasons + this one) + a home edge
// (a smaller one, fitted separately, for "displaced" home games: Maccabi / Hapoel Tel Aviv playing their home games abroad since 2023);
// P(home win) = Phi(margin / sigma). Season sim: rest of the regular season (standings = win%, then head-to-head among the tied teams,
// then head-to-head diff, then overall diff) -> play-in 7-10 (2023+) -> best-of-5 series (2-2-1, home court to the higher seed:
// 1v8, 4v5, 2v7, 3v6) -> neutral Final Four (1/8 v 4/5, 2/7 v 3/6, final). Old Top-16 era (2008-15, backtest only): groups simulated, the
// bracket slots (group, place) read from that season's actual quarterfinals.
//   node euroleague.mjs check | backtest | dump | [live] [--log] [--book "Real Madrid:+300,Fenerbahce:+450,..."] [--export file] [--sims N]
// NO KALSHI / Polymarket. The Odds API has EuroLeague game lines but NO outright market -> prices only from the user's DraftKings
// (else FanDuel) screenshot via --book. BP_TODAY=YYYY-MM-DD rewinds the board.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {TIER_NAME, rankRows, cutoffs as tierCuts, score as tierScore, cutLabel} from './tiers.mjs';

const DATA_FIRST = 2002;   // ratings warm-up (each season's pool = the two seasons before + this one)
const DUMP_FIRST = 2004;   // first season with playoffs before the Final Four (every-champion profile: 2004-25, 2019-20 cancelled)
const T_FIRST = 2008;      // title backtest: the best-of-5 era (2008-25)
// P: settings tuned by `backtest` on the first half of the seasons (also written to the cache's params.json).
const P0 = {half: 240, lam: 3, sig: 10};   // backtest 2026-11-24 (tuned on 2008-16 games; sigma 10 = the best of 8-14, half-life best of 90-540, shrink best of 1/3/10)
// every-champion rule (study/criteria.mjs euroleague on `dump`, 2026-11-24): all 21 champions 2004-25 cleared all 5 at the start of the post-season;
// ~5.3 of the ~8.3 post-season teams do -- a LOOSE filter. Honest test (search re-run without each season): the hidden champion cleared all 5 in only
// 14/21 (8/11 | 6/10), and as a predictor it was WORSE than a coin flip over the field in both halves (log-loss 2.37 vs 2.08 | 2.56 vs 2.15; also worse
// with 1-3 metrics and on 2016-25 alone) -> tiers are context only. Misses: 2011 + 2012 Olympiacos, 2013 Maccabi, 2015 CSKA, 2016 Fenerbahce, 2021 Efes, 2023 Panathinaikos.
const FEATS = [
  {k: 'wp', dir: 1, kind: 'rank', label: 'Win%'},
  {k: 'def', dir: 1, kind: 'rank', label: 'Defense (pts allowed vs avg)'},
  {k: 'rtg', dir: 1, kind: 'value', label: 'Rating'},
  {k: 'form5', dir: 1, kind: 'rank', label: 'Form (last 5)'},
  {k: 'hwp', dir: 1, kind: 'rank', label: 'Home win%'},
];
// index: champion's rank in the post-season field avg #2.81, #1 in 8/21, top-3 in 14/21 (rating alone #3.00, 8/21, 14/21); matched or beat the rating in both halves
const IDXW = {rtg: 70, awp: 30};
// display names (current + recent clubs); others fall back to the feed's short name. AKA = extra words a pasted book name may use.
const SHORT = {BAR: 'Barcelona', PAR: 'Partizan', OLY: 'Olympiacos', PAM: 'Valencia', BES: 'Besiktas', VIR: 'Virtus Bologna', DUB: 'Dubai', ASV: 'ASVEL',
  PRS: 'Paris', MUN: 'Bayern Munich', PAN: 'Panathinaikos', MAD: 'Real Madrid', TEL: 'Maccabi Tel Aviv', BAS: 'Baskonia', RED: 'Crvena Zvezda', MIL: 'Olimpia Milano',
  IST: 'Anadolu Efes', HTA: 'Hapoel Tel Aviv', ZAL: 'Zalgiris', ULK: 'Fenerbahce', MCO: 'Monaco', CSK: 'CSKA Moscow', DYR: 'Zenit', UNK: 'UNICS Kazan', KHI: 'Khimki',
  BER: 'ALBA Berlin', SIE: 'Siena', MAL: 'Unicaja', TIV: 'Lokomotiv Kuban', DAR: 'Darussafaka', BAM: 'Bamberg', CED: 'Cedevita', GAL: 'Galatasaray', LIE: 'Lietuvos Rytas'};
const AKA = {BAR: ['barca', 'barcelona'], OLY: ['olympiakos', 'olympiacos'], PAM: ['valencia'], VIR: ['virtus', 'bologna'], ASV: ['asvel', 'villeurbanne', 'lyon'],
  MUN: ['bayern', 'munich'], PAN: ['panathinaikos'], MAD: ['real madrid', 'real'], TEL: ['maccabi'], BAS: ['baskonia', 'vitoria'], RED: ['red star', 'zvezda', 'crvena'],
  MIL: ['milan', 'milano', 'olimpia', 'armani'], IST: ['efes', 'anadolu'], HTA: ['hapoel'], ZAL: ['zalgiris'], ULK: ['fenerbahce', 'fener'], PRS: ['paris'], DUB: ['dubai'],
  BES: ['besiktas'], PAR: ['partizan'], MCO: ['monaco']};
// home games played away from home (war): Israeli clubs outside Israel; recognised by the venue
const DISPL = {TEL: /MENORA|NOKIA|PAIS|JERUSALEM|YAD ELIYAHU|TEL AVIV/i, HTA: /MENORA|NOKIA|PAIS|JERUSALEM|YAD ELIYAHU|TEL AVIV|DRIVE IN|SHLOMO/i};

const [mode0 = 'live', ...rest] = process.argv.slice(2);
const mode = mode0.startsWith('--') ? 'live' : mode0; if (mode0.startsWith('--')) rest.unshift(mode0);
const arg = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
const CACHE = path.join(os.tmpdir(), 'pro_bp_cache', 'euroleague'); fs.mkdirSync(CACHE, {recursive: true});
const today = process.env.BP_TODAY || new Date().toLocaleDateString('en-CA');
const CURY = +today.slice(5, 7) >= 7 ? +today.slice(0, 4) : +today.slice(0, 4) - 1;   // season code: E2026 = 2026-27
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const seasonLabel = Y => `${Y}-${String(Y + 1).slice(2)}`;

// ---------- data ----------
async function raw(Y) {
  const f = path.join(CACHE, `E${Y}.json`);
  if (fs.existsSync(f)) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8')), complete = (j.data || []).some(g => g.phaseType?.code === 'FF' && /CHAMPIONSHIP|^FINAL/i.test(g.group?.name?.trim() || '') && g.status === 'result');
    if (Y < CURY - 1 || complete || Y === 2019 || Date.now() - fs.statSync(f).mtimeMs < 6 * 3600e3) return j;
  }
  for (let a = 0; a < 4; a++) {
    try { const r = await fetch(`https://feeds.incrowdsports.com/provider/euroleague-feeds/v2/competitions/E/seasons/E${Y}/games?limit=1000`, {signal: AbortSignal.timeout(60e3)});
      if (r.ok) { const j = await r.json(); if (Array.isArray(j.data)) { fs.writeFileSync(f, JSON.stringify(j)); return j; } } if (r.status === 404) return {data: []}; } catch {}
    await sleep(3000 * (a + 1));
  }
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {data: []};
}
const NAMES = new Map();   // code -> display name
const SEAS = {};
async function season(Y) {
  if (SEAS[Y]) return SEAS[Y];
  const j = await raw(Y), out = [], cancelled = new Map();
  for (const g of j.data || []) {
    const ph = g.phaseType?.code, grp = (g.group?.name || '').trim().replace(/\s+/g, ' ');
    if (!ph || !g.home?.code || !g.away?.code) continue;
    if (ph === 'FF' && /THIRD|3RD/i.test(grp)) continue;                    // third-place game: not part of the title path
    if (/cancel/i.test(g.status || '')) { for (const t of [g.home.code, g.away.code]) cancelled.set(t, (cancelled.get(t) || 0) + 1); continue; }   // 2021-22: Russian clubs expelled
    if (/suspend/i.test(g.status || '')) continue;                           // 2019-20 (COVID): season abandoned
    for (const t of [g.home, g.away]) if (!NAMES.has(t.code) || Y >= (NAMES.get(t.code).Y || 0)) NAMES.set(t.code, {Y, n: SHORT[t.code] || t.abbreviatedName || t.name});
    const fin = g.status === 'result' && g.home.score != null, h = g.home.code, a = g.away.code, venue = g.venue?.name || '';
    out.push({id: g.identifier, Y, d: (g.date || '').slice(0, 10), ph, grp, rnd: g.round?.round, h, a, hs: fin ? g.home.score : null, as: fin ? g.away.score : null, fin,
      sm: fin ? (g.home.standingsScore ?? g.home.score) - (g.away.standingsScore ?? g.away.score) : null,   // margin without overtime (the tiebreak diff)
      venue, post: ph === 'PI' || ph === 'PO' || ph === 'FF', neutral: ph === 'FF', disp: !!(DISPL[h] && venue && !DISPL[h].test(venue)) && ph !== 'FF',
      ch: ph === 'FF' && /CHAMPIONSHIP|^FINAL/i.test(grp)});
  }
  out.sort((x, y) => x.d.localeCompare(y.d) || String(x.id).localeCompare(String(y.id)));
  // clubs removed mid-season (CSKA, Zenit, UNICS in 2022): the league took their games out of the standings -> out of the deciding table too
  const gone = new Set([...cancelled].filter(([, c]) => c >= 5).map(([t]) => t)); for (const g of out) if (gone.has(g.h) || gone.has(g.a)) g.voidT = true;
  // Final Four in a club's own arena (2015 Real Madrid): that club gets its home edge
  const homeV = new Map(); for (const g of out) if (!g.post && !g.disp && g.venue) { if (!homeV.has(g.h)) homeV.set(g.h, new Set()); homeV.get(g.h).add(g.venue); }
  for (const g of out) if (g.ph === 'FF' && g.venue) {
    if (homeV.get(g.h)?.has(g.venue)) g.neutral = false;
    else if (homeV.get(g.a)?.has(g.venue)) { [g.h, g.a, g.hs, g.as, g.sm] = [g.a, g.h, g.as, g.hs, g.sm == null ? null : -g.sm]; g.neutral = false; }
  }
  return SEAS[Y] = out;
}
const nm = id => NAMES.get(id)?.n || id;
const champion = G => { const f = G.filter(g => g.ch && g.fin).pop(); return f ? (f.hs > f.as ? f.h : f.a) : null; };
const firstPost = G => G.filter(g => g.post).map(g => g.d).sort()[0];
const isLeague = Y => Y >= 2016, hasPlayin = Y => Y >= 2023, bestOf = Y => Y >= 2008 ? 5 : 3;
// the games that decide the playoff places: the single league (2016+) or the last group stage (Top 16 up to 2015)
const deciding = (Y, G) => G.filter(g => !g.voidT && (isLeague(Y) ? g.ph === 'RS' : g.ph === 'TS'));
const regular = G => G.filter(g => g.ph === 'RS' || g.ph === 'TS');

// ---------- ratings (afl.mjs/rugby.mjs ridge fit; edges: normal home Hs, displaced home Hd, neutral 0) ----------
function fit(games, asOf, P) {
  const G = games.filter(g => g.fin && g.d < asOf), t0 = Date.parse(asOf + 'T12:00:00Z');
  const w = G.map(g => Math.pow(0.5, (t0 - Date.parse(g.d + 'T12:00:00Z')) / 864e5 / P.half)), m = G.map(g => g.hs - g.as);
  const T = [...new Set(G.flatMap(g => [g.h, g.a]))], r = new Map(T.map(t => [t, 0])), idx = new Map();
  for (const [i, g] of G.entries()) for (const t of [g.h, g.a]) { if (!idx.has(t)) idx.set(t, []); idx.get(t).push(i); }
  let Hs = 3.5, Hd = 1.5;
  const edge = i => G[i].neutral ? 0 : G[i].disp ? Hd : Hs;
  for (let it = 0; it < 50; it++) {
    for (const t of T) { let den = P.lam, n2 = 0; for (const i of idx.get(t)) { const g = G[i], s = g.h === t ? 1 : -1, other = r.get(g.h === t ? g.a : g.h); den += w[i]; n2 += w[i] * (s * (m[i] - edge(i)) + other); } r.set(t, n2 / den); }
    const mu = mean([...r.values()]); for (const t of T) r.set(t, r.get(t) - mu);
    let ss = 0, ws = 0, sd = 0, wd = 0;
    for (const [i, g] of G.entries()) { if (g.neutral) continue; const res = m[i] - (r.get(g.h) - r.get(g.a)); if (g.disp) { sd += w[i] * res; wd += w[i]; } else { ss += w[i] * res; ws += w[i]; } }
    Hs = ws ? ss / ws : 0; Hd = wd > 3 ? sd / wd : Hs / 2;
  }
  return {r, Hs, Hd};
}
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
const Phi = x => 0.5 * (1 + erf(x / Math.SQRT2));
const predMargin = (M, g) => (M.r.get(g.h) ?? 0) - (M.r.get(g.a) ?? 0) + (g.neutral ? 0 : g.disp ? M.Hd : M.Hs);
const pHome = (M, g, P) => Phi(predMargin(M, g) / P.sig);
const LLf = (p, y) => -(y * Math.log(Math.max(p, 1e-6)) + (1 - y) * Math.log(Math.max(1 - p, 1e-6)));
const randn = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// ---------- standings: win%, then head-to-head wins among the tied teams, then head-to-head diff, then overall diff ----------
// played: [{h, a, m}] (m = home margin). groups: Map team -> group key (league = one group). Returns Map group -> ordered team ids.
function standings(teams, played, groupOf = () => 'L') {
  const ix = new Map(teams.map((t, i) => [t, i])), n = teams.length, W = new Float64Array(n * n), D = new Float64Array(n * n), w = new Float64Array(n), gp = new Float64Array(n), pd = new Float64Array(n);
  for (const g of played) { const i = ix.get(g.h), j = ix.get(g.a); if (i == null || j == null) continue; gp[i]++; gp[j]++; pd[i] += g.sm; pd[j] -= g.sm; D[i * n + j] += g.sm; D[j * n + i] -= g.sm;
    if (g.m > 0) { w[i]++; W[i * n + j]++; } else if (g.m < 0) { w[j]++; W[j * n + i]++; } else { w[i] += .5; w[j] += .5; } }
  return rankIdx(teams, groupOf, n, W, D, w, gp, pd);
}
function rankIdx(teams, groupOf, n, W, D, w, gp, pd, jitter = false) {
  const out = new Map(), byG = new Map();
  teams.forEach((t, i) => { const k = groupOf(t); if (!byG.has(k)) byG.set(k, []); byG.get(k).push(i); });
  for (const [k, mem] of byG) {
    const wp = i => gp[i] ? w[i] / gp[i] : 0;
    mem.sort((x, y) => wp(y) - wp(x));
    const ord = [];
    for (let s = 0; s < mem.length;) {
      let e = s + 1; while (e < mem.length && Math.abs(wp(mem[e]) - wp(mem[s])) < 1e-9) e++;
      const tie = mem.slice(s, e);
      if (tie.length > 1) {
        const hw = new Map(), hd = new Map(), rnd = new Map();
        for (const i of tie) { let a = 0, b = 0; for (const j of tie) if (j !== i) { a += W[i * n + j]; b += D[i * n + j]; } hw.set(i, a); hd.set(i, b); rnd.set(i, jitter ? Math.random() : 0); }
        tie.sort((x, y) => hw.get(y) - hw.get(x) || hd.get(y) - hd.get(x) || pd[y] - pd[x] || rnd.get(y) - rnd.get(x));
      }
      ord.push(...tie); s = e;
    }
    out.set(k, ord.map(i => teams[i]));
  }
  return out;
}
const asPlayed = games => games.filter(g => g.fin).map(g => ({h: g.h, a: g.a, m: g.hs - g.as, sm: g.sm ?? g.hs - g.as}));   // m decides the winner, sm (no overtime) the diffs

// ---------- the bracket ----------
// league era: seeds from the table (play-in 7-10 since 2023). Top-16 era: slots (group, place) of each quarterfinal + the Final Four pairing,
// read from that season's actual playoffs (the bracket was fixed before the playoffs; only the structure is used, not the results).
function oldBracket(Y, G) {
  const dec = deciding(Y, G), teams = [...new Set(dec.flatMap(g => [g.h, g.a]))], grpOf = new Map(dec.map(g => [g.h, g.grp]).concat(dec.map(g => [g.a, g.grp])));
  const st = standings(teams, asPlayed(dec), t => grpOf.get(t)), place = new Map(); for (const [k, ord] of st) ord.forEach((t, i) => place.set(t, [k, i]));
  const po = G.filter(g => g.ph === 'PO'), keys = [...new Set(po.map(g => g.grp))];
  const series = keys.map(k => { const gs = po.filter(g => g.grp === k).sort((x, y) => x.d.localeCompare(y.d)), hi = gs[0].h, lo = gs[0].a; return {k, hi, lo, hiSlot: place.get(hi), loSlot: place.get(lo)}; });
  const ff = G.filter(g => g.ph === 'FF' && !g.ch), pairs = ff.map(g => [series.findIndex(s => s.hi === g.h || s.lo === g.h), series.findIndex(s => s.hi === g.a || s.lo === g.a)]);
  return {series, pairs, grpOf, place};
}
const seriesCache = new Map();
function pSeries(M, P, hi, lo, bo, dispT) {   // P(higher seed wins) -- 2-2-1 (bo5), 1-1-1 (bo3), single game (bo1); home court = hi
  const key = hi + '|' + lo + '|' + bo; if (seriesCache.has(key)) return seriesCache.get(key);
  const d = (M.r.get(hi) ?? 0) - (M.r.get(lo) ?? 0), eH = dispT.has(hi) ? M.Hd : M.Hs, eL = dispT.has(lo) ? M.Hd : M.Hs;
  const pH = Phi((d + eH) / P.sig), pA = Phi((d - eL) / P.sig), seq = bo === 5 ? [pH, pH, pA, pA, pH] : bo === 3 ? [pH, pA, pH] : [pH], need = (bo + 1) / 2;
  let st = new Map([['0|0', 1]]);
  let win = 0;
  for (const p of seq) { const nx = new Map(); for (const [k, v] of st) { const [a, b] = k.split('|').map(Number); for (const [a2, b2, q] of [[a + 1, b, p], [a, b + 1, 1 - p]]) { if (a2 === need) win += v * q; else if (b2 === need) {} else nx.set(a2 + '|' + b2, (nx.get(a2 + '|' + b2) || 0) + v * q); } } st = nx; }
  seriesCache.set(key, win); return win;
}
// title simulation. info: {Y, G (season games, rewound), fixed: {seeds} | {series, pairs} | null}. Returns Map team -> P(title), .top = P(1st seed)
function simulate(M, P, Y, G, N = 20000, fixed = null, ffHost = null, OB0 = null) {
  seriesCache.clear();
  const dec = deciding(Y, G), league = isLeague(Y), bo = bestOf(Y), pin = hasPlayin(Y);
  const dispT = new Set(); { const last = new Map(); for (const g of regular(G)) if (!g.neutral) last.set(g.h, g.disp); for (const [t, v] of last) if (v) dispT.add(t); }
  const OB = league ? null : OB0 || oldBracket(Y, G);   // Top-16 era: slots from the season's full results (the structure only)
  const teams = [...new Set(dec.flatMap(g => [g.h, g.a]))], n = teams.length, ix = new Map(teams.map((t, i) => [t, i]));
  const grpOf = league ? () => 'L' : t => OB.grpOf.get(t);
  const W0 = new Float64Array(n * n), D0 = new Float64Array(n * n), w0 = new Float64Array(n), gp0 = new Float64Array(n), pd0 = new Float64Array(n);
  for (const g of asPlayed(dec)) { const i = ix.get(g.h), j = ix.get(g.a); gp0[i]++; gp0[j]++; pd0[i] += g.sm; pd0[j] -= g.sm; D0[i * n + j] += g.sm; D0[j * n + i] -= g.sm; if (g.m > 0) { w0[i]++; W0[i * n + j]++; } else { w0[j]++; W0[j * n + i]++; } }
  const left = dec.filter(g => !g.fin).map(g => ({i: ix.get(g.h), j: ix.get(g.a), pm: predMargin(M, g)}));
  const ffWin = (x, y) => { const e = ffHost === x ? M.Hs : ffHost === y ? -M.Hs : 0; return Math.random() < Phi(((M.r.get(x) ?? 0) - (M.r.get(y) ?? 0) + e) / P.sig) ? x : y; };
  const ser = (hi, lo, b = bo) => Math.random() < pSeries(M, P, hi, lo, b, dispT) ? hi : lo;
  const cup = new Map(), top = new Map();
  for (let s = 0; s < N; s++) {
    let series, pairs;
    if (fixed?.series) { series = fixed.series.map(x => [x.hi, x.lo]); pairs = fixed.pairs; }
    else {
      let seeds = fixed?.seeds, st = null;
      if (!seeds) {
        const W = W0.slice(), D = D0.slice(), w = w0.slice(), gp = gp0.slice(), pd = pd0.slice();
        for (const g of left) { const m = g.pm + P.sig * randn(); gp[g.i]++; gp[g.j]++; pd[g.i] += m; pd[g.j] -= m; D[g.i * n + g.j] += m; D[g.j * n + g.i] -= m; if (m > 0) { w[g.i]++; W[g.i * n + g.j]++; } else { w[g.j]++; W[g.j * n + g.i]++; } }
        st = rankIdx(teams, grpOf, n, W, D, w, gp, pd, true);
        if (league) seeds = st.get('L');
      }
      if (league) {
        const sd = seeds.slice();
        if (pin) { const a = ser(sd[6], sd[7], 1), la = a === sd[6] ? sd[7] : sd[6], b = ser(sd[8], sd[9], 1), c = ser(la, b, 1); sd[6] = a; sd[7] = c; }
        series = [[sd[0], sd[7]], [sd[3], sd[4]], [sd[1], sd[6]], [sd[2], sd[5]]]; pairs = [[0, 1], [2, 3]];
        top.set(sd[0], (top.get(sd[0]) || 0) + 1);
      } else {
        const at = ([k, i]) => st.get(k)[i];
        series = OB.series.map(x => [at(x.hiSlot), at(x.loSlot)]); pairs = OB.pairs;
      }
    }
    const qw = series.map(([hi, lo]) => ser(hi, lo));
    const ch = ffWin(ffWin(qw[pairs[0][0]], qw[pairs[0][1]]), ffWin(qw[pairs[1][0]], qw[pairs[1][1]]));
    cup.set(ch, (cup.get(ch) || 0) + 1);
  }
  const out = new Map([...cup].map(([k, v]) => [k, v / N])); out.top = new Map([...top].map(([k, v]) => [k, v / N])); return out;
}
// the actual bracket at the start of the post-season (play-in or playoffs)
function actualFixed(Y, G) {
  if (!isLeague(Y)) { const OB = oldBracket(Y, G); return {series: OB.series, pairs: OB.pairs}; }
  const dec = deciding(Y, G), teams = [...new Set(dec.flatMap(g => [g.h, g.a]))];
  return {seeds: standings(teams, asPlayed(dec)).get('L')};
}
// FF host club (Final Four in its own arena), known before the season
const ffHostOf = G => { const f = G.find(g => g.ph === 'FF' && !g.neutral); return f ? f.h : null; };

const loadP = () => fs.existsSync(path.join(CACHE, 'params.json')) ? JSON.parse(fs.readFileSync(path.join(CACHE, 'params.json'), 'utf8')) : P0;
const SEASONS = Array.from({length: CURY - DATA_FIRST + 1}, (_, i) => DATA_FIRST + i);
async function all() { const S = {}; for (const Y of SEASONS) S[Y] = await season(Y).catch(() => []); return S; }
const pool = (S, Y) => [...(S[Y - 2] || []), ...(S[Y - 1] || []), ...(S[Y] || [])];

// ---------- champion profile (at the start of the post-season = the day of the first play-in/playoff game) ----------
// universe = the teams in the deciding stage (the league; the Top 16 up to 2015); stats from every regular-season game (RS + Top 16).
function profile(Y, G, pl, asOf, P) {
  const reg = regular(G).filter(g => g.fin && g.d < asOf), dec = deciding(Y, G).filter(g => g.d < asOf), M = fit(pl, asOf, P);
  const uni = [...new Set(deciding(Y, G).flatMap(g => [g.h, g.a]))], T = new Map();
  const lgPts = reg.length ? mean(reg.flatMap(g => [g.hs, g.as])) : 0;
  for (const g of reg) for (const [me, pf, pa, side] of [[g.h, g.hs, g.as, g.neutral ? 0 : 1], [g.a, g.as, g.hs, g.neutral ? 0 : -1]]) {
    const t = T.get(me) || {id: me, pf: 0, pa: 0, w: 0, l: 0, gp: 0, res: [], hw: 0, hn: 0, aw: 0, an: 0}, r = pf > pa ? 1 : 0;
    t.gp++; t.pf += pf; t.pa += pa; if (r) t.w++; else t.l++; t.res.push([g.d, r]);
    if (side > 0) { t.hw += r; t.hn++; } else if (side < 0) { t.aw += r; t.an++; } T.set(me, t); }
  // standing: league = the table; Top-16 era = group place, then Top-16 win%, then diff (group winners first)
  let order;
  if (isLeague(Y)) order = standings(uni, asPlayed(dec)).get('L');
  else { const grpOf = new Map(deciding(Y, G).flatMap(g => [[g.h, g.grp], [g.a, g.grp]])), st = standings(uni, asPlayed(dec), t => grpOf.get(t)), pl2 = new Map(); for (const [, o] of st) o.forEach((t, i) => pl2.set(t, i));
    const tw = standings(uni, asPlayed(dec)).get('L'); order = uni.slice().sort((a, b) => pl2.get(a) - pl2.get(b) || tw.indexOf(a) - tw.indexOf(b)); }
  const rows = order.filter(id => T.has(id)).map((id, i) => { const t = T.get(id), s = t.res.sort((a, b) => a[0].localeCompare(b[0])), f = k => mean(s.slice(-k).map(x => x[1]));
    return {id, pos: i + 1, gp: t.gp, w: t.w, l: t.l, pf: t.pf, pa: t.pa, wp: t.w / t.gp, mgn: (t.pf - t.pa) / t.gp, off: t.pf / t.gp - lgPts, def: lgPts - t.pa / t.gp,
      rtg: M.r.get(id) ?? 0, form8: f(8), form5: f(5), hwp: t.hn ? t.hw / t.hn : 0, awp: t.an ? t.aw / t.an : 0}; });
  return {rows: rankRows(rows, FEATS), M};
}
function addIndex(rows) {
  const N = {}, tw = Object.values(IDXW).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(IDXW)) { const v = rows.map(r => +r[k]), lo = Math.min(...v), hi = Math.max(...v); N[k] = r => hi === lo ? 50 : 100 * (r[k] - lo) / (hi - lo); }
  for (const r of rows) r.idx = Object.entries(IDXW).reduce((a, [k, w]) => a + w * N[k](r), 0) / tw;
}
const fieldOf = G => [...new Set(G.filter(g => g.post).flatMap(g => [g.h, g.a]))];
const TITLE_SEASONS = S => SEASONS.filter(Y => Y >= T_FIRST && champion(S[Y]));

if (mode === 'dump') {   // every team's start-of-post-season profile -> study/data/euroleague.json (input for study/criteria.mjs)
  const S = await all(), P = loadP(), K = ['pos', 'wp', 'mgn', 'off', 'def', 'rtg', 'form8', 'form5', 'hwp', 'awp'];
  const out = {sport: 'euroleague', label: 'EuroLeague title', when: 'start of the post-season (play-in / playoffs)', fieldLabel: 'the play-in + playoff teams', universeLabel: 'the league (the Top 16 up to 2015)',
    cands: [{k: 'pos', dir: -1, label: 'Standing', value: true, rank: false, dec: 0}, {k: 'wp', dir: 1, label: 'Win%', value: true}, {k: 'mgn', dir: 1, label: 'Point diff/game', value: true, dec: 1},
      {k: 'off', dir: 1, label: 'Points for/game vs league avg', value: true, dec: 1}, {k: 'def', dir: 1, label: 'Points against/game vs league avg (lower = +)', value: true, dec: 1},
      {k: 'rtg', dir: 1, label: 'Rating', value: true, dec: 1}, {k: 'form8', dir: 1, label: 'Form (win%, last 8)', value: true}, {k: 'form5', dir: 1, label: 'Form (win%, last 5)', value: true},
      {k: 'hwp', dir: 1, label: 'Home win%', value: true}, {k: 'awp', dir: 1, label: 'Away win%', value: true}],
    seasons: []};
  for (const Y of SEASONS.filter(Y => Y >= DUMP_FIRST && Y < CURY)) {
    const G = S[Y], ch = champion(G); if (!ch) continue;
    const {rows} = profile(Y, G, pool(S, Y), firstPost(G), P);
    out.seasons.push({Y, champ: ch, champName: nm(ch), field: fieldOf(G), rows: rows.map(r => Object.fromEntries([['id', r.id], ['name', nm(r.id)], ...K.map(k => [k, r[k]])]))});
  }
  fs.mkdirSync('C:/Users/User/baseball-blueprint/study/data', {recursive: true});
  fs.writeFileSync('C:/Users/User/baseball-blueprint/study/data/euroleague.json', JSON.stringify(out));
  console.log(`dumped ${out.seasons.length} seasons -> study/data/euroleague.json · champs: ${out.seasons.map(s => `${s.Y} ${s.champName} (#${s.rows.find(r => r.id === s.champ)?.pos} of ${s.field.length})`).join(', ')}`);
  process.exit(0);
}
if (mode === 'check') {
  const S = await all();
  for (const Y of SEASONS) {
    const G = S[Y], reg = regular(G), ch = champion(G), ph = {}; for (const g of G) ph[g.ph] = (ph[g.ph] || 0) + 1;
    let note = '';
    if (ch && Y >= DUMP_FIRST) {
      if (isLeague(Y)) {   // computed seeds vs the actual post-season matchups
        const sd = actualFixed(Y, G).seeds, po = G.filter(g => g.ph === 'PO'), pi = G.filter(g => g.ph === 'PI');
        const want = hasPlayin(Y) ? [[sd[0]], [sd[1]], [sd[2], sd[5]], [sd[3], sd[4]]] : [[sd[0], sd[7]], [sd[1], sd[6]], [sd[2], sd[5]], [sd[3], sd[4]]];
        const g1 = [...new Set(po.map(g => g.grp))].map(k => po.filter(g => g.grp === k).sort((x, y) => x.d.localeCompare(y.d))[0]);
        const ok = want.every(([a, b]) => g1.some(g => g.h === a && (b == null || g.a === b)));
        const piOk = !hasPlayin(Y) || (pi.some(g => g.h === sd[6] && g.a === sd[7]) && pi.some(g => g.h === sd[8] && g.a === sd[9]));
        const ffOk = (() => { const w = new Map(); for (const g of g1) { const ser = po.filter(x => x.grp === g.grp); const c = new Map(); for (const x of ser) { const wn = x.hs > x.as ? x.h : x.a; c.set(wn, (c.get(wn) || 0) + 1); } w.set(g.h, [...c].sort((a, b) => b[1] - a[1])[0][0]); }
          const sf = G.filter(g => g.ph === 'FF' && !g.ch), byTop = [sd[0], sd[1]].map(s => w.get(s)), qf = q => [...w].find(([h]) => h === q)?.[1];
          const pairA = [qf(sd[0]), qf(sd[3])], pairB = [qf(sd[1]), qf(sd[2])];
          return sf.every(g => [pairA, pairB].some(p => p.includes(g.h) && p.includes(g.a))); })();
        note = `seeds ${ok ? 'OK' : 'MISMATCH'}${hasPlayin(Y) ? ` · play-in ${piOk ? 'OK' : 'MISMATCH'}` : ''} · FF pairing 1/8-4/5 ${ffOk ? 'OK' : 'MISMATCH'} · 1-${hasPlayin(Y) ? 10 : 8}: ${sd.slice(0, hasPlayin(Y) ? 10 : 8).join(' ')}`;
      } else { const OB = oldBracket(Y, G), slots = OB.series.map(s => `${s.hiSlot?.join('')}v${s.loSlot?.join('')}`.replace(/Group /g, ''));
        note = `QF slots ${slots.join(' ')} · FF pairs ${OB.pairs.map(p => p.join('+')).join(' / ')}${OB.series.some(s => !s.hiSlot || !s.loSlot) || OB.pairs.flat().includes(-1) ? ' · PROBLEM' : ''}`; }
    }
    console.log(`${Y} (${seasonLabel(Y)}): ${JSON.stringify(ph)} · regular ${reg.filter(g => g.fin).length}/${reg.length} played · ${reg.map(g => g.d).sort()[0] ?? '—'} .. ${reg.map(g => g.d).sort().pop() ?? '—'} · post ${firstPost(G) ?? '—'} · champion ${ch ? nm(ch) : '—'}${ffHostOf(G) ? ` · FF host ${nm(ffHostOf(G))}` : ''}${G.some(g => g.disp) ? ` · displaced home games ${G.filter(g => g.disp).length}` : ''}${note ? '\n    ' + note : ''}`);
  }
  process.exit(0);
}
if (mode === 'backtest') {
  const S = await all(), TY = TITLE_SEASONS(S), half = Math.ceil(TY.length / 2), H1 = TY.slice(0, half), H2 = TY.slice(half);
  const rkeys = Y => [...new Set(regular(S[Y]).filter(g => g.fin).map(g => g.ph + g.rnd))];
  const fitsFor = P => { const F = new Map(); for (const Y of TY) for (const rk of rkeys(Y)) { const d0 = regular(S[Y]).filter(g => g.ph + g.rnd === rk).map(g => g.d).sort()[0]; F.set(Y + '|' + rk, fit(pool(S, Y), d0, P)); } return F; };
  const yv = g => g.hs > g.as ? 1 : 0;
  const evalM = (P, F, Ys) => mean(Ys.flatMap(Y => regular(S[Y]).filter(g => g.fin).map(g => LLf(pHome(F.get(Y + '|' + g.ph + g.rnd), g, P), yv(g)))));
  let best = null; const cache = new Map();
  for (const hl of [90, 150, 240, 365, 540]) for (const lam of [1, 3, 10]) { const F = fitsFor({half: hl, lam}); cache.set(hl + '|' + lam, F);
    for (const sig of [8, 9, 10, 11, 12, 13, 14]) { const P = {half: hl, lam, sig}, ll = evalM(P, F, H1); if (!best || ll < best.ll) best = {P, ll}; } }
  const P = best.P, F = cache.get(P.half + '|' + P.lam);
  const hb = Ys => { const g = Ys.flatMap(Y => regular(S[Y]).filter(x => x.fin)), hr = mean(g.map(yv)); return mean(g.map(x => LLf(hr, yv(x)))); };
  const acc = Ys => mean(Ys.flatMap(Y => regular(S[Y]).filter(g => g.fin).map(g => (pHome(F.get(Y + '|' + g.ph + g.rnd), g, P) > 0.5) === (yv(g) === 1) ? 1 : 0)));
  console.log(`EuroLeague backtest -- title seasons ${TY[0]}-${TY[TY.length - 1]} (${TY.length}; 2019-20 cancelled) · halves ${H1[0]}-${H1[H1.length - 1]} / ${H2[0]}-${H2[H2.length - 1]}`);
  console.log(`GAMES (regular season + Top 16, refit every round): tuned on the 1st half -> half-life ${P.half} d, shrink ${P.lam}, sigma ${P.sig} pts`);
  console.log(`  1st half LL ${evalM(P, F, H1).toFixed(4)} vs home-win base rate ${hb(H1).toFixed(4)} (acc ${(100 * acc(H1)).toFixed(1)}%) · 2nd half (held out) LL ${evalM(P, F, H2).toFixed(4)} vs ${hb(H2).toFixed(4)} (acc ${(100 * acc(H2)).toFixed(1)}%) · coin 0.6931`);
  const fm = []; for (const Y of TY) for (const g of S[Y].filter(g => g.post && g.fin)) { const M = fit(pool(S, Y), g.d, P); fm.push({Y, ll: LLf(pHome(M, g, P), yv(g)), y: yv(g), neu: g.neutral}); }
  const hostLL = Ys => mean(fm.filter(x => Ys.includes(x.Y)).map(x => x.neu ? Math.log(2) : LLf(mean(fm.filter(z => !z.neu && z.Y !== x.Y).map(z => z.y)), x.y)));
  const fl = Ys => mean(fm.filter(x => Ys.includes(x.Y)).map(x => x.ll));
  console.log(`\nPLAY-IN / PLAYOFF / FINAL FOUR GAMES (${fm.length}): model LL ${fl(TY).toFixed(4)} (${fl(H1).toFixed(4)} | ${fl(H2).toFixed(4)}) vs "host wins" ${hostLL(TY).toFixed(4)} (${hostLL(H1).toFixed(4)} | ${hostLL(H2).toFixed(4)})`);
  const titles = [];
  for (const Y of TY) {
    const G = S[Y], ch = champion(G), first = firstPost(G), fx = actualFixed(Y, G);
    const field = fx.seeds ? fx.seeds.slice(0, hasPlayin(Y) ? 10 : 8) : (() => { const OB = oldBracket(Y, G), t = OB.series.flatMap(s => [s.hi, s.lo]); return t.sort((a, b) => OB.place.get(a)[1] - OB.place.get(b)[1] || 0); })();
    let seedOf = field.indexOf(ch) + 1;
    if (!fx.seeds) { const {rows} = profile(Y, G, pool(S, Y), first, P); seedOf = rows.filter(r => field.includes(r.id)).findIndex(r => r.id === ch) + 1; }
    const Tf = simulate(fit(pool(S, Y), first, P), P, Y, G, 20000, fx, ffHostOf(G));
    const reg = regular(G), ds = reg.map(g => g.d).sort(); let d75 = ds[Math.floor(0.75 * ds.length)];
    if (!isLeague(Y)) { const t0 = G.filter(g => g.ph === 'TS').map(g => g.d).sort()[0]; if (d75 < t0) d75 = t0; }
    const G75 = G.map(g => g.d < d75 || g.post ? g : {...g, fin: false, hs: null, as: null});
    const T75 = simulate(fit(pool(S, Y).map(g => g.d < d75 ? g : {...g, fin: false}), d75, P), P, Y, G75, 8000, null, ffHostOf(G), isLeague(Y) ? null : oldBracket(Y, G));
    const rk = (T, id) => 1 + [...T.values()].filter(v => v > (T.get(id) || 0)).length;
    const nT = new Set(deciding(Y, G).flatMap(g => [g.h, g.a])).size;
    const pos75 = profile(Y, G75, pool(S, Y), d75, P).rows.find(r => r.id === ch)?.pos ?? nT;   // the champion's standing at the 75% mark (Top-16 era: group place first)
    // info only: one-third of the league season (2016+: where today's board sits in late November; the Top-16 era has no comparable point)
    let p35 = null, r35 = null;
    if (isLeague(Y)) { const d35 = ds[Math.floor(0.35 * ds.length)], G35 = G.map(g => g.d < d35 || g.post ? g : {...g, fin: false, hs: null, as: null}), T35 = simulate(fit(pool(S, Y), d35, P), P, Y, G35, 8000);
      p35 = T35.get(ch) || 0; r35 = rk(T35, ch); }
    titles.push({Y, ch: nm(ch), seed: seedOf, nF: field.length, p: Tf.get(ch) || 0, r: rk(Tf, ch), p75: T75.get(ch) || 0, r75: rk(T75, ch), nT, pos75, p35, r35, fav: nm([...Tf].sort((a, b) => b[1] - a[1])[0][0])});
  }
  console.log(`\nTITLE ODDS (${TY[0]}-${TY[TY.length - 1]}) -- start of the post-season (bracket known) | at 75% of the regular season`);
  for (const t of titles) console.log(`  ${seasonLabel(t.Y)} ${String(t.ch).padEnd(18)} seed ${String(t.seed).padStart(2)}/${t.nF} | post-season start ${(100 * t.p).toFixed(1).padStart(5)}% (#${t.r}; fav ${t.fav}) | 75% ${(100 * t.p75).toFixed(1).padStart(5)}% (#${t.r75} of ${t.nT}; ${t.pos75}. in the standings)`);
  const Lg = a => mean(a.map(p => -Math.log(Math.max(p, 1e-4))));
  const posLL = Ys => mean(titles.filter(t => Ys.includes(t.Y)).map(t => { const tr = titles.filter(z => z.Y !== t.Y); return -Math.log((tr.filter(z => z.pos75 === t.pos75).length + 0.5) / (tr.length + 0.5 * t.nT)); }));
  const seedLL = Ys => mean(titles.filter(t => Ys.includes(t.Y)).map(t => { const tr = titles.filter(z => z.Y !== t.Y); return -Math.log((tr.filter(z => z.seed === t.seed).length + 0.5) / (tr.length + 0.5 * t.nF)); }));
  for (const [lab, Ys] of [['ALL', TY], ['1st half', H1], ['2nd half', H2]]) { const rs = titles.filter(t => Ys.includes(t.Y));
    console.log(`  ${lab.padEnd(9)} post-season start: #1 won ${rs.filter(t => t.r === 1).length}/${rs.length} · top-3 ${rs.filter(t => t.r <= 3).length} · champ avg rank #${mean(rs.map(t => t.r)).toFixed(2)} · LL ${Lg(rs.map(t => t.p)).toFixed(3)} vs equal ${mean(rs.map(t => Math.log(t.nF))).toFixed(3)} vs seed history ${seedLL(Ys).toFixed(3)} | 75%: #1 ${rs.filter(t => t.r75 === 1).length} · avg rank #${mean(rs.map(t => t.r75)).toFixed(2)} · LL ${Lg(rs.map(t => t.p75)).toFixed(3)} vs equal ${mean(rs.map(t => Math.log(t.nT))).toFixed(3)} vs standing history ${posLL(Ys).toFixed(3)}`); }
  { const rs = titles.filter(t => t.p35 != null); console.log(`  INFO 35% of the season (2016-25 only, ${rs.length} seasons): #1 won ${rs.filter(t => t.r35 === 1).length} · champ avg rank #${mean(rs.map(t => t.r35)).toFixed(2)} · champ p ${rs.map(t => (100 * t.p35).toFixed(1) + '%').join(' ')} · LL ${Lg(rs.map(t => t.p35)).toFixed(3)} vs equal ${mean(rs.map(t => Math.log(t.nT))).toFixed(3)}`); }
  console.log(`  1 seed won ${titles.filter(t => t.seed === 1).length}/${titles.length} · top-2 seed ${titles.filter(t => t.seed <= 2).length}/${titles.length} · top-4 ${titles.filter(t => t.seed <= 4).length}/${titles.length}`);
  fs.writeFileSync(path.join(CACHE, 'params.json'), JSON.stringify(P));
  fs.writeFileSync(path.join(CACHE, 'titles.json'), JSON.stringify(titles));
  process.exit(0);
}
// ---------- live board (+ --export JSON; BP_TODAY=YYYY-MM-DD rewinds it to a past date) ----------
{
  const S0 = await all(), P = loadP(), asOf = new Date(Date.parse(today + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
  const rewind = G => G.map(g => g.d < asOf ? g : {...g, fin: false, hs: null, as: null});   // games on/after asOf count as unplayed
  const S = Object.fromEntries(Object.entries(S0).map(([Y, G]) => [Y, rewind(G)]));
  let Y = CURY; if (!S[Y]?.some(g => g.ph === 'RS')) Y--;
  // offseason: once this season is decided, switch to next season's schedule as soon as it is published in full (a preseason board)
  if (champion(S[Y]) && !process.env.BP_TODAY) { try { const nx = await season(Y + 1), creg = deciding(Y, S[Y]).length;
    if (deciding(Y + 1, nx).length >= 0.9 * creg) { S[Y + 1] = rewind(nx); S0[Y + 1] = nx; Y++; } } catch {} }
  const G = S[Y], dec = deciding(Y, G), first = firstPost(G), done = !!champion(G);
  const postStarted = G.some(g => g.post && g.fin), started = dec.some(g => g.fin);
  const stage = done ? 'done' : postStarted ? 'post-season' : started ? 'regular' : 'preseason', N = +(arg('--sims') || 20000);
  // title odds: before the post-season = the rest of the regular season + play-in + playoffs + Final Four; once the play-in/playoffs start =
  // FROZEN at the start of the post-season (ratings fit on games before the first play-in/playoff game, actual seeds) -- the user never bets within the playoffs
  const freezeAt = postStarted ? first : asOf, Gs = postStarted ? G.map(g => g.post ? {...g, fin: false, hs: null, as: null} : g) : G;
  const fixed = postStarted ? actualFixed(Y, Gs) : null;
  const M = fit(pool(S, Y).map(g => g.d < freezeAt ? g : {...g, fin: false}), freezeAt, P), T = simulate(M, P, Y, Gs, N, fixed, ffHostOf(G));
  let PG = G, PY = Y, pAsOf = freezeAt;
  if (stage === 'preseason' && S[Y - 1]?.length) { PG = S[Y - 1]; PY = Y - 1; pAsOf = firstPost(PG) || asOf; }
  const {rows} = profile(PY, PG, pool(S, PY), pAsOf, P);
  const TS = SEASONS.filter(Yp => Yp >= DUMP_FIRST && Yp < Y && champion(S[Yp])).map(Yp => { const Gp = S[Yp], ch = champion(Gp); return profile(Yp, Gp, pool(S, Yp), firstPost(Gp), P).rows.find(r => r.id === ch); }).filter(Boolean);
  const cuts = tierCuts(TS, FEATS, 1);   // each cutoff = the loosest champion (every champion cleared all of them)
  for (const r of rows) tierScore(r, FEATS, cuts);
  addIndex(rows);
  const prof = new Map(rows.map(r => [r.id, r])), curT = [...new Set(dec.flatMap(g => [g.h, g.a]))];
  const tab = standings(curT, asPlayed(dec.filter(g => !postStarted || !g.post))).get('L'), rec = new Map(curT.map(t => [t, {w: 0, l: 0, pf: 0, pa: 0}]));
  for (const g of dec.filter(g => g.fin)) { const H = rec.get(g.h), A = rec.get(g.a); H.pf += g.hs; H.pa += g.as; A.pf += g.as; A.pa += g.hs; if (g.hs > g.as) { H.w++; A.l++; } else { A.w++; H.l++; } }
  const played = dec.filter(g => g.fin).length, pct = dec.length ? 100 * played / dec.length : 0;
  const fair = p => p < 0.001 ? '—' : p >= 0.5 ? '-' + Math.round(100 * p / (1 - p)) : '+' + Math.round(100 * (1 - p) / p);
  const fv = (k, v) => v == null || !isFinite(v) ? '—' : k === 'pos' ? String(Math.round(v)) : /rtg|mgn|off|def/.test(k) ? (v >= 0 ? '+' : '') + v.toFixed(1) : /wp|form/.test(k) ? v.toFixed(3) : v.toFixed(1);
  // pasted book prices -> team ids
  const book = new Map(), unmatched = [];
  const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const matchTeam = w => { const x = norm(w); let bestId = null, bl = 0;
    for (const id of curT) for (const a of [nm(id), id, ...(AKA[id] || [])].map(norm)) if (a && (x === a || x.includes(a) || (a.includes(x) && x.length >= 4)) && a.length > bl) { bestId = id; bl = a.length; }
    return bestId; };
  if (arg('--book')) for (const pair of arg('--book').split(',')) { const m = pair.trim().match(/^(.*?):\s*([+-]?\d+)$/); if (!m) continue; const id = matchTeam(m[1]); if (id) book.set(id, +m[2]); else unmatched.push(m[1].trim()); }
  const ev = (id, p) => { if (!book.has(id)) return null; const am = book.get(id), dec2 = am > 0 ? 1 + am / 100 : 1 + 100 / -am; return p * dec2 - 1; };
  console.log(`EuroLeague title odds -- ${seasonLabel(Y)} season, games through ${today} · ${played}/${dec.length} regular-season games played (${pct.toFixed(0)}%) · stage: ${stage}${done ? ` · CHAMPION: ${nm(champion(G))} (odds = frozen at the start of the post-season)` : postStarted ? ' (odds frozen at the start of the post-season)' : ''}`);
  if (PY !== Y) console.log(`tiers/index = ${seasonLabel(PY)} at the start of its post-season (${seasonLabel(Y)} hasn't started) -- title odds are preseason, from ratings that fade toward average (untested stage)`);
  console.log(`model: half-life ${P.half} d, shrink ${P.lam}, sigma ${P.sig} pts · home edge ${M.Hs.toFixed(1)} pts (displaced home games ${M.Hd.toFixed(1)}) · ${N} sims of the rest of the season + play-in + best-of-5 playoffs + neutral Final Four`);
  console.log(`VERDICT (backtest 2026-11-24): 🟡 FAIR (thin) -- title odds beat equal odds + seed history in both halves at the start of the post-season (1st half only just: LL 2.04 vs 2.08) and clearly at 75% of the season; the every-champion rule lost to a coin flip, so tiers are context only (like Super League/AFL/CFL). Value play only from 75% of the season to the play-in, EV >= +20%, <= +2500, top 3 by fair odds.`);
  console.log(`TIERS -- every-champion profile (${TS.length} champions ${DUMP_FIRST}-${Y - 1}): ${FEATS.map((f, i) => cutLabel(f, cuts[i], v => fv(f.k, +v))).join(' · ')}`);
  console.log(`index (0-100) = ${Object.entries(IDXW).map(([k, w]) => `${{rtg: 'Rating', wp: 'Win%', awp: 'Away win%', mgn: 'Point diff/g', def: 'Defense', off: 'Offense', hwp: 'Home win%'}[k] || k} ${w}`).join(' · ')}${book.size ? ' · EV = fair p x decimal book odds - 1' : ''}\n`);
  const order = tab.slice().sort((a, b) => (T.get(b) || 0) - (T.get(a) || 0) || (prof.get(b)?.idx ?? 0) - (prof.get(a)?.idx ?? 0));
  for (const id of order) {
    const p = T.get(id) || 0, r = prof.get(id), R = rec.get(id), e = ev(id, p), pos = PY !== Y ? (r?.pos ?? '-') : tab.indexOf(id) + 1;
    console.log(`  ${TIER_NAME(r ? r.score : 0).padEnd(18)} ${String(nm(id)).padEnd(17)} #${String(pos).padEnd(2)} ${R.w}-${R.l} (diff ${R.pf - R.pa >= 0 ? '+' : ''}${R.pf - R.pa}) | idx ${r ? r.idx.toFixed(1).padStart(5) : '    —'} | rating ${(M.r.get(id) ?? 0) >= 0 ? '+' : ''}${(M.r.get(id) ?? 0).toFixed(1)} | title ${(100 * p).toFixed(1).padStart(5)}% (fair ${fair(p)})${book.has(id) ? ` | book ${book.get(id) > 0 ? '+' : ''}${book.get(id)} EV ${e >= 0 ? '+' : ''}${Math.round(100 * e)}%` : ''}${r ? ' | ' + r.q.map(x => x ? '✓' : '✗').join('') + ` ${r.score}/${FEATS.length}` : ''}`); }
  console.log(`  checks (in order): ${FEATS.map(f => f.label).join(' · ')}`);
  if (unmatched.length) console.log(`  !! book names not matched to a team: ${unmatched.join(', ')}`);
  if (arg('--export')) {
    const out = {league: 'euroleague', label: 'EuroLeague', season: Y, profile_season: PY, generated: new Date().toISOString(), today, stage, first_post: first || null, played, games: dec.length, sims: N,
      champion: done ? nm(champion(G)) : null, champions: TS.length, sig: P.sig, hfa: {home: +M.Hs.toFixed(2), displaced: +M.Hd.toFixed(2)},
      cats: FEATS.map((f, i) => cutLabel(f, cuts[i], v => fv(f.k, +v))), labels: FEATS.map(f => f.label),
      teams: tab.map((id, i) => { const r = prof.get(id), R = rec.get(id);
        return {id, name: nm(id), pos: i + 1, w: R.w, l: R.l, pf: R.pf, pa: R.pa, p: T.get(id) || 0, top: T.top.get(id) || 0, score: r ? r.score : 0, q: r ? r.q : FEATS.map(() => false),
          vals: FEATS.map(f => !r ? '—' : fv(f.k, r[f.k])), idx: r ? +r.idx.toFixed(1) : null, rtg: +(M.r.get(id) ?? 0).toFixed(2), book: book.get(id) ?? null}; })};
    fs.writeFileSync(arg('--export'), JSON.stringify(out)); console.log('\nexported -> ' + arg('--export'));
  }
  if (rest.includes('--log')) {
    const file = 'C:/Users/User/baseball-blueprint/euroleague-history.md', head = `# EuroLeague Title Blueprint — Run History\n\nEach run prepends a dated snapshot (engine: baseball-blueprint/pro/euroleague.mjs). Verdict (backtest 2026-11-24): ❌ not bet-able -- context only, no command file.\n\n---\n\n`;
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : head, i = old.indexOf('---\n\n');
    let body = i >= 0 ? old.slice(i + 5) : ''; if (body.startsWith(`## ${today} `)) { const nx = body.indexOf('\n## '); body = nx >= 0 ? body.slice(nx + 1) : ''; }
    const entry = `## ${today} (${seasonLabel(Y)} season, ${pct.toFixed(0)}% of the regular season played${done ? `, champion ${nm(champion(G))}` : ''})\n\n${[...T].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, p]) => `- ${nm(id)} ${prof.get(id) ? prof.get(id).score + '/' + FEATS.length + ' · ' : ''}${(100 * p).toFixed(1)}% (fair ${fair(p)})${book.has(id) ? ` · book ${book.get(id) > 0 ? '+' : ''}${book.get(id)} · EV ${ev(id, p) >= 0 ? '+' : ''}${Math.round(100 * ev(id, p))}%` : ''}`).join('\n')}\n\n`;
    fs.writeFileSync(file, i >= 0 ? old.slice(0, i + 5) + entry + body : old + entry); console.log('\nlogged to ' + file);
  }
}
