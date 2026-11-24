// Liga MX title engine (built 2026-11-24). Each Apertura and Clausura is its own title, decided by the liguilla.
// Data: ESPN soccer scoreboards (mex.1), Apertura 2001 on; season.slug marks every liguilla round. Cache: %TEMP%/pro_bp_cache/ligamx
// Model (logic copied from soccer.mjs, which stays untouched -- it is shared with the live site): Poisson goals, attack x defence x home
// edge, recency-weighted, shrunk toward average (k pseudo-games), plus a draw-inflation term. The rest of the regular phase is simulated,
// then the real liguilla format of the tournament's era (see FORMATS below), two-legged ties scored exactly from the per-leg score grids.
//   node ligamx.mjs check                       tournaments, formats, champions, and the REWIND PROOF (BP_TODAY turns later matches into fixtures)
//   node ligamx.mjs backtest                    match / liguilla-tie / title backtests (tuned on the 1st half of tournaments, tested on the 2nd)
//   node ligamx.mjs dump                        every team's profile at the start of each past liguilla -> study/data/ligamx.json (study/criteria.mjs)
//   node ligamx.mjs index                       index weights chosen on champions' ranks (+ leave-one-tournament-out check)
//   node ligamx.mjs [live] [--log] [--book "Toluca:+300,..."] [--export file.json] [--sims N]
// BP_TODAY=YYYY-MM-DD rewinds everything: matches on/after that date become unplayed fixtures (regular phase) or vanish (liguilla).
// Offseason: once a title is decided and the next tournament's fixture list is out, the board switches to it (preseason, an UNTESTED stage).
// NO KALSHI / Polymarket, no Odds API: prices come only from the user's DraftKings (else FanDuel) screenshot via --book.
//
// FORMATS (checked against ESPN's round slugs and pairings 2001-2026, see `check`):
//   groups    (Apertura 2001 - Clausura 2011) groups + general table; some seasons had a two-legged repechaje/reclassification round.
//             Used for ratings, matches and the every-champion profile; the title test uses it only as context (decision point = start of the quarters).
//   top8      (Apertura 2011 - Apertura 2019, Clausura 2026 on) single table, top 8: QF 1v8 2v7 3v6 4v5, reseeded semis (best vs worst left), final.
//   reclass12 (Apertura 2020 - Clausura 2023) top 4 straight in; 5v12 6v11 7v10 8v9 one match at the higher seed, a draw goes to penalties;
//             the winners keep their table positions and the 8 are reseeded for the QF.
//   playin10  (Apertura 2023 - Apertura 2025) play-in: 7v8 at 7 (winner = 7th seed), 9v10 at 9, then the 7v8 loser hosts the 9v10 winner for the 8th seed;
//             one match each, a draw goes to penalties.
//   Every QF / SF / final is two legs, the higher seed hosting the second. QF/SF aggregate tie -> the higher seed advances (no away goals; ESPN's
//   ties 2001-26 follow it ~95% of the time -- the exceptions are mostly table-tiebreak differences). Final aggregate tie -> 30 min extra time, then penalties (coin flip).
//   Clausura 2020 was cancelled (COVID) -- no champion. A league format change is picked up from the round slugs once the liguilla fixtures exist.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {TIER_NAME, rankRows, cutoffs as tierCuts, score as tierScore, cutLabel} from './tiers.mjs';

const CACHE = path.join(os.tmpdir(), 'pro_bp_cache', 'ligamx'); fs.mkdirSync(CACHE, {recursive: true});
const ROOT = 'C:/Users/User/baseball-blueprint';
// tuned on the 1st half of tournaments (every match before Clausura 2019) by `backtest` -- the fallback MUST equal what backtest found
const TUNED = {half: 365, k: 20, rho: 0.16, pool: 1100};
const loadP = () => { const f = path.join(CACHE, 'params.json'); return fs.existsSync(f) ? {...TUNED, ...JSON.parse(fs.readFileSync(f, 'utf8'))} : TUNED; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(u) { for (let a = 0; a < 5; a++) { try { const r = await fetch(u, {signal: AbortSignal.timeout(30e3)}); if (r.ok) { const t = await r.text(); return t.trim() ? JSON.parse(t) : null; } if (r.status === 404) return null; } catch {} await sleep(800 * (a + 1)); } throw new Error('fetch failed ' + u); }

const [mode0 = 'live', ...rest0] = process.argv.slice(2);
const mode = mode0.startsWith('--') ? 'live' : mode0, rest = mode0.startsWith('--') ? [mode0, ...rest0] : rest0;
const arg = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
const REAL_TODAY = new Date().toLocaleDateString('en-CA');
const today = process.env.BP_TODAY || REAL_TODAY;
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
const LLf = p => -Math.log(Math.max(p, 1e-4));
const fairAm = p => p < 0.0005 ? '—' : p >= 0.5 ? '-' + Math.round(100 * p / (1 - p)) : '+' + Math.round(100 * (1 - p) / p);
function rng(seed = 20261124) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---------------------------------------------------------------- data
const tIdx = key => +key.slice(1) * 2 + (key[0] === 'A' ? 1 : 0);   // C2012 < A2012 < C2013 ...
const tName = key => `${key[0] === 'A' ? 'Apertura' : 'Clausura'} ${key.slice(1)}`;
async function year(Y) {   // one calendar year of ESPN events -> rows (past years cached for good, this year for 3 hours)
  const f = path.join(CACHE, `espn_${Y}.json`), realY = +REAL_TODAY.slice(0, 4);
  if (fs.existsSync(f) && (Y < realY || Date.now() - fs.statSync(f).mtimeMs < 3 * 3600e3)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const j = await getJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/mex.1/scoreboard?dates=${Y}&limit=1000`), rows = [];
  for (const e of (j?.events || [])) {
    const c = (e.competitions || [])[0]; if (!c) continue;
    const H = c.competitors.find(x => x.homeAway === 'home'), A = c.competitors.find(x => x.homeAway === 'away'); if (!H || !A) continue;
    const slug = e.season?.slug || '', ty = /apertura/i.test(slug) ? 'A' : /clausura/i.test(slug) ? 'C' : null; if (!ty) continue;
    const m = slug.match(/(\d{4})/), yr = m ? +m[1] : ty === 'C' ? +e.season.year + 1 : +e.season.year;   // 2024+ slugs drop the year; season.year = the season's start year
    const num = s => s === '' || s == null ? null : +s;
    rows.push({id: e.id, d: (e.date || '').slice(0, 10), T: ty + yr, po: /^torneo/i.test(slug) ? '' : slug.replace(/^.*---/, ''), h: String(H.team.id), a: String(A.team.id),
      hn: H.team.displayName, an: A.team.displayName, hs: num(H.score), as: num(A.score), st: c.status?.type?.name || '', fin: !!c.status?.type?.completed,
      hw: !!H.winner, aw: !!A.winner, hso: H.shootoutScore ?? null, aso: A.shootoutScore ?? null, neutral: !!c.neutralSite});
  }
  if (rows.length) fs.writeFileSync(f, JSON.stringify(rows));
  return rows;
}
const CHAMP_FIX = {C2004: 'Pumas UNAM'};
const oneLeg = s => /reclass|place|seed-game|play-?in/i.test(s);   // single-match rounds (reclassification 2020-23, play-in 2023-25); every other round is two legs
const isFinalSlug = s => /final/i.test(s) && !/semi|quarter/i.test(s);
const FINAL_MISLABEL = {A2003: 18, A2009: 14};   // ESPN files the A2003 liguilla as 'reclassification' and the A2009 final as 'semi-finals': last two matches = the final once all are in   // ESPN has no winner flag / shootout score for this final (Pumas won on penalties)
async function loadAll(extraYear = false) {
  const realY = +REAL_TODAY.slice(0, 4), rows = [];
  for (let Y = 2001; Y <= realY + (extraYear ? 1 : 0); Y++) { try { rows.push(...await year(Y)); } catch (e) { if (Y <= realY) throw e; } }
  // clean: drop cancelled / postponed / abandoned leftovers and duplicate fixtures of a match that was played on another date
  const played = new Set(rows.filter(g => g.fin && !g.po).map(g => g.T + '|' + g.h + '|' + g.a));
  const keep = rows.filter(g => g.fin || (!/CANCEL|POSTPONED|ABANDON|SUSPEND|FORFEIT/i.test(g.st) && !(!g.po && played.has(g.T + '|' + g.h + '|' + g.a)) && g.d >= addDays(REAL_TODAY, -3)));
  keep.sort((x, y) => x.d.localeCompare(y.d) || x.id.localeCompare(y.id));
  // ESPN filed two Clausura 2014 quarterfinal legs under the regular season (155 'regular' matches, two dated after the liguilla began): refile them
  const fp = new Map(); for (const g of keep) if (g.po && (!fp.has(g.T) || g.d < fp.get(g.T))) fp.set(g.T, g.d);
  return keep.map(g => !g.po && fp.has(g.T) && g.d >= fp.get(g.T) ? {...g, po: 'quarter-finals', refiled: true} : g);
}
// rewind: everything dated on/after asOf is unplayed. Regular-phase matches become fixtures; liguilla matches are removed (who reached them was not known yet).
const rewind = (rows, asOf) => rows.filter(g => !g.po || g.d < asOf).map(g => g.d < asOf ? g : {...g, fin: false, hs: null, as: null, hw: false, aw: false, hso: null, aso: null});

const FMT_RULE = key => { const i = tIdx(key);
  return i < tIdx('A2011') ? 'groups' : key === 'C2020' ? 'cancelled' : i < tIdx('A2020') ? 'top8' : i < tIdx('A2023') ? 'reclass12' : i < tIdx('C2026') ? 'playin10' : 'top8'; };
const FIELD = {top8: 8, reclass12: 12, playin10: 10, groups: 8};
function tournaments(rows) {
  const by = new Map();
  for (const g of rows) { if (!by.has(g.T)) by.set(g.T, {key: g.T, reg: [], post: []}); by.get(g.T)[g.po ? 'post' : 'reg'].push(g); }
  const out = [...by.values()].filter(t => t.reg.length).sort((a, b) => tIdx(a.key) - tIdx(b.key));
  for (const t of out) {
    t.idx = tIdx(t.key); t.first = t.reg.map(g => g.d).sort()[0]; t.lastReg = t.reg.map(g => g.d).sort().pop();
    t.firstPost = t.post.length ? t.post.map(g => g.d).sort()[0] : null;
    // format: the round slugs once the liguilla fixtures exist (picks up a league change), else the era rule
    const P = t.post.map(g => g.po).join(' '), rule = FMT_RULE(t.key);
    t.fmt = rule === 'groups' || rule === 'cancelled' || !t.post.length ? rule : /place|seed-game|play-?in/i.test(P) ? 'playin10' : /reclass/i.test(P) ? 'reclass12' : 'top8';
    t.champ = champion(t);
  }
  return out;
}
function tieWinner(legs, hiId) {   // legs of one tie (same pair), all finished -> advancing team id (null if unknown)
  const a = legs[0].h, b = legs[0].a; let ga = 0, gb = 0;
  for (const g of legs) { if (g.h === a) { ga += g.hs; gb += g.as; } else { ga += g.as; gb += g.hs; } }
  if (ga !== gb) return ga > gb ? a : b;
  const L = legs[legs.length - 1];
  if (L.hso != null && L.aso != null && L.hso !== L.aso) return L.hso > L.aso ? L.h : L.a;
  if (hiId && legs.length === 2 && !isFinalSlug(L.po)) return hiId;   // QF / SF: higher seed advances
  return L.hw ? L.h : L.aw ? L.a : hiId || null;
}
function champion(t) {
  if (CHAMP_FIX[t.key]) { const id = [...t.reg, ...t.post].find(g => g.hn === CHAMP_FIX[t.key]); if (id) return id.hn === CHAMP_FIX[t.key] ? id.h : id.a; }
  const P = t.post.filter(g => g.fin); if (!P.length) return null;
  const last = t.post[t.post.length - 1]; if (!last.fin) return null;
  if (!isFinalSlug(last.po) && !(FINAL_MISLABEL[t.key] && P.length >= FINAL_MISLABEL[t.key])) return null;
  const pair = [last.h, last.a].sort().join('|'), legs = P.filter(g => [g.h, g.a].sort().join('|') === pair && g.po === last.po);
  if (legs.length < 2) return null;
  return tieWinner(legs, null);
}

// ---------------------------------------------------------------- model (fit copied from soccer.mjs, array-based for speed)
function fit(rows, asOf, P) {
  const lo = addDays(asOf, -P.pool), G = rows.filter(g => g.fin && g.hs != null && g.d < asOf && g.d >= lo);
  if (!G.length) return null;
  const ids = [...new Set(G.flatMap(g => [g.h, g.a]))], ix = new Map(ids.map((t, i) => [t, i])), n = ids.length;
  const t0 = Date.parse(asOf + 'T12:00:00Z'), W = G.map(g => Math.pow(0.5, (t0 - Date.parse(g.d + 'T12:00:00Z')) / 864e5 / P.half));
  const hI = G.map(g => ix.get(g.h)), aI = G.map(g => ix.get(g.a)), neu = G.map(g => g.neutral);
  const a = new Float64Array(n).fill(1), d = new Float64Array(n).fill(1);
  let sw = 0, gh = 0, ga = 0; G.forEach((g, i) => { sw += W[i]; gh += W[i] * g.hs; ga += W[i] * g.as; });
  let mu = (gh + ga) / (2 * sw), H = gh / Math.max(ga, 1e-9);
  for (let it = 0; it < 30; it++) {
    const sa = new Float64Array(n), ea = new Float64Array(n), sd = new Float64Array(n), ed = new Float64Array(n);
    for (let i = 0; i < G.length; i++) {
      const x = W[i], h = hI[i], q = aI[i], hf = neu[i] ? Math.sqrt(H) : H, af = neu[i] ? Math.sqrt(H) : 1, hs = G[i].hs, as = G[i].as;
      sa[h] += x * hs; ea[h] += x * mu * hf * d[q]; sa[q] += x * as; ea[q] += x * mu * af * d[h];
      sd[h] += x * as; ed[h] += x * mu * af * a[q]; sd[q] += x * hs; ed[q] += x * mu * hf * a[h];
    }
    let ma = 0, md = 0;
    for (let t = 0; t < n; t++) { a[t] = (sa[t] + P.k * mu) / (ea[t] + P.k * mu); d[t] = (sd[t] + P.k * mu) / (ed[t] + P.k * mu); ma += a[t]; md += d[t]; }
    ma /= n; md /= n; for (let t = 0; t < n; t++) { a[t] /= ma; d[t] /= md; }
    let ph = 0, pa = 0, nh = 0, na = 0;
    for (let i = 0; i < G.length; i++) { if (neu[i]) continue; const x = W[i]; ph += x * a[hI[i]] * d[aI[i]]; pa += x * a[aI[i]] * d[hI[i]]; nh += x * G[i].hs; na += x * G[i].as; }
    H = (nh / ph) / (na / pa); mu = na / pa;
  }
  return {a: new Map(ids.map((t, i) => [t, a[i]])), d: new Map(ids.map((t, i) => [t, d[i]])), mu, H, rho: P.rho, memo: new Map()};
}
const pois = (l, k) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };
function lambdas(M, h, a, home) {   // home: 'h' = h at home, null = neutral
  const ah = M.a.get(h) ?? 0.9, dh = M.d.get(h) ?? 1.1, aa = M.a.get(a) ?? 0.9, da = M.d.get(a) ?? 1.1, s = Math.sqrt(M.H);   // unrated (new) club = a bit below average
  const fh = home === 'h' ? M.H : home === 'a' ? 1 : s, fa = home === 'a' ? M.H : home === 'h' ? 1 : s;
  return [M.mu * fh * ah * da, M.mu * fa * aa * dh];
}
const GMAX = 10;
function diffPmf(lh, la, rho) {   // P(home goals - away goals = k), index k + GMAX; draws inflated by (1 + rho) as in soccer.mjs wdl()
  const ph = [], pa = [], out = new Float64Array(2 * GMAX + 1); let s = 0;
  for (let i = 0; i <= GMAX; i++) { ph.push(pois(lh, i)); pa.push(pois(la, i)); }
  for (let i = 0; i <= GMAX; i++) for (let j = 0; j <= GMAX; j++) { const p = ph[i] * pa[j] * (i === j ? 1 + rho : 1); out[i - j + GMAX] += p; s += p; }
  for (let k = 0; k < out.length; k++) out[k] /= s;
  return out;
}
function wdl(M, h, a, home = 'h') { const p = diffPmf(...lambdas(M, h, a, home), M.rho); let W = 0, L = 0; for (let k = 1; k <= GMAX; k++) { W += p[GMAX + k]; L += p[GMAX - k]; } return [W, p[GMAX], L]; }
function adv1(M, hi, lo) {   // one match at hi's ground, a draw goes to penalties (reclassification / play-in)
  const k = '1|' + hi + '|' + lo; if (M.memo.has(k)) return M.memo.get(k);
  const [W, D] = wdl(M, hi, lo, 'h'), p = W + D / 2; M.memo.set(k, p); return p;
}
function adv2(M, hi, lo, isFinal) {   // two legs, hi hosts the 2nd. QF/SF aggregate tie -> hi; final -> extra time (30 min at hi's ground) then penalties
  const k = (isFinal ? 'F|' : '2|') + hi + '|' + lo; if (M.memo.has(k)) return M.memo.get(k);
  const l1 = diffPmf(...lambdas(M, lo, hi, 'h'), M.rho), l2 = diffPmf(...lambdas(M, hi, lo, 'h'), M.rho);   // l1 = lo-hi (lo at home), l2 = hi-lo
  let pW = 0, pT = 0;
  for (let i = 0; i < l1.length; i++) for (let j = 0; j < l2.length; j++) { const agg = -(i - GMAX) + (j - GMAX), p = l1[i] * l2[j]; if (agg > 0) pW += p; else if (agg === 0) pT += p; }
  let tie = 1;
  if (isFinal) { const [lh, la] = lambdas(M, hi, lo, 'h'), e = diffPmf(lh / 3, la / 3, 0); let w = 0; for (let k2 = 1; k2 <= GMAX; k2++) w += e[GMAX + k2]; tie = w + e[GMAX] / 2; }
  const p = pW + pT * tie; M.memo.set(k, p); return p;
}

// ---------------------------------------------------------------- table + liguilla + simulation
function table(reg) {   // played regular-phase matches -> Map id -> row (every club on the fixture list appears)
  const T = new Map();
  for (const g of reg) for (const id of [g.h, g.a]) if (!T.has(id)) T.set(id, {id, gp: 0, w: 0, d: 0, l: 0, pts: 0, gf: 0, ga: 0});
  for (const g of reg) { if (!g.fin || g.hs == null) continue;
    for (const [me, gf, ga] of [[g.h, g.hs, g.as], [g.a, g.as, g.hs]]) { const t = T.get(me); t.gp++; t.gf += gf; t.ga += ga; if (gf > ga) { t.w++; t.pts += 3; } else if (gf === ga) { t.d++; t.pts++; } else t.l++; } }
  return T;
}
const order = T => [...T.values()].sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf || x.id.localeCompare(y.id));   // points, goal difference, goals for
// one liguilla from a seeded list (best first). Returns the champion and the 8 quarterfinalists.
function runLig(M, seeds, fmt, R) {
  let q;
  if (fmt === 'reclass12') { const w = [[4, 11], [5, 10], [6, 9], [7, 8]].map(([x, y]) => R() < adv1(M, seeds[x], seeds[y]) ? x : y); q = [0, 1, 2, 3, ...w].sort((x, y) => x - y).map(i => seeds[i]); }
  else if (fmt === 'playin10') { const g1 = R() < adv1(M, seeds[6], seeds[7]), w1 = g1 ? seeds[6] : seeds[7], l1 = g1 ? seeds[7] : seeds[6];
    const w2 = R() < adv1(M, seeds[8], seeds[9]) ? seeds[8] : seeds[9], w3 = R() < adv1(M, l1, w2) ? l1 : w2; q = [...seeds.slice(0, 6), w1, w3]; }
  else q = seeds.slice(0, 8);
  const round = (slots, fin) => { const s = slots.slice().sort((x, y) => x - y), out = [];
    for (let i = 0; i < s.length / 2; i++) { const hi = s[i], lo = s[s.length - 1 - i]; out.push(R() < adv2(M, q[hi], q[lo], fin) ? hi : lo); } return out; };
  const sf = round([0, 1, 2, 3, 4, 5, 6, 7], false), fi = round(sf, false), ch = round(fi, true)[0];
  return {champ: q[ch], qf: q};
}
// title odds: simulate the unplayed regular-phase matches (if seeds are not given), seed by the table, play the era's liguilla
function simulate(M, reg, fmt, N, seeds0 = null, R = rng()) {
  const title = new Map(), qual = new Map(), base = table(reg), left = seeds0 ? [] : reg.filter(g => !g.fin);
  const L = left.map(g => { const [lh, la] = lambdas(M, g.h, g.a, g.neutral ? null : 'h'); return {h: g.h, a: g.a, eh: Math.exp(-lh), ea: Math.exp(-la), lh, la}; });
  const rp = (l, e) => { let k = 0, p = e, s = p, u = R(); while (u > s && k < 15) { k++; p *= l / k; s += p; } return k; };
  const acc = 1 / (1 + M.rho);
  for (let s = 0; s < N; s++) {
    let seeds = seeds0;
    if (!seeds) {
      const T = new Map([...base].map(([k, v]) => [k, {...v}]));
      for (const g of L) { let x, y; do { x = rp(g.lh, g.eh); y = rp(g.la, g.ea); } while (x !== y && R() > acc);   // draw inflation by rejection
        const H = T.get(g.h), A = T.get(g.a); H.gf += x; H.ga += y; A.gf += y; A.ga += x; if (x > y) H.pts += 3; else if (x < y) A.pts += 3; else { H.pts++; A.pts++; } }
      for (const t of T.values()) t.r = R();
      seeds = [...T.values()].sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf || x.r - y.r).map(t => t.id);
    }
    const {champ, qf} = runLig(M, seeds, fmt, R);
    title.set(champ, (title.get(champ) || 0) + 1); for (const id of qf) qual.set(id, (qual.get(id) || 0) + 1);
  }
  for (const m of [title, qual]) for (const [k, v] of m) m.set(k, v / N);
  return {title, qual};
}
const liguillaSeeds = t => {   // the real liguilla field at its start, seeded by the final table (group era: the 8 quarterfinalists)
  const tab = order(table(t.reg)).map(r => r.id);
  if (t.fmt === 'groups') { const qf = new Set(t.post.filter(g => /quarter/i.test(g.po)).flatMap(g => [g.h, g.a])); return qf.size === 8 ? tab.filter(id => qf.has(id)) : null; }
  const real = new Set(t.post.flatMap(g => [g.h, g.a]));   // the clubs that really played it (official tiebreaks can differ from points/GD/GF at the cut line)
  return real.size === FIELD[t.fmt] ? tab.filter(id => real.has(id)) : tab.slice(0, FIELD[t.fmt]);
};

// ---------------------------------------------------------------- champion profile (every team at a date) + tiers + index
function profile(t, rowsBefore, asOf, P) {
  const reg = t.reg.filter(g => g.fin && g.hs != null && g.d < asOf), M = fit(rowsBefore, asOf, P), T = new Map();
  for (const g of reg) for (const [me, gf, ga, home] of [[g.h, g.hs, g.as, 1], [g.a, g.as, g.hs, 0]]) {
    const r = T.get(me) || {id: me, gp: 0, pts: 0, gd: 0, gf: 0, ga: 0, w: 0, l: 0, hp: 0, hn: 0, ap: 0, an: 0, res: []}, p = gf > ga ? 3 : gf === ga ? 1 : 0;
    r.gp++; r.gd += gf - ga; r.gf += gf; r.ga += ga; r.pts += p; if (p === 3) r.w++; if (p === 0) r.l++;
    if (home) { r.hp += p; r.hn++; } else { r.ap += p; r.an++; }
    r.res.push([g.d, p]); T.set(me, r);
  }
  const avgP = a => a.length ? a.reduce((s, x) => s + x[1], 0) / a.length : 0, posOf = new Map(order(table(reg)).map((r, i) => [r.id, i + 1]));
  const rows = [...T.values()].map(r => { const s = r.res.sort((x, y) => x[0].localeCompare(y[0])), att = M ? (M.a.get(r.id) ?? 1) : 1, def = M ? (M.d.get(r.id) ?? 1) : 1;
    return {id: r.id, pos: posOf.get(r.id), pts: r.pts, ppg: r.pts / r.gp, gdpg: r.gd / r.gp, att, def, str: att / def, form: avgP(s.slice(-8)), form5: avgP(s.slice(-5)),
      gf: r.gf / r.gp, ga: r.ga / r.gp, wpct: r.w / r.gp, lpct: r.l / r.gp, hppg: r.hn ? r.hp / r.hn : 0, appg: r.an ? r.ap / r.an : 0}; });
  return {rows, M};
}
// every-champion rule (study/criteria.mjs ligamx, 2026-11-24): each cutoff = the loosest past champion at the start of the liguilla
const FEATS = [   // found 2026-11-24 on 48 champions (C2002-C2026); honest test: hidden champion cleared all 5 in 41/48, but the rule lets 5.5 of 9 field teams through -> CONTEXT ONLY
  {k: 'str', dir: 1, kind: 'value', label: 'Overall rating (att/def)'},
  {k: 'form5', dir: 1, kind: 'rank', label: 'Form (last 5)'},
  {k: 'ga', dir: -1, kind: 'rank', label: 'Goals against/game'},
  {k: 'wpct', dir: 1, kind: 'rank', label: 'Win%'},
  {k: 'appg', dir: 1, kind: 'rank', label: 'Away pts/game'},
];
// index (0-100): champion-weighted mean of profile metrics scaled across the league (weights from `index`, chosen on champions' ranks in the field)
const IDXW = {str: 34, ppg: 33, ga: 33};   // 2026-11-24 `index`: champion avg rank in the field 2.92 (halves 3.17 / 2.67, random 5.0); the full weight search overfit (leave-one-out 3.46), so: equal thirds of the 3 best single metrics
function addIndex(rows) {
  const N = {};
  for (const k of Object.keys(IDXW)) { const dir = k === 'ga' || k === 'pos' || k === 'def' || k === 'lpct' ? -1 : 1, v = rows.map(r => +r[k]), lo = Math.min(...v), hi = Math.max(...v);
    N[k] = r => hi === lo ? 50 : 100 * (dir > 0 ? r[k] - lo : hi - r[k]) / (hi - lo); }
  const tw = Object.values(IDXW).reduce((a, b) => a + b, 0);
  for (const r of rows) r.idx = Object.entries(IDXW).reduce((a, [k, w]) => a + w * N[k](r), 0) / tw;
}
const titleSet = Ts => Ts.filter(t => t.champ && t.fmt !== 'cancelled' && t.post.length);   // decided tournaments
function champProfiles(Ts, rows, P, before = '9999') {   // every past champion's row at the start of its liguilla (for the tier cutoffs)
  const out = [];
  for (const t of titleSet(Ts).filter(t => t.firstPost < before && t.idx >= tIdx('C2002'))) {
    const pr = profile(t, rows, t.firstPost, P); rankRows(pr.rows, FEATS); const c = pr.rows.find(r => r.id === t.champ); if (c) out.push({t, c, rows: pr.rows});
  }
  return out;
}
const fmtV = (k, v) => v == null || !isFinite(v) ? '—' : k === 'pos' ? String(Math.round(v)) : (+v).toFixed(2);

// ---------------------------------------------------------------- state at a date (live + check use the same code)
function stateAt(ALL, asOf, allowNext) {
  const rows = rewind(ALL, asOf), Ts = tournaments(rows);
  let t = [...Ts].reverse().find(x => x.first < asOf) || Ts[0];
  const decided = !!t.champ;
  // offseason: once this tournament is decided, switch to the next one as soon as its fixture list is published (preseason board, untested stage)
  if ((decided || t.fmt === 'cancelled') && allowNext) { const nx = Ts.find(x => x.idx > t.idx); if (nx && nx.reg.length >= 0.9 * t.reg.length) t = nx; }
  const regPlayed = t.reg.filter(g => g.fin).length, postPlayed = t.post.filter(g => g.fin).length;
  const stage = t.champ ? 'done' : postPlayed ? 'liguilla' : !regPlayed ? 'preseason' : regPlayed < t.reg.length ? 'regular' : 'bracket';
  return {rows, Ts, t, stage, regPlayed, left: t.reg.length - regPlayed, postPlayed};
}

const names = ALL => { const m = new Map(); for (const g of ALL) { m.set(g.h, g.hn); m.set(g.a, g.an); } return m; };
const KNOWN = {A2011: 'Tigres', C2012: 'Santos', A2012: 'Tijuana', C2013: 'América', A2013: 'León', C2014: 'León', A2014: 'América', C2015: 'Santos', A2015: 'Tigres',
  C2016: 'Pachuca', A2016: 'Tigres', C2017: 'Guadalajara', A2017: 'Tigres', C2018: 'Santos', A2018: 'América', C2019: 'Tigres', A2019: 'Monterrey', A2020: 'León',
  C2021: 'Cruz Azul', A2021: 'Atlas', C2022: 'Atlas', A2022: 'Pachuca', C2023: 'Tigres', A2023: 'América', C2024: 'América', A2024: 'América', C2025: 'Toluca', A2025: 'Toluca'};

// ================================================================ check
if (mode === 'check') {
  const ALL = await loadAll(), NM = names(ALL), Ts = tournaments(ALL);
  console.log(`ESPN mex.1 -- ${ALL.length} matches, ${Ts.length} tournaments (${tName(Ts[0].key)} .. ${tName(Ts[Ts.length - 1].key)})\n`);
  let bad = 0;
  for (const t of Ts) {
    const rd = {}; for (const g of t.post) rd[g.po] = (rd[g.po] || 0) + 1;
    const pos = t.champ ? order(table(t.reg)).findIndex(r => r.id === t.champ) + 1 : null, kn = KNOWN[t.key], cn = t.champ ? NM.get(t.champ) : null;
    const ok = !kn ? '' : cn && cn.includes(kn) ? ' ✓' : (bad++, ` ✗ (expected ${kn})`);
    console.log(`${tName(t.key).padEnd(14)} ${t.fmt.padEnd(9)} reg ${t.reg.filter(g => g.fin).length}/${t.reg.length} (${new Set(t.reg.flatMap(g => [g.h, g.a])).size} clubs) ${t.first}..${t.lastReg} | liguilla ${t.firstPost || '—'} ${Object.entries(rd).map(([k, v]) => `${k} ${v}`).join(', ') || '—'} | champion ${cn ?? '—'}${pos ? ` (#${pos})` : ''}${ok}`);
  }
  console.log(`\nchampions vs the known list (A2011+): ${bad ? bad + ' MISMATCH(ES)' : 'all match'}`);
  // ---- REWIND PROOF: at each as-of date, every match dated on/after it must be unplayed (regular) or gone (liguilla); standings recomputed independently
  console.log(`\nREWIND PROOF (BP_TODAY): later matches -> unplayed fixtures; standings rebuilt from raw rows dated before the as-of day must agree`);
  const dates = ['2025-02-15', '2025-03-30', '2025-04-27', '2025-05-12', '2025-06-10', '2025-11-12', '2025-11-22', '2025-12-05', '2025-12-20', '2026-11-24'];
  for (const D of dates) {
    const asOf = addDays(D, 1), S = stateAt(ALL, asOf, false), t = S.t;
    const leak = S.rows.filter(g => g.fin && g.d >= asOf).length, postKept = t.post.length, postLater = S.rows.filter(g => g.po && g.d >= asOf).length;
    const rawPlayed = ALL.filter(g => g.T === t.key && !g.po && g.fin && g.d < asOf), rawLeft = ALL.filter(g => g.T === t.key && !g.po && (g.d >= asOf || !g.fin)).length;
    const indep = new Map(); for (const g of rawPlayed) for (const [me, p] of [[g.h, g.hs > g.as ? 3 : g.hs === g.as ? 1 : 0], [g.a, g.as > g.hs ? 3 : g.hs === g.as ? 1 : 0]]) indep.set(me, (indep.get(me) || 0) + p);
    const mine = order(table(t.reg)), same = mine.every(r => (indep.get(r.id) || 0) === r.pts);
    const pass = leak === 0 && postLater === 0 && same && S.left === rawLeft && S.regPlayed === rawPlayed.length;
    console.log(`  BP_TODAY=${D} -> ${tName(t.key)} · stage ${S.stage.padEnd(9)} · regular played ${String(S.regPlayed).padStart(3)} (raw ${rawPlayed.length}) · left ${String(S.left).padStart(3)} (raw ${rawLeft}) · liguilla matches kept ${postKept} (all before the day: ${postLater === 0}) · played-after-date leaks ${leak} · leader ${NM.get(mine[0]?.id)} ${mine[0]?.pts} pts · ${pass ? 'PASS' : 'FAIL'}`);
  }
  process.exit(0);
}

// ================================================================ dump (study/criteria.mjs input)
if (mode === 'dump') {
  const ALL = await loadAll(), NM = names(ALL), Ts = tournaments(ALL), P = loadP();
  const K = ['pos', 'ppg', 'gdpg', 'att', 'def', 'str', 'form', 'form5', 'gf', 'ga', 'wpct', 'lpct', 'hppg', 'appg'];
  const out = {sport: 'ligamx', label: 'Liga MX title (Apertura/Clausura)', when: 'start of the liguilla (regular phase complete)', fieldLabel: 'the liguilla teams (incl. play-in / reclassification)', universeLabel: 'every Liga MX club',
    cands: [{k: 'pos', dir: -1, label: 'Table position', value: true, rank: false, dec: 0}, {k: 'ppg', dir: 1, label: 'Points/game', value: true}, {k: 'gdpg', dir: 1, label: 'Goal diff/game', value: true},
      {k: 'att', dir: 1, label: 'Attack rating', value: true}, {k: 'def', dir: -1, label: 'Defence rating', value: true}, {k: 'str', dir: 1, label: 'Overall rating (att/def)', value: true},
      {k: 'form', dir: 1, label: 'Form (pts/g, last 8)', value: true}, {k: 'form5', dir: 1, label: 'Form (pts/g, last 5)', value: true}, {k: 'gf', dir: 1, label: 'Goals for/game', value: true},
      {k: 'ga', dir: -1, label: 'Goals against/game', value: true}, {k: 'wpct', dir: 1, label: 'Win%', value: true}, {k: 'lpct', dir: -1, label: 'Loss%', value: true},
      {k: 'hppg', dir: 1, label: 'Home pts/game', value: true}, {k: 'appg', dir: 1, label: 'Away pts/game', value: true}], seasons: []};
  for (const t of titleSet(Ts).filter(t => t.idx >= tIdx('C2002'))) {
    const {rows} = profile(t, ALL, t.firstPost, P), field = [...new Set(t.post.flatMap(g => [g.h, g.a]))];
    out.seasons.push({Y: t.key, champ: t.champ, champName: NM.get(t.champ), field, rows: rows.map(r => Object.fromEntries([['id', r.id], ['name', NM.get(r.id)], ...K.map(k => [k, r[k]])]))});
  }
  fs.mkdirSync(`${ROOT}/study/data`, {recursive: true});
  fs.writeFileSync(`${ROOT}/study/data/ligamx.json`, JSON.stringify(out));
  console.log(`dumped ${out.seasons.length} tournaments -> study/data/ligamx.json · champs: ${out.seasons.map(s => `${s.Y} ${s.champName} (#${s.rows.find(r => r.id === s.champ)?.pos} of ${s.field.length})`).join(', ')}`);
  process.exit(0);
}

// ================================================================ index weights (chosen on champions' ranks in the liguilla field)
if (mode === 'index') {
  const ALL = await loadAll(), Ts = tournaments(ALL), P = loadP(), CP = champProfiles(Ts, ALL, P);
  const keys = ['str', 'ppg', 'gdpg', 'form', 'att', 'appg', 'ga'], steps = [];
  const rec = (i, left, cur) => { if (i === keys.length - 1) { steps.push({...cur, [keys[i]]: left}); return; } for (let w = 0; w <= left; w += 25) rec(i + 1, left - w, {...cur, [keys[i]]: w}); };
  rec(0, 100, {});
  const dirOf = k => k === 'ga' ? -1 : 1;
  const S = CP.map(({t, c, rows}) => { const field = new Set(t.post.flatMap(g => [g.h, g.a])), F = rows.filter(r => field.has(r.id));
    const N = {}; for (const k of keys) { const v = rows.map(r => r[k]), lo = Math.min(...v), hi = Math.max(...v); N[k] = r => hi === lo ? 50 : 100 * (dirOf(k) > 0 ? r[k] - lo : hi - r[k]) / (hi - lo); }
    return {key: t.key, F: F.map(r => Object.fromEntries(keys.map(k => [k, N[k](r)]))), ci: F.findIndex(r => r.id === c.id)}; }).filter(s => s.ci >= 0);
  const rankIn = (s, W) => { const sc = s.F.map(r => keys.reduce((a, k) => a + (W[k] || 0) * r[k], 0)); return 1 + sc.filter(v => v > sc[s.ci] + 1e-9).length; };
  const avgRank = (W, set) => mean(set.map(s => rankIn(s, W)));
  const best = set => steps.reduce((b, W) => { const r = avgRank(W, set); return !b || r < b.r - 1e-9 ? {W, r} : b; }, null);
  const B = best(S), loso = S.map((s, i) => rankIn(s, best(S.filter((_, j) => j !== i)).W));
  const half = Math.ceil(S.length / 2);
  console.log(`index weights on ${S.length} champions (avg field ${mean(S.map(s => s.F.length)).toFixed(1)}): best ${JSON.stringify(Object.fromEntries(Object.entries(B.W).filter(([, w]) => w)))} -> champion avg rank ${B.r.toFixed(2)}`);
  console.log(`  leave-one-tournament-out (weights re-chosen without it): avg rank ${mean(loso).toFixed(2)} · #1 ${loso.filter(r => r === 1).length}/${S.length} · top-3 ${loso.filter(r => r <= 3).length} | halves ${mean(loso.slice(0, half)).toFixed(2)} / ${mean(loso.slice(half)).toFixed(2)}`);
  for (const k of keys) { const r = S.map(s => rankIn(s, {[k]: 1})); console.log(`  ${k.padEnd(5)} alone: avg ${mean(r).toFixed(2)} · #1 ${r.filter(x => x === 1).length} | halves ${mean(r.slice(0, half)).toFixed(2)} / ${mean(r.slice(half)).toFixed(2)}`); }
  const B1 = best(S.slice(0, half)), r2 = S.slice(half).map(s => rankIn(s, B1.W));
  console.log(`  chosen on the 1st half only: ${JSON.stringify(Object.fromEntries(Object.entries(B1.W).filter(([, w]) => w)))} (1st-half avg ${B1.r.toFixed(2)}) -> 2nd half (held out) avg ${mean(r2).toFixed(2)} · #1 ${r2.filter(x => x === 1).length}/${r2.length}`);
  for (const W of [{str: 50, ga: 50}, {ppg: 50, ga: 50}, {gdpg: 50, ga: 50}, {str: 34, ppg: 33, ga: 33}, {str: 25, ppg: 25, ga: 50}, {gdpg: 34, ga: 33, str: 33}, {str: 50, ppg: 50}, ...(arg('--w') ? [JSON.parse(arg('--w'))] : [])]) {
    const r = S.map(s => rankIn(s, W)); console.log(`  candidate ${JSON.stringify(W).padEnd(32)} avg ${mean(r).toFixed(2)} · #1 ${r.filter(x => x === 1).length} · top-3 ${r.filter(x => x <= 3).length} | halves ${mean(r.slice(0, half)).toFixed(2)} / ${mean(r.slice(half)).toFixed(2)}`); }
  const cur = S.map(s => rankIn(s, IDXW)); console.log(`  current IDXW ${JSON.stringify(IDXW)}: avg ${mean(cur).toFixed(2)} · #1 ${cur.filter(x => x === 1).length} · top-3 ${cur.filter(x => x <= 3).length} | halves ${mean(cur.slice(0, half)).toFixed(2)} / ${mean(cur.slice(half)).toFixed(2)}`);
  console.log(`  random pick: avg ${mean(S.map(s => (s.F.length + 1) / 2)).toFixed(2)}`);
  process.exit(0);
}

// ================================================================ backtest
if (mode === 'backtest') {
  const ALL = await loadAll(), NM = names(ALL), Ts = tournaments(ALL);
  const ST = titleSet(Ts).filter(t => t.idx >= tIdx('A2011')), half = Math.ceil(ST.length / 2), H1 = ST.slice(0, half), H2 = ST.slice(half), cut = H2[0].idx;
  const inH = (t, H) => H.some(x => x.key === t.key);
  console.log(`Liga MX backtest -- title test on the single-table era: ${ST.length} tournaments (1st half ${tName(H1[0].key)} - ${tName(H1[H1.length - 1].key)} · 2nd half ${tName(H2[0].key)} - ${tName(H2[H2.length - 1].key)})`);
  // ---- 1. matches: every regular-phase match from a fit on everything before its week; tune on matches before the 2nd half only
  const weekOf = d => { const t = Date.parse(d + 'T12:00:00Z'); return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10); };
  const MT = Ts.filter(t => t.idx >= tIdx('C2003') && t.reg.some(g => g.fin)), weeks = new Map();
  for (const t of MT) for (const g of t.reg) if (g.fin && g.hs != null) { const w = weekOf(g.d); if (!weeks.has(w)) weeks.set(w, []); weeks.get(w).push({g, t}); }
  const res = r => r.g.hs > r.g.as ? 0 : r.g.hs === r.g.as ? 1 : 2;
  const evalFits = Pf => { const out = []; for (const [w, L] of weeks) { const M = fit(ALL, w, Pf); if (!M) continue; for (const r of L) { const [lh, la] = lambdas(M, r.g.h, r.g.a, r.g.neutral ? null : 'h'); out.push({r, lh, la}); } } return out; };
  const scoreRho = (E, rho, f) => mean(E.filter(f).map(e => { const p = diffPmf(e.lh, e.la, rho); let W = 0, L = 0; for (let k = 1; k <= GMAX; k++) { W += p[GMAX + k]; L += p[GMAX - k]; } return LLf([W, p[GMAX], L][res(e.r)]); }));
  const tuneF = e => e.r.t.idx < cut;
  let best = null; const EC = new Map();
  for (const h of [90, 180, 365, 730]) for (const k of [6, 10, 20, 40]) { const E = evalFits({half: h, k, pool: 1100}); EC.set(h + '|' + k, E);
    for (const rho of [0, 0.08, 0.16, 0.24]) { const ll = scoreRho(E, rho, tuneF); if (!best || ll < best.ll) best = {P: {half: h, k, rho, pool: 1100}, ll}; } }
  const P = best.P, E = EC.get(P.half + '|' + P.k);
  const baseLL = f => { const R = E.filter(f).map(e => res(e.r)), fr = [0, 1, 2].map(k => R.filter(x => x === k).length / R.length); return mean(R.map(x => LLf(fr[x]))); };
  console.log(`\nMATCHES (regular phase, refit weekly on everything before): tuned on every match before ${tName(H2[0].key)} -> half-life ${P.half} d, shrink ${P.k} games, draws +${Math.round(P.rho * 100)}%`);
  for (const [lab, f] of [['group era 2003-11 (tuning)', e => e.r.t.idx < tIdx('A2011')], ['1st half (tuning)', e => inH(e.r.t, H1)], ['2nd half (held out)', e => e.r.t.idx >= cut]])
    console.log(`  ${lab.padEnd(27)} ${String(E.filter(f).length).padStart(5)} matches · model LL ${scoreRho(E, P.rho, f).toFixed(4)} vs home/draw/away base rates ${baseLL(f).toFixed(4)}`);
  // ---- 2. liguilla ties (QF/SF/final two legs; reclass/play-in single matches): P(higher seed advances)
  const ties = [];
  for (const t of ST) { const pos = new Map(order(table(t.reg)).map((r, i) => [r.id, i + 1])), by = new Map();
    for (const g of t.post) { const k = g.po + '|' + [g.h, g.a].sort().join('|'); if (!by.has(k)) by.set(k, []); by.get(k).push(g); }
    for (const [k, legs] of by) { if (!legs.every(g => g.fin)) continue; const [x, y] = [legs[0].h, legs[0].a], hi = pos.get(x) < pos.get(y) ? x : y, lo = hi === x ? y : x;
      const M = fit(ALL, legs[0].d, P), single = legs.length === 1, fin = /final/i.test(legs[0].po) && !/semi|quarter/i.test(legs[0].po);
      const p = single ? adv1(M, legs[0].h, legs[0].a) * (legs[0].h === hi ? 1 : -1) + (legs[0].h === hi ? 0 : 1) : adv2(M, hi, lo, fin), w = tieWinner(legs, hi);
      ties.push({t, p, hiAdv: w === hi, single}); } }
  const tieLL = rs => mean(rs.map(r => LLf(r.hiAdv ? r.p : 1 - r.p)));
  const tieBase = rs => mean(rs.map(r => { const o = ties.filter(z => z.t.key !== r.t.key && z.single === r.single), q = o.filter(z => z.hiAdv).length / o.length; return LLf(r.hiAdv ? q : 1 - q); }));
  console.log(`\nLIGUILLA TIES (${ties.length}; refit before each tie): P(higher seed advances) vs the base rate "higher seed advances" (from the other tournaments)`);
  for (const [lab, H] of [['1st half', H1], ['2nd half', H2]]) { const rs = ties.filter(r => inH(r.t, H)); console.log(`  ${lab}: ${rs.length} ties · model LL ${tieLL(rs).toFixed(4)} vs base rate ${tieBase(rs).toFixed(4)} · coin ${Math.log(2).toFixed(4)} · higher seed advanced ${rs.filter(r => r.hiAdv).length}/${rs.length}`); }
  // ---- 3. title odds at the start of the liguilla (real field + seeds) and at 75% of the regular phase
  const titles = [];
  for (const t of ST) {
    const seeds = liguillaSeeds(t), M = fit(ALL, t.firstPost, P), Tf = simulate(M, t.reg, t.fmt, 20000, seeds).title;
    const ds = t.reg.map(g => g.d).sort(), d75 = ds[Math.floor(0.75 * ds.length)], reg75 = t.reg.map(g => g.d < d75 ? g : {...g, fin: false, hs: null, as: null});
    const T75 = simulate(fit(ALL, d75, P), reg75, t.fmt, 8000).title, pos75 = order(table(reg75)).findIndex(r => r.id === t.champ) + 1;
    const rk = (T, id) => 1 + [...T.values()].filter(v => v > (T.get(id) || 0)).length;
    titles.push({t, ch: NM.get(t.champ), seed: seeds.indexOf(t.champ) + 1, field: seeds.length, p: Tf.get(t.champ) || 0, r: rk(Tf, t.champ), p75: T75.get(t.champ) || 0, r75: rk(T75, t.champ), pos75, nT: table(t.reg).size, d75});
  }
  // seed history (leave-one-tournament-out): share of the OTHER titles won from each table position, +0.5 smoothing, normalised over this field
  const seedLL = (x, k, n) => { const o = titles.filter(z => z.t.key !== x.t.key), num = o.filter(z => z[k] === x[k]).length + 0.5, den = Array.from({length: n}, (_, i) => o.filter(z => z[k] === i + 1).length + 0.5).reduce((a, b) => a + b, 0); return -Math.log(num / den); };
  console.log(`\nTITLE ODDS -- start of the liguilla (real field, seeded by the table) | at 75% of the regular phase (rest of the phase + liguilla simulated)`);
  for (const x of titles) console.log(`  ${tName(x.t.key).padEnd(14)} ${String(x.ch).padEnd(22)} ${x.t.fmt.padEnd(9)} seed ${String(x.seed).padStart(2)}/${x.field} | liguilla start ${(100 * x.p).toFixed(1).padStart(5)}% (#${x.r}) | 75% (${x.d75}, #${x.pos75} in the table) ${(100 * x.p75).toFixed(1).padStart(5)}% (#${x.r75})`);
  for (const [lab, H] of [['ALL', ST], ['1st half', H1], ['2nd half', H2]]) { const rs = titles.filter(x => inH(x.t, H));
    console.log(`  ${lab.padEnd(8)} liguilla start: LL ${mean(rs.map(x => LLf(x.p))).toFixed(3)} vs equal ${mean(rs.map(x => Math.log(x.field))).toFixed(3)} vs seed history ${mean(rs.map(x => seedLL(x, 'seed', x.field))).toFixed(3)} · #1 won ${rs.filter(x => x.r === 1).length}/${rs.length} · champ avg rank ${mean(rs.map(x => x.r)).toFixed(2)} (field avg ${mean(rs.map(x => x.field)).toFixed(1)})`);
    console.log(`  ${''.padEnd(8)} 75% mark:       LL ${mean(rs.map(x => LLf(x.p75))).toFixed(3)} vs equal ${mean(rs.map(x => Math.log(x.nT))).toFixed(3)} vs table-position history ${mean(rs.map(x => seedLL(x, 'pos75', x.nT))).toFixed(3)} · #1 won ${rs.filter(x => x.r75 === 1).length}/${rs.length} · champ avg rank ${mean(rs.map(x => x.r75)).toFixed(2)} of ${mean(rs.map(x => x.nT)).toFixed(0)}`); }
  console.log(`  table #1 won ${titles.filter(x => x.seed === 1).length}/${titles.length} · a top-2 seed ${titles.filter(x => x.seed <= 2).length}/${titles.length} · seeds 5+ ${titles.filter(x => x.seed >= 5).length}/${titles.length}`);
  // ---- context: group era (Clausura 2004 - Clausura 2011), decision point = start of the quarterfinals (8 quarterfinalists, seeded by the general table)
  const GE = titleSet(Ts).filter(t => t.fmt === 'groups' && t.idx >= tIdx('C2004') && liguillaSeeds(t)).map(t => { const seeds = liguillaSeeds(t), q0 = t.post.filter(g => /quarter/i.test(g.po)).map(g => g.d).sort()[0];
    const T = simulate(fit(ALL, q0, P), t.reg, 'top8', 10000, seeds).title, p = T.get(t.champ) || 0; return {t, p, r: 1 + [...T.values()].filter(v => v > p).length}; }).filter(x => x.p > 0 || true);
  if (GE.length) console.log(`\nCONTEXT -- group era ${tName(GE[0].t.key)} - ${tName(GE[GE.length - 1].t.key)} (${GE.length} titles, start of the quarters): LL ${mean(GE.map(x => LLf(x.p))).toFixed(3)} vs equal ${Math.log(8).toFixed(3)} · #1 won ${GE.filter(x => x.r === 1).length}/${GE.length} · champ avg rank ${mean(GE.map(x => x.r)).toFixed(2)}`);
  fs.writeFileSync(path.join(CACHE, 'params.json'), JSON.stringify(P));
  console.log(`\nsaved tuned settings -> ${path.join(CACHE, 'params.json')} (keep TUNED in the file equal to them: ${JSON.stringify(P)})`);
  process.exit(0);
}

// ================================================================ live board
{
  const ALL = await loadAll(!process.env.BP_TODAY), NM = names(ALL), P = loadP(), asOf = addDays(today, 1);
  const S = stateAt(ALL, asOf, !process.env.BP_TODAY || !!process.env.BP_NEXT), {t, stage, rows} = S, N = +(arg('--sims') || 20000);   // BP_NEXT=1: allow the offseason switch under a rewind (tests the preseason board)
  const frozen = stage === 'liguilla' || stage === 'done', atBracket = stage === 'bracket' || frozen;
  const fmt = t.fmt === 'groups' || t.fmt === 'cancelled' ? 'top8' : t.fmt;
  // odds: before the liguilla = the rest of the regular phase + the liguilla simulated; from the bracket on = START-OF-LIGUILLA odds
  // (ratings fit on matches before the first liguilla match, the real seeds) -- FROZEN once the liguilla starts: the user never bets within the playoffs
  const fitDay = atBracket && t.firstPost && t.firstPost < asOf ? t.firstPost : asOf;
  const M = fit(rows, fitDay, P), seeds = atBracket ? (t.post.length ? liguillaSeeds({...t, fmt}) : order(table(t.reg)).map(r => r.id).slice(0, FIELD[fmt])) : null;
  const {title: T, qual} = simulate(M, t.reg, fmt, N, seeds);
  // alive (liguilla): losers of completed ties are out
  const posOf = new Map(order(table(t.reg)).map((r, i) => [r.id, i + 1])), out = new Set();
  if (frozen) { const by = new Map(); for (const g of t.post) { const k = g.po + '|' + [g.h, g.a].sort().join('|'); if (!by.has(k)) by.set(k, []); by.get(k).push(g); }
    for (const legs of by.values()) { if (!legs.every(g => g.fin) || legs.length < (oneLeg(legs[0].po) ? 1 : 2)) continue;   /* a two-legged tie counts only once both legs are in */ const [x, y] = [legs[0].h, legs[0].a], hi = posOf.get(x) < posOf.get(y) ? x : y, w = tieWinner(legs, hi);
      if (legs.length === 1 && /^7th/i.test(legs[0].po)) continue;   // play-in: the 7v8 loser gets a second chance (8th-seed game)
      if (w) out.add(w === x ? y : x); }
  }
  // profile: as of today (start of the liguilla once it starts). Preseason: the last decided tournament's start-of-liguilla profile
  let PT = t, pDay = atBracket ? fitDay : asOf;
  if (stage === 'preseason') { PT = [...S.Ts].reverse().find(x => x.champ && x.idx < t.idx); pDay = PT.firstPost; }
  const {rows: prof} = profile(PT, rows, pDay, P);
  rankRows(prof, FEATS);
  const CP = champProfiles(S.Ts, rows, P, frozen ? t.firstPost : asOf), cuts = tierCuts(CP.map(x => x.c), FEATS, 1);
  for (const r of prof) tierScore(r, FEATS, cuts);
  addIndex(prof);
  const pr = new Map(prof.map(r => [r.id, r])), tab = order(table(t.reg)), pct = Math.round(100 * S.regPlayed / Math.max(1, t.reg.length));
  // book prices: --book "Toluca:+300,Cruz Azul:+450,..." (the user's DraftKings, else FanDuel, screenshot)
  const deacc = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const ALIAS = {chivas: 'guadalajara', rayados: 'monterrey', xolos: 'tijuana', tuzos: 'pachuca', 'san luis': 'atletico de san luis', 'atl san luis': 'atletico de san luis', 'la maquina': 'cruz azul', 'diablos rojos': 'toluca', 'gallos blancos': 'queretaro', 'guerreros': 'santos laguna', 'santos': 'santos laguna', 'juarez': 'fc juarez', 'bravos': 'fc juarez', 'esmeraldas': 'leon', 'rayos': 'necaxa', 'camoteros': 'puebla', 'tigres': 'tigres uanl', 'pumas': 'pumas unam', 'aguilas': 'america', 'club america': 'america'};
  const nm = s => { let x = deacc(s).replace(/[^a-z ]/g, ' ').replace(/\b(fc|cf|club|de futbol)\b/g, ' ').replace(/\s+/g, ' ').trim(); return ALIAS[x] ? deacc(ALIAS[x]).replace(/\b(fc)\b/g, ' ').trim() : x; };
  const book = new Map(); const bk = arg('--book');
  if (bk) for (const pair of bk.split(',')) { const m = pair.trim().match(/^(.*?):\s*([+-]?\d+)$/); if (!m) continue; const w = nm(m[1]);
    const id = tab.map(r => r.id).find(i => { const b = nm(NM.get(i)); return b === w || b.includes(w) || w.includes(b); }); if (id) book.set(id, +m[2]); else console.log(`(book: no club matched "${m[1]}")`); }
  const dec = am => am > 0 ? 1 + am / 100 : 1 + 100 / -am;
  console.log(`Liga MX title odds -- ${tName(t.key)}, matches through ${today} · regular phase ${S.regPlayed}/${t.reg.length} played (${pct}%) · format ${fmt} · stage: ${stage}${frozen ? ` · odds FROZEN at the start of the liguilla (${t.firstPost}) -- never bet within the playoffs${t.champ ? ` · CHAMPION: ${NM.get(t.champ)}` : ''}` : stage === 'bracket' ? ' · liguilla set, not started (betting window open)' : ''}`);
  if (stage === 'preseason') console.log(`(preseason: odds from carried-over ratings, an UNTESTED stage; tiers/index = ${tName(PT.key)} at the start of its liguilla)`);
  console.log(`model: half-life ${P.half} d, shrink ${P.k}, draws +${Math.round(P.rho * 100)}%, home edge x${M.H.toFixed(2)} · ${N} sims · prices: ${bk ? 'pasted screenshot (--book)' : 'none (post a DraftKings, else FanDuel, screenshot and rerun with --book)'}`);
  console.log(`TIERS -- every-champion profile (${CP.length} champions, each cutoff = the loosest one): ${FEATS.map((f, i) => cutLabel(f, cuts[i], v => fmtV(f.k, v))).join(' · ')}`);
  console.log(`index (0-100) = ${Object.entries(IDXW).map(([k, w]) => `${k} ${w}`).join(' · ')}\n`);
  const shown = tab.filter(r => (T.get(r.id) || 0) >= 0.0005 || book.has(r.id) || stage === 'preseason').map(r => r.id);
  for (const s of [5, 4, 3, 2, 1]) {
    const L = shown.filter(id => { const sc = pr.get(id)?.score ?? 0; return s === 1 ? sc <= 1 : sc === s; }).sort((a, b) => (T.get(b) || 0) - (T.get(a) || 0));
    if (!L.length) continue; console.log(TIER_NAME(s));
    for (const id of L) { const r = pr.get(id), b = tab.find(x => x.id === id), p = T.get(id) || 0, am = book.get(id);
      const ev = am != null ? p * dec(am) - 1 : null;
      console.log(`  ${String(NM.get(id)).padEnd(22)} #${String(stage === 'preseason' ? '-' : posOf.get(id)).padEnd(2)} ${b.w}-${b.d}-${b.l} ${String(b.pts).padStart(2)} pts${frozen ? (out.has(id) ? ' (out)   ' : ' ◀ alive ') : ''} | idx ${r ? r.idx.toFixed(1).padStart(5) : '    —'} | title ${(100 * p).toFixed(1).padStart(5)}% fair ${fairAm(p).padStart(6)}${am != null ? ` | book ${(am > 0 ? '+' : '') + am} EV ${ev >= 0 ? '+' : ''}${Math.round(100 * ev)}%` : ''}${!atBracket ? ` | liguilla ${(100 * (qual.get(id) || 0)).toFixed(0)}%` : ''} | ${r ? FEATS.map((f, i) => `${r.q[i] ? '✓' : '✗'} ${f.label} ${fmtV(f.k, r[f.k])}`).join(' · ') : ''}`); }
  }
  const rest2 = tab.filter(r => !shown.includes(r.id)).map(r => NM.get(r.id));
  if (rest2.length) console.log(`  (under 0.05%: ${rest2.join(', ')})`);
  if (arg('--export')) {
    const o = {league: 'ligamx', tournament: tName(t.key), key: t.key, generated: new Date().toISOString(), today, stage, format: fmt, first_liguilla: t.firstPost, champion: t.champ ? NM.get(t.champ) : null, sims: N, games_left: S.left,
      home_edge: +M.H.toFixed(3), champions: CP.length, cats: FEATS.map((f, i) => cutLabel(f, cuts[i], v => fmtV(f.k, v))), labels: FEATS.map(f => f.label),
      teams: tab.map(b => { const r = pr.get(b.id); return {id: b.id, name: NM.get(b.id), pos: posOf.get(b.id), gp: b.gp, w: b.w, d: b.d, l: b.l, pts: b.pts, gd: b.gf - b.ga, p: T.get(b.id) || 0, pliguilla: qual.get(b.id) || 0,
        alive: frozen ? !out.has(b.id) && (seeds || []).includes(b.id) : null, score: r ? r.score : 0, q: r ? r.q : FEATS.map(() => false), vals: FEATS.map(f => r ? fmtV(f.k, r[f.k]) : '—'), idx: r ? +r.idx.toFixed(1) : null, book: book.get(b.id) ?? null}; })};
    fs.writeFileSync(arg('--export'), JSON.stringify(o)); console.log('\nexported -> ' + arg('--export'));
  }
  if (rest.includes('--log')) {
    const file = `${ROOT}/ligamx-history.md`, head = `# Liga MX Title Blueprint — Run History\n\nEach run prepends a dated snapshot (engine: baseball-blueprint/pro/ligamx.mjs).\n\n---\n\n`;
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : head, i = old.indexOf('---\n\n');
    let body = i >= 0 ? old.slice(i + 5) : ''; if (body.startsWith(`## ${today} `)) { const nx = body.indexOf('\n## '); body = nx >= 0 ? body.slice(nx + 1) : ''; }
    const top = [...T].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const entry = `## ${today} (${tName(t.key)}, ${stage}${frozen ? ', odds frozen at the start of the liguilla' : ''}${t.champ ? `, champion ${NM.get(t.champ)}` : ''})\n\n${top.map(([id, p]) => `- ${NM.get(id)} ${pr.get(id) ? pr.get(id).score + '/5 · ' : ''}${(100 * p).toFixed(1)}% (fair ${fairAm(p)})${book.has(id) ? ` · book ${book.get(id) > 0 ? '+' : ''}${book.get(id)}` : ''}`).join('\n')}\n\n`;
    fs.writeFileSync(file, i >= 0 ? old.slice(0, i + 5) + entry + body : old + entry); console.log('\nlogged to ' + file);
  }
}
