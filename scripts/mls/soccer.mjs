// NWSL / MLS title engine (built 2026-11-05). ESPN soccer scoreboards (usa.nwsl, usa.1), season slugs mark playoff rounds.
// Model: Poisson goals -- attack x defence x home edge, recency-weighted, shrunk toward average (k pseudo-games), plus a
// draw-inflation term; knockout draws go to extra time (30 min of the same rates) then penalties (coin flip).
//   node soccer.mjs <nwsl|mls> backtest      match-level (weekly refits), playoff-match and title (final four / bracket) backtests
//   node soccer.mjs <nwsl|mls> [live] [--log] [--book "Team:+300,..."]   current bracket odds (+ EV vs a pasted DraftKings/FanDuel screenshot)
//   node soccer.mjs <nwsl|mls> dump          every team's profile at the start of each past playoff -> study/data/<lg>.json (study/criteria.mjs)
// NO KALSHI (user, 2026-11-06): no odds feed has MLS Cup / NWSL futures, so prices come only from the user's screenshots.
//   node soccer.mjs <nwsl|mls> tiers         champion-profile tiers: cutoffs + held-out champion check
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {TIER_NAME, rankRows, cutoffs as tierCuts, score as tierScore, cutLabel, tierBacktest} from './tiers.mjs';

const CACHE = path.join(os.tmpdir(), 'pro_bp_cache'); fs.mkdirSync(CACHE, {recursive: true});
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(u) { for (let a = 0; a < 5; a++) { try { const r = await fetch(u, {signal: AbortSignal.timeout(30e3)}); if (r.ok) { const t = await r.text(); return t.trim() ? JSON.parse(t) : null; } if (r.status === 404) return null; } catch {} await sleep(800 * (a + 1)); } throw new Error('fetch failed ' + u); }
const LG = {
  nwsl: {espn: 'usa.nwsl', label: 'NWSL', seasons: [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025], cur: 2026, hist: 'nwsl-history.md'},
  mls: {espn: 'usa.1', label: 'MLS', seasons: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025], cur: 2026, hist: 'mls-history.md'},
};
const [lk, mode0 = 'live', ...rest] = process.argv.slice(2);
const L = LG[lk];
if (!L) { console.log('usage: node soccer.mjs <nwsl|mls> [backtest|live] [--log] [--book "..."]'); process.exit(1); }
const mode = mode0.startsWith('--') ? 'live' : mode0;
if (mode0.startsWith('--')) rest.unshift(mode0);
const arg = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
const today = process.env.BP_TODAY || new Date().toLocaleDateString('en-CA');

async function season(Y) {
  const f = path.join(CACHE, `${lk}_${Y}.json`);
  if (Y < L.cur && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const j = await getJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${L.espn}/scoreboard?dates=${Y}&limit=1000`);
  const rows = [];
  for (const e of (j?.events || [])) {
    const c = (e.competitions || [])[0];
    if (!c) continue;
    const H = c.competitors.find(x => x.homeAway === 'home'), A = c.competitors.find(x => x.homeAway === 'away');
    if (!H || !A) continue;
    const slug = e.season?.slug || '';
    rows.push({id: e.id, d: (e.date || '').slice(0, 10), h: String(H.team.id), a: String(A.team.id), hn: H.team.displayName, an: A.team.displayName,
      hs: H.score === '' || H.score == null ? null : +H.score, as: A.score === '' || A.score == null ? null : +A.score, fin: !!c.status?.type?.completed,
      po: !/regular/i.test(slug) && slug !== '' ? slug : '', neutral: !!c.neutralSite, hw: !!H.winner, aw: !!A.winner});
  }
  rows.sort((x, y) => x.d.localeCompare(y.d));
  if (Y < L.cur) fs.writeFileSync(f, JSON.stringify(rows));
  return rows;
}

// ---------- model ----------
function fit(games, asOf, P) {
  const G = games.filter(g => g.fin && g.hs != null && g.d < asOf);
  const t0 = Date.parse(asOf + 'T12:00:00Z'), w = g => Math.pow(0.5, (t0 - Date.parse(g.d + 'T12:00:00Z')) / 864e5 / P.half);
  const T = new Set(G.flatMap(g => [g.h, g.a]));
  const a = new Map([...T].map(t => [t, 1])), d = new Map([...T].map(t => [t, 1]));
  let sw = 0, gh = 0, ga = 0;
  for (const g of G) { const x = w(g); sw += x; gh += x * g.hs; ga += x * g.as; }
  if (!sw) return null;
  let mu = (gh + ga) / (2 * sw), H = gh / Math.max(ga, 1e-9);
  for (let it = 0; it < 40; it++) {
    const sa = new Map(), ea = new Map(), sd = new Map(), ed = new Map();
    for (const g of G) {
      const x = w(g), hf = g.neutral ? Math.sqrt(H) : H, af = g.neutral ? Math.sqrt(H) : 1;
      sa.set(g.h, (sa.get(g.h) || 0) + x * g.hs); ea.set(g.h, (ea.get(g.h) || 0) + x * mu * hf * d.get(g.a));
      sa.set(g.a, (sa.get(g.a) || 0) + x * g.as); ea.set(g.a, (ea.get(g.a) || 0) + x * mu * af * d.get(g.h));
      sd.set(g.h, (sd.get(g.h) || 0) + x * g.as); ed.set(g.h, (ed.get(g.h) || 0) + x * mu * af * a.get(g.a));
      sd.set(g.a, (sd.get(g.a) || 0) + x * g.hs); ed.set(g.a, (ed.get(g.a) || 0) + x * mu * hf * a.get(g.h));
    }
    for (const t of T) { a.set(t, ((sa.get(t) || 0) + P.k * mu) / ((ea.get(t) || 0) + P.k * mu)); d.set(t, ((sd.get(t) || 0) + P.k * mu) / ((ed.get(t) || 0) + P.k * mu)); }
    const ma = [...a.values()].reduce((s, v) => s + v, 0) / T.size, md = [...d.values()].reduce((s, v) => s + v, 0) / T.size;
    for (const t of T) { a.set(t, a.get(t) / ma); d.set(t, d.get(t) / md); }
    let ph = 0, pa = 0;
    for (const g of G) { if (g.neutral) continue; const x = w(g); ph += x * a.get(g.h) * d.get(g.a); pa += x * a.get(g.a) * d.get(g.h); }
    const nh = G.filter(g => !g.neutral).reduce((s, g) => s + w(g) * g.hs, 0), na = G.filter(g => !g.neutral).reduce((s, g) => s + w(g) * g.as, 0);
    mu = (nh / ph + na / pa) / 2 / Math.sqrt(H) * Math.sqrt(H); H = (nh / ph) / (na / pa);
    mu = na / pa;
  }
  return {a, d, mu, H, rho: P.rho};
}
const pois = (l, k) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };
function lambdas(M, h, a, home) {   // home: 'h' = h at home, 'a' = a at home, null = neutral
  const ah = M.a.get(h) ?? 1, dh = M.d.get(h) ?? 1, aa = M.a.get(a) ?? 1, da = M.d.get(a) ?? 1, s = Math.sqrt(M.H);
  const fh = home === 'h' ? M.H : home === 'a' ? 1 : s, fa = home === 'a' ? M.H : home === 'h' ? 1 : s;
  return [M.mu * fh * ah * da, M.mu * fa * aa * dh];
}
function wdl(lh, la, rho) {
  let W = 0, D = 0, Lo = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) { const p = pois(lh, i) * pois(la, j); if (i > j) W += p; else if (i === j) D += p; else Lo += p; }
  D *= 1 + rho; const s = W + D + Lo; return [W / s, D / s, Lo / s];
}
function pAdvance(M, h, a, home) {   // single knockout match, h's chance to advance
  const [lh, la] = lambdas(M, h, a, home), [W, D] = wdl(lh, la, M.rho), [W2, D2] = wdl(lh / 3, la / 3, 0);
  return W + D * (W2 + D2 * 0.5);
}

// ---------- standings (seeding) from regular-season results ----------
function table(games) {
  const T = new Map();
  for (const g of games.filter(g => g.fin && !g.po && g.hs != null)) for (const [me, op, gf, ga] of [[g.h, g.a, g.hs, g.as], [g.a, g.h, g.as, g.hs]]) {
    const t = T.get(me) || {id: me, pts: 0, gp: 0, gf: 0, ga: 0, w: 0}; t.gp++; t.gf += gf; t.ga += ga; if (gf > ga) { t.pts += 3; t.w++; } else if (gf === ga) t.pts += 1; T.set(me, t);
  }
  return [...T.values()].sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf);
}

// ---------- title probability from the final four (two semis + final) ----------
function titleFromSemis(M, semis, finalHomeTeam) {
  const out = new Map(), reach = new Map();
  for (const s of semis) { const p = pAdvance(M, s.h, s.a, s.neutral ? null : 'h'); reach.set(s.h, p); reach.set(s.a, 1 - p); }
  const [s1, s2] = semis;
  for (const x of [s1.h, s1.a]) for (const y of [s2.h, s2.a]) {
    const home = finalHomeTeam === x ? 'h' : finalHomeTeam === y ? 'a' : null, px = pAdvance(M, x, y, home), both = reach.get(x) * reach.get(y);
    out.set(x, (out.get(x) || 0) + both * px); out.set(y, (out.get(y) || 0) + both * (1 - px));
  }
  return out;
}
// NWSL 8-team fixed bracket (2024+): QF 1v8 / 4v5 meet, 2v7 / 3v6 meet; higher seed hosts the semis; final at a set venue
function titleFrom8(M, qf, seedOf, finalHomeTeam) {
  const adv = new Map();
  for (const g of qf) { const p = pAdvance(M, g.h, g.a, 'h'); adv.set(g.h, p); adv.set(g.a, 1 - p); }
  const side = s => qf.filter(g => s.includes(Math.min(seedOf.get(g.h), seedOf.get(g.a))));
  const halves = [side([1, 4]), side([2, 3])], reachF = new Map();
  for (const [g1, g2] of halves) {
    if (!g1 || !g2) continue;
    for (const x of [g1.h, g1.a]) for (const y of [g2.h, g2.a]) {
      const both = adv.get(x) * adv.get(y), hostX = seedOf.get(x) < seedOf.get(y), px = pAdvance(M, x, y, hostX ? 'h' : 'a');
      reachF.set(x, (reachF.get(x) || 0) + both * px); reachF.set(y, (reachF.get(y) || 0) + both * (1 - px));
    }
  }
  const out = new Map(), A = [...halves[0].flatMap(g => [g.h, g.a])], B = [...halves[1].flatMap(g => [g.h, g.a])];
  for (const x of A) for (const y of B) {
    const home = finalHomeTeam === x ? 'h' : finalHomeTeam === y ? 'a' : null, px = pAdvance(M, x, y, home), both = (reachF.get(x) || 0) * (reachF.get(y) || 0);
    out.set(x, (out.get(x) || 0) + both * px); out.set(y, (out.get(y) || 0) + both * (1 - px));
  }
  return out;
}
const LLf = p => -Math.log(Math.max(p, 1e-4));
const winner = g => g.hs > g.as ? g.h : g.hs < g.as ? g.a : g.hw ? g.h : g.aw ? g.a : null;   // score first; the flag only for penalty ties (ESPN flags the wrong side of the 2010 MLS Cup)
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

// ---------- champion-profile tiers (every team's table + model numbers at the start of the playoffs) ----------
// every-champion rules (2026-11-06 search, study/criteria.mjs): each cutoff = the loosest past champion, so every champion clears all 5
const FEATS = lk === 'mls'
  ? [{k: 'att', dir: 1, kind: 'rank', label: 'Attack rating'}, {k: 'form', dir: 1, kind: 'value', label: 'Form (pts/g, last 8)'}, {k: 'form5', dir: 1, kind: 'value', label: 'Form (pts/g, last 5)'},
     {k: 'wpct', dir: 1, kind: 'rank', label: 'Win%'}, {k: 'str', dir: 1, kind: 'value', label: 'Overall rating (att/def)'}]
  : [{k: 'gdpg', dir: 1, kind: 'rank', label: 'Goal diff/game'}, {k: 'form', dir: 1, kind: 'rank', label: 'Form (last 8)'}, {k: 'gf', dir: 1, kind: 'value', label: 'Goals for/game'},
     {k: 'ga', dir: -1, kind: 'value', label: 'Goals against/game'}, {k: 'lpct', dir: -1, kind: 'value', label: 'Loss%'}];
const COVER = 1;   // every past champion (was 90%)
const gpSpread = G => { const c = new Map(); for (const g of G.filter(g => !g.po && g.fin)) for (const t of [g.h, g.a]) c.set(t, (c.get(t) || 0) + 1); const v = [...c.values()]; return v.length ? Math.max(...v) - Math.min(...v) : 99; };
const loadP = () => fs.existsSync(path.join(CACHE, `${lk}_params.json`)) ? JSON.parse(fs.readFileSync(path.join(CACHE, `${lk}_params.json`), 'utf8')) : {half: 240, k: 6, rho: 0.04};
function profile(seasonGames, poolGames, asOf, P) {
  const reg = seasonGames.filter(g => !g.po && g.fin && g.hs != null && g.d < asOf), M = fit(poolGames, asOf, P), T = new Map();
  for (const g of reg) for (const [me, gf, ga, home] of [[g.h, g.hs, g.as, 1], [g.a, g.as, g.hs, 0]]) {
    const t = T.get(me) || {id: me, gp: 0, pts: 0, gd: 0, gf: 0, ga: 0, w: 0, l: 0, hp: 0, hn: 0, ap: 0, an: 0, res: []}, p = gf > ga ? 3 : gf === ga ? 1 : 0;
    t.gp++; t.gd += gf - ga; t.gf += gf; t.ga += ga; t.pts += p; if (p === 3) t.w++; if (p === 0) t.l++;
    if (home) { t.hp += p; t.hn++; } else { t.ap += p; t.an++; }
    t.res.push([g.d, p]); T.set(me, t);
  }
  const avgP = a => a.reduce((s, x) => s + x[1], 0) / a.length;
  const rows = [...T.values()].map(t => { const s = t.res.sort((a, b) => a[0].localeCompare(b[0])), att = M ? (M.a.get(t.id) ?? 1) : 1, def = M ? (M.d.get(t.id) ?? 1) : 1;
    return {id: t.id, pts: t.pts, ppg: t.pts / t.gp, gdpg: t.gd / t.gp, att, def, form: avgP(s.slice(-8)), form5: avgP(s.slice(-5)), gf: t.gf / t.gp, ga: t.ga / t.gp, wpct: t.w / t.gp, lpct: t.l / t.gp,
      hppg: t.hn ? t.hp / t.hn : 0, appg: t.an ? t.ap / t.an : 0, str: att / def}; });
  return rankRows(rows, FEATS);
}
async function tierSeasons(P) {
  const S = {}, out = [];
  for (const Y of [L.seasons[0] - 1, ...L.seasons]) { try { S[Y] = await season(Y); } catch { S[Y] = []; } }
  for (const Y of L.seasons.filter(Y => gpSpread(S[Y]) <= 2)) {
    const G = S[Y], P0 = G.filter(g => g.po && g.fin && !/all-star/i.test(g.po));
    if (!P0.length) continue;
    const fin = P0[P0.length - 1], champ = winner(fin), field = new Set(P0.flatMap(g => [g.h, g.a]));
    const rows = profile(G, [...(S[Y - 1] || []), ...G], P0[0].d, P), c = rows.find(r => r.id === champ);
    if (c) out.push({Y, rows, champ: c, champName: champ === fin.h ? fin.hn : fin.an, field: rows.filter(r => field.has(r.id))});
  }
  return out;
}
// NWSL index (display only -- the title odds come from the bracket sim): champion-weighted mean of the 5 profile metrics, each scaled
// 0-100 across the whole league. Weights = how far the 8 clean champions (2017-25) sat above their playoff field on each metric
// (2026-11-06 study): Loss% 30 · GA/g 25 · GD/g 20 · Form 15 · GF/g 10. Hidden-season check (weights refit without that year):
// the champion was the field's index #1 in 5/8 (avg rank 2.1 vs 3.4 random) -- but #1 in only 2 of the 5 since 2021.
// MLS index (2026-11-06, same method, 15 champions 2010-25): Win% 25 · Overall (att/def) 25 · Attack 20 · Form8 15 · Form5 15.
// Hidden-season check: champion's index rank in the playoff field avg 2.73 (random 6.9), top-3 in 10/15, #1 in 3/15; it beats the
// dashboard's old overall-rating-only index (avg 3.53, and 4.29 in 2018-25 vs 2.71). Exported as `idx`; the dashboard's MLS cards use it
// since 2026-11-06 (build.py build_mls falls back to the overall rating if idx is missing).
const IDXW = lk === 'nwsl' ? {lpct: 30, ga: 25, gdpg: 20, form: 15, gf: 10} : {wpct: 25, str: 25, att: 20, form: 15, form5: 15};
function addIndex(rows) {
  if (!IDXW) return;
  const N = {};
  for (const k of Object.keys(IDXW)) { const f = FEATS.find(x => x.k === k), dir = f ? f.dir : 1, v = rows.map(r => +r[k]), lo = Math.min(...v), hi = Math.max(...v);
    N[k] = r => hi === lo ? 50 : 100 * (dir > 0 ? r[k] - lo : hi - r[k]) / (hi - lo); }
  const tw = Object.values(IDXW).reduce((a, b) => a + b, 0);
  for (const r of rows) r.idx = Object.entries(IDXW).reduce((a, [k, w]) => a + w * N[k](r), 0) / tw;
}
function printTiers(rows, cuts, pct, nameOf) {
  console.log(`\nTIERS -- champion profile (every past champion had all 5 at the start of the playoffs): ${FEATS.map((f, i) => cutLabel(f, cuts[i])).join(' · ')}`);
  if (IDXW) console.log(`index (0-100, display only) = ${Object.entries(IDXW).map(([k, w]) => `${FEATS.find(f => f.k === k)?.label || k} ${w}%`).join(' · ')}`);
  for (const s of [5, 4, 3, 2, 1]) {
    const L2 = rows.filter(r => (s === 1 ? r.score <= 1 : r.score === s)).sort((a, b) => (pct(b.id) || 0) - (pct(a.id) || 0));
    if (!L2.length) continue;
    console.log(`${TIER_NAME(s)}`);
    const fairOf = p => p >= 0.5 ? '-' + Math.round(100 * p / (1 - p)) : '+' + Math.round(100 * (1 - p) / Math.max(p, 1e-4));
    for (const r of L2) console.log(`  ${String(nameOf(r.id)).padEnd(26)} title ${(100 * (pct(r.id) || 0)).toFixed(1).padStart(5)}% (fair ${fairOf(pct(r.id) || 0).padStart(6)})${r.idx != null ? ` · idx ${r.idx.toFixed(1).padStart(5)}` : ''} | ${FEATS.map((f, i) => `${r.q[i] ? '✓' : '✗'} ${f.label} #${r['r_' + f.k]}`).join(' · ')}`);
  }
}
if (mode === 'dump') {   // input for study/criteria.mjs (the "every champion" search)
  const TS = await tierSeasons(loadP()), names = new Map();
  for (const Y of L.seasons) for (const g of await season(Y)) { names.set(g.h, g.hn); names.set(g.a, g.an); }
  const K = ['ppg', 'gdpg', 'att', 'def', 'form', 'form5', 'gf', 'ga', 'wpct', 'lpct', 'hppg', 'appg', 'str'];
  const out = {sport: lk, label: `${L.label} title`, when: 'start of the playoffs (regular season complete)', fieldLabel: 'the playoff teams', universeLabel: 'every team in the league',
    cands: [{k: 'ppg', dir: 1, label: 'Points/game', value: true}, {k: 'gdpg', dir: 1, label: 'Goal diff/game', value: true}, {k: 'att', dir: 1, label: 'Attack rating', value: true},
      {k: 'def', dir: -1, label: 'Defence rating', value: true}, {k: 'form', dir: 1, label: 'Form (pts/g, last 8)', value: true}, {k: 'form5', dir: 1, label: 'Form (pts/g, last 5)', value: true},
      {k: 'gf', dir: 1, label: 'Goals for/game', value: true}, {k: 'ga', dir: -1, label: 'Goals against/game', value: true}, {k: 'wpct', dir: 1, label: 'Win%', value: true},
      {k: 'lpct', dir: -1, label: 'Loss%', value: true}, {k: 'hppg', dir: 1, label: 'Home pts/game', value: true}, {k: 'appg', dir: 1, label: 'Away pts/game', value: true},
      {k: 'str', dir: 1, label: 'Overall rating (att/def)', value: true}],
    seasons: TS.map(t => ({Y: t.Y, champ: t.champ.id, champName: t.champName, field: t.field.map(r => r.id), rows: t.rows.map(r => Object.fromEntries([['id', r.id], ['name', names.get(r.id) || r.id], ...K.map(k => [k, r[k] ?? null])]))}))};
  fs.mkdirSync('C:/Users/User/baseball-blueprint/study/data', {recursive: true});
  fs.writeFileSync(`C:/Users/User/baseball-blueprint/study/data/${lk}.json`, JSON.stringify(out));
  console.log(`dumped ${out.seasons.length} seasons -> study/data/${lk}.json`);
  process.exit(0);
}
if (mode === 'tiers') {
  const TS = await tierSeasons(loadP());
  console.log(`${L.label} champion-profile tiers -- ${TS.length} clean seasons (${TS.map(t => t.Y).join(', ')})`);
  for (const line of tierBacktest(TS, FEATS, COVER)) console.log(line);
  process.exit(0);
}

// ---------------------------------------------------------------- backtest
if (mode === 'backtest') {
  const S = {};
  for (const Y of [L.seasons[0] - 1, ...L.seasons]) { try { S[Y] = await season(Y); } catch { S[Y] = []; } }
  // data-quality gate: ESPN's early NWSL seasons have teams under two ids / missing games (2013 teams show 12-21 games)
  const gpSpread = Y => { const c = new Map(); for (const g of S[Y].filter(g => !g.po && g.fin)) for (const t of [g.h, g.a]) c.set(t, (c.get(t) || 0) + 1); const v = [...c.values()]; return v.length ? Math.max(...v) - Math.min(...v) : 99; };
  const dropped = L.seasons.filter(Y => gpSpread(Y) > 2);
  if (dropped.length) console.log(`dropped for bad data (teams' games-played differ by >2): ${dropped.map(Y => `${Y} (spread ${gpSpread(Y)})`).join(', ')}`);
  L.seasons = L.seasons.filter(Y => !dropped.includes(Y));
  const pool = Y => [...(S[Y - 1] || []), ...(S[Y - 2] || [])].concat(S[Y]);
  const GRID = []; for (const half of [60, 120, 240, 100000]) for (const k of [1, 3, 6]) for (const rho of [0, 0.08, 0.16]) GRID.push({half, k, rho});
  const weekOf = d => { const t = Date.parse(d + 'T12:00:00Z'); return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10); };
  // 1. match level: every regular-season match predicted from a fit on everything before its week (incl. last season)
  const evalMatches = (P, Ys) => { const out = [];
    for (const Y of Ys) { const G = S[Y].filter(g => !g.po && g.fin && g.hs != null), weeks = [...new Set(G.map(g => weekOf(g.d)))];
      for (const wk of weeks) { const M = fit(pool(Y), wk, P); if (!M) continue;
        for (const g of G.filter(x => weekOf(x.d) === wk)) { const [W, D, Lo] = wdl(...lambdas(M, g.h, g.a, g.neutral ? null : 'h'), P.rho); out.push({Y, p: g.hs > g.as ? W : g.hs === g.as ? D : Lo, r: g.hs > g.as ? 0 : g.hs === g.as ? 1 : 2}); } } }
    return out; };
  const half = Math.ceil(L.seasons.length / 2), H1 = L.seasons.slice(0, half), H2 = L.seasons.slice(half);
  console.log(`${L.label} backtest -- seasons ${L.seasons.join(', ')} (halves ${H1[0]}-${H1[H1.length - 1]} / ${H2[0]}-${H2[H2.length - 1]})\n`);
  let best = null;
  for (const P of GRID) { const r1 = evalMatches(P, H1), ll = mean(r1.map(x => LLf(x.p))); if (!best || ll < best.ll) best = {P, ll}; }
  const P = best.P, A1 = evalMatches(P, H1), A2 = evalMatches(P, H2);
  const base = rs => { const f = [0, 1, 2].map(k => rs.filter(x => x.r === k).length / rs.length); return mean(rs.map(x => LLf(f[x.r]))); };
  console.log(`MATCHES (regular season, refit weekly on everything before): settings tuned on the 1st half only -> half-life ${P.half >= 1e5 ? 'none' : P.half + ' d'}, shrink ${P.k} games, draw +${Math.round(P.rho * 100)}%`);
  for (const [lab, rs] of [['1st half (tuned here)', A1], ['2nd half (held out)', A2]]) console.log(`  ${lab.padEnd(22)} ${rs.length} matches · model log-loss ${mean(rs.map(x => LLf(x.p))).toFixed(4)} vs home/draw/away base rates ${base(rs).toFixed(4)}`);
  // 2. playoff matches + 3. title from the final four
  const po = [], titles = [];
  for (const Y of L.seasons) {
    const G = S[Y], P0 = G.filter(g => g.po && g.fin && !/all-star/i.test(g.po)), start = P0.length ? P0[0].d : null;
    if (!start) continue;
    const M = fit(pool(Y), start, P), seeds = table(G.filter(g => g.d < start)), seedOf = new Map(seeds.map((t, i) => [t.id, i + 1]));
    for (const g of P0) {
      const Mg = fit(pool(Y), g.d, P), p = pAdvance(Mg, g.h, g.a, g.neutral ? null : 'h'), hAdv = winner(g) === g.h;
      po.push({Y, p: hAdv ? p : 1 - p, home: !g.neutral, hAdv, hiSeedHome: !g.neutral && (seedOf.get(g.h) || 99) < (seedOf.get(g.a) || 99)});
    }
    const fin = P0.filter(g => !/all-star/i.test(g.po)).pop(), champ = winner(fin);
    // final four: NWSL = the semifinals; MLS = the two conference finals (single matches only -- two-legged years skipped)
    const semis = lk === 'mls' ? P0.filter(g => /conf/i.test(g.po) && /final/i.test(g.po) && !/semi/i.test(g.po)) : P0.filter(g => /semi/i.test(g.po));
    if (semis.length === 2) {
      const Ms = fit(pool(Y), semis[0].d, P), finalHome = fin.neutral ? null : fin.h, T = titleFromSemis(Ms, semis, finalHome);
      const pc = T.get(champ) || 0, rank = 1 + [...T.values()].filter(v => v > pc).length;
      let p8 = null;
      const qf = P0.filter(g => /quarter/i.test(g.po));
      if (qf.length === 4) { const T8 = titleFrom8(fit(pool(Y), qf[0].d, P), qf, seedOf, finalHome); p8 = T8.get(champ) || 0; }
      titles.push({Y, champ: champ === fin.h ? fin.hn : fin.an, pc, rank, seed: seedOf.get(champ), p8});
    }
  }
  const pl = rs => mean(rs.map(x => LLf(x.p)));
  const homeRate = po.filter(x => x.home).reduce((s, x) => s + (x.hAdv ? 1 : 0), 0) / Math.max(1, po.filter(x => x.home).length);
  console.log(`\nPLAYOFF MATCHES (${po.length}): model log-loss ${pl(po).toFixed(3)} · coin flip ${Math.log(2).toFixed(3)} · "home side advances ${(100 * homeRate).toFixed(0)}%" ${mean(po.map(x => LLf(x.home ? (x.hAdv ? homeRate : 1 - homeRate) : 0.5))).toFixed(3)}`);
  for (const [lab, Ys] of [['1st half', H1], ['2nd half', H2]]) { const rs = po.filter(x => Ys.includes(x.Y)); if (rs.length) console.log(`  ${lab}: ${rs.length} matches · model ${pl(rs).toFixed(3)} vs coin ${Math.log(2).toFixed(3)}`); }
  console.log(`\nTITLE FROM THE FINAL FOUR (semis known) -- coin flip = 25% (LL ${Math.log(4).toFixed(3)})`);
  for (const t of titles) console.log(`  ${t.Y} ${String(t.champ).padEnd(24)} (seed ${t.seed}) model ${(100 * t.pc).toFixed(0).padStart(3)}% (#${t.rank} of 4)${t.p8 != null ? ` · from the 8-team bracket ${(100 * t.p8).toFixed(0)}% (coin 12.5%)` : ''}`);
  for (const [lab, Ys] of [['ALL', L.seasons], ['1st half', H1], ['2nd half', H2]]) { const rs = titles.filter(t => Ys.includes(t.Y)); if (rs.length) console.log(`  ${lab.padEnd(8)} ${rs.length} finals · champ avg ${(100 * mean(rs.map(t => t.pc))).toFixed(1)}% · #1 pick ${rs.filter(t => t.rank === 1).length}/${rs.length} · log-loss ${mean(rs.map(t => LLf(t.pc))).toFixed(3)} vs coin ${Math.log(4).toFixed(3)}`); }
  const shield = titles.filter(t => t.seed === 1).length;
  console.log(`  regular-season #1 seed won ${shield}/${titles.length} titles`);
  fs.writeFileSync(path.join(CACHE, `${lk}_params.json`), JSON.stringify(P));
  process.exit(0);
}

// ---------------------------------------------------------------- live: MLS (simulate the last matchday, seeding, the full bracket)
if (lk === 'mls') {
  const P = fs.existsSync(path.join(CACHE, `mls_params.json`)) ? JSON.parse(fs.readFileSync(path.join(CACHE, `mls_params.json`), 'utf8')) : {half: 240, k: 6, rho: 0.08};   // default = the tuned settings (the site's bot has no cache)
  const G = [...(await season(L.cur - 1)), ...(await season(L.cur))], cur = G.filter(g => g.d >= `${L.cur}-02-01` && !g.po), names = new Map();
  for (const g of cur) { names.set(g.h, g.hn); names.set(g.a, g.an); }
  const asOf = new Date(Date.parse(today + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10), M = fit(G, asOf, P);
  const st = await getJson(`https://site.api.espn.com/apis/v2/sports/soccer/usa.1/standings?season=${L.cur}`);
  const conf = new Map(); for (const ch of (st?.children || [])) for (const e of (ch.standings?.entries || [])) conf.set(String(e.team.id), /east/i.test(ch.name) ? 'E' : 'W');
  const played = cur.filter(g => g.fin && g.hs != null), left = cur.filter(g => !g.fin);
  const base = new Map(); for (const id of conf.keys()) base.set(id, {id, pts: 0, w: 0, d: 0, gp: 0, gd: 0, gf: 0});
  for (const g of played) for (const [me, gf, ga] of [[g.h, g.hs, g.as], [g.a, g.as, g.hs]]) { const t = base.get(me); if (!t) continue; t.gp++; t.gf += gf; t.gd += gf - ga; if (gf > ga) { t.pts += 3; t.w++; } else if (gf === ga) { t.pts++; t.d++; } }
  const memo = new Map(), adv = (h, a, home) => { const k = h + '|' + a + '|' + home; if (!memo.has(k)) memo.set(k, pAdvance(M, h, a, home)); return memo.get(k); };
  const g90 = (h, a, home) => { const k = 'g' + h + '|' + a + '|' + home; if (!memo.has(k)) memo.set(k, wdl(...lambdas(M, h, a, home), P.rho)); return memo.get(k); };
  const rpois = l => { let k = 0, p = Math.exp(-l), s = p, u = Math.random(); while (u > s && k < 15) { k++; p *= l / k; s += p; } return k; };
  const N = +(arg('--sims') || 20000), win = new Map(), cup = new Map();
  for (let s = 0; s < N; s++) {
    const T = new Map([...base].map(([k, v]) => [k, {...v}]));
    for (const g of left) { const [lh, la] = lambdas(M, g.h, g.a, 'h'), x = rpois(lh), y = rpois(la), H = T.get(g.h), A = T.get(g.a); if (!H || !A) continue; H.gf += x; A.gf += y; H.gd += x - y; A.gd += y - x; if (x > y) { H.pts += 3; H.w++; } else if (x < y) { A.pts += 3; A.w++; } else { H.pts++; A.pts++; } }
    const champs = [];
    for (const c of ['E', 'W']) {
      const seeds = [...T.values()].filter(t => conf.get(t.id) === c).sort((x, y) => y.pts - x.pts || y.w - x.w || y.gd - x.gd || y.gf - x.gf).slice(0, 9).map(t => t.id);
      const pk = (h, a) => { const [W, D] = g90(h, a, 'h'); const u = Math.random(); return u < W ? h : u < W + D ? (Math.random() < 0.5 ? h : a) : a; };   // 90 min then straight to penalties
      const wc = pk(seeds[7], seeds[8]);
      const bo3 = (hi, lo) => { let a = 0, b = 0; for (const host of [hi, lo, hi]) { const w = host === hi ? pk(hi, lo) : pk(lo, hi); if (w === hi) a++; else b++; if (a === 2 || b === 2) break; } return a === 2 ? hi : lo; };
      const r1 = [bo3(seeds[0], wc), bo3(seeds[3], seeds[4]), bo3(seeds[1], seeds[6]), bo3(seeds[2], seeds[5])], rank = id => seeds.indexOf(id);
      const ko = (x, y) => { const [hi, lo] = rank(x) < rank(y) ? [x, y] : [y, x]; return Math.random() < adv(hi, lo, 'h') ? hi : lo; };
      const cf = ko(ko(r1[0], r1[1]), ko(r1[2], r1[3]));
      win.set(cf, (win.get(cf) || 0) + 1); champs.push(cf);
    }
    const [e, w] = champs, te = T.get(e), tw = T.get(w), eHosts = te.pts > tw.pts || (te.pts === tw.pts && te.w >= tw.w);
    const ch = Math.random() < adv(eHosts ? e : w, eHosts ? w : e, 'h') ? (eHosts ? e : w) : (eHosts ? w : e);
    cup.set(ch, (cup.get(ch) || 0) + 1);
  }
  const nm = s => String(s).toLowerCase().trim().replace(/^(los angeles f|los angeles fc|la fc)$/, 'lafc').replace(/^(los angeles g|los angeles galaxy)$/, 'la galaxy').replace(/\bsaint\b/g, 'st').replace(/[^a-z ]/g, ' ').replace(/\b(fc|sc|cf|the|united|city)\b/g, ' ').replace(/\s+/g, ' ').trim();
  console.log(`MLS Cup odds -- ${L.cur}, games through ${today} · ${left.length} regular-season games left (simulated) · ${N} sims · home edge x${M.H.toFixed(2)}\n`);
  const rows = [...cup].map(([id, n]) => [id, n / N]).sort((x, y) => y[1] - x[1]);
  for (const [id, p] of rows.slice(0, 16)) { const b = base.get(id);
    console.log(`  ${String(names.get(id)).padEnd(26)} ${conf.get(id)} ${String(b?.pts).padStart(3)} pts | conf title ${(100 * (win.get(id) || 0) / N).toFixed(1).padStart(5)}% | MLS Cup ${(100 * p).toFixed(1).padStart(5)}% (fair ${p >= 0.5 ? '-' + Math.round(100 * p / (1 - p)) : '+' + Math.round(100 * (1 - p) / Math.max(p, 1e-4))})`); }
  if (!arg('--book')) console.log('  (no odds feed for MLS Cup futures -- post a DraftKings, else FanDuel, screenshot and rerun with --book)');
  const TS = await tierSeasons(P), cuts = tierCuts(TS.map(t => t.champ), FEATS, COVER), prof = profile(cur, G, asOf, P);
  for (const r of prof) tierScore(r, FEATS, cuts);
  addIndex(prof);   // scaled across all teams, before narrowing to the contenders
  printTiers(prof.filter(r => (cup.get(r.id) || 0) / N >= 0.005), cuts, id => (cup.get(id) || 0) / N, id => names.get(id));
  if (arg('--export')) {   // board JSON for the blueprint dashboard (scripts/build.py build_mls)
    const SHORT = {att: 'Attack', form: 'Form 8', form5: 'Form 5', wpct: 'Win%', str: 'Overall'}, s2 = Math.sqrt(M.H);
    const out = {league: 'mls', season: L.cur, generated: new Date().toISOString(), today, sims: N, games_left: left.length, home_edge: +M.H.toFixed(3), champions: TS.length,
      cats: FEATS.map((f, i) => cutLabel(f, cuts[i])), labels: FEATS.map(f => SHORT[f.k] || f.label),
      teams: [...conf.keys()].map(id => { const b = base.get(id), r = prof.find(x => x.id === id), a = M.a.get(id) ?? 1, dd = M.d.get(id) ?? 1;
        return {id, name: names.get(id) || id, conf: conf.get(id), gp: b.gp, w: b.w, d: b.d, l: b.gp - b.w - b.d, pts: b.pts, gd: b.gd,
          p: (cup.get(id) || 0) / N, pconf: (win.get(id) || 0) / N, score: r ? r.score : 0, q: r ? r.q : FEATS.map(() => false),
          vals: FEATS.map(f => !r ? '—' : f.kind === 'value' ? `${(+r[f.k]).toFixed(2)} #${r['r_' + f.k]}` : `#${r['r_' + f.k]}`),
          str: r ? r.str : a / dd, rtg: +(M.mu * s2 * (a - dd)).toFixed(3), idx: r && r.idx != null ? +r.idx.toFixed(1) : null}; })};   // idx = champion-weighted index (IDXW)
    fs.writeFileSync(arg('--export'), JSON.stringify(out));
    console.log('exported -> ' + arg('--export'));
  }
  const bk = arg('--book');   // pasted DraftKings / FanDuel board: --book "Nashville SC:+300,Inter Miami:+450,..."
  if (bk) { console.log('\nBOOK PRICES (pasted) -- EV = model p x decimal odds - 1');
    for (const pair of bk.split(',')) { const m = pair.trim().match(/^(.*?):\s*([+-]?\d+)$/); if (!m) continue; const am = +m[2], dec = am > 0 ? 1 + am / 100 : 1 + 100 / -am, w = nm(m[1]);
      const hit = rows.find(([id]) => { const b = nm(names.get(id)); return b && w && (b.includes(w) || w.includes(b) || b.split(' ')[0] === w.split(' ')[0]); }), q = hit ? hit[1] : null;
      console.log(`  ${m[1].padEnd(24)} ${m[2].padStart(6)} implied ${(100 / dec).toFixed(1)}% | model ${q == null ? 'n/a' : (100 * q).toFixed(1) + '% -> EV ' + (q * dec - 1 >= 0 ? '+' : '') + Math.round(100 * (q * dec - 1)) + '%'}`); } }
  if (rest.includes('--log')) {
    const file = `C:/Users/User/baseball-blueprint/${L.hist}`, head = `# MLS Cup Blueprint — Run History\n\nEach run prepends a dated snapshot (engine: baseball-blueprint/pro/soccer.mjs mls).\n\n---\n\n`;
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : head, i = old.indexOf('---\n\n');
    let body = i >= 0 ? old.slice(i + 5) : ''; if (body.startsWith(`## ${today} `)) { const nx = body.indexOf('\n## '); body = nx >= 0 ? body.slice(nx + 1) : ''; }
    const entry = `## ${today} (${L.cur}, ${left.length} regular-season games left)\n\n${rows.slice(0, 12).map(([id, p]) => `- ${names.get(id)} ${(100 * p).toFixed(1)}%`).join('\n')}\n\n`;
    fs.writeFileSync(file, i >= 0 ? old.slice(0, i + 5) + entry + body : old + entry); console.log('\nlogged to ' + file);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- live
const P = fs.existsSync(path.join(CACHE, `${lk}_params.json`)) ? JSON.parse(fs.readFileSync(path.join(CACHE, `${lk}_params.json`), 'utf8')) : {half: 120, k: 3, rho: 0.08};
const G = [...(await season(L.cur - 1)), ...(await season(L.cur))];
const cur = G.filter(g => g.d >= `${L.cur}-01-01`), names = new Map();
for (const g of cur) { names.set(g.h, g.hn); names.set(g.a, g.an); }
const M = fit(G, today < '9999' ? new Date(Date.parse(today + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10) : today, P);
const seeds = table(cur), seedOf = new Map(seeds.map((t, i) => [t.id, i + 1]));
const PO = cur.filter(g => g.po);
const alive = new Set(PO.flatMap(g => [g.h, g.a]));
for (const g of PO.filter(g => g.fin)) alive.delete(winner(g) === g.h ? g.a : g.h);
let T = new Map();
const finalHome = lk === 'nwsl' ? [...names].find(([, n]) => /Washington Spirit/.test(n))?.[0] : null;   // 2026 NWSL final at Audi Field
const qf = PO.filter(g => /quarter/i.test(g.po)), sf = PO.filter(g => /semi/i.test(g.po));
if (sf.length === 2 && sf.every(g => !g.fin)) T = titleFromSemis(M, sf, finalHome);
else if (qf.length === 4) T = titleFrom8(M, qf, seedOf, finalHome);
const norm = s => String(s).toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\b(fc|sc|cf|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
console.log(`${L.label} title odds -- ${L.cur}, games through ${today} · model: half-life ${P.half >= 1e5 ? 'none' : P.half + ' d'}, shrink ${P.k}, draw +${Math.round(P.rho * 100)}%, home edge x${M.H.toFixed(2)}`);
console.log(`seeds: ${seeds.slice(0, 10).map((t, i) => `${i + 1} ${names.get(t.id)} ${t.pts}`).join(' · ')}\n`);
const rows = [...T].sort((x, y) => y[1] - x[1]);
for (const [id, p] of rows) {
  const att = M.a.get(id), def = M.d.get(id);
  console.log(`  ${String(names.get(id)).padEnd(24)} seed ${String(seedOf.get(id)).padStart(2)} · attack ${att.toFixed(2)} defence ${def.toFixed(2)} | title ${(100 * p).toFixed(1).padStart(5)}% (fair ${p >= 0.5 ? '-' + Math.round(100 * p / (1 - p)) : '+' + Math.round(100 * (1 - p) / Math.max(p, 1e-4))})`);
}
for (const g of PO.filter(g => !g.fin)) { const p = pAdvance(M, g.h, g.a, g.neutral ? null : 'h'), [W, D, Lo] = wdl(...lambdas(M, g.h, g.a, g.neutral ? null : 'h'), P.rho); console.log(`  next: ${g.d} ${names.get(g.h)} (home) vs ${names.get(g.a)} -- 90 min ${(100 * W).toFixed(0)}/${(100 * D).toFixed(0)}/${(100 * Lo).toFixed(0)}, ${names.get(g.h)} advances ${(100 * p).toFixed(0)}%`); }
{ const TS = await tierSeasons(P), cuts = tierCuts(TS.map(t => t.champ), FEATS, COVER), prof = profile(cur, G, new Date(Date.parse(today + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10), P);
  for (const r of prof) tierScore(r, FEATS, cuts);
  addIndex(prof);   // scaled across the whole league, before narrowing to the playoff teams
  printTiers(prof.filter(r => alive.has(r.id) || T.has(r.id)), cuts, id => T.get(id), id => names.get(id)); }
const book = arg('--book');
if (book) for (const pair of book.split(',')) { const m = pair.trim().match(/^(.*?):\s*([+-]?\d+)$/); if (!m) continue; const am = +m[2], dec = am > 0 ? 1 + am / 100 : 1 + 100 / -am, id = [...T.keys()].find(i => norm(names.get(i)).includes(norm(m[1])) || norm(m[1]).includes(norm(names.get(i)))); const p = id ? T.get(id) : null; console.log(`  book ${m[1].padEnd(22)} ${m[2].padStart(6)} implied ${(100 / dec).toFixed(1)}% | model ${p == null ? 'n/a' : (100 * p).toFixed(1) + '% -> EV ' + Math.round(100 * (p * dec - 1)) + '%'}`); }
if (rest.includes('--log')) {
  const file = `C:/Users/User/baseball-blueprint/${L.hist}`, head = `# ${L.label} Title Blueprint — Run History\n\nEach run prepends a dated snapshot (engine: baseball-blueprint/pro/soccer.mjs ${lk}).\n\n---\n\n`;
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : head, i = old.indexOf('---\n\n');
  let body = i >= 0 ? old.slice(i + 5) : ''; if (body.startsWith(`## ${today} `)) { const nx = body.indexOf('\n## '); body = nx >= 0 ? body.slice(nx + 1) : ''; }
  const entry = `## ${today} (${L.cur} playoffs)\n\n${rows.map(([id, p]) => `- ${names.get(id)} ${(100 * p).toFixed(1)}%`).join('\n')}\n\n`;
  fs.writeFileSync(file, i >= 0 ? old.slice(0, i + 5) + entry + body : old + entry); console.log('\nlogged to ' + file);
}
