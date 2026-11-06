// Shared engine for the FCS football / women's volleyball / men's college hockey title blueprints (built 2026-11-05).
// Every stat is rebuilt from game results only (no box scores): record, scoring, opponent-adjusted rating (SRS),
// adjusted offense/defense, strength of schedule, RPI, record vs field-calibre teams -- as of any cutoff date.
// Backtests are leave-one-season-out: the held-out season's champion never shapes its own cutoffs or odds settings.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const ymd = d => d.toISOString().slice(0, 10);
export const addDays = (s, n) => ymd(new Date(Date.parse(s + 'T12:00:00Z') + n * 864e5));
export function dayList(from, to) { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; }

export async function fetchJson(u, tries = 6) {
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(u, {headers: {'User-Agent': 'Mozilla/5.0 (college-blueprint)'}, signal: AbortSignal.timeout(30e3)});
      if (r.ok) { const txt = await r.text(); if (!txt.trim()) return null; return JSON.parse(txt); }
      if (r.status === 404) return null;
    } catch {}
    await sleep(600 * (a + 1));
  }
  throw new Error('fetch failed ' + u);
}

export const CACHE_ROOT = path.join(os.tmpdir(), 'college_bp_cache');
export function cacheFile(sport, key) { const d = path.join(CACHE_ROOT, sport); fs.mkdirSync(d, {recursive: true}); return path.join(d, key + '.json'); }
export async function cached(sport, key, fn, keep = true) {
  const f = cacheFile(sport, key);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const v = await fn();
  if (keep) fs.writeFileSync(f, JSON.stringify(v));
  return v;
}
export async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({length: n}, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }

// NCAA.com scoreboard feed (data.ncaa.com) -- one file per day; parsed to compact rows; cached once the day is 2+ days old.
export async function ncaaDay(sport, slug, date, today) {
  const [y, m, d] = date.split('-');
  return cached(sport, 'day_' + date, async () => {
    const j = await fetchJson(`https://data.ncaa.com/casablanca/scoreboard/${slug}/d1/${y}/${m}/${d}/scoreboard.json`);
    const rows = [];
    for (const {game: g} of (j?.games || [])) {
      const A = g.away, H = g.home;
      if (!A?.names?.seo || !H?.names?.seo) continue;
      rows.push({id: g.gameID, d: date, a: A.names.seo, b: H.names.seo, an: A.names.short, bn: H.names.short,
        as: A.score === '' || A.score == null ? null : +A.score, bs: H.score === '' || H.score == null ? null : +H.score,
        aw: !!A.winner, bw: !!H.winner, fin: g.gameState === 'final', round: g.bracketRound || '', msg: g.finalMessage || ''});
    }
    return rows;
  }, date <= addDays(today, -2));
}

// NCAA.com's current scoreboard via the public ncaa-api mirror (ncaa-api.henrygd.me) -- data.ncaa.com stopped posting
// scores in 2025. Same game shape, but bracketRound is a number (1 = first round ... 6 = championship).
const ROUNDS = {1: 'First Round', 2: 'Second Round', 3: 'Third Round', 4: 'Quarterfinals', 5: 'Semifinals', 6: 'Championship'};
export async function henryDay(sport, slug, date, today) {
  const [y, m, d] = date.split('-');
  return cached(sport, 'h_' + date, async () => {
    await sleep(250);
    const j = await fetchJson(`https://ncaa-api.henrygd.me/scoreboard/${slug}/d1/${y}/${m}/${d}/all-conf`);
    const rows = [];
    for (const {game: g} of (j?.games || [])) {
      const A = g.away, H = g.home;
      if (!A?.names?.seo || !H?.names?.seo) continue;
      const br = String(g.bracketRound ?? '').trim();
      rows.push({id: g.gameID, d: date, a: A.names.seo, b: H.names.seo, an: A.names.short, bn: H.names.short,
        as: A.score === '' || A.score == null ? null : +A.score, bs: H.score === '' || H.score == null ? null : +H.score,
        aw: !!A.winner, bw: !!H.winner, fin: g.gameState === 'final', round: ROUNDS[br] || br, msg: g.finalMessage || ''});
    }
    return rows;
  }, date <= addDays(today, -2));
}

// ---------- season bookkeeping: tournament field, champion, first tournament date ----------
export function tourney(S, isFinal) {
  const T = S.games.filter(g => g.round);
  const field = new Set(T.flatMap(g => [g.a, g.b]));
  const fin = T.filter(isFinal).sort((x, y) => x.d.localeCompare(y.d)).pop();
  const champ = fin && fin.fin ? (fin.as > fin.bs ? fin.a : fin.bs > fin.as ? fin.b : fin.aw ? fin.a : fin.bw ? fin.b : null) : null;
  const start = T.length ? T.map(g => g.d).sort()[0] : null;
  return {field, champ, start, final: fin};
}

// ---------- the board: every D1 team's numbers from games played before `asOf` ----------
export const FEAT = {
  srs:   {dir: 1,  label: 'Rating (SRS)'},
  adjO:  {dir: 1,  label: 'Adj offense'},
  adjD:  {dir: -1, label: 'Adj defense'},
  wp:    {dir: 1,  label: 'Win%'},
  off:   {dir: 1,  label: 'Scoring'},
  def:   {dir: -1, label: 'Allowed'},
  mgn:   {dir: 1,  label: 'Margin'},
  sos:   {dir: 1,  label: 'SOS'},
  rpi:   {dir: 1,  label: 'RPI'},
  wpTop: {dir: 1,  label: 'Win% vs top'},
};

export function board(S, asOf, cfg) {
  const all = S.games.filter(g => !g.round);
  const cnt = new Map();
  for (const g of all) for (const t of [g.a, g.b]) cnt.set(t, (cnt.get(t) || 0) + 1);
  const cs = [...cnt.values()].sort((x, y) => x - y), p75 = cs[Math.floor(cs.length * 0.75)] || 0;
  const isD1 = id => !(S.exclude && S.exclude.has(id)) && (cnt.get(id) || 0) >= Math.max(2, cfg.minFrac * p75);
  const node = id => isD1(id) ? id : (S.groupOf ? S.groupOf(id) : 'ND');
  const G = all.filter(g => g.fin && g.as != null && g.bs != null && g.d < asOf && (isD1(g.a) || isD1(g.b)));
  const T = new Map();
  const add = id => { if (!T.has(id)) T.set(id, {id, name: (S.names && S.names.get(id)) || id, d1: isD1(id), gp: 0, w: 0, l: 0, t: 0, pf: 0, pa: 0, games: []}); return T.get(id); };
  for (const g of G) {
    const A = add(node(g.a)), B = add(node(g.b));
    if (A === B) continue;
    const ra = g.as > g.bs ? 1 : g.as < g.bs ? 0 : 0.5;
    for (const [X, Y, xs, ys, r] of [[A, B, g.as, g.bs, ra], [B, A, g.bs, g.as, 1 - ra]]) {
      X.gp++; X.pf += xs; X.pa += ys;
      if (r === 1) X.w++; else if (r === 0) X.l++; else X.t++;
      X.games.push({o: Y.id, pf: xs, pa: ys, r, m: Math.max(-cfg.cap, Math.min(cfg.cap, xs - ys))});
    }
  }
  const nodes = [...T.values()], d1n = nodes.filter(x => x.d1);
  if (!d1n.length) return {teams: [], asOf, games: 0};
  for (const x of nodes) { x.wp = (x.w + x.t / 2) / x.gp; x.off = x.pf / x.gp; x.def = x.pa / x.gp; x.mgn = (x.pf - x.pa) / x.gp; }
  // SRS: rating = average capped margin + average opponent rating (damped iteration, D1 mean re-centred to 0)
  let R = new Map(nodes.map(x => [x.id, 0]));
  for (let it = 0; it < 80; it++) {
    const N = new Map();
    for (const x of nodes) N.set(x.id, 0.5 * R.get(x.id) + 0.5 * x.games.reduce((a, g) => a + g.m + R.get(g.o), 0) / x.games.length);
    const mu = d1n.reduce((a, x) => a + N.get(x.id), 0) / d1n.length;
    for (const [k, v] of N) N.set(k, v - mu);
    R = N;
  }
  // two-way adjusted offense / defense (points above average vs an average opponent; defense lower = better)
  const avg = d1n.reduce((a, x) => a + x.pf, 0) / d1n.reduce((a, x) => a + x.gp, 0);
  let O = new Map(nodes.map(x => [x.id, 0])), D = new Map(nodes.map(x => [x.id, 0]));
  for (let it = 0; it < 80; it++) {
    const NO = new Map(), ND = new Map();
    for (const x of nodes) {
      NO.set(x.id, 0.5 * O.get(x.id) + 0.5 * x.games.reduce((a, g) => a + g.pf - avg - D.get(g.o), 0) / x.games.length);
      ND.set(x.id, 0.5 * D.get(x.id) + 0.5 * x.games.reduce((a, g) => a + g.pa - avg - O.get(g.o), 0) / x.games.length);
    }
    const mo = d1n.reduce((a, x) => a + NO.get(x.id), 0) / d1n.length, md = d1n.reduce((a, x) => a + ND.get(x.id), 0) / d1n.length;
    for (const [k, v] of NO) NO.set(k, v - mo);
    for (const [k, v] of ND) ND.set(k, v - md);
    O = NO; D = ND;
  }
  const byId = new Map(nodes.map(x => [x.id, x]));
  for (const x of nodes) { x.srs = R.get(x.id); x.adjO = O.get(x.id); x.adjD = D.get(x.id); x.owp = x.games.reduce((a, g) => a + byId.get(g.o).wp, 0) / x.games.length; }
  for (const x of nodes) { x.oowp = x.games.reduce((a, g) => a + byId.get(g.o).owp, 0) / x.games.length; x.sos = x.owp; x.rpi = 0.25 * x.wp + 0.5 * x.owp + 0.25 * x.oowp; }
  const top = new Set(d1n.slice().sort((a, b) => b.srs - a.srs).slice(0, cfg.topN).map(x => x.id));
  for (const x of nodes) { const tg = x.games.filter(g => top.has(g.o)); x.nTop = tg.length; x.wTop = tg.reduce((a, g) => a + g.r, 0); x.wpTop = tg.length ? x.wTop / tg.length : null; }
  const gps = d1n.map(x => x.gp).sort((a, b) => a - b), med = gps[Math.floor(gps.length / 2)];
  const teams = d1n.filter(x => x.gp >= Math.max(1, 0.5 * med));
  for (const [f, {dir}] of Object.entries(FEAT)) {
    const v = x => x[f] == null ? (dir > 0 ? -Infinity : Infinity) : x[f];
    for (const x of teams) x['r_' + f] = 1 + teams.filter(o => dir > 0 ? v(o) > v(x) : v(o) < v(x)).length;
  }
  for (const x of teams) x.rec = x.t ? `${x.w}-${x.l}-${x.t}` : `${x.w}-${x.l}`;
  return {teams, asOf, games: G.length, gpMin: gps[0], gpMax: gps[gps.length - 1], gpMed: med};
}

// ---------- blueprint: criteria cutoffs from champions, tiers, index, fair odds ----------
// crit: [{f, kind: 'rank'|'value'}]; cutoff covers `cover` share of the given champions (ties at the cutoff qualify)
export function cutoffs(champs, crit, cover) {
  return crit.map(c => {
    const dir = FEAT[c.f].dir, n = champs.length, k = Math.max(1, Math.ceil(cover * n)) - 1;
    if (c.kind === 'rank') return champs.map(t => t['r_' + c.f]).sort((a, b) => a - b)[k];
    const vals = champs.map(t => t[c.f] ?? (dir > 0 ? -Infinity : Infinity)).sort((a, b) => dir > 0 ? b - a : a - b);
    return vals[k];
  });
}
export function passes(t, c, cut) {
  if (c.kind === 'rank') return t['r_' + c.f] <= cut;
  const v = t[c.f];
  if (v == null) return false;
  return FEAT[c.f].dir > 0 ? v >= cut - 1e-9 : v <= cut + 1e-9;
}
export function scoreTeams(teams, crit, cut) { for (const t of teams) { t.q = crit.map((c, i) => passes(t, c, cut[i])); t.score = t.q.filter(Boolean).length; } }
export function indexTeams(teams, W) {
  const N = {};
  for (const f of Object.keys(W)) {
    const dir = FEAT[f].dir, v = teams.map(t => t[f] ?? null).filter(x => x != null), lo = Math.min(...v), hi = Math.max(...v);
    N[f] = t => t[f] == null || hi === lo ? 0 : 100 * (dir > 0 ? t[f] - lo : hi - t[f]) / (hi - lo);
  }
  const tw = Object.values(W).reduce((a, b) => a + b, 0);
  for (const t of teams) t.idx = Object.entries(W).reduce((a, [f, w]) => a + w * N[f](t), 0) / tw;
}
export const TIERS = {
  flat:  {5: 1, 4: 1, 3: 1, 2: 1, 1: 1, 0: 1},
  cfb:   {5: 1.33, 4: 1, 3: 0.75, 2: 0.5, 1: 0.25, 0: 0.1},
  steep: {5: 2, 4: 1, 3: 0.5, 2: 0.25, 1: 0.1, 0: 0.04},
};
export function fair(poolTeams, P) {
  const TW = TIERS[P.tier];
  let p = poolTeams.map(t => TW[t.score] * Math.pow(Math.max(t.idx, 0.5) / 100, P.k));
  let s = p.reduce((a, b) => a + b, 0);
  p = p.map(x => (1 - P.eps) * x / s + P.eps / poolTeams.length);
  for (let it = 0; it < 20 && P.cap < 1; it++) {
    const over = p.map(x => x > P.cap + 1e-12);
    if (!over.some(Boolean)) break;
    const excess = p.reduce((a, x, i) => a + (over[i] ? x - P.cap : 0), 0), rest = p.reduce((a, x, i) => a + (over[i] ? 0 : x), 0);
    p = p.map((x, i) => over[i] ? P.cap : x + excess * x / rest);
  }
  return poolTeams.map((t, i) => ({t, p: p[i]})).sort((a, b) => b.p - a.p);
}
export function srsSoft(poolTeams, beta, eps = 0.01) {
  const v = poolTeams.map(t => t.srs), mu = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / v.length) || 1;
  let p = poolTeams.map(t => Math.exp(beta * (t.srs - mu) / sd));
  const s = p.reduce((a, b) => a + b, 0);
  p = p.map(x => (1 - eps) * x / s + eps / poolTeams.length);
  return poolTeams.map((t, i) => ({t, p: p[i]})).sort((a, b) => b.p - a.p);
}
export const GRID = (() => { const g = []; for (const k of [1, 2, 3, 4, 6, 8, 11, 15, 20]) for (const tier of ['flat', 'cfb', 'steep']) for (const cap of [1, 0.45, 0.35, 0.25, 0.2, 0.15]) g.push({k, tier, cap, eps: 0.01}); return g; })();
export const BETAS = [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
export const LL = p => -Math.log(Math.max(p, 0.002));

// (Kalshi helper removed 2026-11-06 -- user: "Do not use Kalshi"; book prices come from pasted DraftKings/FanDuel screenshots)
export function norm(s) {
  let t = ' ' + String(s).toLowerCase().replace(/&/g, ' and ').replace(/[.'’()\-]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  t = t.replace(/^ st /, ' saint ').replace(/ st /g, ' state ').replace(/ u /g, ' university ').replace(/ univ /g, ' university ').replace(/ mich /g, ' michigan ').replace(/ so /g, ' southern ');
  return t.trim().replace(/\s+/g, ' ');
}
export const american = p => p >= 0.5 ? `-${Math.round(100 * p / (1 - p))}` : `+${Math.round(100 * (1 - p) / p)}`;
