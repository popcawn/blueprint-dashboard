// A-League Men title engine (built 2026-11-24). Data: ESPN soccer scoreboards (aus.1), fetched by calendar year and grouped by ESPN's
// season.year (= the season's START year: 2025 = the 2025-26 season). 2005-06 (the first A-League season) on.
// Model (copied from soccer.mjs, NOT shared with it -- soccer.mjs is the live site's MLS/NWSL engine): Poisson goals -- attack x defence x
// home edge, recency-weighted, shrunk toward average (k pseudo-games), plus a draw-inflation term. Knockout draws go to extra time
// (30 min of the same rates), then penalties (coin flip); two-legged ties are decided on aggregate (no away goals), then extra time
// in the 2nd leg, then penalties.
// Season sim: the rest of the regular season, score by score -> ladder (3 pts a win; points, goal difference, goals for) -> the finals
// series in THAT season's format (see FMT). NO KALSHI / Polymarket; no odds feed has A-League futures -> prices only from the user's
// DraftKings/FanDuel screenshot via --book.
//   node aleague.mjs check                 data audit per season + the rewind proof (BP_TODAY turns every later match into an unplayed fixture)
//   node aleague.mjs backtest              match + finals-tie + title (finals start and 75% of the regular season) backtests, tuned on the 1st half
//   node aleague.mjs dump                  every team's end-of-regular-season profile -> study/data/aleague.json (study/criteria.mjs)
//   node aleague.mjs [live] [--log] [--book "Sydney FC:+400,Auckland FC:+350,..."] [--export file.json] [--sims N]
//   BP_TODAY=YYYY-MM-DD rewinds everything (standings, games left, stage, ratings) to that date.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {TIER_NAME, rankRows, cutoffs as tierCuts, score as tierScore, cutLabel} from './tiers.mjs';

const CACHE = path.join(os.tmpdir(), 'pro_bp_cache', 'aleague'); fs.mkdirSync(CACHE, {recursive: true});
// tuned settings (= what `backtest` picked on the 1st half, 2005-06..2015-16, and wrote to params.json). The fallback MUST equal them.
const TUNED = {half: 120, k: 15, rho: 0};
const loadP = () => { const f = path.join(CACHE, 'params.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : TUNED; };
const realToday = new Date().toLocaleDateString('en-CA');
const today = process.env.BP_TODAY || realToday;
const FIRST = 2005;
const [mode0 = 'live', ...rest] = process.argv.slice(2);
const mode = mode0.startsWith('--') ? 'live' : mode0; if (mode0.startsWith('--')) rest.unshift(mode0);
const arg = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
const addDay = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const lab = Y => `${Y}-${String((Y + 1) % 100).padStart(2, '0')}`;   // season label from the start year
async function getJson(u) { for (let a = 0; a < 5; a++) { try { const r = await fetch(u, {signal: AbortSignal.timeout(30e3)}); if (r.ok) { const t = await r.text(); return t.trim() ? JSON.parse(t) : null; } if (r.status === 404) return null; } catch {} await sleep(800 * (a + 1)); } throw new Error('fetch failed ' + u); }

// ---------------------------------------------------------------- history / format eras (documented in aleague-history.md + the command file)
// Finals formats (start year of the season):
//   page4  2005-08: top 4, Page playoff. Major semi 1v2 and minor semi 3v4 over two legs (higher seed hosts leg 2); preliminary final =
//          major-semi loser hosts minor-semi winner; Grand Final hosted by the major-semi winner (2007-08 GF at the Sydney Football Stadium = neutral).
//   page6L 2009-10: top 6. Elimination finals 3v6 / 4v5; major semi 1v2 over two legs; minor semi = the EF winners (higher seed hosts);
//          preliminary final = major loser hosts minor winner; GF hosted by the major winner.
//   page6  2011: as page6L but the major semi is one match (1 hosts 2).
//   six    2012-20: EF 3v6 / 4v5; semis 1 v lowest surviving seed, 2 v the other (top seeds host); GF hosted by the higher seed.
//          2012-13 GF at Allianz Stadium (neither club's ground) = neutral. 2019-20 (COVID): the season stopped in March 2020 and finished in a
//          Sydney hub; every final was played at Bankwest/CommBank Stadium = neutral.
//   six2   2021-: EF single matches; semis over two legs (higher seed hosts leg 2); GF hosted by the higher seed -- except 2022-23, when the
//          APL had sold the Grand Final to Sydney (the "GF venue controversy"): CCM v Melbourne City at CommBank Stadium = neutral. The deal was
//          dropped after that one season and the GF went back to the higher seed (CCM hosted 2023-24, Auckland 2025-26).
const FMT = Y => Y <= 2008 ? 'page4' : Y <= 2010 ? 'page6L' : Y === 2011 ? 'page6' : Y <= 2020 ? 'six' : 'six2';
const NF = Y => FMT(Y) === 'page4' ? 4 : 6;
const GF_NEUTRAL = new Set([2007, 2012, 2022]), ALL_FINALS_NEUTRAL = new Set([2019]);
// clubs barred from the finals: 2014-15 Perth Glory (3rd on the ladder, thrown out of the finals for salary-cap breaches; 7th-placed Brisbane went in)
const FINALS_BAN = {2014: ['5322']};
const seedsOf = (reg, Y) => ladder([...table(reg).values()]).filter(t => !(FINALS_BAN[Y] || []).includes(t.id)).slice(0, NF(Y)).map(t => t.id);
// ESPN files some finals under the regular-season slug: 2005-06 (all six finals), 2007-08 (both semi first legs), 2011-12 (both EFs and both
// semis). Every match on/after this date (UTC) is a final.
const REG_END = {2005: '2006-02-07', 2007: '2008-01-23', 2011: '2012-03-27'};
// Champions (Grand Final winners). ESPN can't be trusted for these: the 2009-10 GF (Sydney won on penalties) has no winner, the 2010-11 GF note
// names the wrong club (Brisbane won 4-2 on penalties), and some GFs are labelled 'preliminary-final' / 'finals---week-1'. `check` compares
// each with ESPN. Seasons after 2025-26 are read from ESPN's 'grand-final' match.
const CHAMPS = {2005: '5327', 2006: '5328', 2007: '5323', 2008: '5328', 2009: '5327', 2010: '5326', 2011: '5326', 2012: '5325', 2013: '5326', 2014: '5328',
  2015: '5321', 2016: '5327', 2017: '5328', 2018: '5327', 2019: '5327', 2020: '11143', 2021: '20086', 2022: '5325', 2023: '5325', 2024: '11143', 2025: '22344'};
// renamed clubs: ESPN keeps one id per club and shows today's name (Melbourne Heart 2010-14 = id 11143 "Melbourne City FC"). Defunct clubs keep
// their own ids (NZ Knights 5324 -> Wellington Phoenix 8352 is a NEW club, not merged; Gold Coast United 10502, North Queensland Fury 10501).
// Sydney FC (5327) and Western Sydney Wanderers (13696) are different clubs. ALIAS maps any id ESPN may split a club into -> one key.
const ALIAS = {};

// ---------------------------------------------------------------- data
async function calYear(cY) {
  const f = path.join(CACHE, `cal${cY}.json`);
  const fresh = fs.existsSync(f) && (fs.statSync(f).mtimeMs > Date.parse(`${cY + 1}-01-08T00:00:00Z`) || Date.now() - fs.statSync(f).mtimeMs < 6 * 3600e3);
  if (fresh) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const j = await getJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/aus.1/scoreboard?dates=${cY}&limit=1000`);
  const ev = j?.events || []; fs.writeFileSync(f, JSON.stringify(ev)); return ev;
}
const isFinalSlug = s => !/regular|australian-a-league/i.test(s || '');
async function loadAll() {
  const ev = []; const last = +realToday.slice(0, 4) + 1;
  for (let cY = FIRST; cY <= last; cY++) ev.push(...await calYear(cY));
  const S = {}, seen = new Set();
  for (const e of ev) {
    if (seen.has(e.id)) continue; seen.add(e.id);
    const c = (e.competitions || [])[0]; if (!c) continue;
    const H = c.competitors.find(x => x.homeAway === 'home'), A = c.competitors.find(x => x.homeAway === 'away'); if (!H || !A) continue;
    const st = c.status?.type?.name || '', Y = +e.season?.year;
    const fin = !!c.status?.type?.completed || (/SUSPENDED/.test(st) && H.score !== '' && H.score != null);   // 2014-15 Brisbane v Wellington (suspended, result stood)
    const d = (e.date || '').slice(0, 10), id = h => ALIAS[h] || h;
    const g = {id: e.id, Y, d, t: e.date, h: id(String(H.team.id)), a: id(String(A.team.id)), hn: H.team.displayName, an: A.team.displayName, st, slug: e.season?.slug || '',
      hs: fin ? +H.score : null, as: fin ? +A.score : null, hp: fin && H.shootoutScore != null ? +H.shootoutScore : null, ap: fin && A.shootoutScore != null ? +A.shootoutScore : null,
      hw: !!H.winner, aw: !!A.winner, fin, note: (c.notes || []).map(n => n.headline).join('; '), venue: c.venue?.fullName || '', neutral: false};
    g.fl = isFinalSlug(g.slug) || (REG_END[Y] != null && d >= REG_END[Y]);
    (S[Y] ||= []).push(g);
  }
  for (const Y in S) {
    const G = S[Y].sort((x, y) => x.t.localeCompare(y.t)), lastD = G[G.length - 1].d;
    // postponed/cancelled entries: dropped when the fixture was replayed under another id, or the season is long over (2011-12 GC v CCM never replayed)
    S[Y] = G.filter(g => !/POSTPONED|CANCEL/.test(g.st) || !(G.some(o => o !== g && o.h === g.h && o.a === g.a && o.d > g.d) || lastD < addDay(realToday, -30)));
    const F = S[Y].filter(g => g.fl);
    if (ALL_FINALS_NEUTRAL.has(+Y)) F.forEach(g => { g.neutral = true; });
    if (GF_NEUTRAL.has(+Y) && F.length) F[F.length - 1].neutral = true;
    // the Grand Final = ESPN's 'grand-final' match, else (old seasons with odd labels) the last final of a season whose champion is known.
    // Marked on the FULL data, so a rewind that drops it also drops the champion.
    const gf = F.find(g => /grand-final/.test(g.slug)) || (CHAMPS[Y] ? F[F.length - 1] : null); if (gf) gf.gf = true;
  }
  return S;
}
// winner of one finals match: score, then the shootout score (ESPN's notes/flags can be wrong, e.g. the 2010-11 GF), then the flag
const matchWinner = g => !g.fin ? null : g.hs > g.as ? g.h : g.as > g.hs ? g.a : g.hp != null && g.ap != null && g.hp !== g.ap ? (g.hp > g.ap ? g.h : g.a) : g.hw ? g.h : g.aw ? g.a : null;
// rewind (the soccer.mjs lesson: BP_TODAY must not leave later results in place): every match dated on/after asOf becomes an unplayed fixture
// (score, shootout and winner flags wiped), and finals fixtures dated on/after asOf are dropped (they were not drawn yet on that date).
const rewind = (G, asOf) => (G || []).filter(g => !(g.fl && g.d >= asOf)).map(g => g.d < asOf ? g : {...g, fin: false, hs: null, as: null, hp: null, ap: null, hw: false, aw: false});
const rewindAll = (S, asOf) => Object.fromEntries(Object.entries(S).map(([Y, G]) => [Y, rewind(G, asOf)]));
const regOf = G => G.filter(g => !g.fl);
const finOf = G => G.filter(g => g.fl);
const pool = (S, Y) => [...(S[Y - 2] || []), ...(S[Y - 1] || []), ...(S[Y] || [])];
const nameMap = S => { const n = new Map(); for (const Y of Object.keys(S).sort()) for (const g of S[Y]) { n.set(g.h, g.hn); n.set(g.a, g.an); } return n; };
// champion as known on the data passed in (rewound data: only if the Grand Final was already played)
function champOf(G, Y) {
  const F = finOf(G); if (!F.length) return null;
  const gf = F.find(g => g.gf);
  if (!gf || !gf.fin) return null;
  return CHAMPS[Y] || matchWinner(gf);
}

// ---------------------------------------------------------------- model (copied from soccer.mjs, goals only)
function fit(games, asOf, P) {
  const G = games.filter(g => g.fin && g.hs != null && g.d < asOf);
  const t0 = Date.parse(asOf + 'T12:00:00Z'), w = g => Math.pow(0.5, (t0 - Date.parse(g.d + 'T12:00:00Z')) / 864e5 / P.half);
  const T = new Set(G.flatMap(g => [g.h, g.a]));
  const a = new Map([...T].map(t => [t, 1])), d = new Map([...T].map(t => [t, 1]));
  let sw = 0, gh = 0, ga = 0;
  for (const g of G) { const x = w(g); sw += x; gh += x * g.hs; ga += x * g.as; }
  if (!sw) return {a, d, mu: 1.35, H: 1.25, rho: P.rho};
  let mu = (gh + ga) / (2 * sw), H = gh / Math.max(ga, 1e-9);
  const W = G.map(w);
  for (let it = 0; it < 40; it++) {
    const sa = new Map(), ea = new Map(), sd = new Map(), ed = new Map();
    for (const [i, g] of G.entries()) {
      const x = W[i], hf = g.neutral ? Math.sqrt(H) : H, af = g.neutral ? Math.sqrt(H) : 1;
      sa.set(g.h, (sa.get(g.h) || 0) + x * g.hs); ea.set(g.h, (ea.get(g.h) || 0) + x * mu * hf * d.get(g.a));
      sa.set(g.a, (sa.get(g.a) || 0) + x * g.as); ea.set(g.a, (ea.get(g.a) || 0) + x * mu * af * d.get(g.h));
      sd.set(g.h, (sd.get(g.h) || 0) + x * g.as); ed.set(g.h, (ed.get(g.h) || 0) + x * mu * af * a.get(g.a));
      sd.set(g.a, (sd.get(g.a) || 0) + x * g.hs); ed.set(g.a, (ed.get(g.a) || 0) + x * mu * hf * a.get(g.h));
    }
    for (const t of T) { a.set(t, ((sa.get(t) || 0) + P.k * mu) / ((ea.get(t) || 0) + P.k * mu)); d.set(t, ((sd.get(t) || 0) + P.k * mu) / ((ed.get(t) || 0) + P.k * mu)); }
    const ma = mean([...a.values()]), md = mean([...d.values()]);
    for (const t of T) { a.set(t, a.get(t) / ma); d.set(t, d.get(t) / md); }
    let ph = 0, pa = 0, nh = 0, na = 0;
    for (const [i, g] of G.entries()) { if (g.neutral) continue; const x = W[i]; ph += x * a.get(g.h) * d.get(g.a); pa += x * a.get(g.a) * d.get(g.h); nh += x * g.hs; na += x * g.as; }
    if (ph && pa) { H = (nh / ph) / (na / pa); mu = na / pa; }
  }
  return {a, d, mu, H, rho: P.rho};
}
const pois = (l, k) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };
function lambdas(M, h, a, home) {   // home: 'h' = h at home, null = neutral
  const ah = M.a.get(h) ?? 1, dh = M.d.get(h) ?? 1, aa = M.a.get(a) ?? 1, da = M.d.get(a) ?? 1, s = Math.sqrt(M.H);
  const fh = home === 'h' ? M.H : s, fa = home === 'h' ? 1 : s;
  return [M.mu * fh * ah * da, M.mu * fa * aa * dh];
}
function wdl(lh, la, rho) {
  let W = 0, D = 0, Lo = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) { const p = pois(lh, i) * pois(la, j); if (i > j) W += p; else if (i === j) D += p; else Lo += p; }
  D *= 1 + rho; const s = W + D + Lo; return [W / s, D / s, Lo / s];
}
function pAdvance(M, h, a, home) {   // one knockout match: h's chance to go through (90 min, extra time, penalties)
  const [lh, la] = lambdas(M, h, a, home), [W, D] = wdl(lh, la, M.rho), [W2, D2] = wdl(lh / 3, la / 3, 0);
  return W + D * (W2 + D2 * 0.5);
}
function diffDist(lx, ly, rho) {   // P(goals x - goals y = k), k = -10..10, draws inflated like wdl
  const D = new Float64Array(21);
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) D[i - j + 10] += pois(lx, i) * pois(ly, j);
  D[10] *= 1 + rho; const s = D.reduce((x, y) => x + y, 0); for (let k = 0; k < 21; k++) D[k] /= s; return D;
}
function pTwoLeg(M, first, second, neutral = false) {   // first hosts leg 1, second hosts leg 2 (aggregate, then ET in leg 2, then penalties)
  const [l1f, l1s] = lambdas(M, first, second, neutral ? null : 'h'), [l2s, l2f] = lambdas(M, second, first, neutral ? null : 'h');
  const D1 = diffDist(l1f, l1s, M.rho), D2 = diffDist(l2f, l2s, M.rho);
  let win = 0, tie = 0;
  for (let i = 0; i < 21; i++) for (let j = 0; j < 21; j++) { const k = (i - 10) + (j - 10), p = D1[i] * D2[j]; if (k > 0) win += p; else if (k === 0) tie += p; }
  const [We, De] = wdl(l2f / 3, l2s / 3, 0);
  return win + tie * (We + De * 0.5);
}

// ---------------------------------------------------------------- ladder + season/finals simulation
function table(reg) {
  const T = new Map();
  for (const g of reg) for (const t of [g.h, g.a]) if (!T.has(t)) T.set(t, {id: t, pts: 0, w: 0, d: 0, l: 0, gp: 0, gf: 0, ga: 0});
  for (const g of reg) { if (!g.fin || g.hs == null) continue; const H = T.get(g.h), A = T.get(g.a);
    H.gp++; A.gp++; H.gf += g.hs; H.ga += g.as; A.gf += g.as; A.ga += g.hs;
    if (g.hs > g.as) { H.pts += 3; H.w++; A.l++; } else if (g.hs < g.as) { A.pts += 3; A.w++; H.l++; } else { H.pts++; A.pts++; H.d++; A.d++; } }
  return T;
}
const ladder = rows => rows.slice().sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf || y.w - x.w);
function engine(M) {
  const m1 = new Map(), m2 = new Map();
  const adv = (h, a, neutral) => { const k = h + '|' + a + '|' + (neutral ? 'n' : 'h'); if (!m1.has(k)) m1.set(k, pAdvance(M, h, a, neutral ? null : 'h')); return m1.get(k); };
  const two = (f, s, neutral) => { const k = f + '|' + s + '|' + (neutral ? 'n' : 'h'); if (!m2.has(k)) m2.set(k, pTwoLeg(M, f, s, neutral)); return m2.get(k); };
  return {adv, two, one: (host, guest, neutral) => Math.random() < adv(host, guest, neutral) ? host : guest, legs: (f, s, neutral) => Math.random() < two(f, s, neutral) ? f : s};
}
// seeds = finals teams in ladder order; returns the champion
function finalsSim(seeds, E, Y) {
  const fmt = FMT(Y), nA = ALL_FINALS_NEUTRAL.has(Y), nGF = nA || GF_NEUTRAL.has(Y), rank = id => seeds.indexOf(id);
  const hi = (x, y) => rank(x) < rank(y) ? [x, y] : [y, x];
  const gf = (x, y) => { const [h, a] = hi(x, y); return E.one(h, a, nGF); };
  if (fmt === 'page4') {
    const [s1, s2, s3, s4] = seeds, maj = E.legs(s2, s1, nA), majL = maj === s1 ? s2 : s1, mnr = E.legs(s4, s3, nA), pf = E.one(majL, mnr, nA);
    return E.one(maj, pf, nGF);   // the major-semi winner hosts the GF
  }
  const [s1, s2, s3, s4, s5, s6] = seeds, e1 = E.one(s3, s6, nA), e2 = E.one(s4, s5, nA);
  if (fmt === 'page6L' || fmt === 'page6') {
    const maj = fmt === 'page6L' ? E.legs(s2, s1, nA) : E.one(s1, s2, nA), majL = maj === s1 ? s2 : s1;
    const [mh, ma] = hi(e1, e2), mnr = E.one(mh, ma, nA), pf = E.one(majL, mnr, nA);
    return E.one(maj, pf, nGF);
  }
  const [up, lo] = hi(e1, e2);   // up = the higher surviving seed (plays 2), lo = the lower (plays 1)
  const f1 = fmt === 'six2' ? E.legs(lo, s1, nA) : E.one(s1, lo, nA), f2 = fmt === 'six2' ? E.legs(up, s2, nA) : E.one(s2, up, nA);
  return gf(f1, f2);
}
const rpois = l => { let k = 0, p = Math.exp(-l), s = p; const u = Math.random(); while (u > s && k < 15) { k++; p *= l / k; s += p; } return k; };
// title odds: simulate the regular-season matches still to play (unless fixedSeeds), then the finals. Returns Map id -> p (+ .top6, .minor)
function simulate(M, reg, Y, N = 20000, fixedSeeds = null) {
  const base = table(reg), left = reg.filter(g => !g.fin), E = engine(M), cup = new Map(), top = new Map(), minor = new Map(), nf = NF(Y);
  const lam = new Map(left.map(g => [g, lambdas(M, g.h, g.a, g.neutral ? null : 'h')]));
  for (let s = 0; s < N; s++) {
    let seeds = fixedSeeds;
    if (!seeds) {
      const T = new Map([...base].map(([k, v]) => [k, {...v}]));
      for (const g of left) { const [lh, la] = lam.get(g), x = rpois(lh), y = rpois(la), H = T.get(g.h), A = T.get(g.a);
        H.gf += x; H.ga += y; A.gf += y; A.ga += x; if (x > y) { H.pts += 3; H.w++; } else if (x < y) { A.pts += 3; A.w++; } else { H.pts++; A.pts++; } }
      seeds = ladder([...T.values()]).filter(t => !(FINALS_BAN[Y] || []).includes(t.id)).slice(0, nf).map(t => t.id);
    }
    minor.set(seeds[0], (minor.get(seeds[0]) || 0) + 1);
    for (const t of seeds) top.set(t, (top.get(t) || 0) + 1);
    const ch = finalsSim(seeds, E, Y); cup.set(ch, (cup.get(ch) || 0) + 1);
  }
  const out = new Map([...cup].map(([k, v]) => [k, v / N])); out.top = new Map([...top].map(([k, v]) => [k, v / N])); out.minor = new Map([...minor].map(([k, v]) => [k, v / N]));
  return out;
}

// ---------------------------------------------------------------- champion profile (tiers / index / dump)
// every-champion rule (study/criteria.mjs aleague on `dump`, 2026-11-24): all 21 champions 2005-06..2025-26 cleared all 5 at the end of the
// regular season; ~2.0 of the ~5.6 finals teams do. Honest test (search + cutoffs re-run without each season): the hidden champion cleared
// all 5 in 15/21 (9/11 | 6/10), and as a predictor it beat a coin flip over the field in the 1st half (1.25 vs 1.64) but LOST in the 2nd
// (2.15 vs 1.79) -> tiers are CONTEXT ONLY (like Super League / AFL); the odds come from the simulation.
// Misses: 2007-08 Newcastle, 2008-09 Victory, 2017-18 Victory, 2020-21 City, 2022-23 CCM, 2025-26 Auckland.
const FEATS = [
  {k: 'att', dir: 1, kind: 'value', label: 'Attack rating'},
  {k: 'def', dir: -1, kind: 'value', label: 'Defence rating'},
  {k: 'ga', dir: -1, kind: 'value', label: 'Goals against/game'},
  {k: 'wpct', dir: 1, kind: 'value', label: 'Win%'},
  {k: 'lpct', dir: -1, kind: 'rank', label: 'Loss%'},
];
// index (0-100) = points per game, scaled across the league. Chosen on the 1st half in `backtest` (INDEX section: champion's rank in the
// finals field avg #1.27, #1 in 8/11), held-out 2nd half avg #2.00 (#1 4/10, top-3 9/10; random 3.5) -- the title odds' own rank was #2.10.
const IDXW = {ppg: 100};
function profile(G, pl, asOf, P) {
  const reg = regOf(G).filter(g => g.fin && g.hs != null && g.d < asOf), M = fit(pl, asOf, P), T = new Map();
  for (const g of reg) for (const [me, gf, ga, home] of [[g.h, g.hs, g.as, 1], [g.a, g.as, g.hs, 0]]) {
    const t = T.get(me) || {id: me, gp: 0, pts: 0, gd: 0, gf: 0, ga: 0, w: 0, l: 0, hp: 0, hn: 0, ap: 0, an: 0, res: []}, p = gf > ga ? 3 : gf === ga ? 1 : 0;
    t.gp++; t.gd += gf - ga; t.gf += gf; t.ga += ga; t.pts += p; if (p === 3) t.w++; if (p === 0) t.l++;
    if (home) { t.hp += p; t.hn++; } else { t.ap += p; t.an++; }
    t.res.push([g.d, p]); T.set(me, t);
  }
  const avgP = a => a.length ? a.reduce((s, x) => s + x[1], 0) / a.length : 0, s2 = Math.sqrt(M.H);
  const lad = ladder([...T.values()].map(t => ({...t, gf: t.gf, ga: t.ga})));
  const rows = lad.map((t, i) => { const s = t.res.sort((a, b) => a[0].localeCompare(b[0])), att = M.a.get(t.id) ?? 1, def = M.d.get(t.id) ?? 1;
    return {id: t.id, pos: i + 1, pts: t.pts, gp: t.gp, ppg: t.pts / t.gp, gdpg: t.gd / t.gp, att, def, form: avgP(s.slice(-8)), form5: avgP(s.slice(-5)), gf: t.gf / t.gp, ga: t.ga / t.gp,
      wpct: t.w / t.gp, lpct: t.l / t.gp, hppg: t.hn ? t.hp / t.hn : 0, appg: t.an ? t.ap / t.an : 0, str: att / def, rtg: M.mu * s2 * (att - def)}; });
  return {rows: rankRows(rows, FEATS), M};
}
function addIndex(rows, W = IDXW) {
  const N = {}, tw = Object.values(W).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(W)) { const dir = ['def', 'ga', 'lpct', 'pos'].includes(k) ? -1 : 1, v = rows.map(r => +r[k]), lo = Math.min(...v), hi = Math.max(...v);
    N[k] = r => hi === lo ? 50 : 100 * (dir > 0 ? r[k] - lo : hi - r[k]) / (hi - lo); }
  for (const r of rows) r.idx = Object.entries(W).reduce((a, [k, w]) => a + w * N[k](r), 0) / tw;
}
const firstFinal = G => finOf(G).map(g => g.d).sort()[0] || null;
const regDone = G => regOf(G).length > 0 && regOf(G).every(g => g.fin);
const finalsStartOf = G => firstFinal(G) || addDay(regOf(G).map(g => g.d).sort().pop(), 1);
const pastSeasons = S => Object.keys(CHAMPS).map(Number).filter(Y => S[Y]?.length).concat(Object.keys(S).map(Number).filter(Y => !CHAMPS[Y] && champOf(S[Y], Y)));
function champProfiles(S, P, upTo = 9999) {   // every past champion's end-of-regular-season profile (cutoffs = the loosest champion)
  return pastSeasons(S).filter(Y => Y < upTo).map(Y => { const G = S[Y], ch = champOf(G, Y); return profile(G, pool(S, Y), finalsStartOf(G), P).rows.find(r => r.id === ch); }).filter(Boolean);
}

// ---------------------------------------------------------------- the board (live + rewinds; also used by `check`)
function board(S0, asOf, P, N) {
  const S = rewindAll(S0, asOf);
  const started = Object.keys(S).map(Number).filter(Y => regOf(S[Y]).some(g => g.d < asOf)).sort((a, b) => a - b);
  let Y = started[started.length - 1] ?? FIRST, stage;
  const champ0 = champOf(S[Y], Y);
  // offseason: once the season is decided, switch to next season's draw (preseason board) when it is out in full AND its first match is within
  // 75 days -- a rewind to June must not see a draw that ESPN only published later (the A-League draw comes out around August/September)
  const nx = S[Y + 1] ? regOf(S[Y + 1]) : [], nxFirst = nx.map(g => g.d).sort()[0];
  if (champ0 && nx.length >= 0.9 * regOf(S[Y]).length && nxFirst <= addDay(asOf, 75)) { Y++; }
  const G = S[Y], reg = regOf(G), champ = champOf(G, Y), finPlayed = finOf(G).some(g => g.fin), regPlayed = reg.filter(g => g.fin).length;
  stage = champ ? 'done' : finPlayed ? 'finals' : regPlayed === 0 ? 'preseason' : regDone(G) ? 'bracket' : 'regular';
  const frozen = stage === 'finals' || stage === 'done', f0 = frozen || stage === 'bracket' ? finalsStartOf(G) : null;
  const seeds = frozen ? seedsOf(reg, Y) : null;
  const M = fit(pool(S, Y), frozen ? f0 : asOf, P), T = simulate(M, reg, Y, N, seeds);
  // tiers/index: this season's profile as of today (at the finals start once they begin); preseason = last season's end of the regular season
  let PY = Y, pAsOf = frozen ? f0 : asOf;
  if (stage === 'preseason' && S[Y - 1]?.length) { PY = Y - 1; pAsOf = finalsStartOf(S[Y - 1]); }
  const {rows} = profile(S[PY], pool(S, PY), pAsOf, P);
  const TS = champProfiles(S, P, Y), cuts = tierCuts(TS, FEATS, 1);
  for (const r of rows) tierScore(r, FEATS, cuts);
  addIndex(rows);
  // who is still alive in the finals (frozen boards only)
  const alive = new Set(seeds || []);
  if (frozen) { const F = finOf(G).filter(g => g.fin), used = new Set(), twoLeg = g => /1st Leg/i.test(g.note) || (FMT(Y) === 'six2' && /semi/i.test(g.slug));
    for (const g of F) { if (used.has(g)) continue; used.add(g);
      const back = F.find(o => !used.has(o) && o.h === g.a && o.a === g.h && o.d > g.d && o.d <= addDay(g.d, 10));
      let w = null;
      if (back) { used.add(back); const ag = g.hs + back.as, bg = g.as + back.hs; w = ag > bg ? g.h : bg > ag ? g.a : matchWinner(back); }
      else if (!twoLeg(g)) w = matchWinner(g);   // a first leg whose second leg isn't played yet eliminates nobody
      const lo = w ? (w === g.h ? g.a : g.h) : null;
      if (lo && !(FMT(Y).startsWith('page') && [g.h, g.a].every(t => seeds.indexOf(t) <= 1))) alive.delete(lo);   // Page playoff: the major-semi loser gets a 2nd chance
    }
    if (champ) { alive.clear(); alive.add(champ); } }
  const totalReg = reg.length, pctPlayed = totalReg ? regPlayed / totalReg : 0;
  return {S, Y, stage, frozen, f0, seeds, M, T, rows, cuts, TS, champ, reg, regPlayed, totalReg, pctPlayed, PY, alive, lad: ladder([...table(reg).values()])};
}

// ---------------------------------------------------------------- modes
const S0 = await loadAll();
const NAMES = nameMap(S0);
const nm = id => NAMES.get(id) || id;
const fair = p => p < 0.0005 ? '—' : p >= 0.5 ? '-' + Math.round(100 * p / (1 - p)) : '+' + Math.round(100 * (1 - p) / p);
const LLf = p => -Math.log(Math.max(p, 1e-4));

if (mode === 'check') {
  console.log('A-League Men data audit (ESPN aus.1; season = start year)\n');
  for (const Y of Object.keys(S0).map(Number).sort((a, b) => a - b)) {
    const G = S0[Y], reg = regOf(G), F = finOf(G), T = table(reg), lad = ladder([...T.values()]), gps = [...T.values()].map(t => t.gp);
    const field = new Set(F.flatMap(g => [g.h, g.a])), seeds = seedsOf(reg, Y), ch = champOf(G, Y), gfW = F.length ? matchWinner(F[F.length - 1]) : null;
    const seedOK = !F.length || (seeds.every(t => field.has(t)) && field.size === seeds.length);
    console.log(`${lab(Y)} [${FMT(Y)}] ${T.size} teams · reg ${reg.length} (${reg.filter(g => g.fin).length} played, gp ${Math.min(...gps)}-${Math.max(...gps)}) ${reg[0]?.d}..${reg[reg.length - 1]?.d}` +
      ` · finals ${F.length} [${[...new Set(F.map(g => g.slug))].join(',')}]${REG_END[Y] ? ` (incl. ${F.filter(g => !isFinalSlug(g.slug)).length} ESPN filed as regular season)` : ''}` +
      ` · premiers ${nm(lad[0]?.id)}${ch ? ` · champion ${nm(ch)} (seed ${seeds.indexOf(ch) + 1})` : ''}${CHAMPS[Y] && gfW !== CHAMPS[Y] ? ` · ESPN's last final says ${gfW ? nm(gfW) : 'no winner'} -> hard-coded champion used` : ''}${seedOK ? '' : ' · !! finals teams != ladder top ' + NF(Y)}`);
  }
  // ---- rewind proof
  console.log('\nREWIND PROOF (every match on/after the as-of date must become an unplayed fixture: standings, games left, stage, champion)');
  const P = loadP(); let bad = 0;
  const truth = (Y, asOf) => { const reg = regOf(S0[Y]), pl = reg.filter(g => g.fin && g.d < asOf); return {played: pl.length, left: reg.length - pl.length, pts: ladder([...table(pl.concat(reg.filter(g => !(g.fin && g.d < asOf)).map(g => ({...g, fin: false})))).values()])}; };
  for (const asOf of ['2026-02-15', '2026-04-28', '2026-05-12', '2026-05-20', '2026-07-01', '2025-03-01', '2023-05-10', '2020-03-20', '2026-11-01']) {
    const B = board(S0, asOf, P, 2000), tr = truth(B.Y, asOf), Sx = B.S;
    const leak = Object.values(Sx).flat().filter(g => g.d >= asOf && (g.fin || g.hs != null || g.hp != null || g.hw || g.aw)).length;
    const finLeak = Object.values(Sx).flat().filter(g => g.fl && g.d >= asOf).length;
    const sameTable = JSON.stringify(B.lad.map(t => [t.id, t.pts, t.gp, t.gf - t.ga])) === JSON.stringify(tr.pts.map(t => [t.id, t.pts, t.gp, t.gf - t.ga]));
    const ok = !leak && !finLeak && sameTable && B.regPlayed === tr.played && B.totalReg - B.regPlayed === tr.left;
    if (!ok) bad++;
    const top = [...B.T].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, p]) => `${nm(id)} ${(100 * p).toFixed(0)}%`).join(', ');
    console.log(`  as of ${asOf}: season ${lab(B.Y)} stage ${B.stage.padEnd(9)} played ${B.regPlayed}/${B.totalReg} (truth ${tr.played}, left ${tr.left}) · leaders ${B.lad.slice(0, 2).map(t => `${nm(t.id)} ${t.pts}`).join(', ')} · results after the date left in: ${leak} · finals fixtures after the date: ${finLeak} · table = truth: ${sameTable ? 'yes' : 'NO'} · champion known: ${B.champ ? nm(B.champ) : 'no'} | top: ${top} -> ${ok ? 'OK' : 'FAIL'}`);
  }
  // the 75% backtest checkpoint uses the same rewind(): spot-check one season
  { const Y = 2024, ds = regOf(S0[Y]).map(g => g.d).sort(), d75 = ds[Math.floor(0.75 * ds.length)], G = rewind(S0[Y], d75), r = regOf(G);
    console.log(`  backtest 75% checkpoint ${lab(Y)} (${d75}): ${r.filter(g => g.fin).length}/${r.length} regular games kept as played, ${finOf(G).length} finals fixtures kept, champion known: ${champOf(G, Y) ? 'yes' : 'no'}`); }
  console.log(bad ? `\n${bad} REWIND CHECK(S) FAILED` : '\nall rewind checks passed');
  process.exit(bad ? 1 : 0);
}

if (mode === 'dump') {   // input for study/criteria.mjs
  const P = loadP(), K = ['pos', 'ppg', 'gdpg', 'att', 'def', 'form', 'form5', 'gf', 'ga', 'wpct', 'lpct', 'hppg', 'appg', 'str', 'rtg'];
  const out = {sport: 'aleague', label: 'A-League Men title', when: 'end of the regular season (start of the finals)', fieldLabel: 'the finals teams (top 4 to 2008-09, top 6 since)', universeLabel: 'every A-League team',
    cands: [{k: 'pos', dir: -1, label: 'Ladder position', value: true, rank: false, dec: 0}, {k: 'ppg', dir: 1, label: 'Points/game', value: true}, {k: 'gdpg', dir: 1, label: 'Goal diff/game', value: true},
      {k: 'att', dir: 1, label: 'Attack rating', value: true}, {k: 'def', dir: -1, label: 'Defence rating', value: true}, {k: 'form', dir: 1, label: 'Form (pts/g, last 8)', value: true},
      {k: 'form5', dir: 1, label: 'Form (pts/g, last 5)', value: true}, {k: 'gf', dir: 1, label: 'Goals for/game', value: true}, {k: 'ga', dir: -1, label: 'Goals against/game', value: true},
      {k: 'wpct', dir: 1, label: 'Win%', value: true}, {k: 'lpct', dir: -1, label: 'Loss%', value: true}, {k: 'hppg', dir: 1, label: 'Home pts/game', value: true},
      {k: 'appg', dir: 1, label: 'Away pts/game', value: true}, {k: 'str', dir: 1, label: 'Overall rating (att/def)', value: true}, {k: 'rtg', dir: 1, label: 'Goal-diff rating', value: true}],
    seasons: []};
  for (const Y of pastSeasons(S0)) {
    const G = S0[Y], ch = champOf(G, Y), {rows} = profile(G, pool(S0, Y), finalsStartOf(G), P);
    out.seasons.push({Y: Y + 1, champ: ch, champName: nm(ch), field: seedsOf(regOf(G), Y), rows: rows.map(r => Object.fromEntries([['id', r.id], ['name', nm(r.id)], ...K.map(k => [k, r[k]])]))});
  }
  fs.mkdirSync('C:/Users/User/baseball-blueprint/study/data', {recursive: true});
  fs.writeFileSync('C:/Users/User/baseball-blueprint/study/data/aleague.json', JSON.stringify(out));
  console.log(`dumped ${out.seasons.length} seasons -> study/data/aleague.json (Y = the season's END year) · ` + out.seasons.map(s => `${s.Y} ${s.champName} (#${s.rows.find(r => r.id === s.champ).pos})`).join(', '));
  process.exit(0);
}

if (mode === 'backtest') {
  const S = S0, done = pastSeasons(S).filter(Y => CHAMPS[Y]), half = Math.ceil(done.length / 2), H1 = done.slice(0, half), H2 = done.slice(half);
  const hl = Ys => `${lab(Ys[0])}..${lab(Ys[Ys.length - 1])}`;
  console.log(`A-League Men backtest -- ${done.length} seasons ${hl(done)} · 1st half ${hl(H1)} (tuning) · 2nd half ${hl(H2)} (held out)\n`);
  // 1. regular-season matches, refit before each week
  const weekOf = d => { const t = Date.parse(d + 'T12:00:00Z'); return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10); };
  const fitCache = new Map();
  const fitsFor = (P, Y) => { const key = P.half + '|' + P.k + '|' + Y; if (!fitCache.has(key)) { const F = new Map(); for (const wk of [...new Set(regOf(S[Y]).filter(g => g.fin).map(g => weekOf(g.d)))]) F.set(wk, fit(pool(S, Y), wk, P)); fitCache.set(key, F); } return fitCache.get(key); };
  const evalM = (P, Ys) => { const out = []; for (const Y of Ys) { const F = fitsFor(P, Y);
    for (const g of regOf(S[Y]).filter(g => g.fin)) { const M = {...F.get(weekOf(g.d)), rho: P.rho}, [W, D, Lo] = wdl(...lambdas(M, g.h, g.a, g.neutral ? null : 'h'), P.rho); out.push({Y, p: g.hs > g.as ? W : g.hs === g.as ? D : Lo, r: g.hs > g.as ? 0 : g.hs === g.as ? 1 : 2}); } }
    return out; };
  let best = null;
  for (const hf of [60, 120, 240, 365, 100000]) for (const k of [1, 3, 6, 10, 15, 20, 30]) for (const rho of [0, 0.08, 0.16]) { const P = {half: hf, k, rho}, ll = mean(evalM(P, H1).map(x => LLf(x.p))); if (!best || ll < best.ll) best = {P, ll}; }
  const P = best.P, A1 = evalM(P, H1), A2 = evalM(P, H2);
  const base = (rs, from) => { const f = [0, 1, 2].map(k => from.filter(x => x.r === k).length / from.length); return mean(rs.map(x => LLf(f[x.r]))); };
  console.log(`MATCHES (regular season, refit weekly on everything before): tuned on the 1st half -> half-life ${P.half >= 1e5 ? 'none' : P.half + ' d'}, shrink ${P.k} games, draws +${Math.round(P.rho * 100)}%`);
  console.log(`  1st half (tuned)    ${A1.length} matches · model LL ${mean(A1.map(x => LLf(x.p))).toFixed(4)} vs home/draw/away base rates ${base(A1, A1).toFixed(4)}`);
  console.log(`  2nd half (held out) ${A2.length} matches · model LL ${mean(A2.map(x => LLf(x.p))).toFixed(4)} vs base rates (1st-half rates) ${base(A2, A1).toFixed(4)} / (own rates, in-sample) ${base(A2, A2).toFixed(4)}`);
  // 2. finals ties (single matches + two-legged ties), model at the date of the tie
  const ties = [];
  for (const Y of done) { const F = finOf(S[Y]).filter(g => g.fin), used = new Set();
    for (const g of F) { if (used.has(g)) continue; used.add(g);
      const back = F.find(o => !used.has(o) && o.h === g.a && o.a === g.h && o.d > g.d && o.d <= addDay(g.d, 10));
      const M = fit(pool(S, Y), g.d, P);
      if (back) { used.add(back); const ag = g.hs + back.as, bg = g.as + back.hs, w = ag > bg ? g.h : bg > ag ? g.a : matchWinner(back) || (back === F[F.length - 1] ? CHAMPS[Y] : null);
        if (!w) continue; const p = pTwoLeg(M, g.h, g.a, g.neutral); ties.push({Y, p: w === g.h ? p : 1 - p, hostAdv: w === g.a, host: true, legs: 2}); }   // "host" of a 2-leg tie = the leg-2 host
      else { const isGF = g === F[F.length - 1], w = isGF && CHAMPS[Y] ? CHAMPS[Y] : matchWinner(g); if (!w) continue; const p = pAdvance(M, g.h, g.a, g.neutral ? null : 'h'); ties.push({Y, p: w === g.h ? p : 1 - p, hostAdv: w === g.h, host: !g.neutral, legs: 1}); } } }
  const tl = (Ys) => { const r = ties.filter(t => Ys.includes(t.Y)), hr = Y => { const o = ties.filter(t => t.Y !== Y && t.host); return o.filter(t => t.hostAdv).length / o.length; };
    return {n: r.length, m: mean(r.map(t => LLf(t.p))), h: mean(r.map(t => t.host ? LLf(t.hostAdv ? hr(t.Y) : 1 - hr(t.Y)) : Math.log(2)))}; };
  { const a = tl(done), b = tl(H1), c = tl(H2), hr = ties.filter(t => t.host && t.hostAdv).length / ties.filter(t => t.host).length;
    console.log(`\nFINALS TIES (${a.n}; host = the home side / leg-2 host advanced ${(100 * hr).toFixed(0)}%): model LL ${a.m.toFixed(3)} vs "host advances" (other seasons' rate) ${a.h.toFixed(3)} vs coin 0.693`);
    console.log(`  1st half ${b.n} ties · model ${b.m.toFixed(3)} vs host ${b.h.toFixed(3)} | 2nd half ${c.n} ties · model ${c.m.toFixed(3)} vs host ${c.h.toFixed(3)}`); }
  // 3. title odds at the start of the finals (actual seeds) and at 75% of the regular season (everything after rewound to fixtures)
  const NS = +(arg('--sims') || 20000), titles = [];
  for (const Y of done) {
    const G = S[Y], reg = regOf(G), ch = CHAMPS[Y], f0 = finalsStartOf(G), lad = ladder([...table(reg).values()]), seeds = seedsOf(reg, Y);
    const Tf = simulate(fit(pool(S, Y), f0, P), reg, Y, NS, seeds);
    const ds = reg.map(g => g.d).sort(), d75 = ds[Math.floor(0.75 * ds.length)], S75 = rewindAll(S, d75), reg75 = regOf(S75[Y]);
    const T75 = simulate(fit(pool(S75, Y), d75, P), reg75, Y, Math.round(NS / 2));
    const lad75 = ladder([...table(reg75).values()]), pos75 = lad75.findIndex(t => t.id === ch) + 1;
    const rk = (T, id, ids) => 1 + ids.filter(x => x !== id && (T.get(x) || 0) > (T.get(id) || 0)).length;
    const {rows} = profile(G, pool(S, Y), f0, P);
    titles.push({Y, ch, seed: seeds.indexOf(ch) + 1, nf: NF(Y), nT: lad.length, p: Tf.get(ch) || 0, r: rk(Tf, ch, seeds), top1: seeds.reduce((b, x) => (Tf.get(x) || 0) > (Tf.get(b) || 0) ? x : b),
      p75: T75.get(ch) || 0, r75: rk(T75, ch, lad.map(t => t.id)), pos75, nT75: lad75.length, rows: rows.filter(r => seeds.includes(r.id)), d75});
  }
  console.log(`\nTITLE ODDS -- start of the finals (actual seeds, ratings fit on games before the first final) | at 75% of the regular season (rest of the season + finals simulated)`);
  for (const t of titles) console.log(`  ${lab(t.Y)} ${nm(t.ch).padEnd(28)} seed ${t.seed}/${t.nf} | finals start ${(100 * t.p).toFixed(1).padStart(5)}% (#${t.r})${t.r === 1 ? '' : ` [#1 ${nm(t.top1)}]`} | 75% (${t.d75}) ${(100 * t.p75).toFixed(1).padStart(5)}% (#${t.r75} of ${t.nT}, ladder #${t.pos75})`);
  // seed / position history baselines: leave-one-season-out frequency of the champion's finishing position, smoothed (+0.5) and renormalised over the field
  const seedP = (t, key, n) => { const o = titles.filter(z => z.Y !== t.Y), num = o.filter(z => z[key] === t[key]).length + 0.5; let den = 0; for (let s = 1; s <= n; s++) den += o.filter(z => z[key] === s).length + 0.5; return num / den; };
  const sm = Ys => { const r = titles.filter(t => Ys.includes(t.Y));
    return {n: r.length, m: mean(r.map(t => LLf(t.p))), eq: mean(r.map(t => Math.log(t.nf))), sd: mean(r.map(t => -Math.log(seedP(t, 'seed', t.nf)))), one: r.filter(t => t.r === 1).length, top3: r.filter(t => t.r <= 3).length, avg: mean(r.map(t => t.r)),
      m75: mean(r.map(t => LLf(t.p75))), eq75: mean(r.map(t => Math.log(t.nT75))), sd75: mean(r.map(t => -Math.log(seedP(t, 'pos75', t.nT75)))), one75: r.filter(t => t.r75 === 1).length, avg75: mean(r.map(t => t.r75)),
      minor: r.filter(t => t.seed === 1).length, top2: r.filter(t => t.seed <= 2).length}; };
  const verdict = {};
  for (const [nmH, Ys] of [['ALL', done], ['1st half', H1], ['2nd half', H2]]) { const x = sm(Ys); verdict[nmH] = x;
    console.log(`  ${nmH.padEnd(9)} finals start: LL ${x.m.toFixed(3)} vs equal ${x.eq.toFixed(3)} vs seed history ${x.sd.toFixed(3)} · model #1 won ${x.one}/${x.n}, top-3 ${x.top3}/${x.n}, champ avg rank ${x.avg.toFixed(2)}` +
      ` | 75%: LL ${x.m75.toFixed(3)} vs equal ${x.eq75.toFixed(3)} vs ladder-position history ${x.sd75.toFixed(3)} · #1 won ${x.one75}/${x.n}, champ avg rank ${x.avg75.toFixed(2)} | premiers won ${x.minor}/${x.n}, top-2 ${x.top2}/${x.n}`); }
  const pass = h => verdict[h].m < verdict[h].eq && verdict[h].m < verdict[h].sd, pass75 = h => verdict[h].m75 < verdict[h].eq75 && verdict[h].m75 < verdict[h].sd75;
  console.log(`\nVERDICT RULE (finals start beats equal odds AND seed history in BOTH halves): 1st ${pass('1st half') ? '✅' : '❌'} · 2nd ${pass('2nd half') ? '✅' : '❌'} -> ${pass('1st half') && pass('2nd half') ? '🟡 fair' : '❌'}  (75% mark: 1st ${pass75('1st half') ? '✅' : '❌'} · 2nd ${pass75('2nd half') ? '✅' : '❌'})`);
  // 4. index: candidate weightings scored by the champion's rank in the finals field, chosen on the 1st half only
  const CANDW = [{str: 100}, {ppg: 100}, {gdpg: 100}, {rtg: 100}, {str: 60, ppg: 20, form: 20}, {str: 50, ppg: 50}, {str: 60, appg: 20, form: 20}, {str: 40, ppg: 20, gdpg: 20, form: 20}, {str: 60, wpct: 20, appg: 20}, {ppg: 50, form: 50}];
  const champRank = (W, Ys) => { const rr = titles.filter(t => Ys.includes(t.Y)).map(t => { const rows = t.rows.map(r => ({...r})); addIndex(rows, W); const c = rows.find(r => r.id === t.ch); return 1 + rows.filter(r => r.idx > c.idx).length; });
    return {avg: mean(rr), one: rr.filter(x => x === 1).length, top3: rr.filter(x => x <= 3).length}; };
  console.log(`\nINDEX -- champion's rank in the finals field (lower = better), weights chosen on the 1st half only`);
  let bw = null;
  for (const W of CANDW) { const a = champRank(W, H1), b = champRank(W, H2); if (!bw || a.avg < bw.a.avg - 1e-9) bw = {W, a, b};
    console.log(`  ${JSON.stringify(W).padEnd(44)} 1st half avg #${a.avg.toFixed(2)} (#1 ${a.one}/${H1.length}, top-3 ${a.top3}) | 2nd half avg #${b.avg.toFixed(2)} (#1 ${b.one}/${H2.length}, top-3 ${b.top3})`); }
  console.log(`  -> chosen on the 1st half: ${JSON.stringify(bw.W)} · held-out 2nd half avg #${bw.b.avg.toFixed(2)} · model title odds' champ avg rank 2nd half #${verdict['2nd half'].avg.toFixed(2)} · random ${(mean(titles.filter(t => H2.includes(t.Y)).map(t => (t.nf + 1) / 2))).toFixed(2)}`);
  fs.writeFileSync(path.join(CACHE, 'params.json'), JSON.stringify(P));
  process.exit(0);
}

// ---------------------------------------------------------------- live board
{
  const P = loadP(), N = +(arg('--sims') || 20000), asOf = addDay(today, 1);   // matches dated today count once final
  const B = board(S0, asOf, P, N), {Y, stage, frozen, T, rows, cuts, TS, champ, reg} = B;
  const prof = new Map(rows.map(r => [r.id, r])), curT = new Set(reg.flatMap(g => [g.h, g.a]));
  const fv = (k, v) => v == null || !isFinite(v) ? '—' : k === 'pos' ? String(Math.round(v)) : (+v).toFixed(2);
  const pct = (100 * B.pctPlayed).toFixed(0);
  console.log(`A-League Men title odds -- ${lab(Y)} season, games through ${today} · ${B.regPlayed}/${B.totalReg} regular-season games played (${pct}% of the season) · stage: ${stage}` +
    (frozen ? ` · odds FROZEN at the start of the finals (${B.f0}) -- never bet within the finals${champ ? ` · CHAMPION: ${nm(champ)}` : ''}` : stage === 'bracket' ? ' · finals field set, no final played (window open)' : ''));
  if (B.PY !== Y) console.log(`tiers/index = ${lab(B.PY)} end of the regular season (${lab(Y)} hasn't started) -- title odds are preseason (untested stage)`);
  console.log(`model: half-life ${P.half >= 1e5 ? 'none' : P.half + ' d'}, shrink ${P.k} games, draws +${Math.round(P.rho * 100)}%, home edge x${B.M.H.toFixed(2)} · ${N} sims · finals: top ${NF(Y)} (${FMT(Y)}: EF 3v6/4v5, two-legged semis, GF hosted by the higher seed)`);
  console.log(`TIERS -- every-champion profile (${TS.length} champions ${lab(FIRST)}..${lab(Y - 1)}, end of the regular season): ${FEATS.map((f, i) => cutLabel(f, cuts[i], v => fv(f.k, v))).join(' · ')}`);
  console.log(`index (0-100) = ${Object.entries(IDXW).map(([k, w]) => `${{str: 'Overall rating', ppg: 'Points/game', form: 'Form (last 8)'}[k] || k} ${w}`).join(' · ')}\n`);
  const order = B.lad.filter(t => curT.has(t.id)).sort((a, b) => (T.get(b.id) || 0) - (T.get(a.id) || 0) || (prof.get(b.id)?.idx ?? 0) - (prof.get(a.id)?.idx ?? 0));
  for (const s of [5, 4, 3, 2, 1]) {
    const L2 = order.filter(t => { const r = prof.get(t.id), sc = r ? r.score : 0; return s === 1 ? sc <= 1 : sc === s; });
    if (!L2.length) continue;
    console.log(TIER_NAME(s));
    for (const t of L2) { const p = T.get(t.id) || 0, r = prof.get(t.id), pos = B.lad.indexOf(t) + 1;
      console.log(`  ${nm(t.id).padEnd(28)} #${String(pos).padEnd(2)} ${String(t.pts).padStart(2)} pts (${t.w}-${t.d}-${t.l}, GD ${t.gf - t.ga >= 0 ? '+' : ''}${t.gf - t.ga})${frozen ? (B.alive.has(t.id) ? ' ◀ alive' : ' (out)  ') : ''} | idx ${r ? r.idx.toFixed(1).padStart(5) : '    —'} | title ${(100 * p).toFixed(1).padStart(5)}% (fair ${fair(p).padStart(6)}) | top-6 ${(100 * (T.top.get(t.id) || 0)).toFixed(0).padStart(3)}% | premiers ${(100 * (T.minor.get(t.id) || 0)).toFixed(0).padStart(3)}%` +
        (r ? ' | ' + FEATS.map((f, i) => `${r.q[i] ? '✓' : '✗'} ${f.label}`).join(' · ') : '')); }
  }
  // book prices: --book "Sydney FC:+400,Auckland:+350,..." (user's DraftKings, else FanDuel, screenshot)
  const norm = s => String(s).toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z ]/g, ' ').replace(/\b(fc|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const NICK = {wanderers: '13696', wsw: '13696', 'western sydney': '13696', mariners: '5325', ccm: '5325', 'central coast': '5325', victory: '5328', 'melbourne v': '5328', city: '11143', 'melbourne c': '11143',
    jets: '5323', newcastle: '5323', roar: '5326', brisbane: '5326', glory: '5322', perth: '5322', phoenix: '8352', wellington: '8352', bulls: '19340', macarthur: '19340', adelaide: '5321', auckland: '22344', 'western united': '20086', sydney: '5327'};
  const findTeam = w0 => { const w = norm(w0), cand = [...curT];
    const ex = cand.find(id => norm(nm(id)) === w); if (ex) return ex;
    if (NICK[w] && cand.includes(NICK[w])) return NICK[w];
    const st = cand.filter(id => norm(nm(id)).startsWith(w)); if (st.length === 1) return st[0];
    const inc = cand.filter(id => norm(nm(id)).includes(w) || w.includes(norm(nm(id)))); return inc.length === 1 ? inc[0] : null; };
  const bk = arg('--book'), bookRows = [];
  if (bk) { console.log(`\nBOOK PRICES (pasted screenshot) -- EV = model p x decimal odds - 1${frozen ? ' · finals under way: EV is vs the FROZEN start-of-finals odds, for reference only (never bet within the finals)' : ''}`);
    for (const pair of bk.split(',')) { const m = pair.trim().match(/^(.*?):\s*([+-]?\d+)$/); if (!m) continue; const am = +m[2], dec = am > 0 ? 1 + am / 100 : 1 + 100 / -am, id = findTeam(m[1]), p = id ? (T.get(id) || 0) : null;
      bookRows.push({id, am, ev: p == null ? null : p * dec - 1});
      console.log(`  ${m[1].padEnd(24)} ${m[2].padStart(6)} implied ${(100 / dec).toFixed(1).padStart(5)}% | ${id ? nm(id).padEnd(28) : 'no match'.padEnd(28)} model ${p == null ? 'n/a' : (100 * p).toFixed(1) + '% -> EV ' + (p * dec - 1 >= 0 ? '+' : '') + Math.round(100 * (p * dec - 1)) + '%'}`); } }
  else console.log('\n(no odds feed carries A-League futures -- post a DraftKings, else FanDuel, screenshot and rerun with --book "Team:+300,...")');
  if (arg('--export')) {
    const out = {league: 'aleague', label: 'A-League Men', season: Y, season_label: lab(Y), today, generated: new Date().toISOString(), stage, first_final: B.f0, champion: champ ? nm(champ) : null,
      games_played: B.regPlayed, games_total: B.totalReg, sims: N, home_edge: +B.M.H.toFixed(3), champions: TS.length, cats: FEATS.map((f, i) => cutLabel(f, cuts[i], v => fv(f.k, v))), labels: FEATS.map(f => f.label),
      teams: order.map(t => { const r = prof.get(t.id); return {id: t.id, name: nm(t.id), pos: B.lad.indexOf(t) + 1, gp: t.gp, w: t.w, d: t.d, l: t.l, pts: t.pts, gd: t.gf - t.ga, gf: t.gf, ga: t.ga, p: T.get(t.id) || 0, top6: T.top.get(t.id) || 0, minor: T.minor.get(t.id) || 0,
        alive: frozen ? B.alive.has(t.id) : null, score: r ? r.score : 0, q: r ? r.q : FEATS.map(() => false), idx: r ? +r.idx.toFixed(1) : null, str: r ? +r.str.toFixed(3) : null,
        vals: FEATS.map(f => !r ? '—' : `${fv(f.k, r[f.k])} #${r['r_' + f.k]}`)}; })};   // (2026-11-24) per-check values for the site's cards
    fs.writeFileSync(arg('--export'), JSON.stringify(out)); console.log('\nexported -> ' + arg('--export'));
  }
  if (rest.includes('--log')) {
    const file = 'C:/Users/User/baseball-blueprint/aleague-history.md';
    const head = `# A-League Men Title Blueprint — Run History\n\nEach run prepends a dated snapshot (engine: baseball-blueprint/pro/aleague.mjs). Notes on data, formats and the backtest are at the bottom.\n\n---\n\n`;
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : head, i = old.indexOf('---\n\n');   // CRLF-safe (an editor may save it with CRLF)
    let body = i >= 0 ? old.slice(i + 5) : ''; if (body.startsWith(`## ${today} `)) { const nx = body.indexOf('\n## '); body = nx >= 0 ? body.slice(nx + 1) : ''; }
    const bookOf = id => bookRows.find(b => b.id === id);
    const entry = `## ${today} (${lab(Y)}, ${stage}, ${B.regPlayed}/${B.totalReg} games = ${pct}% of the season${champ ? `, champion ${nm(champ)}` : ''}${frozen ? ', odds frozen at the start of the finals' : ''})\n\n` +
      order.slice(0, 8).map(t => { const p = T.get(t.id) || 0, r = prof.get(t.id), b = bookOf(t.id); return `- ${nm(t.id)} ${r ? r.score + '/5 · idx ' + r.idx.toFixed(0) + ' · ' : ''}${(100 * p).toFixed(1)}% (fair ${fair(p)})${b ? ` · book ${b.am > 0 ? '+' : ''}${b.am} EV ${b.ev >= 0 ? '+' : ''}${Math.round(100 * b.ev)}%` : ''}`; }).join('\n') + '\n\n';
    fs.writeFileSync(file, i >= 0 ? old.slice(0, i + 5) + entry + body : old + entry); console.log('\nlogged to ' + file);
  }
}
