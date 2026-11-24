// Rugby UNION title engine (built 2026-11-24): Super Rugby Pacific, Premiership Rugby (England), United Rugby Championship, Top 14 (France).
// Same house pattern as rugby.mjs (NRL/Super League, which stays untouched -- it is shared with the live site): recency-weighted ridge
// ratings on game margins + home edge (same region vs travelling visitor); P(home win) = Phi(margin / sigma). Season sim: remaining
// regular-season games -> ladder (4 a win, 2 a draw + bonus points) -> the league's play-off bracket for that era.
// Data: ESPN rugby (site scoreboard per calendar year + core event list per season, gaps filled from the site summary; official
// end-of-season standings from the site standings API). Cached in %TEMP%/pro_bp_cache/<lg>. No odds feed: prices only from the
// user's DraftKings/FanDuel screenshot via --book. NO KALSHI / POLYMARKET.
//   node union.mjs <superrugby|premrugby|urc|top14> check | backtest | dump | [live] [--log] [--book "Leinster:+250,..."] [--export f] [--sims N]
//   BP_TODAY=YYYY-MM-DD rewinds everything (games on/after the day after BP_TODAY become unplayed fixtures, ladder included).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {TIER_NAME, rankRows, cutoffs as tierCuts, score as tierScore, cutLabel} from './tiers.mjs';

const REG_SR = n => /crusaders|blues|chiefs|hurricanes|highlanders|moana/i.test(n) ? 'NZ' : /brumbies|waratahs|reds|force|rebels/i.test(n) ? 'AUS'
  : /jaguares/i.test(n) ? 'ARG' : /sunwolves/i.test(n) ? 'JPN' : /drua|fiji/i.test(n) ? 'FIJ' : 'RSA';
const REG_URC = n => /leinster|munster|ulster|connacht/i.test(n) ? 'IRE' : /glasgow|edinburgh/i.test(n) ? 'SCO' : /benetton|treviso|zebre|aironi/i.test(n) ? 'ITA'
  : /bulls|lions|sharks|stormers|cheetahs|kings/i.test(n) ? 'RSA' : 'WAL';
// fmt = play-off format of that season (see finals()); K = play-off games; N = play-off teams.
const FMT = {four: {K: 3, N: 4}, six: {K: 5, N: 6}, eight: {K: 7, N: 8}, top8re: {K: 7, N: 8}, sr6: {K: 5, N: 6}, sr16: {K: 7, N: 8}, sr18: {K: 7, N: 8},
  sr6ll: {K: 6, N: 6}, conf3: {K: 5, N: 6}, conf2: {K: 3, N: 4}, final2: {K: 1, N: 2}};
// neutral play-off rounds, in date order (must agree with finals())
const NEUTRAL = (fmt, Y) => fmt === 'four' ? [0, 0, L.finalNeutral(Y)] : fmt === 'six' ? [0, 0, 1, 1, 1] : fmt === 'conf3' ? [0, 0, 0, 0, 1] : fmt === 'conf2' ? [0, 0, 1] : [];
// bonus: tb = try bonus ('4' = 4+ tries, '3more' = 3+ more tries than the opponent, '3moreW' = same but winners only), lb = losing bonus margin.
// P: settings tuned by `backtest` on the first half (also written to the cache's params.json). FEATS/IDXW: from `dump` + study/criteria.mjs.
const LG = {
  superrugby: {verdict: "🟡 fair (backtest 2026-11-24): title odds at the play-off start beat equal odds and seed history in both halves (11 seasons, small sample)",
    id: 242041, label: 'Super Rugby Pacific', euro: false, first: 2014, warm: 2012, region: REG_SR,
    // 2014-15 six (3 conference winners + 3 wildcards); 2016-17 eight (4 conference winners + 3 Australasian + 1 SA wildcard, reseeded);
    // 2018-19 eight (3 conference winners + 5); 2020-21 COVID (no title on ESPN); 2022-24 top 8 reseeded; 2025+ top 6, three QFs + best-ranked loser
    fmtOf: Y => Y <= 2015 ? 'sr6' : Y <= 2017 ? 'sr16' : Y <= 2019 ? 'sr18' : Y <= 2021 ? null : Y <= 2024 ? 'top8re' : 'sr6ll',
    // 2027 (10 clubs, 16 games each): play-off format not confirmed -> assumed top 6 as in 2025-26
    gpt: Y => Y >= 2027 ? 16 : Y >= 2022 ? 14 : 16, assumed: Y => Y >= 2027, bonus: Y => ({tb: Y >= 2016 ? '3more' : '4', lb: 7}),
    // every-champion rule (study/criteria.mjs on `dump`, 2026-11-24): all 11 champions 2014-26 cleared all 5 at the end of the regular season; ~1.6 of the
    // 6-8 play-off teams do. Honest test (search re-run without each season): the hidden champion cleared all 5 in 8/11 (5/6 | 3/5); as a predictor it beat a
    // coin flip over the field in the 1st half (1.23 vs 1.98) but not the 2nd (2.15 vs 1.96) -> tiers are context; the odds come from the simulation.
    // (4-metric version 9/11, beat the coin flip in both halves: 1.23 | 1.46 vs 1.98 | 1.96.) Misses: 2015 Highlanders, 2022 + 2025 Crusaders.
    FEATS: [{k: 'pos', dir: -1, kind: 'value', label: 'Ladder position'}, {k: 'ppg', dir: 1, kind: 'rank', label: 'Ladder points/game'}, {k: 'pfpg', dir: 1, kind: 'value', label: 'Points for/game'}, {k: 'papg', dir: -1, kind: 'rank', label: 'Points against/game'}, {k: 'form8', dir: 1, kind: 'value', label: 'Form (win%, last 8)'}],
    // index = rating alone: champion's rank in the play-off field avg #1.55, #1 in 8/11; no blend beat it in both halves (rating 60/win% 40 won the 1st half, lost #1s in the 2nd)
    IDXW: {rtg: 100},
    P: {half: 240, lam: 1, sig: 16}},
  premrugby: {verdict: "❌ (backtest 2026-11-24): title odds tie/lose to 'the top-2 seed wins' history (top-2 seeds won 19/21) -- shortlist only, no bets",
    id: 267979, label: 'Premiership Rugby', euro: true, first: 2006, warm: 2004, region: () => 'ENG',
    fmtOf: Y => Y >= 2006 ? 'four' : null, finalNeutral: () => true, gpt: Y => Y >= 2024 ? 18 : Y === 2023 ? 20 : Y === 2022 ? 24 : 22,
    bonus: () => ({tb: '4', lb: 7}), deduct: {2020: [/saracens/i, -105]}, drop: {2023: /worcester|wasps/i},
    // every-champion rule (2026-11-24): all 21 champions 2006-26 cleared all 5; ~2.0 of the 4 play-off teams do. Honest test: the hidden champion cleared all 5
    // in 17/21 (9/11 | 8/10); as a predictor it tied a coin flip in the 1st half (1.39 vs 1.39) and beat it in the 2nd (1.25 vs 1.39) -> context only.
    // Misses: 2007 Leicester, 2011 Saracens, 2021 Harlequins, 2024 Northampton.
    FEATS: [{k: 'ppg', dir: 1, kind: 'rank', label: 'Ladder points/game'}, {k: 'wp', dir: 1, kind: 'value', label: 'Win%'}, {k: 'pfpg', dir: 1, kind: 'value', label: 'Points for/game'}, {k: 'mgn', dir: 1, kind: 'value', label: 'Margin/game'}, {k: 'hwp', dir: 1, kind: 'value', label: 'Home win%'}],
    // index: champion's rank in the field avg #1.71 (rating alone #1.95); chosen on 2006-16 (#1.45 vs #1.82), 2017-26 #2.00 vs #2.10 (but #1 in 4/10 vs 5/10)
    IDXW: {rtg: 70, awp: 30},
    P: {half: 120, lam: 3, sig: 11}},
  urc: {verdict: "🟡 fair (backtest 2026-11-24): beat equal odds and seed history in both halves -- the 1st-half margin over seed history is razor thin (1.24 vs 1.26)",
    id: 270557, label: 'United Rugby Championship', euro: true, first: 2010, warm: 2008, region: REG_URC,
    // Pro12 2010-17 top 4 (final at the top seed's ground to 2014, neutral from 2015); Pro14 2018-19 conferences (A2vB3, B2vA3, conference
    // winners host the semis, neutral final); 2020 conference semis; 2021 final only (conference winners); URC 2022+ top 8, fixed bracket, top seed hosts every round
    fmtOf: Y => Y >= 2022 ? 'eight' : Y === 2021 ? 'final2' : Y === 2020 ? 'conf2' : Y >= 2018 ? 'conf3' : Y >= 2010 ? 'four' : null,
    finalNeutral: Y => Y >= 2015, gpt: Y => Y >= 2022 ? 18 : Y >= 2018 ? 21 : 22, bonus: () => ({tb: '4', lb: 7}),
    // every-champion rule (2026-11-24): all 17 champions 2010-26 cleared all 5; ~2.7 of the 4-8 play-off teams do. Honest test: the hidden champion cleared all 5
    // in only 11/17 (5/9 | 6/8) and as a predictor it was WORSE than a coin flip over the field in both halves (2.12 vs 1.43 | 1.88 vs 1.78) -> context only.
    // Misses: 2010 + 2012 Ospreys, 2016 Connacht, 2018 + 2026 Leinster, 2023 Munster.
    FEATS: [{k: 'pct', dir: 1, kind: 'value', label: 'Percentage (PF/PA)'}, {k: 'pfpg', dir: 1, kind: 'rank', label: 'Points for/game'}, {k: 'papg', dir: -1, kind: 'value', label: 'Points against/game'}, {k: 'mgn', dir: 1, kind: 'rank', label: 'Margin/game'}, {k: 'awp', dir: 1, kind: 'value', label: 'Away win%'}],
    // index = rating alone: champion's rank in the field avg #2.06, #1 in 8/17; no blend beat it in both halves
    IDXW: {rtg: 100},
    P: {half: 240, lam: 1, sig: 12}},
  top14: {verdict: "❌ (backtest 2026-11-24): title odds lose to seed history in the 2nd half and play-off matches lose to 'host wins' -- shortlist only, no bets",
    id: 270559, label: 'Top 14', euro: true, first: 2010, warm: 2009, region: () => 'FRA',
    // top 6: barrages 3v6 / 4v5 at the higher seed, semis 1 v W(4/5) and 2 v W(3/6) at neutral grounds, neutral final. 2020 cancelled (COVID).
    fmtOf: Y => Y === 2020 ? null : Y >= 2010 ? 'six' : Y === 2009 ? 'four' : null, finalNeutral: () => true, gpt: () => 26,
    bonus: Y => ({tb: '3more', lb: Y >= 2015 ? 5 : 7}),   // check --rules: '3 tries more than the opponent' reproduces the official bonus points; losing bonus 7 -> 5 from 2014-15
    // every-champion rule (2026-11-24): all 16 champions 2010-26 cleared all 5; ~2.6 of the 6 play-off teams do. Honest test: the hidden champion cleared all 5
    // in 11/16 (5/8 | 6/8); as a predictor it lost to a coin flip in the 1st half (2.02 vs 1.79) and beat it in the 2nd (1.67 vs 1.79) -> context only.
    // Misses: 2013 + 2018 Castres, 2015 Stade Francais, 2016 Racing 92, 2024 Toulouse. Bonus points/game rests partly on ESTIMATED tries (2012-14 have none).
    FEATS: [{k: 'wp', dir: 1, kind: 'rank', label: 'Win%'}, {k: 'pfpg', dir: 1, kind: 'value', label: 'Points for/game'}, {k: 'hwp', dir: 1, kind: 'rank', label: 'Home win%'}, {k: 'awp', dir: 1, kind: 'value', label: 'Away win%'}, {k: 'bpg', dir: 1, kind: 'rank', label: 'Bonus points/game'}],
    // index: champion's rank in the field avg #2.44 (rating alone #3.06), #1 in 8/16 (6/16); chosen on 2010-17 (#2.50 vs #3.13), held out 2018-26 #2.38 vs #3.00
    IDXW: {rtg: 60, ppg: 20, pos: 20},
    P: {half: 120, lam: 3, sig: 12}},
};
const KNOWN = {   // champions from the record books -- `check` compares the data's champion with these
  premrugby: {2006: 'Sale', 2007: 'Leicester', 2008: 'Wasps', 2009: 'Leicester', 2010: 'Leicester', 2011: 'Saracens', 2012: 'Harlequins', 2013: 'Leicester', 2014: 'Northampton',
    2015: 'Saracens', 2016: 'Saracens', 2017: 'Exeter', 2018: 'Saracens', 2019: 'Saracens', 2020: 'Exeter', 2021: 'Harlequins', 2022: 'Leicester', 2023: 'Saracens', 2024: 'Northampton', 2025: 'Bath'},
  urc: {2010: 'Ospreys', 2011: 'Munster', 2012: 'Ospreys', 2013: 'Leinster', 2014: 'Leinster', 2015: 'Glasgow', 2016: 'Connacht', 2017: 'Scarlets', 2018: 'Leinster', 2019: 'Leinster',
    2020: 'Leinster', 2021: 'Leinster', 2022: 'Stormers', 2023: 'Munster', 2024: 'Glasgow', 2025: 'Leinster'},
  top14: {2010: 'Clermont', 2011: 'Toulous', 2012: 'Toulous', 2013: 'Castres', 2014: 'Toulon', 2015: 'Stade Fran', 2016: 'Racing', 2017: 'Clermont', 2018: 'Castres', 2019: 'Toulous',
    2021: 'Toulous', 2022: 'Montpellier', 2023: 'Toulous', 2024: 'Toulous', 2025: 'Toulous'},
  superrugby: {2014: 'Waratahs', 2015: 'Highlanders', 2016: 'Hurricanes', 2017: 'Crusaders', 2018: 'Crusaders', 2019: 'Crusaders', 2022: 'Crusaders', 2023: 'Crusaders', 2024: 'Blues', 2025: 'Crusaders'},
};
const [lk, mode0 = 'live', ...rest] = process.argv.slice(2);
const L = LG[lk]; if (!L) { console.log('usage: node union.mjs <superrugby|premrugby|urc|top14> [check|backtest|dump|live] [--log] [--book "..."]'); process.exit(1); }
const mode = mode0.startsWith('--') ? 'live' : mode0; if (mode0.startsWith('--')) rest.unshift(mode0);
const arg = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
const CACHE = path.join(os.tmpdir(), 'pro_bp_cache', lk); fs.mkdirSync(CACHE, {recursive: true});
const today = process.env.BP_TODAY || new Date().toLocaleDateString('en-CA');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
const TODAY_Y = +new Date().toLocaleDateString('en-CA').slice(0, 4), NOW = new Date().toLocaleDateString('en-CA');
// season key = ESPN season year (the year the season ENDS for the European leagues: 2027 = 2026-27)
const seasonOf = d => L.euro ? (+d.slice(5, 7) >= 8 ? +d.slice(0, 4) + 1 : +d.slice(0, 4)) : +d.slice(0, 4);
const CURY = seasonOf(today), REALCUR = seasonOf(NOW);
const lab = Y => L.euro ? `${Y - 1}-${String(Y).slice(2)}` : String(Y);
const SITE = `https://site.api.espn.com/apis/site/v2/sports/rugby/${L.id}`, CORE = `https://sports.core.api.espn.com/v2/sports/rugby/leagues/${L.id}`;

// ---------- data ----------
async function getJSON(url, file, ttlH) {
  const f = path.join(CACHE, file);
  if (fs.existsSync(f) && (ttlH === Infinity || Date.now() - fs.statSync(f).mtimeMs < ttlH * 3600e3)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {} }
  for (let a = 0; a < 4; a++) {
    try { const r = await fetch(url, {headers: {'User-Agent': UA}, signal: AbortSignal.timeout(60e3)});   // node's fetch handles gzip
      if (r.ok) { const j = await r.json(); fs.writeFileSync(f, JSON.stringify(j)); return j; } if (r.status === 404) return null; } catch {}
    await sleep(1500 * (a + 1));
  }
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
const NAMES = new Map(), NAMED = new Map();   // team id -> latest display name
function nameIt(id, n, t) { if (!NAMED.has(id) || NAMED.get(id) < t) { NAMED.set(id, t); NAMES.set(id, n); } }
// tries from ESPN's play list ('try' + 'penalty try'); trusted only when the scoring plays add up to the score (else estimated, see estT)
function tries(det, H, A) {
  if (!det?.length) return null;
  const pts = {[H.id]: 0, [A.id]: 0}, tr = {[H.id]: 0, [A.id]: 0};
  for (const x of det) { const t = x.team?.id, k = x.type?.text; if (!(t in pts)) continue;
    if (k === 'try') { tr[t]++; pts[t] += 5; } else if (k === 'penalty try') { tr[t]++; pts[t] += 7; } else if (k === 'conversion') pts[t] += 2; else if (k === 'penalty goal' || k === 'drop goal') pts[t] += 3; }
  const ok = Math.abs(pts[H.id] - +H.score) <= 2 && Math.abs(pts[A.id] - +A.score) <= 2;
  return ok ? [tr[H.id], tr[A.id]] : null;
}
function parseSB(e) {
  const c = e.competitions?.[0]; if (!c || !e.season || !e.date) return null;
  const H = c.competitors?.find(x => x.homeAway === 'home'), A = c.competitors?.find(x => x.homeAway === 'away'); if (!H || !A) return null;
  const st = c.status?.type || e.status?.type || {}, fin = !!st.completed && H.score !== '' && A.score !== '' && H.score != null && A.score != null;
  nameIt(H.team.id, H.team.displayName, e.date); nameIt(A.team.id, A.team.displayName, e.date);
  const tr = fin ? tries(c.details, H, A) : null;
  return {id: e.id, Y: e.season.year, t: e.date, d: e.date.slice(0, 10), h: H.team.id, a: A.team.id, hs: fin ? +H.score : null, as: fin ? +A.score : null, fin, st: st.name,
    ht: tr ? tr[0] : null, at: tr ? tr[1] : null, ven: c.venue?.id || c.venue?.fullName || ''};
}
function parseSum(j, id) {
  const c = j?.header?.competitions?.[0]; if (!c || !j.header.season) return null;
  const H = c.competitors?.find(x => x.homeAway === 'home'), A = c.competitors?.find(x => x.homeAway === 'away'); if (!H || !A || !c.date) return null;
  const st = c.status?.type || {}, fin = (!!st.completed || st.name === 'STATUS_FINAL') && H.score != null && H.score !== '' && A.score != null && A.score !== '';
  nameIt(H.team.id, H.team.displayName, c.date); nameIt(A.team.id, A.team.displayName, c.date);
  return {id, Y: j.header.season.year, t: c.date, d: c.date.slice(0, 10), h: H.team.id, a: A.team.id, hs: fin ? +H.score : null, as: fin ? +A.score : null, fin, st: st.name,
    ht: null, at: null, ven: j.gameInfo?.venue?.id || j.gameInfo?.venue?.fullName || ''};
}
const RAW = {};
async function rawSeason(Y) {
  if (RAW[Y]) return RAW[Y];
  const ev = new Map(), live = Y >= REALCUR;
  for (const cy of L.euro ? [Y - 1, Y] : [Y]) {
    const j = await getJSON(`${SITE}/scoreboard?dates=${cy}&limit=1000`, `sb${cy}.json`, cy < TODAY_Y ? Infinity : 6);
    for (const e of j?.events || []) { const g = parseSB(e); if (g && g.Y === Y) ev.set(g.id, g); }
  }
  const core = await getJSON(`${CORE}/seasons/${Y}/types/1/events?limit=1000`, `core${Y}.json`, live ? 6 : Infinity);
  for (const it of core?.items || []) { const id = it.$ref?.match(/events\/(\d+)/)?.[1]; if (!id || ev.has(id)) continue;
    const j = await getJSON(`${SITE}/summary?event=${id}`, `ev${id}.json`, live ? 6 : Infinity), g = j && parseSum(j, id); if (g && g.Y === Y) ev.set(id, g); }
  return RAW[Y] = [...ev.values()];
}
const OFFC = {};
async function official(Y) {   // official standings (points incl. bonus points, conference) -- used at the END of a regular season + to verify our ladder
  if (Y in OFFC) return OFFC[Y];
  const j = await getJSON(`https://site.api.espn.com/apis/v2/sports/rugby/${L.id}/standings?season=${Y}`, `st${Y}.json`, Y >= REALCUR ? 6 : Infinity), m = new Map();
  const ch = j?.children || [], single = ch.filter(c => c.standings?.entries?.length).length === 1;
  for (const c of ch) for (const e of c.standings?.entries || []) { const s = Object.fromEntries((e.stats || []).map(x => [x.name, x.value]));
    if (!(s.gamesPlayed > 0)) continue;
    m.set(e.team.id, {pts: s.points, gp: s.gamesPlayed, bpt: s.bonusPointsTry, bpl: s.bonusPointsLosing, w: s.gamesWon, pf: s.pointsFor, pa: s.pointsAgainst, ord: single ? s.rank : null, grp: c.name}); }
  return OFFC[Y] = m.size ? m : null;
}
const isDone = (G, Y) => G.length > 0 && G.every(g => g.fin) && (Y < REALCUR || G.map(g => g.d).sort().pop() < NOW);
const SEAS = {};
async function season(Y) {
  if (SEAS[Y]) return SEAS[Y];
  let G = (await rawSeason(Y)).filter(g => g.h && g.a && g.h !== g.a);
  if (L.drop?.[Y]) G = G.filter(g => !L.drop[Y].test(NAMES.get(g.h)) && !L.drop[Y].test(NAMES.get(g.a)));   // expunged clubs (Prem 2022-23 Worcester, Wasps)
  if (Y < REALCUR) G = G.filter(g => g.fin);   // past seasons: postponed-and-never-played rows dropped
  G.sort((x, y) => x.t.localeCompare(y.t) || x.id.localeCompare(y.id));
  // ESPN junk rows: a 0-0 "final" duplicate of a real game (same home/away clubs within 3 days) -- Prem 2018-19 had 8
  const near = (x, y) => x !== y && x.h === y.h && x.a === y.a && Math.abs(Date.parse(x.t) - Date.parse(y.t)) < 3 * 864e5;
  G = G.filter(g => !(g.fin && g.hs + g.as === 0 && G.some(x => near(x, g) && (!x.fin || x.hs + x.as > 0 || x.id < g.id))));
  const fmt = L.fmtOf(Y), K = fmt ? FMT[fmt].K : 0;
  for (const g of G) { g.final = false; g.gf = false; }
  if (fmt && isDone(G, Y)) {
    // play-offs = the last K games. ESPN also files a few non-title games under the league (Pro14 2018 + 2019 Champions Cup play-offs) and
    // the odd late rescheduled league game (Pro14 2021 Dragons-Edinburgh, a day after the final): a "play-off" game with a club outside the
    // seeded field is moved back to the regular season if both clubs are short of their official games played, else dropped.
    const OFF = await official(Y), forced = new Set();
    for (let it = 0; it < 8; it++) {
      const cand = G.filter(g => !forced.has(g.id)).slice(-K), cs = new Set(cand.map(g => g.id)), reg = G.filter(g => !cs.has(g.id));
      const field = OFF ? new Set(seedsOf(fmt, ladder([...table(reg, Y, OFF).values()]), OFF)) : null, bad = field ? cand.filter(g => !field.has(g.h) || !field.has(g.a)) : [];
      if (!bad.length) { for (const g of cand) g.final = true; cand[cand.length - 1].gf = true; break; }
      const cnt = t => reg.filter(g => g.h === t || g.a === t).length;
      for (const g of bad) { if (cnt(g.h) < (OFF.get(g.h)?.gp ?? 99) && cnt(g.a) < (OFF.get(g.a)?.gp ?? 99)) forced.add(g.id); else G = G.filter(x => x !== g); }
    }
  }
  else if (fmt) {   // season in progress: a play-off game = both clubs have already played their full regular season
    const n = new Map(), G0 = L.gpt(Y);
    for (const g of G) { if ((n.get(g.h) || 0) >= G0 && (n.get(g.a) || 0) >= G0) g.final = true; else { n.set(g.h, (n.get(g.h) || 0) + 1); n.set(g.a, (n.get(g.a) || 0) + 1); } }
    const f = G.filter(g => g.final); if (f.length === K && f[K - 1].fin) f[K - 1].gf = true;
  }
  // neutral grounds: play-off rounds by the format's rule (NEUTRAL: Prem final at Twickenham, Top 14 semis + final, Pro14 finals; everything
  // else is hosted by the higher seed, which ESPN lists as the home side); a regular-season game only when the ground hosts another club's game
  // within 3 days and the home club doesn't play there regularly (Super Round, double-headers)
  const host = new Map(), byV = new Map();
  for (const g of G) { if (!g.final) host.set(g.h + '|' + g.ven, (host.get(g.h + '|' + g.ven) || 0) + 1); if (!byV.has(g.ven)) byV.set(g.ven, []); byV.get(g.ven).push(g); }
  const nr = fmt ? NEUTRAL(fmt, Y) : [];
  G.filter(g => g.final).forEach((g, i) => { g.neutral = !!nr[i]; });
  for (const g of G) if (!g.final) g.neutral = !!g.ven && (host.get(g.h + '|' + g.ven) || 0) < 2 && (byV.get(g.ven) || []).some(x => x !== g && !x.final && x.h !== g.h && Math.abs(Date.parse(x.t) - Date.parse(g.t)) < 3 * 864e5);
  return SEAS[Y] = G;
}
const premier = G => { const gf = G.find(g => g.gf && g.fin); return gf ? (gf.hs > gf.as ? gf.h : gf.a) : null; };
// tries for games without a usable play list: the median number of tries scored with that many points (fit on this league's games that have them)
let TRYMED = null, TRYMU = 3;
function buildTry(S) {
  const by = new Map(), all = [];
  for (const Y in S) for (const g of S[Y]) if (g.fin && g.ht != null) for (const [p, t] of [[g.hs, g.ht], [g.as, g.at]]) { if (!by.has(p)) by.set(p, []); by.get(p).push(t); all.push(t); }
  TRYMED = new Map([...by].map(([p, a]) => [p, a.sort((x, y) => x - y)[a.length >> 1]])); TRYMU = mean(all) || 3;
}
const estT = p => TRYMED?.get(p) ?? Math.round(p / 7);
const trOf = g => g.ht != null ? [g.ht, g.at] : [estT(g.hs), estT(g.as)];

// ---------- ratings (copied from rugby.mjs) ----------
const REG = id => L.region(NAMES.get(id) || '');
function fit(games, asOf, P) {
  const G = games.filter(g => g.fin && g.d < asOf), t0 = Date.parse(asOf + 'T12:00:00Z');
  const w = G.map(g => Math.pow(0.5, (t0 - Date.parse(g.d + 'T12:00:00Z')) / 864e5 / P.half));
  const inter = G.map(g => REG(g.h) !== REG(g.a)), m = G.map(g => g.hs - g.as);
  const T = [...new Set(G.flatMap(g => [g.h, g.a]))], r = new Map(T.map(t => [t, 0])), idx = new Map();
  for (const [i, g] of G.entries()) for (const t of [g.h, g.a]) { if (!idx.has(t)) idx.set(t, []); idx.get(t).push(i); }
  let Hs = 3, Hi = 5;
  const edge = i => G[i].neutral ? 0 : inter[i] ? Hi : Hs;
  for (let it = 0; it < 50; it++) {
    for (const t of T) { let den = P.lam, n2 = 0; for (const i of idx.get(t)) { const g = G[i], s = g.h === t ? 1 : -1, other = r.get(g.h === t ? g.a : g.h); den += w[i]; n2 += w[i] * (s * (m[i] - edge(i)) + other); } r.set(t, n2 / den); }
    const mu = mean([...r.values()]); for (const t of T) r.set(t, r.get(t) - mu);
    let ss = 0, ws = 0, si = 0, wi = 0;
    for (const [i, g] of G.entries()) { if (g.neutral) continue; const res = m[i] - (r.get(g.h) - r.get(g.a)); if (inter[i]) { si += w[i] * res; wi += w[i]; } else { ss += w[i] * res; ws += w[i]; } }
    Hs = ws ? ss / ws : 0; Hi = wi > 3 ? si / wi : Hs;
  }
  return {r, Hs, Hi};
}
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
const Phi = x => 0.5 * (1 + erf(x / Math.SQRT2));
const predMargin = (M, h, a, neutral) => (M.r.get(h) ?? 0) - (M.r.get(a) ?? 0) + (neutral ? 0 : REG(h) !== REG(a) ? M.Hi : M.Hs);
const pHome = (M, h, a, neutral, P) => Phi(predMargin(M, h, a, neutral) / P.sig);
const LLf = (p, y) => -(y * Math.log(Math.max(p, 1e-6)) + (1 - y) * Math.log(Math.max(1 - p, 1e-6)));
const randn = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const pois = lam => { const L0 = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= Math.random(); } while (p > L0); return k - 1; };

// ---------- ladder (4 a win, 2 a draw, bonus points) + play-offs ----------
function addGame(H, A, hs, as, ht, at, R) {
  H.gp++; A.gp++; H.pf += hs; H.pa += as; A.pf += as; A.pa += hs; H.tf += ht; H.ta += at; A.tf += at; A.ta += ht;
  const b = (me, op, tm, to) => (R.tb === '4' ? tm >= 4 : R.tb === '3more' ? tm - to >= 3 : tm - to >= 3 && me > op) ? 1 : 0;
  let bh = b(hs, as, ht, at), ba = b(as, hs, at, ht);
  if (hs > as) { H.pts += 4; H.w++; A.l++; if (hs - as <= R.lb) ba++; } else if (hs < as) { A.pts += 4; A.w++; H.l++; if (as - hs <= R.lb) bh++; } else { H.pts += 2; A.pts += 2; H.d++; A.d++; }
  H.pts += bh; A.pts += ba; H.bp += bh; A.bp += ba;
}
const blank = id => ({id, pts: 0, pf: 0, pa: 0, w: 0, l: 0, d: 0, gp: 0, bp: 0, tf: 0, ta: 0, ord: null});
// reg = this season's regular-season games (played + unplayed). Once ALL of them are played the official points (and order) replace ours.
function table(reg, Y, OFF, R = L.bonus(Y)) {
  const T = new Map();
  for (const g of reg) for (const t of [g.h, g.a]) if (!T.has(t)) T.set(t, blank(t));
  for (const g of reg) if (g.fin) { const [ht, at] = trOf(g); addGame(T.get(g.h), T.get(g.a), g.hs, g.as, ht, at, R); }
  if (L.deduct?.[Y]) { const [re, v] = L.deduct[Y]; for (const r of T.values()) if (re.test(NAMES.get(r.id) || '')) r.pts += v; }
  if (OFF && reg.length && reg.every(g => g.fin)) for (const r of T.values()) { const o = OFF.get(r.id); if (o) { r.pts = o.pts; r.ord = o.ord; r.off = true; } }
  return T;
}
const ladder = rows => rows.slice().sort((x, y) => y.pts - x.pts || (x.ord != null && y.ord != null ? x.ord - y.ord : 0) || y.w - x.w || (y.pf - y.pa) - (x.pf - x.pa));
// play-off seeds in bracket order (see finals()); conference eras use the official standings' groups
function seedsOf(fmt, lad, OFF) {
  const N = FMT[fmt].N, grp = id => OFF?.get(id)?.grp || '?', ids = lad.map(t => t.id);
  const winners = gs => gs.map(g => ids.find(id => grp(id) === g)).filter(Boolean);
  const groups = [...new Set(ids.map(grp))];
  if (fmt === 'sr6' || fmt === 'sr18') { if (groups.length < 3) return ids.slice(0, N);
    const cw = winners(groups).sort((a, b) => ids.indexOf(a) - ids.indexOf(b)); return cw.concat(ids.filter(id => !cw.includes(id)).slice(0, N - cw.length)); }
  if (fmt === 'sr16') { if (groups.length < 4) return ids.slice(0, N);
    const cw = winners(groups).sort((a, b) => ids.indexOf(a) - ids.indexOf(b)), aus = g => /austral|zealand/i.test(g);
    const wc = ids.filter(id => !cw.includes(id) && aus(grp(id))).slice(0, 3).concat(ids.filter(id => !cw.includes(id) && !aus(grp(id))).slice(0, 1)).sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
    return cw.concat(wc); }
  if (fmt === 'conf3' || fmt === 'conf2' || fmt === 'final2') { if (groups.length < 2) return ids.slice(0, N);
    const [ga, gb] = winners(groups).sort((a, b) => ids.indexOf(a) - ids.indexOf(b)).map(grp), A = ids.filter(id => grp(id) === ga), B = ids.filter(id => grp(id) === gb);
    return fmt === 'final2' ? [A[0], B[0]] : fmt === 'conf2' ? [A[0], B[0], A[1], B[1]] : [A[0], B[0], A[1], B[1], A[2], B[2]]; }
  return ids.slice(0, N);
}
// win(host, visitor, neutral) -> winner. Hosts = the higher seed unless the round is neutral.
function finals(s, win, fmt, Y) {
  const rk = id => s.indexOf(id), W = (x, y, neutral = false) => rk(x) < rk(y) ? win(x, y, neutral) : win(y, x, neutral);
  switch (fmt) {
    case 'four': return W(W(s[0], s[3]), W(s[1], s[2]), L.finalNeutral(Y));
    case 'six': { const b1 = W(s[2], s[5]), b2 = W(s[3], s[4]); return W(W(s[0], b2, true), W(s[1], b1, true), true); }   // Top 14
    case 'eight': { const q = [W(s[0], s[7]), W(s[3], s[4]), W(s[1], s[6]), W(s[2], s[5])]; return W(W(q[0], q[1]), W(q[2], q[3])); }   // URC fixed bracket
    case 'top8re': case 'sr16': case 'sr18': { const q = [W(s[0], s[7]), W(s[1], s[6]), W(s[2], s[5]), W(s[3], s[4])].sort((x, y) => rk(x) - rk(y)); return W(W(q[0], q[3]), W(q[1], q[2])); }
    case 'sr6': { const e1 = W(s[2], s[5]), e2 = W(s[3], s[4]), lo = rk(e1) > rk(e2) ? e1 : e2, hi = lo === e1 ? e2 : e1; return W(W(s[0], lo), W(s[1], hi)); }
    case 'sr6ll': { const pr = [[s[0], s[5]], [s[1], s[4]], [s[2], s[3]]], wn = pr.map(([x, y]) => W(x, y)), ls = pr.map(([x, y], i) => wn[i] === x ? y : x);
      const ll = ls.slice().sort((x, y) => rk(x) - rk(y))[0], beat = wn[ls.indexOf(ll)], f = [...wn, ll].sort((x, y) => rk(x) - rk(y));
      let sf = [[f[0], f[3]], [f[1], f[2]]];   // reseeded; the lucky loser never meets the club that just beat it (2025: Chiefs)
      if (sf.some(p => p.includes(ll) && p.includes(beat))) sf = [[f[0], f[2]], [f[1], f[3]]];
      return W(W(...sf[0]), W(...sf[1])); }
    case 'conf3': { const q1 = W(s[2], s[5]), q2 = W(s[3], s[4]); return W(W(s[0], q2), W(s[1], q1), true); }
    case 'conf2': return W(W(s[0], s[3]), W(s[1], s[2]), true);
    case 'final2': return W(s[0], s[1]);
  }
}
function simulate(M, P, reg, Y, OFF, fmt, N = 20000, fixedSeeds = null) {
  const base = table(reg, Y, OFF), left = reg.filter(g => !g.fin), cup = new Map(), top = new Map(), R = L.bonus(Y);
  const win = (x, y, neutral) => Math.random() < Phi(predMargin(M, x, y, neutral) / P.sig) ? x : y;
  const pm = left.map(g => predMargin(M, g.h, g.a, g.neutral));
  for (let s = 0; s < N; s++) {
    let seeds = fixedSeeds;
    if (!seeds) {
      const T = new Map([...base].map(([k, v]) => [k, {...v}]));
      for (const [i, g] of left.entries()) { const x = Math.round(pm[i] + P.sig * randn()), H = T.get(g.h), A = T.get(g.a);
        // scores/tries for the bonus points: tries ~ Poisson(league mean +/- margin/14) -- an approximation (no team try rates)
        const ht = pois(Math.max(0.15, TRYMU + x / 14)), at = pois(Math.max(0.15, TRYMU - x / 14)), lo = Math.max(3, 7 * Math.min(ht, at) + 3);
        addGame(H, A, x >= 0 ? lo + x : lo, x >= 0 ? lo : lo - x, ht, at, R); }
      seeds = seedsOf(fmt, ladder([...T.values()]), OFF);
    }
    top.set(seeds[0], (top.get(seeds[0]) || 0) + 1);
    const ch = finals(seeds, win, fmt, Y); cup.set(ch, (cup.get(ch) || 0) + 1);
  }
  const out = new Map([...cup].map(([k, v]) => [k, v / N])); out.minor = new Map([...top].map(([k, v]) => [k, v / N])); return out;
}
const loadP = () => fs.existsSync(path.join(CACHE, 'params.json')) ? JSON.parse(fs.readFileSync(path.join(CACHE, 'params.json'), 'utf8')) : L.P;
const SEASONS = Array.from({length: CURY - L.first + 1}, (_, i) => L.first + i);
async function all() { const S = {}; for (let Y = L.warm; Y <= CURY; Y++) S[Y] = await season(Y).catch(e => { console.error(`season ${Y}: ${e.message}`); return []; }); buildTry(S); return S; }
async function offs(S) { const O = {}; for (const Y in S) O[Y] = await official(+Y); return O; }
const pool = (S, Y) => [...(S[Y - 2] || []), ...(S[Y - 1] || []), ...(S[Y] || [])];
const firstFinal = G => G.filter(g => g.final).map(g => g.d).sort()[0];
const finalsField = G => [...new Set(G.filter(g => g.final).flatMap(g => [g.h, g.a]))];
const unplay = g => ({...g, fin: false, hs: null, as: null, ht: null, at: null});

// ---------- champion profile (end of the regular season = the day before the first play-off game) ----------
const FEATS = L.FEATS || [], IDXW = L.IDXW || {rtg: 100};
function profile(G, pl, asOf, P, Y, OFF) {
  const regR = G.filter(g => !g.final).map(g => g.d < asOf ? g : unplay(g)), M = fit(pl, asOf, P);
  const lad = ladder([...table(regR, Y, OFF).values()]), X = new Map(lad.map(t => [t.id, {res: [], hw: 0, hn: 0, aw: 0, an: 0}]));
  for (const g of regR.filter(g => g.fin)) for (const [me, pf, pa, side] of [[g.h, g.hs, g.as, g.neutral ? 0 : 1], [g.a, g.as, g.hs, g.neutral ? 0 : -1]]) {
    const t = X.get(me), r = pf > pa ? 1 : pf < pa ? 0 : 0.5; t.res.push([g.d, r]); if (side > 0) { t.hw += r; t.hn++; } else if (side < 0) { t.aw += r; t.an++; } }
  const rows = lad.filter(t => t.gp > 0).map((t, i) => { const x = X.get(t.id), s = x.res.sort((a, b) => a[0].localeCompare(b[0])), f = n => mean(s.slice(-n).map(v => v[1]));
    return {id: t.id, pos: i + 1, pts: t.pts, gp: t.gp, w: t.w, l: t.l, d: t.d, pf: t.pf, pa: t.pa, ppg: t.pts / t.gp, wp: (t.w + t.d / 2) / t.gp, pct: 100 * t.pf / Math.max(1, t.pa),
      pfpg: t.pf / t.gp, papg: t.pa / t.gp, mgn: (t.pf - t.pa) / t.gp, rtg: M.r.get(t.id) ?? 0, form8: f(8), form5: f(5), hwp: x.hn ? x.hw / x.hn : 0, awp: x.an ? x.aw / x.an : 0,
      bpg: t.bp / t.gp, tdpg: (t.tf - t.ta) / t.gp}; });
  return {rows: rankRows(rows, FEATS), M, lad};
}
function addIndex(rows) {
  const N = {}, tw = Object.values(IDXW).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(IDXW)) { const dir = (FEATS.find(x => x.k === k) || {dir: k === 'papg' || k === 'pos' ? -1 : 1}).dir, v = rows.map(r => +r[k]), lo = Math.min(...v), hi = Math.max(...v);
    N[k] = r => hi === lo ? 50 : 100 * (dir > 0 ? r[k] - lo : hi - r[k]) / (hi - lo); }
  for (const r of rows) r.idx = Object.entries(IDXW).reduce((a, [k, w]) => a + w * N[k](r), 0) / tw;
}
const countLB = (reg, id, lb) => reg.filter(g => g.fin && ((g.h === id && g.as > g.hs && g.as - g.hs <= lb) || (g.a === id && g.hs > g.as && g.hs - g.as <= lb))).length;
const regDone = G => G.filter(g => !g.final).every(g => g.fin);

if (mode === 'dump') {   // every team's end-of-regular-season profile -> study/data/<lk>.json (input for study/criteria.mjs)
  const S = await all(), O = await offs(S), P = loadP(), K = ['pos', 'ppg', 'wp', 'pct', 'pfpg', 'papg', 'mgn', 'rtg', 'form8', 'form5', 'hwp', 'awp', 'bpg', 'tdpg'];
  const out = {sport: lk, label: `${L.label} title`, when: 'end of the regular season', fieldLabel: 'the play-off teams', universeLabel: `every ${L.label} team`,
    cands: [{k: 'pos', dir: -1, label: 'Ladder position', value: true, rank: false, dec: 0}, {k: 'ppg', dir: 1, label: 'Ladder points/game', value: true}, {k: 'wp', dir: 1, label: 'Win%', value: true},
      {k: 'pct', dir: 1, label: 'Percentage (PF/PA)', value: true}, {k: 'pfpg', dir: 1, label: 'Points for/game', value: true}, {k: 'papg', dir: -1, label: 'Points against/game', value: true},
      {k: 'mgn', dir: 1, label: 'Margin/game', value: true}, {k: 'rtg', dir: 1, label: 'Rating', value: true}, {k: 'form8', dir: 1, label: 'Form (win%, last 8)', value: true},
      {k: 'form5', dir: 1, label: 'Form (win%, last 5)', value: true}, {k: 'hwp', dir: 1, label: 'Home win%', value: true}, {k: 'awp', dir: 1, label: 'Away win%', value: true},
      {k: 'bpg', dir: 1, label: 'Bonus points/game', value: true}, {k: 'tdpg', dir: 1, label: 'Try difference/game', value: true}],
    seasons: []};
  for (const Y of SEASONS) {
    const G = S[Y], ch = premier(G); if (!ch || !L.fmtOf(Y)) continue;
    const {rows} = profile(G, pool(S, Y), firstFinal(G), P, Y, O[Y]);
    out.seasons.push({Y, champ: ch, champName: NAMES.get(ch), field: finalsField(G), rows: rows.map(r => Object.fromEntries([['id', r.id], ['name', NAMES.get(r.id)], ...K.map(k => [k, r[k]])]))});
  }
  fs.mkdirSync('C:/Users/User/baseball-blueprint/study/data', {recursive: true});
  fs.writeFileSync(`C:/Users/User/baseball-blueprint/study/data/${lk}.json`, JSON.stringify(out));
  console.log(`dumped ${out.seasons.length} seasons -> study/data/${lk}.json · champs: ${out.seasons.map(s => `${s.Y} ${s.champName} (#${s.rows.find(r => r.id === s.champ)?.pos} of ${s.field.length})`).join(', ')}`);
  process.exit(0);
}
if (mode === 'check') {
  const S = await all(), O = await offs(S), kn = KNOWN[lk] || {};
  console.log(`${L.label} data check -- ESPN league ${L.id}, seasons ${L.warm}-${CURY} (season = ESPN year${L.euro ? ', the year it ENDS' : ''}) · today ${today}`);
  let bad = 0;
  for (let Y = L.warm; Y <= CURY; Y++) {
    const G = S[Y]; if (!G?.length) { console.log(`${lab(Y)}: no games`); continue; }
    const reg = G.filter(g => !g.final), fin = G.filter(g => g.final), ch = premier(G), fmt = L.fmtOf(Y), off = O[Y];
    const trc = reg.filter(g => g.fin && g.ht != null).length / Math.max(1, reg.filter(g => g.fin).length), neu = G.filter(g => g.neutral);
    const T = table(reg, Y, null), lad = ladder([...T.values()]);
    let ptsOK = '', seedOK = '', field = '';
    if (off && regDone(G)) {   // our end-of-season ladder (bonus points from tries) vs the official one
      const cmp = [...T.values()].filter(t => off.has(t.id)), eq = cmp.filter(t => t.pts === off.get(t.id).pts).length, bpEq = cmp.filter(t => t.bp === off.get(t.id).bpt + off.get(t.id).bpl).length;
      ptsOK = ` · ladder pts = official ${eq}/${cmp.length} (bonus pts ${bpEq}/${cmp.length}${cmp.length < T.size ? `, ${T.size - cmp.length} clubs not in the official table` : ''})`;
    }
    if (off && regDone(G) && rest.includes('--rules')) {   // which bonus-point rule reproduces the official bonus points best?
      const sc = [];
      for (const tb of ['4', '3more', '3moreW']) for (const lb of [7, 5]) { const Tq = table(reg, Y, null, {tb, lb}), c = [...Tq.values()].filter(t => off.has(t.id));
        sc.push([`${tb}/${lb}`, c.filter(t => t.bp === off.get(t.id).bpt + off.get(t.id).bpl).length, c.length, c.filter(t => t.bp - (Tq.get(t.id).l ? 0 : 0) === t.bp && countLB(reg, t.id, lb) === off.get(t.id).bpl).length]); }
      console.log(`    bonus rules (total BP match / losing-BP match): ${sc.map(x => `${x[0]} ${x[1]}/${x[2]} (${x[3]})`).join(' · ')}`);
    }
    if (fmt && fin.length) { const sd = seedsOf(fmt, ladder([...table(reg, Y, off).values()]), off), ff = new Set(finalsField(G)), ok = sd.length === ff.size && sd.every(x => ff.has(x));
      seedOK = ` · seeds = actual play-off field ${ok ? '✓' : '✗ ' + sd.map(x => NAMES.get(x)).join('/') + ' vs ' + [...ff].map(x => NAMES.get(x)).join('/')}`; if (!ok && Y >= L.first) bad++;
      field = fin.map(g => `${g.d.slice(5)} ${NAMES.get(g.h)} ${g.fin ? g.hs + '-' + g.as : 'v'} ${NAMES.get(g.a)}${g.neutral ? ' (N)' : ''}`).join(' | '); }
    const kc = kn[Y], kOK = kc ? (ch && NAMES.get(ch).includes(kc) ? ' ✓' : ` ✗ (record books: ${kc})`) : '';
    if (kc && !kOK.includes('✓')) bad++;
    console.log(`${lab(Y)} [${fmt || 'no play-offs'}]: ${reg.length} regular (${reg.filter(g => g.fin).length} played, ${T.size} clubs, tries ${(100 * trc).toFixed(0)}%, ${neu.filter(g => !g.final).length} neutral) · ${fin.length} play-off · champion ${ch ? NAMES.get(ch) : '—'}${kOK}${ptsOK}${seedOK}`);
    if (field) console.log(`    ${field}`);
    if (!regDone(G) && off) { const cmp = [...T.values()].filter(t => off.has(t.id) && off.get(t.id).gp === t.gp), eq = cmp.filter(t => t.pts === off.get(t.id).pts).length;
      console.log(`    in progress: our ladder vs ESPN's current table -- points equal for ${eq}/${cmp.length} clubs with the same games played · top 4 ours: ${lad.slice(0, 4).map(t => `${NAMES.get(t.id)} ${t.pts}`).join(', ')}`); }
  }
  // clubs: one ESPN id per club? (a renamed club with a new id would split into two teams)
  const ids = new Map(); for (const Y in S) for (const g of S[Y]) for (const t of [g.h, g.a]) { if (!ids.has(t)) ids.set(t, new Set()); ids.get(t).add(Y); }
  const byName = new Map(); for (const [id] of ids) { const n = NAMES.get(id).toLowerCase().replace(/[^a-z]/g, '').slice(0, 6); if (!byName.has(n)) byName.set(n, []); byName.get(n).push(id); }
  const dup = [...byName.values()].filter(a => a.length > 1);
  console.log(`\nclubs: ${ids.size} ESPN ids · possible split clubs (same name start, two ids): ${dup.length ? dup.map(a => a.map(i => `${NAMES.get(i)} [${[...ids.get(i)].join(',')}]`).join(' = ')).join(' · ') : 'none'}`);
  // BP_TODAY rewind proof: rewind the last finished season to its 75% date and confirm (1) nothing on/after the date counts as played,
  // (2) the ladder equals one built only from games before the date, (3) the official end-of-season table is NOT used mid-season
  const Yr = SEASONS.filter(Y => premier(S[Y])).pop(), Gr = S[Yr], ds = Gr.filter(g => !g.final).map(g => g.d).sort(), dR = ds[Math.floor(0.75 * ds.length)];
  const rew = Gr.map(g => g.d < dR ? g : unplay(g)), r1 = table(rew.filter(g => !g.final), Yr, O[Yr]), r2 = table(Gr.filter(g => !g.final && g.d < dR), Yr, null);
  const same = [...r2.values()].every(t => r1.get(t.id)?.pts === t.pts && r1.get(t.id)?.gp === t.gp), played = rew.filter(g => g.fin && g.d >= dR).length, offUsed = [...r1.values()].some(t => t.off);
  console.log(`\nREWIND (BP_TODAY) proof on ${lab(Yr)} at ${dR}: games on/after the date still counted as played = ${played} · ladder = games-before-the-date ladder ${same ? '✓' : '✗'} · official end-of-season points used = ${offUsed ? 'YES ✗' : 'no ✓'} · ${rew.filter(g => !g.fin).length} games become fixtures`);
  console.log(`  rewound ladder top 4: ${ladder([...r1.values()]).slice(0, 4).map(t => `${NAMES.get(t.id)} ${t.pts} (${t.gp} gp)`).join(', ')}`);
  console.log(bad ? `\n${bad} PROBLEM(S) above` : '\nall champions match the record books and every seeded field matches the real play-off field');
  process.exit(0);
}
if (mode === 'backtest') {
  const S = await all(), O = await offs(S), done = SEASONS.filter(Y => premier(S[Y]) && L.fmtOf(Y) && regDone(S[Y]));
  const half = Math.ceil(done.length / 2), H1 = done.slice(0, half), H2 = done.slice(half);
  const wk = d => Math.floor((Date.parse(d + 'T12:00:00Z') - Date.parse('2000-01-03T00:00:00Z')) / (7 * 864e5));
  const regs = Y => S[Y].filter(g => !g.final && g.fin), wks = Y => [...new Set(regs(Y).map(g => wk(g.d)))];
  const fitsFor = P => { const F = new Map(); for (const Y of done) for (const w of wks(Y)) { const d0 = regs(Y).filter(g => wk(g.d) === w).map(g => g.d).sort()[0]; F.set(Y + '|' + w, fit(pool(S, Y), d0, P)); } return F; };
  const yv = g => g.hs > g.as ? 1 : g.hs < g.as ? 0 : 0.5;
  const evalM = (P, F, Ys) => mean(Ys.flatMap(Y => regs(Y).map(g => LLf(pHome(F.get(Y + '|' + wk(g.d)), g.h, g.a, g.neutral, P), yv(g)))));
  let best = null; const cache = new Map();
  for (const hl of [120, 240, 365, 730]) for (const lam of [1, 3, 10]) { const F = fitsFor({half: hl, lam}); cache.set(hl + '|' + lam, F);
    for (const sig of [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22]) { const P = {half: hl, lam, sig}, ll = evalM(P, F, H1); if (!best || ll < best.ll) best = {P, ll}; } }
  const P = best.P, F = cache.get(P.half + '|' + P.lam);
  const hb = Ys => { const g = Ys.flatMap(regs), hr = mean(g.map(yv)); return mean(g.map(x => LLf(hr, yv(x)))); };
  console.log(`${L.label} backtest -- ${lab(done[0])} to ${lab(done[done.length - 1])} (${done.length} title seasons; halves ${lab(H1[0])}..${lab(H1[H1.length - 1])} / ${lab(H2[0])}..${lab(H2[H2.length - 1])})`);
  console.log(`MATCHES (regular season, refit every week): tuned on the 1st half -> half-life ${P.half} d, shrink ${P.lam}, sigma ${P.sig} pts`);
  const Mlast = fit(pool(S, done[done.length - 1]), firstFinal(S[done[done.length - 1]]), P);
  console.log(`  home edge (latest fit): ${Mlast.Hs.toFixed(1)} pts same region / ${Mlast.Hi.toFixed(1)} pts travelling visitor`);
  console.log(`  1st half LL ${evalM(P, F, H1).toFixed(4)} vs home-win base rate ${hb(H1).toFixed(4)} · 2nd half (held out) LL ${evalM(P, F, H2).toFixed(4)} vs ${hb(H2).toFixed(4)} · coin 0.6931`);
  const fm = []; for (const Y of done) for (const g of S[Y].filter(g => g.final && g.fin)) { const M = fit(pool(S, Y), g.d, P); fm.push({Y, ll: LLf(pHome(M, g.h, g.a, g.neutral, P), yv(g)), y: yv(g), n: g.neutral}); }
  const hostLL = Ys => mean(fm.filter(x => Ys.includes(x.Y)).map(x => x.n ? Math.log(2) : LLf(mean(fm.filter(z => !z.n && z.Y !== x.Y).map(z => z.y)), x.y)));
  const fl = Ys => mean(fm.filter(x => Ys.includes(x.Y)).map(x => x.ll));
  console.log(`\nPLAY-OFF MATCHES (${fm.length}, ${fm.filter(x => x.n).length} neutral): model LL ${fl(done).toFixed(4)} (${fl(H1).toFixed(4)} | ${fl(H2).toFixed(4)}) vs "host wins" ${hostLL(done).toFixed(4)} (${hostLL(H1).toFixed(4)} | ${hostLL(H2).toFixed(4)})`);
  const titles = [];
  for (const Y of done) {
    const G = S[Y], reg = G.filter(g => !g.final), ch = premier(G), first = firstFinal(G), fmt = L.fmtOf(Y), nF = FMT[fmt].N;
    const seeds = seedsOf(fmt, ladder([...table(reg, Y, O[Y]).values()]), O[Y]);
    const Tf = simulate(fit(pool(S, Y), first, P), P, reg, Y, O[Y], fmt, 20000, seeds);
    const ds = reg.map(g => g.d).sort(), d75 = ds[Math.floor(0.75 * ds.length)], reg75 = reg.map(g => g.d < d75 ? g : unplay(g));
    const T75 = simulate(fit(pool(S, Y), d75, P), P, reg75, Y, O[Y], fmt, 8000), lad75 = ladder([...table(reg75, Y, O[Y]).values()]);
    const rk = (T, id) => 1 + [...T.values()].filter(v => v > (T.get(id) || 0)).length;
    titles.push({Y, fmt, nF, ch: NAMES.get(ch), seed: seeds.indexOf(ch) + 1, p: Tf.get(ch) || 0, r: rk(Tf, ch), p75: T75.get(ch) || 0, r75: rk(T75, ch), pos75: lad75.findIndex(t => t.id === ch) + 1, nT: lad75.length,
      top: NAMES.get([...Tf].sort((a, b) => b[1] - a[1])[0][0]), ptop: Math.max(...Tf.values())});
  }
  console.log(`\nTITLE ODDS -- start of the play-offs (seeds known) | at 75% of the regular season`);
  for (const t of titles) console.log(`  ${lab(t.Y).padEnd(7)} ${String(t.ch).padEnd(26)} seed ${t.seed}/${t.nF} | play-off start ${(100 * t.p).toFixed(1).padStart(5)}% (#${t.r}; fav ${t.top} ${(100 * t.ptop).toFixed(0)}%) | 75%: ${(100 * t.p75).toFixed(1).padStart(5)}% (#${t.r75}, ladder ${t.pos75})`);
  const Lg = a => mean(a.map(p => -Math.log(Math.max(p, 1e-4))));
  const seedLL = (Ys, key, n) => mean(titles.filter(t => Ys.includes(t.Y)).map(t => { const tf = titles.filter(z => z.Y !== t.Y && z.nF === t.nF); return -Math.log((tf.filter(z => z[key] === t[key]).length + 0.5) / (tf.length + 0.5 * n(t))); }));
  const res = {};
  for (const [nm, Ys] of [['ALL', done], ['1st half', H1], ['2nd half', H2]]) { const rs = titles.filter(t => Ys.includes(t.Y));
    const r = res[nm] = {n: rs.length, one: rs.filter(t => t.r === 1).length, top3: rs.filter(t => t.r <= 3).length, avg: mean(rs.map(t => t.r)), ll: Lg(rs.map(t => t.p)), eq: mean(rs.map(t => Math.log(t.nF))), sh: seedLL(Ys, 'seed', t => t.nF),
      one75: rs.filter(t => t.r75 === 1).length, avg75: mean(rs.map(t => t.r75)), ll75: Lg(rs.map(t => t.p75)), eq75: mean(rs.map(t => Math.log(t.nF))), all75: mean(rs.map(t => Math.log(t.nT))), ph75: seedLL(Ys, 'pos75', t => t.nT)};
    console.log(`  ${nm.padEnd(9)} play-off start: #1 won ${r.one}/${r.n}, top-3 ${r.top3}, champ avg rank #${r.avg.toFixed(2)} · LL ${r.ll.toFixed(3)} vs equal over the field ${r.eq.toFixed(3)} vs seed history ${r.sh.toFixed(3)}`);
    console.log(`  ${''.padEnd(9)} 75% mark:       #1 won ${r.one75}/${r.n}, champ avg rank #${r.avg75.toFixed(2)} · LL ${r.ll75.toFixed(3)} vs equal over a play-off-sized field ${r.eq75.toFixed(3)} vs equal over all clubs ${r.all75.toFixed(3)} vs ladder-position history ${r.ph75.toFixed(3)}`); }
  console.log(`  top seed won ${titles.filter(t => t.seed === 1).length}/${titles.length} · top-2 seed won ${titles.filter(t => t.seed <= 2).length}/${titles.length}`);
  const beat = h => res[h].ll < res[h].eq && res[h].ll < res[h].sh, v = beat('1st half') && beat('2nd half');
  console.log(`\nVERDICT: ${v ? '🟡 fair -- title odds at the play-off start beat equal odds AND seed history in both halves' : '❌ -- title odds at the play-off start do not beat both baselines in both halves'}`);
  fs.writeFileSync(path.join(CACHE, 'params.json'), JSON.stringify(P));
  if (rest.includes('--json')) fs.writeFileSync(path.join(CACHE, 'backtest.json'), JSON.stringify({P, res, titles, fm: {n: fm.length, all: fl(done), h1: fl(H1), h2: fl(H2), host: hostLL(done), hh1: hostLL(H1), hh2: hostLL(H2)},
    games: {h1: evalM(P, F, H1), h2: evalM(P, F, H2), b1: hb(H1), b2: hb(H2)}, home: {s: Mlast.Hs, i: Mlast.Hi}}));
  process.exit(0);
}
// ---------- live board (+ --export; BP_TODAY=YYYY-MM-DD rewinds it to a past date) ----------
{
  const S0 = await all(), O = await offs(S0), P = loadP(), asOf = new Date(Date.parse(today + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
  const rewind = G => G.map(g => g.d < asOf ? g : unplay(g));   // games on/after asOf count as unplayed (ladder included)
  const S = Object.fromEntries(Object.entries(S0).map(([Y, G]) => [Y, rewind(G)]));
  let Y = CURY; if (!S[Y]?.length) Y--;
  // offseason: once this season is decided, switch to next season's fixture as soon as it is published in full (a preseason board)
  if (premier(S[Y])) { try { const nx = await season(Y + 1), creg = S[Y].filter(g => !g.final).length;
    if (nx.filter(g => !g.final).length >= 0.9 * creg * (L.gpt(Y + 1) / L.gpt(Y)) * 0.85) { S[Y + 1] = rewind(nx); S0[Y + 1] = nx; O[Y + 1] = await official(Y + 1); Y++; } } catch {} }
  const G = S[Y], reg = G.filter(g => !g.final), first = firstFinal(G), done = !!premier(G);
  const finalsStarted = G.some(g => g.final && g.fin), started = reg.some(g => g.fin);
  const stage = done ? 'done' : finalsStarted ? 'play-offs' : started ? 'regular' : 'preseason';
  const fmt = L.fmtOf(Y) || L.fmtOf(9999), N = +(arg('--sims') || 20000), OFF = O[Y];
  // title odds: before the play-offs = the rest of the regular season + the bracket; once they start = FROZEN at the play-off start
  // (ratings fit on games before the first play-off game, actual seeds) -- the user never bets within the play-offs
  const seeds = finalsStarted ? seedsOf(fmt, ladder([...table(reg, Y, OFF).values()]), OFF) : null;
  const M = fit(pool(S, Y), finalsStarted ? first : asOf, P), T = simulate(M, P, reg, Y, OFF, fmt, N, seeds);
  let PG = G, PY = Y, pAsOf = finalsStarted ? first : asOf;
  if (stage === 'preseason' && S[Y - 1]?.length) { PG = S[Y - 1]; PY = Y - 1; pAsOf = firstFinal(PG) || asOf; }
  const {rows} = profile(PG, pool(S, PY), pAsOf, P, PY, O[PY]);
  const TS = SEASONS.concat(Y > CURY ? [Y] : []).filter(Yp => Yp <= Y && premier(S[Yp]) && L.fmtOf(Yp)).map(Yp => { const Gp = S[Yp], ch = premier(Gp); return profile(Gp, pool(S, Yp), firstFinal(Gp), P, Yp, O[Yp]).rows.find(r => r.id === ch); }).filter(Boolean);
  const cuts = tierCuts(TS, FEATS, 1);   // each cutoff = the loosest champion (every champion cleared all of them)
  for (const r of rows) tierScore(r, FEATS, cuts);
  addIndex(rows);
  const prof = new Map(rows.map(r => [r.id, r])), left = reg.filter(g => !g.fin).length, curT = new Set(reg.flatMap(g => [g.h, g.a]));
  let lad = ladder([...table(reg, Y, OFF).values()]);
  if (PY !== Y) { const prev = ladder([...table(PG.filter(g => !g.final), PY, O[PY]).values()]).filter(t => curT.has(t.id)), have = new Set(prev.map(t => t.id)); lad = prev.concat(lad.filter(t => !have.has(t.id))); }
  const posOf = t => PY !== Y ? (prof.get(t.id)?.pos ?? null) : lad.indexOf(t) + 1;
  const fair = p => p < 0.001 ? '—' : p >= 0.5 ? '-' + Math.round(100 * p / (1 - p)) : '+' + Math.round(100 * (1 - p) / p);
  const fv = (k, v) => v == null || !isFinite(v) ? '—' : k === 'pos' ? String(v) : k === 'rtg' || k === 'mgn' || k === 'tdpg' ? (v >= 0 ? '+' : '') + v.toFixed(1) : k === 'pct' ? v.toFixed(1) : /wp|form/.test(k) ? v.toFixed(3) : v.toFixed(2);
  const nP = reg.filter(g => g.fin).length;
  console.log(`${L.label} title odds -- ${lab(Y)} season, games through ${today} · ${nP}/${reg.length} regular-season games played (${(100 * nP / Math.max(1, reg.length)).toFixed(0)}%) · stage: ${stage}${done ? ` · CHAMPION: ${NAMES.get(premier(G))} (odds = frozen at the play-off start)` : finalsStarted ? ' (odds frozen at the play-off start)' : ''}`);
  console.log(`format: ${fmt} (top ${FMT[fmt].N})${L.fmtOf(Y) && !L.assumed?.(Y) ? '' : ' -- ASSUMED, the league has not confirmed this season\'s play-off format in the data'} · bonus points: ${(b => `${b.tb === '4' ? '4+ tries' : '3+ tries more than the opponent' + (b.tb === '3moreW' ? ' (winners)' : '')}, lose by ≤${b.lb}`)(L.bonus(Y))}`);
  if (PY !== Y) console.log(`tiers/index = ${lab(PY)} end of the regular season (${lab(Y)} hasn't started) -- title odds are preseason, from ratings that fade toward average (untested stage)`);
  console.log(`VERDICT ${L.verdict}`);
  console.log(`model: half-life ${P.half} d, shrink ${P.lam}, sigma ${P.sig} pts · home edge ${M.Hs.toFixed(1)} pts (same country) / ${M.Hi.toFixed(1)} pts (travelling visitor)`);
  console.log(`TIERS -- every-champion profile (${TS.length} champions): ${FEATS.map((f, i) => cutLabel(f, cuts[i], v => fv(f.k, +v))).join(' · ') || '(none)'}`);
  console.log(`index (0-100) = ${Object.entries(IDXW).map(([k, w]) => `${{rtg: 'Rating', wp: 'Win%', awp: 'Away win%', hwp: 'Home win%', mgn: 'Margin/g', pct: 'Pct', ppg: 'Ladder pts/g', bpg: 'Bonus pts/g', tdpg: 'Try diff/g', pos: 'Ladder position'}[k] || k} ${w}`).join(' · ')}\n`);
  for (const t of lad.slice().sort((a, b) => (T.get(b.id) || 0) - (T.get(a.id) || 0) || (prof.get(b.id)?.idx ?? 0) - (prof.get(a.id)?.idx ?? 0))) {
    const p = T.get(t.id) || 0, r = prof.get(t.id), pos = posOf(t) ?? '-';
    console.log(`  ${TIER_NAME(r ? r.score : 0).padEnd(18)} ${String(NAMES.get(t.id)).padEnd(26)} #${String(pos).padEnd(2)} ${String(t.pts).padStart(3)} pts (${t.w}-${t.l}${t.d ? '-' + t.d : ''}, diff ${t.pf - t.pa >= 0 ? '+' : ''}${t.pf - t.pa}) | idx ${r ? r.idx.toFixed(1).padStart(5) : '    —'} | rating ${(M.r.get(t.id) ?? 0) >= 0 ? '+' : ''}${(M.r.get(t.id) ?? 0).toFixed(1)} | title ${(100 * p).toFixed(1).padStart(5)}% (fair ${fair(p)})${r && FEATS.length ? ' | ' + FEATS.map((f, i) => `${r.q[i] ? '✓' : '✗'} ${f.label}`).join(' · ') : ''}`); }
  if (arg('--export')) {
    const gpNow = [...table(reg, Y, null).values()].map(t => t.gp);
    const out = {league: lk, label: L.label, season: Y, season_label: lab(Y), profile_season: PY, gp_now: [Math.min(...gpNow), Math.max(...gpNow)], generated: new Date().toISOString(), today, stage, first_final: first || null, games_left: left, sims: N,
      premier: done ? NAMES.get(premier(G)) : null, champions: TS.length, sig: P.sig, hfa: {same: +M.Hs.toFixed(2), inter: +M.Hi.toFixed(2)}, fmt,
      cats: FEATS.map((f, i) => cutLabel(f, cuts[i], v => fv(f.k, +v))), labels: FEATS.map(f => f.label),
      teams: lad.map(t => { const r = prof.get(t.id);
        return {id: t.id, name: NAMES.get(t.id) || t.id, reg: REG(t.id), pos: posOf(t), gp: t.gp, w: t.w, l: t.l, d: t.d, pts: t.pts, pf: t.pf, pa: t.pa,
          p: T.get(t.id) || 0, minor: T.minor.get(t.id) || 0, score: r ? r.score : 0, q: r ? r.q : FEATS.map(() => false),
          vals: FEATS.map(f => !r ? '—' : f.k === 'pos' ? fv('pos', r.pos) : `${fv(f.k, r[f.k])} #${r['r_' + f.k]}`), idx: r ? +r.idx.toFixed(1) : null, rtg: +(M.r.get(t.id) ?? 0).toFixed(2)}; })};
    fs.writeFileSync(arg('--export'), JSON.stringify(out)); console.log('\nexported -> ' + arg('--export'));
  }
  const bk = arg('--book');
  if (bk) { console.log('\nBOOK PRICES (pasted, DraftKings/FanDuel screenshot) -- EV = model p x decimal odds - 1' + (finalsStarted ? ' · play-offs started: NO BET (odds frozen)' : ''));
    for (const pair of bk.split(',')) { const m = pair.trim().match(/^(.*?):\s*([+-]?\d+)$/); if (!m) continue; const am = +m[2], dec = am > 0 ? 1 + am / 100 : 1 + 100 / -am, w = m[1].trim().toLowerCase();
      const id = [...NAMES].filter(([k]) => curT.has(k)).find(([, n]) => n.toLowerCase() === w || n.toLowerCase().includes(w) || w.includes(n.toLowerCase()))?.[0], p = id ? (T.get(id) || 0) : null;
      console.log(`  ${m[1].padEnd(22)} ${m[2].padStart(6)} implied ${(100 / dec).toFixed(1)}% | model ${p == null ? 'n/a' : (100 * p).toFixed(1) + '% (fair ' + fair(p) + ') -> EV ' + (p * dec - 1 >= 0 ? '+' : '') + Math.round(100 * (p * dec - 1)) + '%'}`); } }
  if (rest.includes('--log')) {
    const file = `C:/Users/User/baseball-blueprint/${lk}-history.md`, head = `# ${L.label} Title Blueprint — Run History\n\nEach run prepends a dated snapshot (engine: baseball-blueprint/pro/union.mjs ${lk}).\n\n---\n\n`;
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : head, i = old.indexOf('---\n\n');
    let body = i >= 0 ? old.slice(i + 5) : ''; if (body.startsWith(`## ${today} `)) { const nx = body.indexOf('\n## '); body = nx >= 0 ? body.slice(nx + 1) : ''; }
    const entry = `## ${today} (${lab(Y)} season, ${stage}, ${nP}/${reg.length} regular-season games played${done ? `, champion ${NAMES.get(premier(G))}` : ''})\n\n${[...T].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, p]) => `- ${NAMES.get(id)} ${prof.get(id) && FEATS.length ? prof.get(id).score + '/' + FEATS.length + ' · ' : ''}${(100 * p).toFixed(1)}% (fair ${fair(p)})`).join('\n')}\n\n`;
    fs.writeFileSync(file, i >= 0 ? old.slice(0, i + 5) + entry + body : old + entry); console.log('\nlogged to ' + file);
  }
}
