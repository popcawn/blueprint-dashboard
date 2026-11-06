// CFL Grey Cup blueprint (built 2026-11-05). ESPN carries no CFL, so every season comes from Wikipedia: the
// "YYYY CFL West/East Division standings" templates (GP W L T Pts PF PA Div) and the season page's {{8TeamBracket}}
// (semi-finals, division finals, Grey Cup with scores). Standings-level data, like the NFL blueprint.
//   node cfl.mjs study                 champion profiles (Grey Cup winners 2008-2025, 2020 cancelled)
//   node cfl.mjs backtest              leave-one-season-out: blueprint vs bracket simulation vs coin flip
//   node cfl.mjs [live] [--log] [--book "Team:+300,..."]   this season's board + title odds (+ EV vs a pasted DraftKings/FanDuel screenshot; NO Kalshi, user 2026-11-06)
//   node cfl.mjs dump                  every team's season line, each year -> study/data/cfl.json (study/criteria.mjs)
import fs from 'node:fs';
import {sleep, cached, FEAT, cutoffs, scoreTeams, indexTeams, fair, GRID, LL, norm, american, fetchJson} from './lib.mjs';

const SEASONS = [2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025];
const today = process.env.BP_TODAY || new Date().toLocaleDateString('en-CA');
const CUR = +today.slice(0, 4);
const [mode0 = 'live', ...rest] = process.argv.slice(2);
const mode = mode0.startsWith('--') ? 'live' : mode0;
if (mode0.startsWith('--')) rest.unshift(mode0);
FEAT.wpX = {dir: 1, label: 'Win% vs other division'};
FEAT.place = {dir: -1, label: 'Division place'};
FEAT.l = {dir: -1, label: 'Losses'};
// every-champion rule (2026-11-06 search, 17 Grey Cup winners 2008-25): each cutoff = the loosest winner, so every past winner clears all 5
const CRIT = [{f: 'wp', kind: 'rank'}, {f: 'off', kind: 'value'}, {f: 'def', kind: 'rank'}, {f: 'place', kind: 'value'}, {f: 'l', kind: 'value'}];
const critLbl = (c, v) => c.kind === 'rank' ? `${FEAT[c.f].label} top-${v}` : `${FEAT[c.f].label} ${FEAT[c.f].dir > 0 ? '≥' : '≤'} ${c.f === 'wp' ? v.toFixed(3) : Number.isInteger(v) ? v : v.toFixed(1)}`;
const W = {mgn: 35, wp: 20, def: 15, off: 15, wpX: 15};
const COVER = 1;   // every champion (was 90%)

// Raw wikitext via index.php?action=raw -- the parse API and REST API throttle bursts (429 "too many requests"), raw does not.
async function wiki(page, keep) {
  return cached('cfl', 'raw_' + page.replace(/\W+/g, '_'), async () => {
    for (let a = 0; a < 6; a++) {
      await sleep(400 * (a + 1));
      try {
        const r = await fetch(`https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(page.replace(/ /g, '_'))}&action=raw`, {headers: {'User-Agent': 'college-blueprint/1.0 (personal sports research)'}});
        if (r.status === 404) return '';
        if (r.ok) return await r.text();
      } catch {}
    }
    throw new Error('Wikipedia refused ' + page);
  }, keep);
}
// 2008-10 standings use {{#invoke:sports table}} (team1 = MON | name_MON = [[...|Montreal Alouettes]] | win_MON = 11 ...)
function standingsAny(w, div) {
  if (!/#invoke:\s*sports table/i.test(w)) return standings(w, div);
  const order = [...w.matchAll(/\|\s*team(\d+)\s*=\s*([A-Za-z0-9_]+)/g)].sort((a, b) => +a[1] - +b[1]).map(m => m[2]);
  const val = (k, code) => { const m = w.match(new RegExp(`\\|\\s*${k}_${code}\\s*=\\s*(\\[\\[[^\\]]*\\]\\]|[^|\\n]*)`)); return m ? m[1].trim() : ''; };
  return order.map((code, i) => {
    const nm = val('name', code), lk = nm.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/), n = k => +val(k, code) || 0;
    const w_ = n('win'), l = n('loss'), t = n('draw');
    return {team: (lk ? (lk[2] || lk[1]) : nm).trim(), div, place: i + 1, gp: w_ + l + t, w: w_, l, t, pf: n('pf'), pa: n('pa'), dw: null, dl: null};
  });
}
const link = s => { const m = s.match(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/); return (m ? (m[2] || m[1]) : s).replace(/'''/g, '').replace(/^\d{4} /, '').replace(/ season$/, '').trim(); };   // [[2009 BC Lions season|BC Lions]] -> BC Lions
// rendered standings table (HTML) -- the same shape in every season, unlike the wikitext
function standingsHtml(html, div) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<t([hd])[^>]*>([\s\S]*?)<\/t[hd]>/g)].map(c => ({txt: c[2].replace(/<[^>]+>/g, '').replace(/&#160;|&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(), html: c[2]})));
  const hi = rows.findIndex(r => r.some(c => /^(GP|W)$/.test(c.txt)) && r.some(c => /^PF$/.test(c.txt)));
  if (hi < 0) return [];
  const heads = rows[hi].map(c => c.txt), out = [];
  for (const r of rows.slice(hi + 1)) {
    if (r.length < 6) continue;
    const a = r[0].html.match(/<a [^>]*title="([^"]+)"/), o = {team: (a ? a[1] : r[0].txt).replace(/&amp;/g, '&')};
    heads.forEach((h, i) => { if (i > 0 && r[i]) o[h] = r[i].txt; });
    out.push(o);
  }
  return out.map((o, i) => {
    const n = k => +String(o[k] ?? '').replace(/[^0-9.]/g, '') || 0, dv = String(o.Div || '').match(/(\d+)\D+(\d+)(?:\D+(\d+))?/);
    return {team: o.team, div, place: i + 1, gp: n('GP') || n('W') + n('L') + n('T'), w: n('W'), l: n('L'), t: n('T'), pf: n('PF'), pa: n('PA'), dw: dv ? +dv[1] : null, dl: dv ? +dv[2] : null};
  });
}
function standings(w, div) {
  const heads = [], rows = [];
  for (const line of w.split('\n')) {
    if (/^!/.test(line) && !/colspan/i.test(line)) { const a = line.match(/\{\{Abbr\|([^|}]+)\|/i); heads.push(a ? a[1].trim() : line.replace(/^!.*\|/, '').replace(/^!/, '').trim()); }
    else if (/^\|[^-}]/.test(line) && line.includes('[[') && line.includes('||')) {
      const c = line.replace(/^\|/, '').split('||').map(x => x.trim()), o = {div, team: link(c[0])};
      heads.forEach((h, i) => { if (i > 0 && c[i] != null) o[h] = c[i]; });
      rows.push(o);
    }
  }
  return rows.map((o, i) => {
    const n = k => +String(o[k] ?? '').replace(/[^0-9.]/g, '') || 0, dv = String(o.Div || '').match(/(\d+)\D+(\d+)(?:\D+(\d+))?/);
    const gp = n('GP') || n('W') + n('L') + n('T');
    return {team: o.team, div, place: i + 1, gp, w: n('W'), l: n('L'), t: n('T'), pf: n('PF'), pa: n('PA'), dw: dv ? +dv[1] : null, dl: dv ? +dv[2] : null, dt: dv && dv[3] ? +dv[3] : 0};
  });
}
function bracket(w) {
  const i = w.search(/\{\{\s*8TeamBracket/i);
  if (i < 0) return null;
  let d = 0, j = i;
  for (; j < w.length; j++) { if (w.startsWith('{{', j)) { d++; j++; } else if (w.startsWith('}}', j)) { d--; j++; if (d === 0) break; } }
  const b = w.slice(i, j + 1), get = (rd, k, f) => { const m = b.match(new RegExp(`\\|\\s*RD${rd}-${f}${k}\\s*=([^\\n|]*(?:\\|[^\\n=]*)?)`)); return m ? m[1] : ''; };
  const team = s => link(s.replace(/\{\{nowrap\|/gi, '').replace(/\}\}/g, '')).replace(/<[^>]+>/g, '').trim();
  const R = {};
  for (const rd of [1, 2, 3]) {
    const slots = [];
    for (let k = 1; k <= 8; k++) {
      const t = team(get(rd, k, 'team'));
      if (!t) continue;
      const sc = get(rd, k, 'score').replace(/'''/g, '').match(/\d+/);
      slots.push({k, team: t, score: sc ? +sc[0] : null, seed: get(rd, k, 'seed').replace(/'''/g, '').trim()});
    }
    const games = [];
    for (const g of new Set(slots.map(s => Math.ceil(s.k / 2)))) {
      const [a, c] = slots.filter(s => Math.ceil(s.k / 2) === g);
      if (!a || !c) continue;
      const win = a.score != null && c.score != null ? (a.score > c.score ? a.team : c.team) : null;
      const sn = s => +(s.seed.match(/\d+/) || [9])[0];
      const home = rd === 3 ? null : (sn(a) <= sn(c) ? a.team : c.team);
      games.push({rd, a: a.team, b: c.team, as: a.score, bs: c.score, win, home});
    }
    R[rd] = games;
  }
  return R;
}
async function season(Y) {
  const keep = Y < CUR;
  const page = await wiki(`${Y} CFL season`, keep);
  const tpl = [...page.matchAll(/\{\{\s*(\d{4} CFL (West|East) Division [Ss]tandings)\s*\}\}/g)];
  const teams = [];
  for (const [, name, div] of tpl) teams.push(...standingsAny(await wiki('Template:' + name, keep), div));
  const br = bracket(page);
  const sq = s => norm(s).replace(/ /g, '');   // "B.C. Lions" == "BC Lions"
  const key = s => { const k = sq(s), t = teams.find(x => sq(x.team) === k) || teams.find(x => sq(x.team).includes(k) || k.includes(sq(x.team))); return t ? norm(t.team) : norm(s); };   // bracket names -> standings team
  for (const t of teams) {
    t.id = key(t.team); t.name = t.team.replace(/ (Roughriders|Stampeders|Lions|Blue Bombers|Eskimos|Elks|Football Team|Tiger-Cats|Argonauts|Alouettes|Redblacks|Renegades)$/, m => m === ' Tiger-Cats' ? '' : '').trim() || t.team;
    t.name = t.team;
    t.wp = (t.w + t.t / 2) / t.gp; t.off = t.pf / t.gp; t.def = t.pa / t.gp; t.mgn = (t.pf - t.pa) / t.gp; t.srs = t.mgn;
    t.xw = t.dw != null ? t.w - t.dw : null; t.xl = t.dl != null ? t.l - t.dl : null; t.wpX = t.xw != null && t.xw + t.xl > 0 ? t.xw / (t.xw + t.xl) : null;
    t.rec = t.t ? `${t.w}-${t.l}-${t.t}` : `${t.w}-${t.l}`;
  }
  for (const f of ['mgn', 'wp', 'off', 'def', 'wpX', 'place']) {
    const dir = FEAT[f].dir;
    for (const t of teams) t['r_' + f] = f === 'place' ? t.place : 1 + teams.filter(o => dir * ((o[f] ?? -1e9 * dir) - (t[f] ?? -1e9 * dir)) > 0).length;
  }
  const out = {Y, teams, br};
  if (br) {
    const all = [1, 2, 3].flatMap(r => br[r] || []);
    out.field = new Set(all.flatMap(g => [key(g.a), key(g.b)]));
    out.final4 = new Set((br[2] || []).flatMap(g => [key(g.a), key(g.b)]));
    out.bye = new Set([...out.final4].filter(id => !(br[1] || []).some(g => key(g.a) === id || key(g.b) === id)));
    const gc = (br[3] || [])[0];
    out.champ = gc && gc.win ? key(gc.win) : null;
    out.games = all.map(g => ({...g, a: key(g.a), b: key(g.b), win: g.win ? key(g.win) : null, home: g.home ? key(g.home) : null}));
  }
  return out;
}

// ---- bracket simulation on the rating (points-per-game margin): P(home wins) = logistic((rH - rA + h) / s); Grey Cup neutral
const sig = x => 1 / (1 + Math.exp(-x));
const pGame = (ra, rb, homeA, P) => sig((ra - rb + (homeA === true ? P.h : homeA === false ? -P.h : 0)) / P.s);
function simFinal4(S, P) {
  const by = new Map(S.teams.map(t => [t.id, t]));
  const finals = S.games.filter(g => g.rd === 2);
  const reach = new Map();
  for (const g of finals) { const pa = pGame(by.get(g.a).mgn, by.get(g.b).mgn, g.home === g.a, P); reach.set(g.a, pa); reach.set(g.b, 1 - pa); }
  const champ = new Map();
  const [f1, f2] = finals;
  if (!f1 || !f2) return champ;
  for (const x of [f1.a, f1.b]) for (const y of [f2.a, f2.b]) {
    const both = reach.get(x) * reach.get(y), px = pGame(by.get(x).mgn, by.get(y).mgn, null, P);
    champ.set(x, (champ.get(x) || 0) + both * px); champ.set(y, (champ.get(y) || 0) + both * (1 - px));
  }
  return champ;
}
function simField(S, P) {
  const by = new Map(S.teams.map(t => [t.id, t]));
  const semis = S.games.filter(g => g.rd === 1), finals = S.games.filter(g => g.rd === 2);
  const reachF = new Map();
  for (const id of S.bye) reachF.set(id, 1);
  const semiOf = new Map();
  for (const g of semis) { const pa = pGame(by.get(g.a).mgn, by.get(g.b).mgn, g.home === g.a, P); reachF.set(g.a, pa); reachF.set(g.b, 1 - pa); semiOf.set(g.a, g); semiOf.set(g.b, g); }
  const reachG = new Map();
  for (const f of finals) {
    const host = [f.a, f.b].find(id => S.bye.has(id)), slot = [f.a, f.b].find(id => !S.bye.has(id)), sg = semiOf.get(slot);
    const challengers = sg ? [sg.a, sg.b] : [slot];
    reachG.set(host, challengers.reduce((acc, c) => acc + reachF.get(c) * pGame(by.get(host).mgn, by.get(c).mgn, true, P), 0));
    for (const c of challengers) reachG.set(c, reachF.get(c) * (1 - pGame(by.get(host).mgn, by.get(c).mgn, true, P)));
  }
  const [f1, f2] = finals, side = f => { const s = semiOf.get([f.a, f.b].find(id => !S.bye.has(id))); return [...new Set([f.a, f.b, ...(s ? [s.a, s.b] : [])])]; };
  const champ = new Map();
  if (!f1 || !f2) return champ;
  for (const x of side(f1)) for (const y of side(f2)) {
    const both = reachG.get(x) * reachG.get(y), px = pGame(by.get(x).mgn, by.get(y).mgn, null, P);
    champ.set(x, (champ.get(x) || 0) + both * px); champ.set(y, (champ.get(y) || 0) + both * (1 - px));
  }
  return champ;
}
// live title chances that respect every result already in (2026-11-06, for the dashboard): a decided game is 1/0, the rest use
// the rating model. Stages: six-team field -> division finals -> Grey Cup set -> champion.
function simLive(S, P) {
  const by = new Map(S.teams.map(t => [t.id, t])), G = S.games || [], pg = (a, b, home) => pGame(by.get(a).mgn, by.get(b).mgn, home, P);
  const gc = G.find(g => g.rd === 3), r2 = G.filter(g => g.rd === 2);
  if (gc && gc.win) return new Map([[gc.win, 1]]);
  if (gc && gc.a && gc.b) { const pa = pg(gc.a, gc.b, null); return new Map([[gc.a, pa], [gc.b, 1 - pa]]); }
  if (r2.length === 2 && r2.every(g => g.a && g.b)) {
    const reach = new Map();
    for (const g of r2) { const pa = g.win ? (g.win === g.a ? 1 : 0) : pg(g.a, g.b, g.home === g.a); reach.set(g.a, pa); reach.set(g.b, 1 - pa); }
    const [f1, f2] = r2, champ = new Map();
    for (const x of [f1.a, f1.b]) for (const y of [f2.a, f2.b]) { const both = reach.get(x) * reach.get(y); if (!both) continue; const px = pg(x, y, null);
      champ.set(x, (champ.get(x) || 0) + both * px); champ.set(y, (champ.get(y) || 0) + both * (1 - px)); }
    return champ;
  }
  return simField(S, P);
}
function fitSim(train) {
  let best = null;
  for (let h = 0; h <= 16; h += 0.5) for (let s = 4; s <= 40; s += 2) {
    let ll = 0;
    for (const S of train) { const by = new Map(S.teams.map(t => [t.id, t])); for (const g of S.games) { if (!g.win) continue; const pa = pGame(by.get(g.a).mgn, by.get(g.b).mgn, g.rd === 3 ? null : g.home === g.a, {h, s}); ll -= Math.log(g.win === g.a ? pa : 1 - pa); } }
    if (!best || ll < best.ll) best = {h, s, ll};
  }
  return best;
}

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const H = [];
for (const Y of SEASONS) { const S = await season(Y); if (S.champ && S.teams.length >= 8) H.push(S); else console.log(`${Y}: parse problem (teams ${S.teams.length}, champ ${S.champ})`); }
for (const S of H) indexTeams(S.teams, W);
const champOf = S => S.teams.find(t => t.id === S.champ);
if (mode === 'dump') {   // input for study/criteria.mjs (the "every champion" search)
  const K = ['mgn', 'wp', 'off', 'def', 'wpX', 'place', 'divwp', 'l'];
  for (const S of H) for (const t of S.teams) t.divwp = t.dw != null && t.dw + t.dl > 0 ? t.dw / (t.dw + t.dl) : null;
  const out = {sport: 'cfl', label: 'CFL Grey Cup', when: 'end of the regular season', fieldLabel: 'the 6 playoff teams', universeLabel: 'all 9 CFL teams',
    cands: [{k: 'mgn', dir: 1, label: 'Point margin/game', value: true, dec: 1}, {k: 'wp', dir: 1, label: 'Win%', value: true}, {k: 'off', dir: 1, label: 'Points scored/game', value: true, dec: 1},
      {k: 'def', dir: -1, label: 'Points allowed/game', value: true, dec: 1}, {k: 'place', dir: -1, label: 'Division place', value: true, rank: false, dec: 0},
      {k: 'l', dir: -1, label: 'Losses', value: true, rank: false, dec: 0}],   // division-record stats left out: missing in ~half the seasons
    seasons: H.map(S => ({Y: S.Y, champ: S.champ, champName: champOf(S).name, field: [...S.field], rows: S.teams.map(t => Object.fromEntries([['id', t.id], ['name', t.name], ...K.map(k => [k, t[k] ?? null])]))}))};
  fs.mkdirSync('C:/Users/User/baseball-blueprint/study/data', {recursive: true});
  fs.writeFileSync('C:/Users/User/baseball-blueprint/study/data/cfl.json', JSON.stringify(out));
  console.log(`dumped ${out.seasons.length} seasons -> study/data/cfl.json`);
  process.exit(0);
}
if (mode === 'debug') {
  for (const S of H) { const ids = new Set(S.teams.map(t => t.id)), bad = S.games.flatMap(g => [g.a, g.b]).filter(x => !ids.has(x)); if (bad.length) console.log(S.Y, 'unmatched:', [...new Set(bad)].join(', '), '| standings:', S.teams.map(t => t.id).join(', ')); }
  process.exit(0);
}

if (mode === 'study') {
  console.log('GREY CUP WINNERS -- regular-season profile (ranks among the 8-9 CFL teams)');
  for (const S of H) { const c = champOf(S); console.log(`${S.Y} ${c.name.padEnd(26)} ${c.rec.padEnd(6)} ${c.div} #${c.place}${S.bye.has(c.id) ? ' (bye)' : ''} | margin #${c.r_mgn} (${c.mgn.toFixed(1)}) · win% #${c.r_wp} (${c.wp.toFixed(3)}) · offense #${c.r_off} · defense #${c.r_def} · vs other div #${c.r_wpX} (${c.wpX == null ? '—' : c.wpX.toFixed(3)})`); }
  for (const f of ['mgn', 'wp', 'off', 'def', 'wpX', 'place']) { const rk = H.map(S => champOf(S)['r_' + f]).sort((a, b) => a - b); console.log(`${f.padEnd(6)} champion ranks ${rk.join(',')} | median ${rk[Math.floor(rk.length / 2)]} | 90% #${rk[Math.ceil(0.9 * rk.length) - 1]}`); }
  const byeW = H.filter(S => S.bye.has(S.champ)).length, east = H.filter(S => champOf(S).div === 'East').length;
  console.log(`champions with a bye (1st place): ${byeW}/${H.length} · from the East: ${east}/${H.length}`);
  process.exit(0);
}

function evalSeason(S, cut, prm, sim, stage) {
  scoreTeams(S.teams, CRIT, cut);
  const pool = S.teams.filter(t => (stage === 'final4' ? S.final4 : S.field).has(t.id));
  const L = fair(pool, prm), i = L.findIndex(x => x.t.id === S.champ);
  const SM = stage === 'final4' ? simFinal4(S, sim) : simField(S, sim), ps = SM.get(S.champ) || 0;
  const rs = 1 + [...SM.values()].filter(v => v > ps).length;
  return {bp: i < 0 ? 0 : L[i].p, bpR: i < 0 ? null : i + 1, sim: ps, simR: rs, n: pool.length, top: L[0].t.name};
}
function tuneBp(train, cut, sim, stage) {
  let best = null;
  for (const prm of GRID) { const ll = mean(train.map(S => LL(evalSeason(S, cut, prm, sim, stage).bp))); if (!best || ll < best.ll) best = {prm, ll}; }
  return best.prm;
}

if (mode === 'backtest') {
  for (const stage of ['field', 'final4']) {
    const res = [];
    for (let h = 0; h < H.length; h++) {
      const train = H.filter((_, i) => i !== h), S = H[h];
      const cut = cutoffs(train.map(champOf), CRIT, COVER), sim = fitSim(train), prm = tuneBp(train, cut, sim, stage);
      const e = evalSeason(S, cut, prm, sim, stage);
      res.push({Y: S.Y, name: champOf(S).name, sc: champOf(S).score, ...e, sim2: sim});
    }
    const half = Math.ceil(res.length / 2);
    console.log(`\n=== ${stage === 'final4' ? 'final four (after the semi-finals)' : 'six-team field (start of playoffs)'} ===`);
    for (const r of res) console.log(`${r.Y} ${r.name.padEnd(26)} ${r.sc}/5 | blueprint #${r.bpR} ${(100 * r.bp).toFixed(0).padStart(3)}% | bracket sim #${r.simR} ${(100 * r.sim).toFixed(0).padStart(3)}% (h ${r.sim2.h}, s ${r.sim2.s}) | blueprint #1: ${r.top}`);
    for (const [lab, rs] of [['ALL', res], [`${res[0].Y}-${res[half - 1].Y}`, res.slice(0, half)], [`${res[half].Y}-${res[res.length - 1].Y}`, res.slice(half)]])
      console.log(`${lab.padEnd(10)} blueprint: #1 ${rs.filter(r => r.bpR === 1).length}/${rs.length} · champ p ${(100 * mean(rs.map(r => r.bp))).toFixed(1)}% · LL ${mean(rs.map(r => LL(r.bp))).toFixed(3)}  ||  bracket sim: #1 ${rs.filter(r => r.simR === 1).length}/${rs.length} · p ${(100 * mean(rs.map(r => r.sim))).toFixed(1)}% · LL ${mean(rs.map(r => LL(r.sim))).toFixed(3)}  ||  coin flip LL ${mean(rs.map(r => Math.log(r.n))).toFixed(3)}`);
  }
  const cut = cutoffs(H.map(champOf), CRIT, COVER);
  console.log('\ncutoffs fitted on all seasons: ' + CRIT.map((c, i) => critLbl(c, cut[i])).join(' · '));
  process.exit(0);
}

// ---- live
const S = await season(CUR);
indexTeams(S.teams, W);
const cut = cutoffs(H.map(champOf), CRIT, COVER), sim = fitSim(H);
scoreTeams(S.teams, CRIT, cut);
const PRE = rest.includes('--preplayoff');   // re-run from the start of the playoffs (six-team field, ignores playoff results)
const GC = (S.games || []).find(g => g.rd === 3);
const stage = PRE ? 'field' : GC && GC.win ? 'done' : GC && GC.a && GC.b ? 'final' : S.br && (S.br[2] || []).length === 2 && S.br[2].every(g => g.a && g.b) ? 'final4' : 'field';
const alive = new Set((S.games || []).flatMap(g => [g.a, g.b]));   // team ids (bracket names resolved to standings)
if (!PRE) for (const g of S.games || []) if (g.win) { const lose = g.win === g.a ? g.b : g.a; alive.delete(lose); }   // a loss anywhere ends a team
const sm = PRE ? simField(S, sim) : simLive(S, sim);
const prm = tuneBp(H, cut, sim, stage === 'field' ? 'field' : 'final4');
const pool = S.teams.filter(t => alive.has(t.id));
const F = fair(pool, prm), BP = new Map(F.map(x => [x.t.id, x.p]));
console.log(`CFL Grey Cup blueprint -- ${CUR} regular season final · stage: ${{final4: 'division finals (4 teams left)', final: 'Grey Cup (2 teams left)', done: 'season over'}[stage] || 'playoffs'}`);
console.log(`criteria (every one of the ${H.length} Grey Cup winners ${H[0].Y}-${H[H.length - 1].Y} had all 5): ` + CRIT.map((c, i) => critLbl(c, cut[i])).join(' · '));
console.log(`bracket sim: rating = points-per-game margin, home edge ${sim.h} pts, spread ${sim.s} (fit on ${H.length} seasons of playoff games)\n`);
const TIERNM = s => s >= 5 ? '🏆 Best' : s === 4 ? '🔵 Great' : s === 3 ? '🟢 Good' : s === 2 ? '🟡 Outside' : '⚪ Longshot';
for (const t of S.teams.slice().sort((a, b) => b.score - a.score || b.idx - a.idx))
  console.log(`  ${TIERNM(t.score).padEnd(11)} ${t.team.padEnd(26)} ${t.rec.padEnd(6)} ${t.div} #${t.place} ${t.score}/5 idx ${t.idx.toFixed(1).padStart(5)} | ` + CRIT.map((c, i) => `${t.q[i] ? '✓' : '✗'} ${FEAT[c.f].label} ${c.f === 'wp' ? t.wp.toFixed(3) + ' #' + t.r_wp : c.f === 'def' ? t.def.toFixed(1) + ' #' + t.r_def : c.f === 'off' ? t.off.toFixed(1) : t[c.f]}`).join(' · ') + ` | margin ${t.mgn.toFixed(1)}${alive.has(t.id) ? `  ◀ alive · title ${(100 * (sm.get(t.id) || 0)).toFixed(1)}% (fair ${american(sm.get(t.id) || 0)})` : ''}`);
console.log(`\nTITLE ODDS (alive teams) -- no odds feed for the Grey Cup: post a DraftKings (else FanDuel) screenshot and rerun with --book`);
for (const t of pool.sort((a, b) => (sm.get(b.id) || 0) - (sm.get(a.id) || 0))) {
  const ps = sm.get(t.id) || 0, pb = BP.get(t.id) || 0;
  console.log(`  ${t.team.padEnd(26)} bracket sim ${(100 * ps).toFixed(1).padStart(5)}% (${american(ps)}) | blueprint ${(100 * pb).toFixed(1).padStart(5)}% | ${t.score}/5`);
}
const bi = rest.indexOf('--book');   // pasted sportsbook board: --book "MTL Alouettes:-115,BC Lions:+300,EDM Elks:+350,WPG Blue Bombers:+800"
if (bi >= 0) { console.log('\nBOOK PRICES (pasted) -- EV = bracket-sim p x decimal odds - 1');
  for (const pair of rest[bi + 1].split(',')) { const m = pair.trim().match(/^(.*?):\s*([+-]?\d+)$/); if (!m) continue; const am = +m[2], dec = am > 0 ? 1 + am / 100 : 1 + 100 / -am, w = m[1].trim().toLowerCase();
    const t = pool.find(x => { const n = x.team.toLowerCase(); return w.split(' ').some(tok => tok.length > 2 && n.includes(tok)); }), q = t ? (sm.get(t.id) || 0) : null;
    console.log(`  ${m[1].padEnd(22)} ${m[2].padStart(6)} implied ${(100 / dec).toFixed(1)}% | sim ${q == null ? 'n/a (not alive / not matched)' : (100 * q).toFixed(1) + '% -> EV ' + (q * dec - 1 >= 0 ? '+' : '') + Math.round(100 * (q * dec - 1)) + '%'}`); } }
const EXPORT = rest.includes('--export') ? rest[rest.indexOf('--export') + 1] : null;
if (EXPORT) {   // board JSON for the blueprint dashboard (blueprint-dashboard/scripts/build.py build_cfl; this file is copied there)
  const SHORT = {wp: 'Win%', off: 'Scoring', def: 'Allowed', place: 'Div place', l: 'Losses'}, nm = id => (S.teams.find(t => t.id === id) || {}).team || id;
  const next = id => { const g = (S.games || []).find(g => !g.win && g.a && g.b && (g.a === id || g.b === id)); if (!g) return null;
    const RD = {1: 'Division semifinal', 2: 'Division final', 3: 'Grey Cup'}; return {round: RD[g.rd], opp: nm(g.a === id ? g.b : g.a), site: g.home == null ? 'neutral' : g.home === id ? 'home' : 'away'}; };
  const out = {league: 'cfl', season: CUR, generated: new Date().toISOString(), today, stage, champions: H.length, home_edge: sim.h, spread: sim.s,
    cats: CRIT.map((c, i) => critLbl(c, cut[i])), labels: CRIT.map(c => SHORT[c.f] || FEAT[c.f].label),
    teams: S.teams.map(t => ({name: t.team, rec: t.rec, gp: t.gp, div: t.div, place: t.place, score: t.score, q: t.q,
      vals: CRIT.map(c => c.f === 'wp' ? `${t.wp.toFixed(3)} #${t.r_wp}` : c.f === 'def' ? `${t.def.toFixed(1)} #${t.r_def}` : c.f === 'off' ? t.off.toFixed(1) : String(t[c.f])),
      idx: +t.idx.toFixed(1), mgn: +t.mgn.toFixed(2), alive: alive.has(t.id), p: sm.get(t.id) || 0, pb: BP.get(t.id) || 0, next: alive.has(t.id) ? next(t.id) : null}))};
  fs.writeFileSync(EXPORT, JSON.stringify(out));
  console.log('exported -> ' + EXPORT);
}
if (rest.includes('--log')) {
  const file = 'C:/Users/User/baseball-blueprint/cfl-history.md';
  const head = `# CFL Grey Cup Blueprint — Run History\n\nEach run prepends a dated snapshot (engine: baseball-blueprint/college/cfl.mjs).\n\n---\n\n`;
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : head, i = old.indexOf('---\n\n');
  let body = i >= 0 ? old.slice(i + 5) : '';
  if (body.startsWith(`## ${today} `)) { const nx = body.indexOf('\n## '); body = nx >= 0 ? body.slice(nx + 1) : ''; }
  const line = pool.map(t => `${t.team} sim ${(100 * (sm.get(t.id) || 0)).toFixed(0)}% / blueprint ${(100 * (BP.get(t.id) || 0)).toFixed(0)}%`).join(' · ');
  const entry = `## ${today} (${CUR}, ${stage})\n\n${S.teams.slice().sort((a, b) => b.score - a.score || b.idx - a.idx).map(t => `- ${t.team} ${t.rec} ${t.score}/5 (idx ${t.idx.toFixed(1)})`).join('\n')}\n\n**Title odds:** ${line}\n\n`;
  fs.writeFileSync(file, i >= 0 ? old.slice(0, i + 5) + entry + body : old + entry);
  console.log('\nlogged to ' + file);
}
