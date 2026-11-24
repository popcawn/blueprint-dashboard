// NBL (Australia, men) championship engine (built 2026-11-24, same house pattern as rugby.mjs / afl.mjs).
// Data: Wikipedia season pages' raw wikitext (every game box: date, home/away, score, section = regular season vs finals), 2003-04 on;
// 2018-19..2021-22 regular seasons and 2017-18+ finals live on their own pages. The current season's past games that Wikipedia has not
// scored yet are filled from ESPN's public NBL scoreboard (league slug `nbl`, carries 2022-23 on). Cached in %TEMP%/pro_bp_cache/nbl.
// Season Y = the season that STARTS in year Y (Y 2026 = NBL27 = 2026-27).
// Model: team ratings from game MARGINS (recency-weighted ridge regression) + one home edge; P(home win) = Phi(margin / sigma).
// Season sim: remaining regular-season games -> ladder (win %, then head-to-head, then percentage) -> finals:
//   2009-10..2015-16: top 4, best-of-3 semis (1v4, 2v3), best-of-3 Grand Final
//   2016-17..2021-22: top 4, best-of-3 semis, best-of-5 Grand Final (2019-20 GF stopped at 2-1, Perth crowned after Sydney withdrew)
//   2022-23 on: play-in (3v4 -> 3rd seed; 5v6 loser out; loser 3v4 v winner 5v6 -> 4th seed), best-of-3 semis, best-of-5 Grand Final
// The higher seed hosts games 1, 3 and 5 of a series (games 1 and 3 of a best-of-3).
//   node nbl.mjs [live] [--log] [--book "Sydney:+150,Melbourne:+300,..."] [--export file] [--sims N]     the board (BP_TODAY=YYYY-MM-DD rewinds it)
//   node nbl.mjs check      seasons, game counts, champions, computed finals seeds vs the real finals field
//   node nbl.mjs backtest [--frac 0.75]   games + finals games + title odds at the start of the finals and at --frac of the regular season (writes params.json)
//   node nbl.mjs dump       end-of-regular-season profiles -> study/data/nbl.json (then: node ../study/criteria.mjs nbl)
//   node nbl.mjs index      index-weight candidates ranked by where past champions landed in the finals field
//   node nbl.mjs xcheck     every 2009-10+ Wikipedia result vs BetExplorer's results pages · raw --y YYYY / table --y YYYY = debug views
// RESULT 2026-11-24: odds model beats equal odds + ladder-position history at the start of the finals in both halves, but the every-champion
// rule fails its honest test (worse than a coin flip over the finals field) -> verdict ❌ by the house rule; no /nbl-blueprint command.
// NO KALSHI / Polymarket. The Odds API has NBL game lines but no outright market -> prices only from the user's DraftKings/FanDuel screenshot.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {TIER_NAME, rankRows, cutoffs as tierCuts, score as tierScore, cutLabel} from './tiers.mjs';

const L = {label: 'NBL', first: 2003, fmtFirst: 2009, P: {half: 120, lam: 3, sig: 11},   // P = tuned by `backtest` on 2003-04..2014-15 games
  fmtOf: Y => Y >= 2022 ? 'playin' : Y >= 2016 ? 'four5' : Y >= 2009 ? 'four3' : null,
  // one key per club across renames/relocations
  alias: {'wollongong-hawks': 'illawarra-hawks', 'melbourne-tigers': 'melbourne-united', 'hunter-pirates': 'singapore-slingers', 'se-melbourne-phoenix': 'south-east-melbourne-phoenix',
    'victoria-giants': 'victoria-titans', 'bullets-bullets': 'brisbane-bullets', 'the-hawks': 'illawarra-hawks'},
  code: {A36: 'adelaide-36ers', BB: 'brisbane-bullets', CT: 'cairns-taipans', GCB: 'gold-coast-blaze', HP: 'hunter-pirates', MT: 'melbourne-tigers', NZ: 'new-zealand-breakers',
    PW: 'perth-wildcats', SD: 'south-dragons', SK: 'sydney-kings', SS: 'singapore-slingers', SST: 'singapore-slingers', VG: 'victoria-giants', WH: 'wollongong-hawks',
    TC: 'townsville-crocodiles', WSR: 'west-sydney-razorbacks'},
  full: {'adelaide-36ers': 'Adelaide 36ers', 'brisbane-bullets': 'Brisbane Bullets', 'cairns-taipans': 'Cairns Taipans', 'gold-coast-blaze': 'Gold Coast Blaze',
    'illawarra-hawks': 'Illawarra Hawks', 'melbourne-united': 'Melbourne United', 'new-zealand-breakers': 'New Zealand Breakers', 'perth-wildcats': 'Perth Wildcats',
    'south-east-melbourne-phoenix': 'South East Melbourne Phoenix', 'sydney-kings': 'Sydney Kings', 'tasmania-jackjumpers': 'Tasmania JackJumpers',
    'townsville-crocodiles': 'Townsville Crocodiles', 'singapore-slingers': 'Singapore Slingers', 'south-dragons': 'South Dragons', 'west-sydney-razorbacks': 'West Sydney Razorbacks',
    'victoria-titans': 'Victoria Titans'},
  // every-champion rule (study/criteria.mjs nbl on `node nbl.mjs dump`, 2026-11-24): all 23 champions 2003-04..2025-26 cleared all 5 at the end of the
  // regular season; ~2.0 of the ~5.3 finals teams do. HONEST TEST FAILED: the hidden champion cleared all 5 in only 16/23 (9/12 | 7/11) and as a
  // predictor the rule was WORSE than a coin flip over the finals field (log-loss 1.68 vs 1.63; 1st half 1.51 vs 1.71, 2nd half 1.87 vs 1.53).
  // Misses: 2008-09 South Dragons, 2010-11 NZ, 2014-15 NZ, 2016-17 Perth, 2021-22 Sydney, 2023-24 Tasmania, 2024-25 Illawarra. -> tiers = context only.
  FEATS: [{k: 'pos', dir: -1, kind: 'value', label: 'Ladder position'}, {k: 'pfpg', dir: 1, kind: 'value', label: 'Points for/game'}, {k: 'papg', dir: -1, kind: 'rank', label: 'Points against/game'},
    {k: 'rtg', dir: 1, kind: 'value', label: 'Rating'}, {k: 'form5', dir: 1, kind: 'rank', label: 'Form (last 5)'}],
  // index (`node nbl.mjs index`): champion's rank inside the finals field avg #1.35, #1 in 16/23, top-3 23/23 (1st half #1.33 | 2nd #1.36);
  // rating alone #1.70 (#1.83 | #1.55), win% alone #1.48 (#1.25 | #1.73) -> beats the rating in both halves
  IDXW: {wp: 50, rtg: 25, hwp: 25}};
const [mode0 = 'live', ...rest] = process.argv.slice(2);
const mode = mode0.startsWith('--') ? 'live' : mode0; if (mode0.startsWith('--')) rest.unshift(mode0);
const arg = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
const CACHE = path.join(os.tmpdir(), 'pro_bp_cache', 'nbl'); fs.mkdirSync(CACHE, {recursive: true});
const today = process.env.BP_TODAY || new Date().toLocaleDateString('en-CA');
const UA = 'blueprint-research-script/1.0 (personal sports model; low volume)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const MON = {jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12};
const CURY = +today.slice(5, 7) >= 7 ? +today.slice(0, 4) : +today.slice(0, 4) - 1;   // season that contains today (or the one just finished)
const SL = Y => `${Y}-${String((Y + 1) % 100).padStart(2, '0')}`;
const pad2 = n => String(n).padStart(2, '0');

// ---------- data ----------
async function getText(url, file, maxAgeH, ua = UA) {
  const f = path.join(CACHE, file);
  if (fs.existsSync(f) && (maxAgeH == null || Date.now() - fs.statSync(f).mtimeMs < maxAgeH * 3600e3)) return fs.readFileSync(f, 'utf8');
  for (let a = 0; a < 4; a++) {
    try { const r = await fetch(url, {headers: {'User-Agent': ua, 'Accept-Encoding': 'gzip'}, signal: AbortSignal.timeout(60e3)});
      if (r.ok) { const t = await r.text(); fs.writeFileSync(f, t); await sleep(700); return t; } if (r.status === 404) { fs.writeFileSync(f, ''); return ''; } } catch {}
    await sleep(2500 * (a + 1));
  }
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}
const wiki = (title, maxAgeH) => getText(`https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(title.replace(/ /g, '_'))}&action=raw`, 'w_' + title.replace(/[^A-Za-z0-9]+/g, '_') + '.txt', maxAgeH);
const slug = s => s.toLowerCase().replace(/\./g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const canon = s => L.alias[s] || s;
const clean = s => s.replace(/<ref[^>]*\/>|<ref[\s\S]*?<\/ref>/g, '').replace(/'''?/g, '').replace(/\{\{[^}]*\}\}/g, ' ').replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
function pdate(s) {
  let m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return `${m[3]}-${pad2(+m[2])}-${pad2(+m[1])}`;
  m = s.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/); if (m && MON[m[2].toLowerCase()]) return `${m[3]}-${pad2(MON[m[2].toLowerCase()])}-${pad2(+m[1])}`;
  m = s.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/); if (m && MON[m[1].toLowerCase()]) return `${m[3]}-${pad2(MON[m[1].toLowerCase()])}-${pad2(+m[2])}`;
  m = s.match(/(\d{4})\|(\d{1,2})\|(\d{1,2})/); if (m) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`;
  return null;
}
// a template's named parameters: split the body on '|' outside nested [[ ]] / {{ }}
function tparams(body) {
  const s = body.replace(/^\s*\{\{/, '').replace(/\}\}\s*$/, ''), parts = []; let d = 0, cur = '';
  for (let i = 0; i < s.length; i++) { const two = s.slice(i, i + 2);
    if (two === '[[' || two === '{{') { d++; cur += two; i++; continue; } if ((two === ']]' || two === '}}') && d > 0) { d--; cur += two; i++; continue; }
    if (s[i] === '|' && d === 0) { parts.push(cur); cur = ''; continue; } cur += s[i]; }
  parts.push(cur);
  const o = {}; for (const p of parts.slice(1)) { const m = p.match(/^\s*([A-Za-z0-9_ ]+?)\s*=([\s\S]*)$/); if (m) o[m[1]] = m[2].trim(); }
  return o;
}
const SKIPPED = [];
const SKIP_RE = /pre-?season|exhibition|blitz|all-?star|ignite|international|tour\b|transaction|award|statistic|attendance|player|coach|signing|import|draft|ladder|standing/i;
const FIN_RE = /final|play-?in|playoff|semi|elimination|qualif/i;
// parse one wikitext page into games; allFinals = a finals page (every box is a final)
function parsePage(txt, allFinals, src) {
  const out = []; let h = [];
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i], hm = ln.match(/^(={2,5})\s*(.*?)\s*\1\s*$/);
    if (hm) { const lv = hm[1].length; h = h.slice(0, lv - 2); h[lv - 2] = clean(hm[2]); continue; }
    const sec = h.filter(Boolean).join(' / ');
    let g = null;
    if (/\{\{\s*NBLMatchSummaryLine/i.test(ln)) {
      const kv = k => (ln.match(new RegExp('\\|\\s*' + k + '\\s*=\\s*([^|}]*)')) || [])[1]?.trim() ?? '';
      const sc = kv('score').match(/(\d+)\s*[–-]\s*(\d+)/);
      g = {d: pdate(kv('date')), h: L.code[kv('hometeam')] || slug(kv('hometeam')), a: L.code[kv('awayteam')] || slug(kv('awayteam')), hs: sc ? +sc[1] : null, as: sc ? +sc[2] : null, place: clean(kv('venue'))};
    } else if (/\{\{\s*basketballbox/i.test(ln)) {
      let body = ln, j = i, depth = 0;   // read until the box's braces close
      for (;;) { for (const c of lines[j].matchAll(/\{\{|\}\}/g)) depth += c[0] === '{{' ? 1 : -1; if (depth <= 0 || j >= lines.length - 1) break; j++; body += '\n' + lines[j]; }
      i = j;
      const pr = tparams(body), kv = (...ks) => { for (const k of ks) if (pr[k] != null) return pr[k]; return ''; };
      const sA = clean(kv('scoreA', 'score1')).match(/\d+/), sB = clean(kv('scoreB', 'score2')).match(/\d+/);
      const tA = clean(kv('teamA', 'team1')).replace(/\s*\(.*\)$/, ''), tB = clean(kv('teamB', 'team2')).replace(/\s*\(.*\)$/, '');
      g = {d: pdate(clean(kv('date')) + ' ' + kv('date')), h: slug(tA), a: slug(tB), hs: sA ? +sA[0] : null, as: sB ? +sB[0] : null, place: clean(kv('place', 'venue'))};
    }
    if (!g) continue;
    if (!allFinals && SKIP_RE.test(sec) && !/regular season/i.test(sec)) { SKIPPED.push(g); continue; }   // kept aside: ESPN must not re-add them (e.g. the Ignite Cup final)
    if (/all-?star/i.test(g.h + g.a)) continue;
    g.h = canon(g.h); g.a = canon(g.a);
    g.sec = sec; g.final = allFinals || (FIN_RE.test(sec) && !/round \d|regular season(?! \/ .*final)/i.test(sec)); g.gf = g.final && /grand final|^final|\/ final|championship series/i.test(sec) && !/semi|play-?in|elimination|qualif|quarter/i.test(sec.split(' / ').pop());
    g.src = src; out.push(g);
  }
  return out;
}
// ESPN fill (current season only): games on dates whose Wikipedia box has no score yet, plus finals games Wikipedia doesn't list yet
const ESPN_NAME = {'s.e. melbourne phoenix': 'south-east-melbourne-phoenix', 'south east melbourne phoenix': 'south-east-melbourne-phoenix'};
async function espnDay(d) {
  const old = d < new Date(Date.parse(today) - 3 * 864e5).toISOString().slice(0, 10);
  const t = await getText(`https://site.api.espn.com/apis/site/v2/sports/basketball/nbl/scoreboard?dates=${d.replace(/-/g, '')}`, `espn_${d}.json`, old ? null : 3);
  try { return (JSON.parse(t).events || []).map(e => { const c = e.competitions[0], H = c.competitors.find(x => x.homeAway === 'home'), A = c.competitors.find(x => x.homeAway === 'away');
    const nm = x => canon(ESPN_NAME[x.team.displayName.toLowerCase()] || slug(x.team.displayName));
    return {d: e.date.slice(0, 10), h: nm(H), a: nm(A), hs: e.status.type.completed ? +H.score : null, as: e.status.type.completed ? +A.score : null, post: /post/.test(e.season?.slug || ''), neutral: !!c.neutralSite}; }); } catch { return []; }
}
// hand corrections, each confirmed by a second source (BetExplorer result + the official finals field): `node nbl.mjs xcheck` lists the rest
const FIX = [{Y: 2016, d: '2016-12-02', h: 'new-zealand-breakers', a: 'illawarra-hawks', hs: 91, as: 95}];   // Wikipedia had 95-91 NZ; Illawarra won (they, not NZ, made the 2017 finals)
const SEAS = {};
async function season(Y) {
  if (SEAS[Y]) return SEAS[Y];
  const yy = pad2((Y + 1) % 100), age = Y >= CURY ? 6 : null, pages = [[`${Y}–${yy} NBL season`, false]];
  if (Y >= 2018 && Y <= 2021) pages.push([`${Y}–${yy} NBL regular season`, false]);
  if (Y >= 2017) pages.push([`${Y + 1} NBL Finals`, true]);
  let G = [];
  for (const [t, fin] of pages) { const txt = await wiki(t, age); G.push(...parsePage(txt, fin, t)); }
  for (const g of G) if (g.d) { const m = +g.d.slice(5, 7); g.d = (m >= 7 ? Y : Y + 1) + g.d.slice(4); }   // Wikipedia year typos (e.g. "25/11/2020" in 2010-11)
  // finals pages / finals sections also show the two clubs' REGULAR-SEASON meetings: a "final" dated on or before the last regular-season
  // game is one of those (the copy in the regular-season section is kept)
  const lastReg0 = G.filter(g => g.d && !g.final).map(g => g.d).sort().pop();
  G = G.filter(g => g.d && !(g.final && g.d <= lastReg0));
  // dedupe (finals boxes can appear on both the season page and the finals page): same date + same two clubs; the first copy wins
  const seen = new Map();
  for (const g of G) { const k = `${g.d}|${[g.h, g.a].sort().join('|')}`, o = seen.get(k);
    if (!o) seen.set(k, g); else if (o.hs == null && g.hs != null) { o.hs = g.hs; o.as = g.as; o.h = g.h; o.a = g.a; } }
  G = [...seen.values()];
  if (Y >= CURY && Y >= 2022) {   // ESPN fill for the live season
    const need = [...new Set(G.filter(g => g.hs == null && g.d < today).map(g => g.d))];
    const lastReg = G.filter(g => !g.final).map(g => g.d).sort().pop();
    if (lastReg && today > lastReg) for (let t = Date.parse(lastReg) + 864e5; t < Date.parse(today) && need.length < 80; t += 864e5) need.push(new Date(t).toISOString().slice(0, 10));
    for (const d of need) for (const e of [...await espnDay(d), ...await espnDay(new Date(Date.parse(d) - 864e5).toISOString().slice(0, 10))]) {
      if (e.hs == null) continue;
      const m = G.find(g => g.hs == null && Math.abs(Date.parse(g.d) - Date.parse(e.d)) <= 2 * 864e5 && ((g.h === e.h && g.a === e.a) || (g.h === e.a && g.a === e.h)));
      if (m) { if (m.h === e.h) { m.hs = e.hs; m.as = e.as; } else { m.hs = e.as; m.as = e.hs; } m.src += '+espn'; }
      else if (e.post && e.d > lastReg && !G.some(g => g.d === e.d && [g.h, g.a].sort().join() === [e.h, e.a].sort().join())) {
        // a "post-season" game Wikipedia doesn't list yet counts as a final only once the regular season is complete, between two clubs of the
        // finals field, and not a game Wikipedia files outside the regular season/finals (ESPN tags the Ignite Cup final "post-season" too)
        const regG = G.filter(g => !g.final), top = ladderIds(regG.filter(g => g.hs != null).map(g => ({...g, fin: true, Y}))).slice(0, nFin(L.fmtOf(Y)));
        const cupDay = SKIPPED.some(g => g.d && Math.abs(Date.parse(g.d.replace(/^d{4}/, String(+g.d.slice(5, 7) >= 7 ? Y : Y + 1))) - Date.parse(e.d)) <= 864e5 && [g.h, g.a].sort().join() === [e.h, e.a].sort().join());
        if (regG.every(g => g.hs != null) && top.includes(e.h) && top.includes(e.a) && !cupDay) G.push({...e, final: true, gf: false, sec: 'ESPN post-season', src: 'espn'});
      }
    }
  }
  for (const c of FIX) if (c.Y === Y) { const g = G.find(x => x.d === c.d && x.h === c.h && x.a === c.a); if (g) { g.hs = c.hs; g.as = c.as; g.src += '+fix'; } }
  for (const g of G) { g.Y = Y; g.fin = g.hs != null && g.as != null && !(g.hs === 0 && g.as === 0); if (!g.fin) { g.hs = null; g.as = null; } g.neutral = !!g.neutral; }
  if (Y < CURY) G = G.filter(g => g.fin);   // past seasons: drop cancelled / never-played fixtures
  // games were 48 minutes through 2008-09 and 40 minutes from 2009-10 (league scoring fell from ~100 to ~84 a team): put the 48-minute
  // seasons on the 40-minute scale (x 40/48) so margins, ratings and points/game mean the same thing in every season. Win/loss unchanged.
  if (Y <= 2008) for (const g of G) if (g.fin) { g.hs *= 40 / 48; g.as *= 40 / 48; }
  G.sort((x, y) => x.d.localeCompare(y.d));
  G.forEach((g, i) => { g.id = `${Y}-${i}`; });
  return SEAS[Y] = G;
}
// champion = the Grand Final series winner (most GF wins; 2019-20: Perth led 2-1 when Sydney withdrew)
const premier = G => { const gf = G.filter(g => g.gf && g.fin); if (!gf.length) return null; const w = new Map();
  for (const g of gf) { const x = g.hs > g.as ? g.h : g.a; w.set(x, (w.get(x) || 0) + 1); }
  const need = gf.length >= 4 || [...w.values()].some(v => v >= 3) ? 3 : 2, best = [...w].sort((a, b) => b[1] - a[1])[0];
  const Y = G[0]?.Y; if (Y === 2019) return best[0];   // GF abandoned at 2-1 (COVID) -> Perth awarded the title
  return best[1] >= need || G[0]?.Y < CURY ? best[0] : null; };

const SEASONS = Array.from({length: CURY - L.first + 1}, (_, i) => L.first + i);
const nameOf = id => L.full[id] || id;
if (mode === 'raw') {   // debug: games by section for one season
  const Y = +(arg('--y') || CURY), G = await season(Y), by = {};
  for (const g of G) { const k = (g.final ? (g.gf ? 'GF ' : 'FIN ') : 'REG ') + g.sec.slice(0, 70); by[k] = (by[k] || 0) + 1; }
  console.log(by);
  const T = {}; for (const g of G.filter(g => !g.final)) for (const t of [g.h, g.a]) T[t] = (T[t] || 0) + 1; console.log(T);
  console.log(G.filter(g => g.final).map(g => `${g.d} ${g.h} ${g.hs}-${g.as} ${g.a} ${g.gf ? 'GF' : ''} [${g.src}]`).join('\n'));
  process.exit(0);
}

// ---------- ratings ----------
function fit(games, asOf, P) {
  const G = games.filter(g => g.fin && g.d < asOf), t0 = Date.parse(asOf + 'T12:00:00Z');
  const w = G.map(g => Math.pow(0.5, (t0 - Date.parse(g.d + 'T12:00:00Z')) / 864e5 / P.half)), m = G.map(g => g.hs - g.as);
  const T = [...new Set(G.flatMap(g => [g.h, g.a]))], r = new Map(T.map(t => [t, 0])), idx = new Map();
  for (const [i, g] of G.entries()) for (const t of [g.h, g.a]) { if (!idx.has(t)) idx.set(t, []); idx.get(t).push(i); }
  let H = 3;
  for (let it = 0; it < 40; it++) {
    for (const t of T) { let den = P.lam, n2 = 0; for (const i of idx.get(t)) { const g = G[i], s = g.h === t ? 1 : -1, other = r.get(g.h === t ? g.a : g.h); den += w[i]; n2 += w[i] * (s * (m[i] - (g.neutral ? 0 : H)) + other); } r.set(t, n2 / den); }
    const mu = T.length ? mean([...r.values()]) : 0; for (const t of T) r.set(t, r.get(t) - mu);
    let ss = 0, ws = 0; for (const [i, g] of G.entries()) { if (g.neutral) continue; ss += w[i] * (m[i] - (r.get(g.h) - r.get(g.a))); ws += w[i]; }
    H = ws ? ss / ws : 0;
  }
  return {r, H};
}
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
const Phi = x => 0.5 * (1 + erf(x / Math.SQRT2));
const predMargin = (M, h, a, neutral) => (M.r.get(h) ?? 0) - (M.r.get(a) ?? 0) + (neutral ? 0 : M.H);
const pHome = (M, h, a, neutral, P) => Phi(predMargin(M, h, a, neutral) / P.sig);
const LLf = (p, y) => -(y * Math.log(Math.max(p, 1e-6)) + (1 - y) * Math.log(Math.max(1 - p, 1e-6)));
const randn = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// ---------- ladder: win %, then (to 2016-17) head-to-head wins among the tied clubs -> head-to-head margin -> percentage;
// from 2017-18 the overall points percentage (Wikipedia's ladder notes quote both rules; this reproduces every finals field 2009-10..2025-26)
const tieRule = Y => Y >= 2017 ? 'pct' : 'h2h';
function makeTab(ids, games, Y) {   // arrays indexed like ids
  const n = ids.length, ix = new Map(ids.map((t, i) => [t, i])), W = new Float64Array(n), GP = new Float64Array(n), PF = new Float64Array(n), PA = new Float64Array(n);
  const HW = new Float64Array(n * n), HD = new Float64Array(n * n);
  for (const g of games) { if (!g.fin) continue; const h = ix.get(g.h), a = ix.get(g.a); if (h == null || a == null) continue; addRes(W, GP, PF, PA, HW, HD, n, h, a, g.hs, g.as); }
  return {ids, ix, n, W, GP, PF, PA, HW, HD, rule: tieRule(Y)};
}
function addRes(W, GP, PF, PA, HW, HD, n, h, a, hs, as) {
  GP[h]++; GP[a]++; PF[h] += hs; PA[h] += as; PF[a] += as; PA[a] += hs;
  if (hs > as) { W[h]++; HW[h * n + a]++; } else { W[a]++; HW[a * n + h]++; }
  HD[h * n + a] += hs - as; HD[a * n + h] += as - hs;
}
function order(T) {   // -> team indexes, best first
  const {n, W, GP, PF, PA, HW, HD} = T, wp = i => GP[i] ? W[i] / GP[i] : 0, o = [...Array(n).keys()].sort((x, y) => wp(y) - wp(x));
  const out = [];
  for (let i = 0; i < o.length;) { let j = i; while (j + 1 < o.length && Math.abs(wp(o[j + 1]) - wp(o[i])) < 1e-9) j++;
    const grp = o.slice(i, j + 1);
    if (grp.length > 1 && T.rule === 'pct') grp.sort((x, y) => PF[y] / Math.max(1, PA[y]) - PF[x] / Math.max(1, PA[x]));
    else if (grp.length > 1) { const hw = x => grp.reduce((s, y) => s + (y === x ? 0 : HW[x * n + y]), 0), hg = x => grp.reduce((s, y) => s + (y === x ? 0 : HW[x * n + y] + HW[y * n + x]), 0),
        hd = x => grp.reduce((s, y) => s + (y === x ? 0 : HD[x * n + y]), 0), hp = x => hg(x) ? hw(x) / hg(x) : 0.5, pc = x => PA[x] ? PF[x] / PA[x] : 1;
      grp.sort((x, y) => hp(y) - hp(x) || hd(y) - hd(x) || pc(y) - pc(x)); }
    out.push(...grp); i = j + 1; }
  return out;
}
const ladderIds = (reg) => { const ids = [...new Set(reg.flatMap(g => [g.h, g.a]))], T = makeTab(ids, reg, reg[0]?.Y ?? CURY); return order(T).map(i => ids[i]); };

// ---------- finals ----------
const NF = {four3: 4, four5: 4, playin: 6}, nFin = fmt => NF[fmt];
function finals(seeds, game, series, fmt) {   // seeds = ids best first; game(home, away) -> winner; series(hi, lo, bestOf) -> winner (hi hosts games 1, 3, 5)
  const rk = id => seeds.indexOf(id), hiLo = (x, y) => rk(x) < rk(y) ? [x, y] : [y, x];
  let s1, s2, s3, s4;
  if (fmt === 'playin') { const [a1, a2, a3, a4, a5, a6] = seeds, w34 = game(a3, a4), l34 = w34 === a3 ? a4 : a3, w56 = game(a5, a6), s4b = game(...hiLo(l34, w56)); s1 = a1; s2 = a2; s3 = w34; s4 = s4b; }
  else [s1, s2, s3, s4] = seeds;
  const f1 = series(s1, s4, 3), f2 = series(s2, s3, 3);
  return series(...hiLo(f1, f2), fmt === 'four3' ? 3 : 5);
}
function simulate(M, P, reg, fmt, N = 20000, fixedSeeds = null) {
  const ids = [...new Set(reg.flatMap(g => [g.h, g.a]))], n = ids.length, base = makeTab(ids, reg, reg[0]?.Y ?? CURY), left = reg.filter(g => !g.fin);
  const mu = left.map(g => predMargin(M, g.h, g.a, g.neutral)), lh = left.map(g => base.ix.get(g.h)), la = left.map(g => base.ix.get(g.a));
  const pc = new Map(), ph = (h, a) => { const k = h + '|' + a; let p = pc.get(k); if (p == null) { p = Phi(predMargin(M, h, a, false) / P.sig); pc.set(k, p); } return p; };
  const game = (h, a) => Math.random() < ph(h, a) ? h : a;
  const series = (hi, lo, bo) => { const need = (bo + 1) / 2; let x = 0, y = 0, k = 0; while (x < need && y < need) { if (k % 2 === 0 ? Math.random() < ph(hi, lo) : Math.random() >= ph(lo, hi)) x++; else y++; k++; } return x === need ? hi : lo; };
  const cup = new Map(), top = new Map(), fin = new Map();
  for (let s = 0; s < N; s++) {
    let seeds = fixedSeeds;
    if (!seeds) {
      const T = {...base, W: base.W.slice(), GP: base.GP.slice(), PF: base.PF.slice(), PA: base.PA.slice(), HW: base.HW.slice(), HD: base.HD.slice()};
      for (let i = 0; i < left.length; i++) { let x = Math.round(mu[i] + P.sig * randn()); if (x === 0) x = Math.random() < 0.5 ? 1 : -1;   // no draws: overtime
        const hs = 85 + Math.max(0, x), as = 85 + Math.max(0, -x); addRes(T.W, T.GP, T.PF, T.PA, T.HW, T.HD, n, lh[i], la[i], hs, as); }
      seeds = order(T).slice(0, nFin(fmt)).map(i => ids[i]);
    }
    top.set(seeds[0], (top.get(seeds[0]) || 0) + 1); for (const t of seeds) fin.set(t, (fin.get(t) || 0) + 1);
    const ch = finals(seeds, game, series, fmt); cup.set(ch, (cup.get(ch) || 0) + 1);
  }
  const out = new Map([...cup].map(([k, v]) => [k, v / N])); out.minor = new Map([...top].map(([k, v]) => [k, v / N])); out.field = new Map([...fin].map(([k, v]) => [k, v / N])); return out;
}
const loadP = () => fs.existsSync(path.join(CACHE, 'params.json')) ? JSON.parse(fs.readFileSync(path.join(CACHE, 'params.json'), 'utf8')) : L.P;
async function all() { const S = {}; for (const Y of [L.first - 2, L.first - 1, ...SEASONS]) S[Y] = Y < L.first ? [] : await season(Y).catch(e => { console.error(Y, e.message); return []; }); return S; }
const pool = (S, Y) => [...(S[Y - 2] || []), ...(S[Y - 1] || []), ...(S[Y] || [])];
const firstFinal = G => G.filter(g => g.final).map(g => g.d).sort()[0];
const finalsField = G => [...new Set(G.filter(g => g.final).flatMap(g => [g.h, g.a]))];

// ---------- champion profile (end of the regular season = the day before the first final) ----------
const FEATS = L.FEATS || [], IDXW = L.IDXW || {rtg: 100};
function profile(G, pl, asOf, P) {
  const reg = G.filter(g => !g.final && g.fin && g.d < asOf), M = fit(pl, asOf, P), T = new Map(), lad = ladderIds(reg);
  for (const g of reg) for (const [me, pf, pa, side] of [[g.h, g.hs, g.as, g.neutral ? 0 : 1], [g.a, g.as, g.hs, g.neutral ? 0 : -1]]) {
    const t = T.get(me) || {id: me, pf: 0, pa: 0, w: 0, l: 0, gp: 0, res: [], hw: 0, hn: 0, aw: 0, an: 0}, r = pf > pa ? 1 : 0;
    t.gp++; t.pf += pf; t.pa += pa; if (r) t.w++; else t.l++; t.res.push([g.d, r]);
    if (side > 0) { t.hw += r; t.hn++; } else if (side < 0) { t.aw += r; t.an++; } T.set(me, t); }
  const rows = lad.map((id, i) => { const t = T.get(id), s = t.res.sort((a, b) => a[0].localeCompare(b[0])), f = n => mean(s.slice(-n).map(x => x[1]));
    return {id, pos: i + 1, gp: t.gp, w: t.w, l: t.l, pf: t.pf, pa: t.pa, wp: t.w / t.gp, pct: 100 * t.pf / Math.max(1, t.pa),
      pfpg: t.pf / t.gp, papg: t.pa / t.gp, mgn: (t.pf - t.pa) / t.gp, rtg: M.r.get(id) ?? 0, form10: f(10), form5: f(5), hwp: t.hn ? t.hw / t.hn : 0, awp: t.an ? t.aw / t.an : 0}; });
  return {rows: rankRows(rows, FEATS), M};
}
function addIndex(rows, W = IDXW) {
  const N = {}, tw = Object.values(W).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(W)) { const dir = k === 'papg' || k === 'pos' ? -1 : 1, v = rows.map(r => +r[k]), lo = Math.min(...v), hi = Math.max(...v);
    N[k] = r => hi === lo ? 50 : 100 * (dir > 0 ? r[k] - lo : hi - r[k]) / (hi - lo); }
  for (const r of rows) r.idx = Object.entries(W).reduce((a, [k, w]) => a + w * N[k](r), 0) / tw;
}
const CANDS = [{k: 'pos', dir: -1, label: 'Ladder position', value: true, rank: false, dec: 0}, {k: 'wp', dir: 1, label: 'Win%', value: true},
  {k: 'pct', dir: 1, label: 'Percentage (PF/PA)', value: true}, {k: 'pfpg', dir: 1, label: 'Points for/game', value: true}, {k: 'papg', dir: -1, label: 'Points against/game', value: true},
  {k: 'mgn', dir: 1, label: 'Margin/game', value: true}, {k: 'rtg', dir: 1, label: 'Rating', value: true}, {k: 'form10', dir: 1, label: 'Form (win%, last 10)', value: true},
  {k: 'form5', dir: 1, label: 'Form (win%, last 5)', value: true}, {k: 'hwp', dir: 1, label: 'Home win%', value: true}, {k: 'awp', dir: 1, label: 'Away win%', value: true}];

if (mode === 'check') {
  const S = await all();
  for (const Y of SEASONS) { const G = S[Y], r = G.filter(g => !g.final), T = {}; for (const g of r) for (const t of [g.h, g.a]) T[t] = (T[t] || 0) + 1;
    const gp = Object.values(T), fmt = L.fmtOf(Y), lad = ladderIds(r.filter(g => g.fin)), fld = finalsField(G);
    // seeds check: the computed top-N must be the finals field (play-in era: top 6); higher seed hosts game 1 of each series
    const topN = fmt ? lad.slice(0, nFin(fmt)) : null, ok = !topN || !fld.length || (topN.every(t => fld.includes(t)) && fld.every(t => topN.includes(t)));
    console.log(`${SL(Y)}: ${r.length} regular (${r.filter(g => g.fin).length} played) · ${Object.keys(T).length} teams, ${Math.min(...gp)}-${Math.max(...gp)} games each · finals ${G.filter(g => g.final).length} (GF ${G.filter(g => g.gf).length}) · premier ${nameOf(premier(G)) ?? '—'} · ${r[0]?.d}..${r.at(-1)?.d} | finals ${G.find(g => g.final)?.d ?? '—'}..${G.filter(g => g.final).at(-1)?.d ?? '—'}${fmt ? ` | ${fmt} seeds ${lad.slice(0, nFin(fmt)).map(t => nameOf(t).split(' ').pop()).join(',')} ${ok ? 'OK' : '!! field ' + fld.map(t => nameOf(t).split(' ').pop()).join(',')}` : ''}`); }
  process.exit(0);
}
if (mode === 'dump') {   // every team's end-of-regular-season profile -> study/data/nbl.json (input for study/criteria.mjs)
  const S = await all(), P = loadP(), K = CANDS.map(c => c.k);
  const out = {sport: 'nbl', label: 'NBL championship', when: 'end of the regular season (start of the finals)', fieldLabel: 'the finals teams (incl. play-in)', universeLabel: 'every NBL team', cands: CANDS, seasons: []};
  for (const Y of SEASONS) {
    const G = S[Y], ch = premier(G); if (!ch) continue;
    const {rows} = profile(G, pool(S, Y), firstFinal(G), P);
    out.seasons.push({Y, champ: ch, champName: `${nameOf(ch)} ${SL(Y)}`, field: finalsField(G), rows: rows.map(r => Object.fromEntries([['id', r.id], ['name', nameOf(r.id)], ...K.map(k => [k, r[k]])]))});
  }
  fs.mkdirSync('C:/Users/User/baseball-blueprint/study/data', {recursive: true});
  fs.writeFileSync('C:/Users/User/baseball-blueprint/study/data/nbl.json', JSON.stringify(out));
  console.log(`dumped ${out.seasons.length} seasons -> study/data/nbl.json · champs: ${out.seasons.map(s => `${SL(s.Y)} ${nameOf(s.champ)} (#${s.rows.find(r => r.id === s.champ).pos} of ${s.field.length})`).join(', ')}`);
  process.exit(0);
}
if (mode === 'index') {   // which index weights best rank past champions inside the finals field (lower avg rank = better), by halves
  const S = await all(), P = loadP(), seas = [];
  for (const Y of SEASONS) { const G = S[Y], ch = premier(G); if (!ch) continue; const {rows} = profile(G, pool(S, Y), firstFinal(G), P), F = new Set(finalsField(G)); seas.push({Y, ch, rows: rows.filter(r => F.has(r.id))}); }
  const half = Math.ceil(seas.length / 2), SETS = [{rtg: 100}, {wp: 100}, {mgn: 100}, {pos: 100}, {rtg: 70, wp: 30}, {rtg: 60, wp: 20, awp: 20}, {rtg: 70, awp: 30}, {rtg: 70, hwp: 30}, {rtg: 70, mgn: 30},
    {rtg: 50, mgn: 50}, {rtg: 70, form10: 30}, {rtg: 80, form5: 20}, {rtg: 60, papg: 40}, {rtg: 60, pfpg: 40}, {rtg: 50, wp: 25, mgn: 25}, {rtg: 50, wp: 50}, {mgn: 50, wp: 50}, {rtg: 60, wp: 20, hwp: 20}, {wp: 70, rtg: 30}, {wp: 70, hwp: 30}, {wp: 50, rtg: 25, hwp: 25}, {wp: 60, rtg: 40}, {wp: 80, form5: 20}];
  for (const W of SETS) { const rk = seas.map(s => { addIndex(s.rows, W); const c = s.rows.find(r => r.id === s.ch); return 1 + s.rows.filter(r => r.idx > c.idx + 1e-9).length + 0.5 * s.rows.filter(r => r !== c && Math.abs(r.idx - c.idx) <= 1e-9).length; });   // ties count half
    const st = a => `avg #${mean(a).toFixed(2)} · #1 ${a.filter(x => x === 1).length}/${a.length} (+${a.filter(x => x > 1 && x < 2).length} tied) · top-3 ${a.filter(x => x <= 3).length}`;
    console.log(`${JSON.stringify(W).padEnd(40)} ALL ${st(rk)} | 1st ${st(rk.slice(0, half))} | 2nd ${st(rk.slice(half))}`); }
  process.exit(0);
}
if (mode === 'backtest') {
  const S = await all(), done = SEASONS.filter(Y => premier(S[Y]));
  const half = Math.ceil(done.length / 2), H1 = done.slice(0, half), H2 = done.slice(half);
  const wk = d => { const t = Date.parse(d + 'T12:00:00Z'), dow = (new Date(t).getUTCDay() + 6) % 7; return new Date(t - dow * 864e5).toISOString().slice(0, 10); };   // Monday of the week
  const weeks = Y => [...new Set(S[Y].filter(g => !g.final).map(g => wk(g.d)))];
  const fitsFor = P => { const F = new Map(); for (const Y of done) for (const w of weeks(Y)) F.set(Y + '|' + w, fit(pool(S, Y), w, P)); return F; };
  const yv = g => g.hs > g.as ? 1 : 0;
  const evalM = (P, F, Ys) => mean(Ys.flatMap(Y => S[Y].filter(g => !g.final && g.fin).map(g => LLf(pHome(F.get(Y + '|' + wk(g.d)), g.h, g.a, g.neutral, P), yv(g)))));
  let best = null; const cache = new Map(), grid = [];
  for (const hl of [60, 120, 240, 365]) for (const lam of [1, 3, 10, 30]) { const F = fitsFor({half: hl, lam}); cache.set(hl + '|' + lam, F);
    for (const sig of [10, 11, 12, 13, 14, 15, 16]) { const P = {half: hl, lam, sig}, ll = evalM(P, F, H1); grid.push([ll, P]); if (!best || ll < best.ll) best = {P, ll}; } }
  if (rest.includes('--grid')) console.log(grid.sort((x, y) => x[0] - y[0]).slice(0, 8).map(([ll, P]) => `${ll.toFixed(4)} ${JSON.stringify(P)}`).join('\n'));
  const P = best.P, F = cache.get(P.half + '|' + P.lam);
  const hb = Ys => { const g = Ys.flatMap(Y => S[Y].filter(x => !x.final && x.fin)), hr = mean(g.map(yv)); return {ll: mean(g.map(x => LLf(hr, yv(x)))), hr}; };
  const acc = Ys => { const g = Ys.flatMap(Y => S[Y].filter(x => !x.final && x.fin)); return mean(g.map(x => (pHome(F.get(x.Y + '|' + wk(x.d)), x.h, x.a, x.neutral, P) > 0.5) === (yv(x) === 1) ? 1 : 0)); };
  console.log(`NBL backtest -- ${SL(done[0])} to ${SL(done.at(-1))} (game halves ${SL(H1[0])}..${SL(H1.at(-1))} / ${SL(H2[0])}..${SL(H2.at(-1))})`);
  console.log(`GAMES (regular season, refit every week): tuned on the 1st half -> half-life ${P.half} d, shrink ${P.lam}, sigma ${P.sig} pts`);
  console.log(`  1st half LL ${evalM(P, F, H1).toFixed(4)} (picks ${(100 * acc(H1)).toFixed(1)}%) vs home-win base rate ${hb(H1).ll.toFixed(4)} (home won ${(100 * hb(H1).hr).toFixed(1)}%)`);
  console.log(`  2nd half (held out) LL ${evalM(P, F, H2).toFixed(4)} (picks ${(100 * acc(H2)).toFixed(1)}%) vs home-win base rate ${hb(H2).ll.toFixed(4)} (home won ${(100 * hb(H2).hr).toFixed(1)}%) · coin 0.6931`);
  const fm = []; for (const Y of done) for (const g of S[Y].filter(g => g.final && g.fin)) { const M = fit(pool(S, Y), g.d, P); fm.push({Y, ll: LLf(pHome(M, g.h, g.a, g.neutral, P), yv(g)), y: yv(g)}); }
  const hostLL = Ys => mean(fm.filter(x => Ys.includes(x.Y)).map(x => LLf(mean(fm.filter(z => z.Y !== x.Y).map(z => z.y)), x.y)));
  const fl = Ys => mean(fm.filter(x => Ys.includes(x.Y)).map(x => x.ll));
  console.log(`\nFINALS GAMES (${fm.length}): model LL ${fl(done).toFixed(4)} (${fl(H1).toFixed(4)} | ${fl(H2).toFixed(4)}) vs "host wins" base rate ${hostLL(done).toFixed(4)} (${hostLL(H1).toFixed(4)} | ${hostLL(H2).toFixed(4)})`);
  // title odds at the start of the finals (actual seeds) and at 75% of the regular season, format era only
  const FR = +(arg('--frac') || 0.75), FL = Math.round(100 * FR) + '%';   // the in-season checkpoint (default 75% of the regular season)
  const TY = done.filter(Y => L.fmtOf(Y)), th = Math.ceil(TY.length / 2), T1 = TY.slice(0, th), T2 = TY.slice(th), titles = [];
  for (const Y of TY) {
    const G = S[Y], reg = G.filter(g => !g.final), ch = premier(G), first = firstFinal(G), fmt = L.fmtOf(Y), lad = ladderIds(reg), seeds = lad.slice(0, nFin(fmt));
    const Tf = simulate(fit(pool(S, Y), first, P), P, reg, fmt, 20000, seeds);
    const ds = reg.map(g => g.d).sort(), d75 = ds[Math.floor(FR * ds.length)], reg75 = reg.map(g => g.d < d75 ? g : {...g, fin: false, hs: null, as: null});
    const T75 = simulate(fit(pool(S, Y), d75, P), P, reg75, fmt, 8000), lad75 = ladderIds(reg75.filter(g => g.fin));
    const rk = (T, id) => 1 + [...T.values()].filter(v => v > (T.get(id) || 0)).length;
    titles.push({Y, fmt, ch: nameOf(ch), seed: seeds.indexOf(ch) + 1, pos75: lad75.indexOf(ch) + 1, p: Tf.get(ch) || 0, r: rk(Tf, ch), p75: T75.get(ch) || 0, r75: rk(T75, ch), nT: lad.length,
      fav: nameOf([...Tf].sort((a, b) => b[1] - a[1])[0][0]), favP: [...Tf].sort((a, b) => b[1] - a[1])[0][1]});
  }
  console.log(`\nCHAMPIONSHIP ODDS (${SL(TY[0])}..${SL(TY.at(-1))}; halves ${SL(T1[0])}..${SL(T1.at(-1))} / ${SL(T2[0])}..${SL(T2.at(-1))}) -- start of the finals (seeds known) | at ${FL} of the regular season`);
  for (const t of titles) console.log(`  ${SL(t.Y)} ${String(t.ch).padEnd(29)} seed ${t.seed} | finals start ${(100 * t.p).toFixed(1).padStart(5)}% (#${t.r}; model #1 ${t.fav} ${(100 * t.favP).toFixed(0)}%) | ${FL}: ladder #${t.pos75}, ${(100 * t.p75).toFixed(1).padStart(5)}% (#${t.r75})`);
  const Lg = a => mean(a.map(p => -Math.log(Math.max(p, 1e-4))));
  // ladder-position history (leave this season out): share of other champions that finished at that ladder position (+0.5 smoothing over the field)
  const posLL = (Ys, key, K) => mean(titles.filter(t => Ys.includes(t.Y)).map(t => { const tr = titles.filter(z => z.Y !== t.Y), k = K(t); return -Math.log((tr.filter(z => z[key] === t[key]).length + 0.5) / (tr.length + 0.5 * k)); }));
  for (const [lab, Ys] of [['ALL', TY], ['1st half', T1], ['2nd half', T2]]) { const rs = titles.filter(t => Ys.includes(t.Y));
    console.log(`  ${lab.padEnd(9)} FINALS START: LL ${Lg(rs.map(t => t.p)).toFixed(3)} vs equal ${mean(rs.map(t => Math.log(nFin(t.fmt)))).toFixed(3)} vs ladder-position history ${posLL(Ys, 'seed', t => nFin(t.fmt)).toFixed(3)} · model #1 won ${rs.filter(t => t.r === 1).length}/${rs.length} · champ avg rank #${mean(rs.map(t => t.r)).toFixed(2)}`);
    console.log(`  ${''.padEnd(9)} ${(FL + ' MARK:').padEnd(13)}LL ${Lg(rs.map(t => t.p75)).toFixed(3)} vs equal ${mean(rs.map(t => Math.log(t.nT))).toFixed(3)} vs ladder-position history ${posLL(Ys, 'pos75', t => t.nT).toFixed(3)} · model #1 won ${rs.filter(t => t.r75 === 1).length}/${rs.length} · champ avg rank #${mean(rs.map(t => t.r75)).toFixed(2)}`); }
  console.log(`  minor premier won ${titles.filter(t => t.seed === 1).length}/${titles.length} · top-2 seed won ${titles.filter(t => t.seed <= 2).length}/${titles.length}`);
  if (!process.env.BP_NOSAVE) fs.writeFileSync(path.join(CACHE, 'params.json'), JSON.stringify(P));
  process.exit(0);
}
if (mode === 'table') { const Y = +arg('--y'), G = (await season(Y)).filter(g => !g.final && g.fin), ids = [...new Set(G.flatMap(g => [g.h, g.a]))], T = makeTab(ids, G, Y);
  for (const i of order(T)) console.log(`${nameOf(ids[i]).padEnd(30)} ${T.W[i]}-${T.GP[i] - T.W[i]}  pct ${(100 * T.PF[i] / T.PA[i]).toFixed(2)}  h2h: ${order(T).filter(j => j !== i).map(j => nameOf(ids[j]).split(' ').pop() + ' ' + T.HW[i * T.n + j] + '-' + T.HW[j * T.n + i]).join(', ')}`); process.exit(0); }
if (mode === 'xcheck') {   // cross-check Wikipedia results against BetExplorer's result pages (cached by the probe in pro_bp_cache/nbl/probe)
  const BE = {perth: 'perth-wildcats', townsville: 'townsville-crocodiles', 'cairns-taipans': 'cairns-taipans', 'new-zealand-breakers': 'new-zealand-breakers', 'melbourne-united': 'melbourne-united',
    'gold-coast': 'gold-coast-blaze', wolves: 'illawarra-hawks', adelaide: 'adelaide-36ers', sydney: 'sydney-kings', 'illawarra-hawks': 'illawarra-hawks', 'brisbane-bullets': 'brisbane-bullets',
    'south-east-melbourne': 'south-east-melbourne-phoenix', 'tasmania-jackjumpers': 'tasmania-jackjumpers'};
  const BUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'; let tot = 0, bad = 0, miss = 0;
  for (const Y of SEASONS.filter(y => y >= 2009 && y < CURY)) {
    const G = await season(Y), be = [], base = `https://www.betexplorer.com/basketball/australia/nbl-${Y}-${Y + 1}/results/`, h0 = await getText(base, `be_${Y}.html`, null, BUA);
    const pages = [h0]; for (const m of new Set([...h0.matchAll(/[?]stage=([A-Za-z0-9]+)"/g)].map(m => m[1]))) pages.push(await getText(base + '?stage=' + m, `be_${Y}_${m}.html`, null, BUA));
    for (const h of pages) {
      for (const m of h.matchAll(/in-match"><span>(?:<strong>)?([^<]+)(?:<\/strong>)?<\/span> - <span>(?:<strong>)?([^<]+)(?:<\/strong>)?<\/span><\/a><\/td><td class="h-text-center"><a[^>]*>(\d+):(\d+)[^<]*<\/a>[\s\S]*?h-text-no-wrap">(\d\d)\.(\d\d)\.(\d{4})?/g)) {
        const mo = +m[6]; be.push({h: BE[slug(m[1])] || slug(m[1]), a: BE[slug(m[2])] || slug(m[2]), hs: +m[3], as: +m[4], d: `${m[7] || (mo >= 7 ? Y : Y + 1)}-${m[6]}-${m[5]}`}); } }
    for (const b of be) { tot++;
      const near = G.filter(g => Math.abs(Date.parse(g.d) - Date.parse(b.d)) <= 3 * 864e5 && [g.h, g.a].sort().join() === [b.h, b.a].sort().join()).sort((x, y) => Math.abs(Date.parse(x.d) - Date.parse(b.d)) - Math.abs(Date.parse(y.d) - Date.parse(b.d)));
      const same = g => (g.h === b.h ? [g.hs, g.as] : [g.as, g.hs]).join() === [b.hs, b.as].join();
      if (near.some(same)) { const g = near.find(same); if (g.h !== b.h) console.log(`${SL(Y)} home/away differs ${b.d}: BetExplorer home ${b.h} | Wikipedia home ${g.h}`); continue; }
      const w = near[0];
      if (!w) { miss++; console.log(`${SL(Y)} not on Wikipedia: ${b.d} ${b.h} ${b.hs}-${b.as} ${b.a}`); continue; }
      const [x, y] = w.h === b.h ? [w.hs, w.as] : [w.as, w.hs];
      if ((x > y) !== (b.hs > b.as) || Math.abs(x - b.hs) + Math.abs(y - b.as) > 0) { bad++; console.log(`${SL(Y)} MISMATCH ${b.d}: BetExplorer ${b.h} ${b.hs}-${b.as} ${b.a} | Wikipedia ${w.d} ${w.h} ${w.hs}-${w.as} ${w.a} ${w.final ? '(final)' : ''}${(x > y) !== (b.hs > b.as) ? '  <-- WINNER DIFFERS' : ''}`); } }
  }
  console.log(`checked ${tot} BetExplorer games: ${bad} score mismatches, ${miss} not found on Wikipedia`); process.exit(0);
}

// ---------- live board (+ --export for a dashboard; BP_TODAY=YYYY-MM-DD rewinds it to a past date) ----------
{
  const S0 = await all(), P = loadP(), asOf = new Date(Date.parse(today + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
  const rewind = G => G.map(g => g.d < asOf ? g : {...g, fin: false, hs: null, as: null});   // games on/after asOf count as unplayed
  const S = Object.fromEntries(Object.entries(S0).map(([Y, G]) => [Y, rewind(G)]));
  let Y = CURY; if (!S[Y]?.filter(g => !g.final).length) Y--;   // new season's fixture not out yet -> last season (decided, frozen)
  const G = S[Y], reg = G.filter(g => !g.final), first = firstFinal(G), champ = premier(G), done = !!champ;
  const finalsStarted = G.some(g => g.final && g.fin), started = reg.some(g => g.fin);
  const stage = done ? 'done' : finalsStarted ? 'finals' : started ? 'regular' : 'preseason';
  const fmt = L.fmtOf(Y) || L.fmtOf(9999), N = +(arg('--sims') || 20000);
  // title odds: before the finals = the rest of the regular season + play-in + finals; once the finals start = FROZEN at the start of the finals
  // (ratings fit on games before the first final, actual seeds) -- the user never bets within the playoffs
  const seeds = finalsStarted ? ladderIds(reg.filter(g => g.fin)).slice(0, nFin(fmt)) : null;
  const M = fit(pool(S, Y), finalsStarted ? first : asOf, P), T = simulate(M, P, reg, fmt, N, seeds);
  // champion profile: this season's numbers as of today (start of the finals once they begin); preseason = last season's end of the regular season
  let PG = G, PY = Y, pAsOf = finalsStarted ? first : asOf;
  if (stage === 'preseason' && S[Y - 1]?.length) { PG = S[Y - 1]; PY = Y - 1; pAsOf = firstFinal(PG) || asOf; }
  const {rows} = profile(PG, pool(S, PY), pAsOf, P);
  const TS = SEASONS.filter(Yp => Yp < Y || (Yp === Y && done)).filter(Yp => premier(S[Yp])).map(Yp => { const Gp = S[Yp], ch = premier(Gp); return profile(Gp, pool(S, Yp), firstFinal(Gp), P).rows.find(r => r.id === ch); }).filter(Boolean);
  const cuts = tierCuts(TS, FEATS, 1);   // each cutoff = the loosest champion (every champion cleared all of them)
  for (const r of rows) tierScore(r, FEATS, cuts);
  addIndex(rows);
  const prof = new Map(rows.map(r => [r.id, r])), played = reg.filter(g => g.fin).length, stale = reg.filter(g => !g.fin && g.d < today).length;
  const lad = PY !== Y ? rows.map(r => r.id).concat(ladderIds(reg).filter(t => !rows.some(r => r.id === t))) : ladderIds(reg.filter(g => g.fin));
  const cur = new Set(reg.flatMap(g => [g.h, g.a])), board = lad.filter(t => cur.has(t)).concat([...cur].filter(t => !lad.includes(t)));
  const tab = makeTab(board, reg.filter(g => g.fin), Y), rec = id => { const i = tab.ix.get(id); return i == null ? '0-0' : `${tab.W[i]}-${tab.GP[i] - tab.W[i]}`; };
  const fair = p => p < 0.0005 ? '—' : p >= 0.5 ? '-' + Math.round(100 * p / (1 - p)) : '+' + Math.round(100 * (1 - p) / p);
  // --book "Tasmania:+250,Sydney:+300,..." (DraftKings, else FanDuel screenshot) -> EV = p x decimal - 1
  const NICK = {sem: 'south-east-melbourne-phoenix', 'se melbourne': 'south-east-melbourne-phoenix', 's.e. melbourne': 'south-east-melbourne-phoenix', phoenix: 'south-east-melbourne-phoenix',
    'south east melbourne': 'south-east-melbourne-phoenix', melbourne: 'melbourne-united', united: 'melbourne-united', tasmania: 'tasmania-jackjumpers', jackjumpers: 'tasmania-jackjumpers', jjs: 'tasmania-jackjumpers',
    sydney: 'sydney-kings', kings: 'sydney-kings', perth: 'perth-wildcats', wildcats: 'perth-wildcats', adelaide: 'adelaide-36ers', '36ers': 'adelaide-36ers', illawarra: 'illawarra-hawks', hawks: 'illawarra-hawks',
    cairns: 'cairns-taipans', taipans: 'cairns-taipans', brisbane: 'brisbane-bullets', bullets: 'brisbane-bullets', 'new zealand': 'new-zealand-breakers', nz: 'new-zealand-breakers', breakers: 'new-zealand-breakers'};
  const book = new Map(), unknown = [];
  for (const pair of (arg('--book') || '').split(',')) { const m = pair.trim().match(/^(.*?):\s*([+-]?\d+)$/); if (!m) continue; const w = m[1].trim().toLowerCase();
    const id = board.find(t => nameOf(t).toLowerCase() === w) || NICK[w] || board.find(t => nameOf(t).toLowerCase().startsWith(w)) || board.find(t => nameOf(t).toLowerCase().includes(w));
    if (id) book.set(id, +m[2]); else unknown.push(m[1]); }
  const dec = am => am > 0 ? 1 + am / 100 : 1 + 100 / -am, ev = (p, am) => p * dec(am) - 1, pctS = x => (x >= 0 ? '+' : '') + Math.round(100 * x) + '%';
  const fv = (k, v) => v == null || !isFinite(v) ? '—' : k === 'pos' ? String(v) : k === 'rtg' || k === 'mgn' ? (v >= 0 ? '+' : '') + v.toFixed(1) : /wp|form/.test(k) ? v.toFixed(3) : v.toFixed(1);
  console.log(`NBL championship odds -- ${SL(Y)} season (NBL${String(Y + 1).slice(2)}), games through ${today} · ${played}/${reg.length} regular-season games played (${Math.round(100 * played / Math.max(1, reg.length))}%) · stage: ${stage}${done ? ` · CHAMPION: ${nameOf(champ)} (odds = frozen at the start of the finals)` : finalsStarted ? ' (odds FROZEN at the start of the finals -- no bets in the playoffs)' : ''}`);
  if (stale) console.log(`note: ${stale} past regular-season game(s) have no score yet on Wikipedia/ESPN -> simulated as unplayed`);
  if (PY !== Y) console.log(`tiers/index = ${SL(PY)} end of the regular season (${SL(Y)} hasn't started) -- title odds are preseason, from ratings that fade toward average (untested stage)`);
  console.log(`model: half-life ${P.half} d, shrink ${P.lam}, sigma ${P.sig} pts · home edge ${M.H.toFixed(1)} pts · ${fmt === 'playin' ? 'play-in for 3rd-6th, best-of-3 semis, best-of-5 Grand Final' : fmt}`);
  console.log(`TIERS -- every-champion profile (${TS.length} champions 2003-04 on): ${FEATS.map((f, i) => cutLabel(f, cuts[i], v => fv(f.k, +v))).join(' · ')}`);
  console.log(`  (its honest test FAILED vs a coin flip over the finals field -> tiers are context only; the odds come from the simulation)`);
  console.log(`index (0-100) = ${Object.entries(IDXW).map(([k, w]) => `${{rtg: 'Rating', wp: 'Win%', hwp: 'Home win%'}[k] || k} ${w}`).join(' · ')}\n`);
  const order2 = board.slice().sort((a, b) => (prof.get(b)?.score ?? 0) - (prof.get(a)?.score ?? 0) || (T.get(b) || 0) - (T.get(a) || 0) || (prof.get(b)?.idx ?? 0) - (prof.get(a)?.idx ?? 0));
  let lastTier = null;
  for (const id of order2) {
    const r = prof.get(id), p = T.get(id) || 0, tn = TIER_NAME(r ? r.score : 0), am = book.get(id);
    if (tn !== lastTier) { console.log(`${tn}`); lastTier = tn; }
    console.log(`  ${(nameOf(id) + ' ' + rec(id)).padEnd(36)} #${String(board.indexOf(id) + 1).padEnd(2)} ${r ? r.q.map(x => x ? '✓' : '✗').join('') : '?????'} | idx ${r ? r.idx.toFixed(0).padStart(3) : '  —'} | rating ${(M.r.get(id) ?? 0) >= 0 ? '+' : ''}${(M.r.get(id) ?? 0).toFixed(1).padStart(4)} | title ${(100 * p).toFixed(1).padStart(4)}% fair ${fair(p).padStart(6)} | finals ${(100 * (T.field.get(id) || 0)).toFixed(0).padStart(3)}%${am != null ? ` | book ${am > 0 ? '+' : ''}${am} -> EV ${pctS(ev(p, am))}` : ''}`);
  }
  console.log(`checks (in order): ${FEATS.map(f => f.label).join(' · ')}`);
  if (unknown.length) console.log(`(--book names not matched: ${unknown.join(', ')})`);
  if (arg('--export')) {   // board JSON (same shape as rugby.mjs --export)
    const gp = [...tab.GP];
    const out = {league: 'nbl', label: 'NBL', season: Y, profile_season: PY, gp_now: [Math.min(...gp), Math.max(...gp)], generated: new Date().toISOString(), today, stage, first_final: first || null,
      games_left: reg.length - played, sims: N, premier: done ? nameOf(champ) : null, champions: TS.length, sig: P.sig, hfa: +M.H.toFixed(2),
      cats: FEATS.map((f, i) => cutLabel(f, cuts[i], v => fv(f.k, +v))), labels: FEATS.map(f => f.label),
      teams: board.map(id => { const r = prof.get(id), i = tab.ix.get(id);
        return {id, name: nameOf(id), pos: board.indexOf(id) + 1, gp: tab.GP[i], w: tab.W[i], l: tab.GP[i] - tab.W[i], pf: tab.PF[i], pa: tab.PA[i], p: T.get(id) || 0, minor: T.minor.get(id) || 0,
          finals: T.field.get(id) || 0, score: r ? r.score : 0, q: r ? r.q : FEATS.map(() => false), vals: FEATS.map(f => !r ? '—' : f.k === 'pos' ? fv('pos', r.pos) : `${fv(f.k, r[f.k])} #${r['r_' + f.k]}`),
          idx: r ? +r.idx.toFixed(1) : null, rtg: +(M.r.get(id) ?? 0).toFixed(2), book: book.get(id) ?? null}; })};
    fs.writeFileSync(arg('--export'), JSON.stringify(out)); console.log('\nexported -> ' + arg('--export'));
  }
  if (rest.includes('--log')) {
    const file = 'C:/Users/User/baseball-blueprint/nbl-history.md', head = `# NBL Championship Blueprint — Run History\n\nEach run prepends a dated snapshot (engine: baseball-blueprint/pro/nbl.mjs).\n\n---\n\n`;
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : head, i = old.indexOf('---\n\n');
    let body = i >= 0 ? old.slice(i + 5) : ''; if (body.startsWith(`## ${today} `)) { const nx = body.indexOf('\n## '); body = nx >= 0 ? body.slice(nx + 1) : ''; }
    const entry = `## ${today} (${SL(Y)} season, ${played}/${reg.length} regular-season games, stage ${stage}${done ? `, champion ${nameOf(champ)}` : ''}${book.size ? ', book prices pasted' : ''})\n\n` +
      [...T].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, p]) => `- ${nameOf(id)} ${rec(id)} · ${prof.get(id) ? prof.get(id).score + '/5 · idx ' + prof.get(id).idx.toFixed(0) + ' · ' : ''}${(100 * p).toFixed(1)}% (fair ${fair(p)})${book.has(id) ? ` · book ${book.get(id) > 0 ? '+' : ''}${book.get(id)} EV ${pctS(ev(p, book.get(id)))}` : ''}`).join('\n') + '\n\n';
    fs.writeFileSync(file, i >= 0 ? old.slice(0, i + 5) + entry + body : old + entry); console.log('\nlogged to ' + file);
  }
}
