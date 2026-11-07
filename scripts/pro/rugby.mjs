// NRL + Super League premiership engine (built 2026-11-07, user: "NRL Premiership ... super league rugby ... can you create a blueprint
// for these? ... remove any that dont pass backtest"). Data: Rugby League Project season results pages (rugbyleagueproject.org), cached.
// Model (same as afl.mjs): team ratings from game MARGINS (recency-weighted ridge regression) + home edge (same region vs travelling
// visitor); P(home win) = Phi(margin / sigma). Season sim: remaining regular-season games -> ladder (2 pts a win, 1 a draw, then points
// difference) -> finals.  NRL finals 2012+: final eight (QF 1v4 / 2v3, EF 5v8 / 6v7, SF, PF, neutral GF).
// Super League finals 2021+: top six (eliminators 3v6 / 4v5, semis 1 v lowest remaining / 2 v highest, neutral GF).
//   node rugby.mjs <nrl|superleague> check | backtest | dump | [live] [--log] [--book "Penrith:+300,..."]
// NO KALSHI. No odds feed carries these futures -> prices only from the user's DraftKings/FanDuel screenshot.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {TIER_NAME, rankRows, cutoffs as tierCuts, score as tierScore, cutLabel} from './tiers.mjs';
// alias: the site's club slugs change with renames/sponsors (fixed 2026-11-07 -- before this a renamed club split into two teams
// across seasons, e.g. NRL "bulldogs" 2003-09 -> "canterbury-bankstown-bulldogs"). full: display names (the site shows short ones).
// P: settings tuned by `backtest` on the first half of the seasons (also written to the cache's params.json).
const LG = {
  nrl: {slug: 'nrl', label: 'NRL', first: 2005, fmtOf: Y => Y >= 2012 ? 'eight' : null, P: {half: 120, lam: 3, sig: 24},
    region: s => /brisbane|north-queensland|gold-coast|dolphins|redcliffe/.test(s) ? 'QLD' : /melbourne/.test(s) ? 'VIC' : /warriors|auckland/.test(s) ? 'NZ' : /canberra/.test(s) ? 'ACT' : /perth/.test(s) ? 'WA' : 'NSW',
    alias: {bulldogs: 'canterbury-bankstown-bulldogs'},
    full: {'brisbane-broncos': 'Brisbane Broncos', 'canberra-raiders': 'Canberra Raiders', 'canterbury-bankstown-bulldogs': 'Canterbury-Bankstown Bulldogs', cronulla: 'Cronulla-Sutherland Sharks',
      dolphins: 'Dolphins', 'gold-coast-titans': 'Gold Coast Titans', 'manly-warringah-sea-eagles': 'Manly Warringah Sea Eagles', melbourne: 'Melbourne Storm', 'newcastle-knights': 'Newcastle Knights',
      'north-queensland-cowboys': 'North Queensland Cowboys', 'parramatta-eels': 'Parramatta Eels', 'penrith-panthers': 'Penrith Panthers', 'south-sydney-rabbitohs': 'South Sydney Rabbitohs',
      'st-george-illawarra-dragons': 'St George Illawarra Dragons', 'sydney-roosters': 'Sydney Roosters', warriors: 'New Zealand Warriors', 'wests-tigers': 'Wests Tigers',
      'perth-bears': 'Perth Bears'},
    // every-champion rule (study/criteria.mjs on `dump`, 2026-11-07): all 22 premiers 2005-26 cleared all 5 at the end of the regular season; ~2.7 of
    // the 8 finals teams do. Honest test (search re-run without each season): the hidden premier cleared all 5 in 18/22 (9/11 in each half), and as a
    // predictor it beat a coin flip over the field in both halves (log-loss 1.59 vs 2.08 | 1.70 vs 2.08). Misses: 2005 Wests, 2014 Souths, 2016 Cronulla, 2026 Roosters.
    FEATS: [{k: 'pos', dir: -1, kind: 'value', label: 'Ladder position'}, {k: 'mgn', dir: 1, kind: 'value', label: 'Margin/game'}, {k: 'rtg', dir: 1, kind: 'value', label: 'Rating'},
      {k: 'hwp', dir: 1, kind: 'rank', label: 'Home win%'}, {k: 'awp', dir: 1, kind: 'rank', label: 'Away win%'}],
    // index: premier's rank in the finals field avg #2.00, #1 in 8/22, top-3 in 21/22 (rating alone #2.18); matched or beat the rating in both halves
    IDXW: {rtg: 60, wp: 20, awp: 20}},
  superleague: {slug: 'super-league', label: 'Super League', first: 2005, fmtOf: Y => Y >= 2021 ? 'six' : Y >= 2015 && Y <= 2018 ? 'four' : null, P: {half: 240, lam: 1, sig: 22},
    region: s => /catalan|toulouse|paris/.test(s) ? 'FRA' : /toronto/.test(s) ? 'CAN' : 'ENG',
    alias: {'salford-city-reds': 'salford', 'salford-red-devils': 'salford', 'salford-rlfc': 'salford', 'wakefield-trinity-wildcats': 'wakefield-trinity', 'leigh-centurions': 'leigh',
      'leigh-leopards': 'leigh', 'york-city-knights': 'york', 'york-knights': 'york', harlequins: 'london-broncos', 'celtic-2000': 'celtic-crusaders', 'halifax-rlfc': 'halifax',
      'halifax-panthers': 'halifax', 'doncaster-dragons': 'doncaster', 'doncaster-lakers': 'doncaster', 'doncaster-rlfc': 'doncaster', 'hunslet-hawks': 'hunslet', 'hunslet-rlfc': 'hunslet',
      'whitehaven-warriors': 'whitehaven-rlfc'},
    full: {},
    // every-champion rule (2026-11-07): all 22 champions 2005-26 cleared all 5; ~3.3 of the ~6 play-off teams do. Honest test: the hidden champion
    // cleared all 5 in 17/22 (8/11 | 9/11), but as a predictor it was WORSE than a coin flip over the field in both halves (1.96 vs 1.91 | 1.73 vs 1.67)
    // -> tiers are context only; the odds come from the simulation. Misses: Leeds 2011, 2012, 2017, Wigan 2013, 2016.
    FEATS: [{k: 'pos', dir: -1, kind: 'value', label: 'Ladder position'}, {k: 'pct', dir: 1, kind: 'value', label: 'Percentage (PF/PA)'}, {k: 'mgn', dir: 1, kind: 'rank', label: 'Margin/game'},
      {k: 'hwp', dir: 1, kind: 'rank', label: 'Home win%'}, {k: 'awp', dir: 1, kind: 'value', label: 'Away win%'}],
    // index: champion's rank in the play-off field avg #1.91, #1 in 11/22, top-3 in 19/22 (rating alone #2.05); matched or beat the rating in both halves
    IDXW: {rtg: 70, awp: 30}},
};
const [lk, mode0 = 'live', ...rest] = process.argv.slice(2);
const L = LG[lk]; if (!L) { console.log('usage: node rugby.mjs <nrl|superleague> [check|backtest|dump|live]'); process.exit(1); }
const mode = mode0.startsWith('--') ? 'live' : mode0; if (mode0.startsWith('--')) rest.unshift(mode0);
const arg = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
const CACHE = path.join(os.tmpdir(), 'pro_bp_cache', lk); fs.mkdirSync(CACHE, {recursive: true});
const today = process.env.BP_TODAY || new Date().toLocaleDateString('en-CA');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const MON = {Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12};
const CURY = +today.slice(0, 4);

// ---------- data ----------
async function page(Y) {
  const f = path.join(CACHE, `r${Y}.html`);
  const fresh = fs.existsSync(f) && fs.statSync(f).size > 20000 && (Y < CURY || Date.now() - fs.statSync(f).mtimeMs < 6 * 3600e3);
  if (fresh) return fs.readFileSync(f, 'utf8');
  for (let a = 0; a < 4; a++) {
    try { const r = await fetch(`https://www.rugbyleagueproject.org/seasons/${L.slug}-${Y}/results.html`, {headers: {'User-Agent': UA}, signal: AbortSignal.timeout(60e3)});
      if (r.ok) { const t = await r.text(); fs.writeFileSync(f, t); await sleep(2000); return t; } if (r.status === 404) return ''; } catch {}
    await sleep(3000 * (a + 1));
  }
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}
const SEAS = {};
async function season(Y) {
  if (SEAS[Y]) return SEAS[Y];
  const html = await page(Y), out = [];
  let rnd = '', mon = null, day = null, n = 0;
  for (const tr of html.split(/<tr[\s>]/).slice(1)) {
    if (/<th/.test(tr) && !/class="team"|\/summary\.html">[^<]+<\/a><\/td>/.test(tr)) { const t = tr.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); if (t && t.length < 60) rnd = t; continue; }
    const dm = tr.match(/<td align="right"[^>]*>\s*(?:([A-Z][a-z]{2})\s+)?(\d{1,2})\s*<\/td>/);
    if (dm) { if (dm[1]) mon = MON[dm[1]]; day = +dm[2]; }
    const tm = [...tr.matchAll(/\/seasons\/[^/"]+\/([a-z0-9-]+)\/summary\.html">([^<]+)<\/a><\/td>\s*<td class="(?:pad )?n">\s*(\d*)\s*<\/td>/g)];
    if (tm.length < 2 || !mon) continue;
    const hs = tm[0][3] === '' ? null : +tm[0][3], as = tm[1][3] === '' ? null : +tm[1][3];
    if (/challenge cup|world club|qualifiers|million pound|nines/i.test(rnd)) continue;   // other competitions on the Super League page
    const fin = hs != null && as != null, isFinal = FINAL_RE.test(rnd), gf = /grand final/i.test(rnd);
    out.push({id: `${Y}-${n++}`, Y, d: `${Y}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`, rn: rnd, h: canon(tm[0][1]), a: canon(tm[1][1]), hn: tm[0][2], an: tm[1][2],
      hs, as, fin, final: isFinal, gf, neutral: gf || /magic/i.test(rnd)});
  }
  out.sort((x, y) => x.d.localeCompare(y.d));
  const f0 = out.filter(g => g.final).map(g => g.d).sort()[0];   // a game filed under a month header after the finals began is a final (Super League 2021)
  if (f0) for (const g of out) if (!g.final && g.d >= f0) g.final = true;
  return SEAS[Y] = out;
}
const canon = s => L.alias[s] || s;   // one key per club across renames (see LG.alias)
const FINAL_RE = /final|elim|playoff|qualif|semi/i;   // 'Round N', 'S8 Round N' and month headers are regular season
const premier = G => { const gf = G.filter(g => g.gf && g.fin).pop(); return gf ? (gf.hs > gf.as ? gf.h : gf.a) : null; };

// ---------- ratings (copied from afl.mjs; region instead of state) ----------
function fit(games, asOf, P) {
  const G = games.filter(g => g.fin && g.d < asOf), t0 = Date.parse(asOf + 'T12:00:00Z');
  const w = G.map(g => Math.pow(0.5, (t0 - Date.parse(g.d + 'T12:00:00Z')) / 864e5 / P.half));
  const inter = G.map(g => L.region(g.h) !== L.region(g.a)), m = G.map(g => g.hs - g.as);
  const T = [...new Set(G.flatMap(g => [g.h, g.a]))], r = new Map(T.map(t => [t, 0])), idx = new Map();
  for (const [i, g] of G.entries()) for (const t of [g.h, g.a]) { if (!idx.has(t)) idx.set(t, []); idx.get(t).push(i); }
  let Hs = 2, Hi = 4;
  const edge = i => G[i].neutral ? 0 : inter[i] ? Hi : Hs;
  for (let it = 0; it < 60; it++) {
    for (const t of T) { let den = P.lam, n2 = 0; for (const i of idx.get(t)) { const g = G[i], s = g.h === t ? 1 : -1, other = r.get(g.h === t ? g.a : g.h); den += w[i]; n2 += w[i] * (s * (m[i] - edge(i)) + other); } r.set(t, n2 / den); }
    const mu = mean([...r.values()]); for (const t of T) r.set(t, r.get(t) - mu);
    let ss = 0, ws = 0, si = 0, wi = 0;
    for (const [i, g] of G.entries()) { if (g.neutral) continue; const res = m[i] - (r.get(g.h) - r.get(g.a)); if (inter[i]) { si += w[i] * res; wi += w[i]; } else { ss += w[i] * res; ws += w[i]; } }
    Hs = ws ? ss / ws : 0; Hi = wi ? si / wi : Hs;
  }
  return {r, Hs, Hi};
}
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
const Phi = x => 0.5 * (1 + erf(x / Math.SQRT2));
const predMargin = (M, h, a, neutral) => (M.r.get(h) ?? 0) - (M.r.get(a) ?? 0) + (neutral ? 0 : L.region(h) !== L.region(a) ? M.Hi : M.Hs);
const pHome = (M, h, a, neutral, P) => Phi(predMargin(M, h, a, neutral) / P.sig);
const LLf = (p, y) => -(y * Math.log(Math.max(p, 1e-6)) + (1 - y) * Math.log(Math.max(1 - p, 1e-6)));
const randn = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// ---------- ladder + simulation ----------
const ladder = rows => rows.slice().sort((x, y) => y.pts / Math.max(1, y.gp) - x.pts / Math.max(1, x.gp) || (y.pf - y.pa) - (x.pf - x.pa));   // points per game (= points when games are equal; Super League 2020-21 ranked by win%)
function table(reg) {
  const T = new Map();
  for (const g of reg) for (const t of [g.h, g.a]) if (!T.has(t)) T.set(t, {id: t, pts: 0, pf: 0, pa: 0, w: 0, l: 0, gp: 0});
  for (const g of reg.filter(g => g.fin)) { const H = T.get(g.h), A = T.get(g.a); H.pf += g.hs; H.pa += g.as; A.pf += g.as; A.pa += g.hs; H.gp++; A.gp++;
    if (g.hs > g.as) { H.pts += 2; H.w++; A.l++; } else if (g.hs < g.as) { A.pts += 2; A.w++; H.l++; } else { H.pts++; A.pts++; } }
  return T;
}
function finals(seeds, win, fmt) {   // returns the premier
  if (fmt === 'four') return win(win(seeds[0], seeds[3]), win(seeds[1], seeds[2]), true);   // Super League 2015-18: semis 1v4 / 2v3, neutral GF
  if (fmt === 'eight') {
    const [s1, s2, s3, s4, s5, s6, s7, s8] = seeds;
    const qf1 = win(s1, s4), qf2 = win(s2, s3), ef1 = win(s5, s8), ef2 = win(s6, s7);
    const l1 = qf1 === s1 ? s4 : s1, l2 = qf2 === s2 ? s3 : s2;
    const sf1 = win(l1, ef1), sf2 = win(l2, ef2);
    return win(win(qf1, sf2), win(qf2, sf1), true);
  }
  const [s1, s2, s3, s4, s5, s6] = seeds, rank = id => seeds.indexOf(id);
  const e1 = win(s3, s6), e2 = win(s4, s5), lo = rank(e1) > rank(e2) ? e1 : e2, hi = lo === e1 ? e2 : e1;
  return win(win(s1, lo), win(s2, hi), true);
}
const NF = {eight: 8, six: 6, four: 4}, nFin = fmt => NF[fmt];
function simulate(M, P, reg, fmt, N = 20000, fixedSeeds = null) {
  const base = table(reg), left = reg.filter(g => !g.fin), cup = new Map(), top = new Map();
  const win = (x, y, neutral) => Math.random() < Phi(predMargin(M, x, y, neutral) / P.sig) ? x : y;
  for (let s = 0; s < N; s++) {
    let seeds = fixedSeeds;
    if (!seeds) {
      const T = new Map([...base].map(([k, v]) => [k, {...v}]));
      for (const g of left) { const mg = predMargin(M, g.h, g.a, g.neutral) + P.sig * randn(), H = T.get(g.h), A = T.get(g.a), x = Math.round(mg);
        H.pf += Math.max(0, x); A.pf += Math.max(0, -x); H.pa += Math.max(0, -x); A.pa += Math.max(0, x);
        if (x > 0) H.pts += 2; else if (x < 0) A.pts += 2; else { H.pts++; A.pts++; } }
      seeds = ladder([...T.values()]).slice(0, nFin(fmt)).map(t => t.id);
    }
    top.set(seeds[0], (top.get(seeds[0]) || 0) + 1);
    const ch = finals(seeds, win, fmt); cup.set(ch, (cup.get(ch) || 0) + 1);
  }
  const out = new Map([...cup].map(([k, v]) => [k, v / N])); out.minor = new Map([...top].map(([k, v]) => [k, v / N])); return out;
}
const loadP = () => fs.existsSync(path.join(CACHE, 'params.json')) ? JSON.parse(fs.readFileSync(path.join(CACHE, 'params.json'), 'utf8')) : L.P;
const SEASONS = Array.from({length: CURY - L.first + 1}, (_, i) => L.first + i);
async function all() { const S = {}; for (const Y of [L.first - 2, L.first - 1, ...SEASONS]) S[Y] = await season(Y).catch(() => []); return S; }
const pool = (S, Y) => [...(S[Y - 2] || []), ...(S[Y - 1] || []), ...(S[Y] || [])];
const nameMap = S => { const n = new Map(); for (const Y in S) for (const g of S[Y]) { n.set(g.h, L.full[g.h] || g.hn); n.set(g.a, L.full[g.a] || g.an); } return n; };

// ---------- champion profile (end of the regular season = the day before the first final) ----------
// FEATS/cutoffs: L.FEATS (every-champion rule from study/criteria.mjs on `dump`); index weights: L.IDXW.
const FEATS = L.FEATS || [], IDXW = L.IDXW || {rtg: 100};
function profile(G, pl, asOf, P) {
  const reg = G.filter(g => !g.final && g.fin && g.d < asOf), M = fit(pl, asOf, P), T = new Map();
  for (const g of reg) for (const [me, pf, pa, side] of [[g.h, g.hs, g.as, g.neutral ? 0 : 1], [g.a, g.as, g.hs, g.neutral ? 0 : -1]]) {
    const t = T.get(me) || {id: me, pts: 0, pf: 0, pa: 0, w: 0, l: 0, d: 0, gp: 0, res: [], hw: 0, hn: 0, aw: 0, an: 0}, r = pf > pa ? 1 : pf < pa ? 0 : 0.5;
    t.gp++; t.pf += pf; t.pa += pa; t.pts += 2 * r; if (r === 1) t.w++; else if (r === 0) t.l++; else t.d++; t.res.push([g.d, r]);
    if (side > 0) { t.hw += r; t.hn++; } else if (side < 0) { t.aw += r; t.an++; } T.set(me, t); }
  const rows = ladder([...T.values()]).map((t, i) => { const s = t.res.sort((a, b) => a[0].localeCompare(b[0])), f = n => mean(s.slice(-n).map(x => x[1]));
    return {id: t.id, pos: i + 1, pts: t.pts, gp: t.gp, w: t.w, l: t.l, d: t.d, pf: t.pf, pa: t.pa, ppg: t.pts / t.gp, wp: (t.w + t.d / 2) / t.gp, pct: 100 * t.pf / Math.max(1, t.pa),
      pfpg: t.pf / t.gp, papg: t.pa / t.gp, mgn: (t.pf - t.pa) / t.gp, rtg: M.r.get(t.id) ?? 0, form8: f(8), form5: f(5), hwp: t.hn ? t.hw / t.hn : 0, awp: t.an ? t.aw / t.an : 0}; });
  return {rows: rankRows(rows, FEATS), M};
}
function addIndex(rows) {
  const N = {}, tw = Object.values(IDXW).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(IDXW)) { const dir = (FEATS.find(x => x.k === k) || {dir: k === 'papg' ? -1 : 1}).dir, v = rows.map(r => +r[k]), lo = Math.min(...v), hi = Math.max(...v);
    N[k] = r => hi === lo ? 50 : 100 * (dir > 0 ? r[k] - lo : hi - r[k]) / (hi - lo); }
  for (const r of rows) r.idx = Object.entries(IDXW).reduce((a, [k, w]) => a + w * N[k](r), 0) / tw;
}
const firstFinal = G => G.filter(g => g.final).map(g => g.d).sort()[0];
const finalsField = G => [...new Set(G.filter(g => g.final).flatMap(g => [g.h, g.a]))];

if (mode === 'dump') {   // every team's end-of-regular-season profile -> study/data/<lk>.json (input for study/criteria.mjs)
  const S = await all(), P = loadP(), names = nameMap(S), K = ['pos', 'ppg', 'wp', 'pct', 'pfpg', 'papg', 'mgn', 'rtg', 'form8', 'form5', 'hwp', 'awp'];
  const out = {sport: lk, label: `${L.label} premiership`, when: 'end of the regular season', fieldLabel: 'the finals teams', universeLabel: `every ${L.label} team`,
    cands: [{k: 'pos', dir: -1, label: 'Ladder position', value: true, rank: false, dec: 0}, {k: 'ppg', dir: 1, label: 'Ladder points/game', value: true}, {k: 'wp', dir: 1, label: 'Win%', value: true},
      {k: 'pct', dir: 1, label: 'Percentage (PF/PA)', value: true}, {k: 'pfpg', dir: 1, label: 'Points for/game', value: true}, {k: 'papg', dir: -1, label: 'Points against/game', value: true},
      {k: 'mgn', dir: 1, label: 'Margin/game', value: true}, {k: 'rtg', dir: 1, label: 'Rating', value: true}, {k: 'form8', dir: 1, label: 'Form (win%, last 8)', value: true},
      {k: 'form5', dir: 1, label: 'Form (win%, last 5)', value: true}, {k: 'hwp', dir: 1, label: 'Home win%', value: true}, {k: 'awp', dir: 1, label: 'Away win%', value: true}],
    seasons: []};
  for (const Y of SEASONS) {
    const G = S[Y], ch = premier(G); if (!ch) continue;
    const {rows} = profile(G, pool(S, Y), firstFinal(G), P);
    out.seasons.push({Y, champ: ch, champName: names.get(ch), field: finalsField(G), rows: rows.map(r => Object.fromEntries([['id', r.id], ['name', names.get(r.id)], ...K.map(k => [k, r[k]])]))});
  }
  fs.mkdirSync('C:/Users/User/baseball-blueprint/study/data', {recursive: true});
  fs.writeFileSync(`C:/Users/User/baseball-blueprint/study/data/${lk}.json`, JSON.stringify(out));
  console.log(`dumped ${out.seasons.length} seasons -> study/data/${lk}.json · champs: ${out.seasons.map(s => `${s.Y} ${s.champName} (#${s.rows.find(r => r.id === s.champ).pos} of ${s.field.length})`).join(', ')}`);
  process.exit(0);
}
if (mode === 'check') {
  const S = await all(), names = nameMap(S);
  for (const Y of SEASONS) { const G = S[Y], r = G.filter(g => !g.final); console.log(`${Y}: ${r.length} regular games (${r.filter(g => g.fin).length} played) · finals ${G.filter(g => g.final).map(g => g.rn).join(', ')} · premier ${names.get(premier(G)) ?? '—'} · dates ${r.map(g => g.d).sort()[0]} .. ${r.map(g => g.d).sort().pop()} | finals ${G.filter(g => g.final).map(g => g.d).sort()[0] ?? '—'} .. ${G.filter(g => g.final).map(g => g.d).sort().pop() ?? '—'}`); }
  process.exit(0);
}
if (mode === 'backtest') {
  const S = await all(), done = SEASONS.filter(Y => premier(S[Y]) && S[Y].filter(g => !g.final).every(g => g.fin));
  const half = Math.ceil(done.length / 2), H1 = done.slice(0, half), H2 = done.slice(half);
  const rounds = Y => [...new Set(S[Y].filter(g => !g.final && g.fin).map(g => g.rn))];
  const fitsFor = P => { const F = new Map(); for (const Y of done) for (const rd of rounds(Y)) { const d0 = S[Y].filter(g => g.rn === rd && !g.final).map(g => g.d).sort()[0]; F.set(Y + '|' + rd, fit(pool(S, Y), d0, P)); } return F; };
  const yv = g => g.hs > g.as ? 1 : g.hs < g.as ? 0 : 0.5;
  const evalM = (P, F, Ys) => mean(Ys.flatMap(Y => S[Y].filter(g => !g.final && g.fin).map(g => LLf(pHome(F.get(Y + '|' + g.rn), g.h, g.a, g.neutral, P), yv(g)))));
  let best = null; const cache = new Map();
  for (const half of [120, 240, 365]) for (const lam of [1, 3, 10]) { const F = fitsFor({half, lam}); cache.set(half + '|' + lam, F);
    for (const sig of [14, 16, 18, 20, 22, 24, 26, 28]) { const P = {half, lam, sig}, ll = evalM(P, F, H1); if (!best || ll < best.ll) best = {P, ll}; } }
  const P = best.P, F = cache.get(P.half + '|' + P.lam);
  const hb = Ys => { const g = Ys.flatMap(Y => S[Y].filter(x => !x.final && x.fin)), hr = mean(g.map(yv)); return mean(g.map(x => LLf(hr, yv(x)))); };
  console.log(`${L.label} backtest -- ${done[0]}-${done[done.length - 1]} (halves ${H1[0]}-${H1[H1.length - 1]} / ${H2[0]}-${H2[H2.length - 1]})`);
  console.log(`MATCHES (regular season, refit every round): tuned on the 1st half -> half-life ${P.half} d, shrink ${P.lam}, sigma ${P.sig} pts`);
  console.log(`  1st half LL ${evalM(P, F, H1).toFixed(4)} vs home-win base rate ${hb(H1).toFixed(4)} · 2nd half (held out) LL ${evalM(P, F, H2).toFixed(4)} vs ${hb(H2).toFixed(4)} · coin 0.6931`);
  const fm = []; for (const Y of done) for (const g of S[Y].filter(g => g.final && g.fin)) { const M = fit(pool(S, Y), g.d, P); fm.push({Y, ll: LLf(pHome(M, g.h, g.a, g.neutral, P), yv(g)), y: yv(g), gf: g.neutral}); }
  const hostLL = Ys => mean(fm.filter(x => Ys.includes(x.Y)).map(x => x.gf ? Math.log(2) : LLf(mean(fm.filter(z => !z.gf && z.Y !== x.Y).map(z => z.y)), x.y)));
  const fl = Ys => mean(fm.filter(x => Ys.includes(x.Y)).map(x => x.ll));
  console.log(`\nFINALS MATCHES (${fm.length}): model LL ${fl(done).toFixed(4)} (${fl(H1).toFixed(4)} | ${fl(H2).toFixed(4)}) vs "host wins" ${hostLL(done).toFixed(4)} (${hostLL(H1).toFixed(4)} | ${hostLL(H2).toFixed(4)})`);
  // premiership odds at the start of the finals (actual seeds) and at 75% of the regular season, in the format era
  const TY = done.filter(Y => L.fmtOf(Y)), th = Math.ceil(TY.length / 2), T1 = TY.slice(0, th), T2 = TY.slice(th), names = nameMap(S), titles = [];
  for (const Y of TY) {
    const G = S[Y], reg = G.filter(g => !g.final), ch = premier(G), first = G.filter(g => g.final).map(g => g.d).sort()[0];
    const fmt = L.fmtOf(Y), seeds = ladder([...table(reg).values()]).slice(0, nFin(fmt)).map(t => t.id);
    const Tf = simulate(fit(pool(S, Y), first, P), P, reg, fmt, 20000, seeds);
    const ds = reg.map(g => g.d).sort(), d75 = ds[Math.floor(0.75 * ds.length)];
    const T75 = simulate(fit(pool(S, Y), d75, P), P, reg.map(g => g.d < d75 ? g : {...g, fin: false, hs: null, as: null}), fmt, 8000);
    const rk = (T, id) => 1 + [...T.values()].filter(v => v > (T.get(id) || 0)).length;
    titles.push({Y, fmt, ch: names.get(ch), seed: seeds.indexOf(ch) + 1, p: Tf.get(ch) || 0, r: rk(Tf, ch), p75: T75.get(ch) || 0, r75: rk(T75, ch), nT: table(reg).size});
  }
  console.log(`\nPREMIERSHIP ODDS (${TY[0]}-${TY[TY.length - 1]}) -- start of the finals (seeds known) | at 75% of the regular season`);
  for (const t of titles) console.log(`  ${t.Y} ${String(t.ch).padEnd(24)} seed ${String(t.seed).padStart(2)} | finals start ${(100 * t.p).toFixed(1).padStart(5)}% (#${t.r}) | 75% ${(100 * t.p75).toFixed(1).padStart(5)}% (#${t.r75})`);
  const Lg = a => mean(a.map(p => -Math.log(Math.max(p, 1e-4))));
  const seedLL = Ys => mean(titles.filter(t => Ys.includes(t.Y)).map(t => { const tr = titles.filter(z => z.Y !== t.Y); const tf = tr.filter(z => z.fmt === t.fmt); return -Math.log((tf.filter(z => z.seed === t.seed).length + 0.5) / (tf.length + 0.5 * nFin(t.fmt))); }));
  for (const [lab, Ys] of [['ALL', TY], ['1st half', T1], ['2nd half', T2]]) { const rs = titles.filter(t => Ys.includes(t.Y));
    console.log(`  ${lab.padEnd(9)} finals start: #1 ${rs.filter(t => t.r === 1).length}/${rs.length} · LL ${Lg(rs.map(t => t.p)).toFixed(3)} vs equal ${mean(rs.map(t => Math.log(nFin(t.fmt)))).toFixed(3)} vs position history ${seedLL(Ys).toFixed(3)} | 75%: #1 ${rs.filter(t => t.r75 === 1).length} · LL ${Lg(rs.map(t => t.p75)).toFixed(3)} vs equal ${mean(rs.map(t => Math.log(t.nT))).toFixed(3)}`); }
  console.log(`  minor premier won ${titles.filter(t => t.seed === 1).length}/${titles.length} · top-2 seed won ${titles.filter(t => t.seed <= 2).length}/${titles.length}`);
  fs.writeFileSync(path.join(CACHE, 'params.json'), JSON.stringify(P));
  process.exit(0);
}
// ---------- live board (+ --export for the blueprint dashboard; BP_TODAY=YYYY-MM-DD rewinds it to a past date) ----------
{
  const S0 = await all(), P = loadP(), asOf = new Date(Date.parse(today + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
  const rewind = G => G.map(g => g.d < asOf ? g : {...g, fin: false, hs: null, as: null});   // games on/after asOf count as unplayed
  const S = Object.fromEntries(Object.entries(S0).map(([Y, G]) => [Y, rewind(G)]));
  let Y = CURY; if (!S[Y]?.length) Y--;
  // offseason: once this season is decided, switch to next season's draw as soon as it is published in full (a preseason board)
  if (premier(S[Y]) && !process.env.BP_TODAY) { try { const nx = await season(Y + 1), creg = S[Y].filter(g => !g.final).length;
    if (nx.filter(g => !g.final).length >= 0.9 * creg) { S[Y + 1] = rewind(nx); S0[Y + 1] = nx; Y++; } } catch {} }
  const names = nameMap(S0), G = S[Y], reg = G.filter(g => !g.final), first = firstFinal(G), done = !!premier(G);
  const finalsStarted = G.some(g => g.final && g.fin), started = reg.some(g => g.fin);
  const stage = done ? 'done' : finalsStarted ? 'finals' : started ? 'regular' : 'preseason';
  const fmt = L.fmtOf(Y) || L.fmtOf(9999), N = +(arg('--sims') || 20000);
  // title odds: before the finals = the rest of the regular season + the finals; once the finals start = FROZEN at the start of the finals
  // (ratings fit on games before the first final, actual seeds) -- the user never bets within the finals
  const seeds = finalsStarted ? ladder([...table(reg).values()]).slice(0, nFin(fmt)).map(t => t.id) : null;
  const M = fit(pool(S, Y), finalsStarted ? first : asOf, P), T = simulate(M, P, reg, fmt, N, seeds);
  // champion profile: this season's numbers (as of today; at the start of the finals once they begin). Preseason: last season's end of the regular season
  let PG = G, PY = Y, pAsOf = finalsStarted ? first : asOf;
  if (stage === 'preseason' && S[Y - 1]?.length) { PG = S[Y - 1]; PY = Y - 1; pAsOf = firstFinal(PG) || asOf; }
  const {rows} = profile(PG, pool(S, PY), pAsOf, P);
  const TS = SEASONS.concat(Y > CURY ? [Y] : []).filter(Yp => Yp <= Y && premier(S[Yp])).map(Yp => { const Gp = S[Yp], ch = premier(Gp); return profile(Gp, pool(S, Yp), firstFinal(Gp), P).rows.find(r => r.id === ch); }).filter(Boolean);
  const cuts = tierCuts(TS, FEATS, 1);   // each cutoff = the loosest premier (every premier cleared all of them)
  for (const r of rows) tierScore(r, FEATS, cuts);
  addIndex(rows);
  const prof = new Map(rows.map(r => [r.id, r])), left = reg.filter(g => !g.fin).length, curT = new Set(reg.flatMap(g => [g.h, g.a]));
  // ladder shown: this season's; preseason = last season's final ladder (this season's clubs only -- promoted/new clubs show zeros)
  let lad = ladder([...table(reg).values()]);
  if (PY !== Y) { const prev = ladder([...table(PG.filter(g => !g.final)).values()]).filter(t => curT.has(t.id)), have = new Set(prev.map(t => t.id)); lad = prev.concat(lad.filter(t => !have.has(t.id))); }
  const posOf = t => PY !== Y ? (prof.get(t.id)?.pos ?? null) : lad.indexOf(t) + 1;
  const fair = p => p < 0.001 ? '—' : p >= 0.5 ? '-' + Math.round(100 * p / (1 - p)) : '+' + Math.round(100 * (1 - p) / p);
  const fv = (k, v) => v == null || !isFinite(v) ? '—' : k === 'pos' ? String(v) : k === 'rtg' || k === 'mgn' ? (v >= 0 ? '+' : '') + v.toFixed(1) : k === 'pct' ? v.toFixed(1) : /wp|form/.test(k) ? v.toFixed(3) : v.toFixed(1);
  console.log(`${L.label} premiership odds -- ${Y} season, games through ${today} · ${reg.filter(g => g.fin).length}/${reg.length} regular-season games played · stage: ${stage}${done ? ` · PREMIER: ${names.get(premier(G))} (odds = frozen at the start of the finals)` : finalsStarted ? ' (odds frozen at the start of the finals)' : ''}`);
  if (PY !== Y) console.log(`tiers/index = ${PY} end of the regular season (${Y} hasn't started) -- premiership odds are preseason, from ratings that fade toward average (untested stage)`);
  console.log(`model: half-life ${P.half} d, shrink ${P.lam}, sigma ${P.sig} pts · home edge ${M.Hs.toFixed(1)} pts (same region) / ${M.Hi.toFixed(1)} pts (travelling visitor)`);
  console.log(`TIERS -- every-champion profile (${TS.length} premiers): ${FEATS.map((f, i) => cutLabel(f, cuts[i], v => fv(f.k, +v))).join(' · ')}`);
  console.log(`index (0-100) = ${Object.entries(IDXW).map(([k, w]) => `${{rtg: 'Rating', wp: 'Win%', awp: 'Away win%'}[k] || k} ${w}`).join(' · ')}\n`);
  for (const t of lad.slice().sort((a, b) => (T.get(b.id) || 0) - (T.get(a.id) || 0) || (prof.get(b.id)?.idx ?? 0) - (prof.get(a.id)?.idx ?? 0))) {
    const p = T.get(t.id) || 0, r = prof.get(t.id), pos = posOf(t) ?? '-';
    console.log(`  ${TIER_NAME(r ? r.score : 0).padEnd(18)} ${String(names.get(t.id)).padEnd(28)} #${String(pos).padEnd(2)} ${String(t.pts).padStart(3)} pts (${t.w}-${t.l}, diff ${t.pf - t.pa >= 0 ? '+' : ''}${t.pf - t.pa}) | idx ${r ? r.idx.toFixed(1).padStart(5) : '    —'} | rating ${(M.r.get(t.id) ?? 0) >= 0 ? '+' : ''}${(M.r.get(t.id) ?? 0).toFixed(1)} | premiership ${(100 * p).toFixed(1).padStart(5)}% (fair ${fair(p)})${r ? ' | ' + FEATS.map((f, i) => `${r.q[i] ? '✓' : '✗'} ${f.label}`).join(' · ') : ''}`); }
  if (arg('--export')) {   // board JSON for the blueprint dashboard (blueprint-dashboard/scripts/build.py build_footy)
    const SHORT = {pos: 'Ladder', mgn: 'Margin/g', rtg: 'Rating', hwp: 'Home W%', awp: 'Away W%', pct: 'Pct', pfpg: 'PF/g', wp: 'Win%', form8: 'Form 8'};
    const gpNow = [...table(reg).values()].map(t => t.gp);
    const out = {league: lk, label: L.label, season: Y, profile_season: PY, rec_season: PY, gp_now: [Math.min(...gpNow), Math.max(...gpNow)], generated: new Date().toISOString(), today, stage, first_final: first || null, games_left: left, sims: N,
      premier: done ? names.get(premier(G)) : null, champions: TS.length, sig: P.sig, hfa: {same: +M.Hs.toFixed(2), inter: +M.Hi.toFixed(2)},
      cats: FEATS.map((f, i) => cutLabel(f, cuts[i], v => fv(f.k, +v))), labels: FEATS.map(f => SHORT[f.k] || f.label),
      teams: lad.map((t, i) => { const r = prof.get(t.id);
        return {id: t.id, name: names.get(t.id) || t.id, reg: L.region(t.id), pos: posOf(t), gp: t.gp, w: t.w, l: t.l, d: t.gp - t.w - t.l, pts: t.pts, pf: t.pf, pa: t.pa,
          p: T.get(t.id) || 0, minor: T.minor.get(t.id) || 0, score: r ? r.score : 0, q: r ? r.q : FEATS.map(() => false),
          vals: FEATS.map(f => !r ? '—' : f.k === 'pos' ? fv('pos', r.pos) : `${fv(f.k, r[f.k])} #${r['r_' + f.k]}`),
          idx: r ? +r.idx.toFixed(1) : null, rtg: +(M.r.get(t.id) ?? 0).toFixed(2)}; })};
    fs.writeFileSync(arg('--export'), JSON.stringify(out));
    console.log('\nexported -> ' + arg('--export'));
  }
  const bk = arg('--book');
  if (bk) { console.log('\nBOOK PRICES (pasted) -- EV = model p x decimal odds - 1');
    for (const pair of bk.split(',')) { const m = pair.trim().match(/^(.*?):\s*([+-]?\d+)$/); if (!m) continue; const am = +m[2], dec = am > 0 ? 1 + am / 100 : 1 + 100 / -am, w = m[1].trim().toLowerCase();
      const id = [...names].find(([k, n]) => n.toLowerCase() === w || n.toLowerCase().includes(w) || w.includes(n.toLowerCase()) || k.includes(w.replace(/\s+/g, '-')))?.[0], p = id ? (T.get(id) || 0) : null;
      console.log(`  ${m[1].padEnd(22)} ${m[2].padStart(6)} implied ${(100 / dec).toFixed(1)}% | model ${p == null ? 'n/a' : (100 * p).toFixed(1) + '% -> EV ' + (p * dec - 1 >= 0 ? '+' : '') + Math.round(100 * (p * dec - 1)) + '%'}`); } }
  if (rest.includes('--log')) {
    const file = `C:/Users/User/baseball-blueprint/${lk}-history.md`, head = `# ${L.label} Premiership Blueprint — Run History\n\nEach run prepends a dated snapshot (engine: baseball-blueprint/pro/rugby.mjs ${lk}).\n\n---\n\n`;
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : head, i = old.indexOf('---\n\n');
    let body = i >= 0 ? old.slice(i + 5) : ''; if (body.startsWith(`## ${today} `)) { const nx = body.indexOf('\n## '); body = nx >= 0 ? body.slice(nx + 1) : ''; }
    const entry = `## ${today} (${Y} season${done ? `, premier ${names.get(premier(G))}` : ''})\n\n${[...T].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, p]) => `- ${names.get(id)} ${prof.get(id) ? prof.get(id).score + '/5 · ' : ''}${(100 * p).toFixed(1)}%`).join('\n')}\n\n`;
    fs.writeFileSync(file, i >= 0 ? old.slice(0, i + 5) + entry + body : old + entry); console.log('\nlogged to ' + file);
  }
}
