// College title blueprints -- FCS football, women's volleyball, men's hockey (built 2026-11-05).
//   node run.mjs <fcs|wcvb|chk> check               pull + cache every season; print field size, champion, bracket date
//   node run.mjs <sport> study                      champion profiles on every candidate stat (bracket-time boards)
//   node run.mjs <sport> backtest [--asof MM-DD]    leave-one-season-out backtest vs SRS-only and coin-flip baselines
//   node run.mjs <sport> [live] [--log] [--book "Team:+300,..."]   this season's board + fair odds (+ EV vs a pasted sportsbook screenshot); --log -> history file
//   node run.mjs <sport> dump                       every team's numbers at the bracket, each season -> study/data/<sport>.json (study/criteria.mjs)
// NO KALSHI (user, 2026-11-06): markets without Odds API futures are priced only from the user's DraftKings/FanDuel screenshots.
import fs from 'node:fs';
import {ymd, addDays, tourney, board, FEAT, cutoffs, scoreTeams, indexTeams, fair, srsSoft, GRID, BETAS, LL, norm, american} from './lib.mjs';

const SPORTS = {fcs: './fcs.mjs', wcvb: './wcvb.mjs', chk: './chk.mjs'};
let [sk, mode = 'live', ...rest] = process.argv.slice(2);
if (mode.startsWith('--')) { rest.unshift(mode); mode = 'live'; }
if (!SPORTS[sk]) { console.log('usage: node run.mjs <fcs|wcvb|chk> [check|study|backtest|live] [--asof MM-DD] [--log]'); process.exit(1); }
const A = await import(SPORTS[sk]);
const today = process.env.BP_TODAY || new Date().toLocaleDateString('en-CA');   // local date (UTC rolls over early in the evening ET)
const arg = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
// experiment overrides: --crit srs:rank,wp:value,... --w srs:30,rpi:20,... --cover 0.9
const C = {crit: A.crit, W: A.W, cover: A.cover ?? 0.9};
if (arg('--crit')) C.crit = arg('--crit').split(',').map(s => { const [f, kind = 'rank'] = s.split(':'); return {f, kind}; });
if (arg('--w')) C.W = Object.fromEntries(arg('--w').split(',').map(s => { const [f, w] = s.split(':'); return [f, +w]; }));
if (arg('--cover')) C.cover = +arg('--cover');
const minD = (a, b) => (a < b ? a : b);
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

async function seasonData(Y) { const S = await A.load(Y, today), tr = A.tourney ? A.tourney(S) : tourney(S, A.isFinal); return {Y, S, tr}; }
async function history(mmdd) {
  const out = [];
  for (const Y of A.seasons) {
    const {S, tr} = await seasonData(Y);
    const Bf = board(S, tr.start, A.cfg);
    indexTeams(Bf.teams, C.W || {srs: 1});
    const d = {Y, S, tr, Bf, champ: tr.champ, field: tr.field, champName: S.names.get(tr.champ)};
    if (mmdd) { d.Ba = board(S, minD(A.asOfFor(Y, mmdd), tr.start), A.cfg); indexTeams(d.Ba.teams, C.W || {srs: 1}); }
    out.push(d);
  }
  return out;
}
const champOn = (B, id) => B.teams.find(t => t.id === id);
function evalPool(list, id) { const i = list.findIndex(x => x.t.id === id); return {r: i < 0 ? null : i + 1, p: i < 0 ? 0 : list[i].p}; }
function tune(train, poolOf) {
  let best = null;
  for (const prm of GRID) { const ll = mean(train.map(d => LL(evalPool(fair(poolOf(d), prm), d.champ).p))); if (!best || ll < best.ll - 1e-12) best = {prm, ll}; }
  let bb = null;
  for (const b of BETAS) { const ll = mean(train.map(d => LL(evalPool(srsSoft(poolOf(d), b), d.champ).p))); if (!bb || ll < bb.ll - 1e-12) bb = {b, ll}; }
  return {prm: best.prm, beta: bb.b};
}
const fmtV = (f, v) => v == null || !isFinite(v) ? '—' : ['wp', 'wpTop', 'sos', 'rpi'].includes(f) ? v.toFixed(3).replace(/^0/, '') : v.toFixed(A.dec ?? 1);
const critLabel = (c, cut) => `${FEAT[c.f].label} ${c.kind === 'rank' ? 'top-' + cut : (FEAT[c.f].dir > 0 ? '≥ ' : '≤ ') + fmtV(c.f, cut)}`;

// ---------------------------------------------------------------- check
if (mode === 'check') {
  for (const Y of [...A.seasons, A.currentSeason(today)]) {
    const {S, tr} = await seasonData(Y);
    const B = board(S, tr.start || addDays(today, 1), A.cfg);
    const inB = tr.champ ? B.teams.some(t => t.id === tr.champ) : null;
    console.log(`${Y}: ${S.games.length} games · D1 teams ${B.teams.length} (gp ${B.gpMin}-${B.gpMax}) · field ${tr.field.size} · bracket ${tr.start || '—'} · final ${tr.final ? tr.final.d + ' ' + (tr.final.round || '') : '—'} · champion ${tr.champ ? S.names.get(tr.champ) : '—'}${inB === false ? ' (NOT on board!)' : ''}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- study
if (mode === 'study') {
  const H = await history(null);
  console.log(`CHAMPION PROFILES -- ${A.label}, stats from games before the bracket (rank among D1; ties share the best rank)`);
  for (const d of H) {
    const c = champOn(d.Bf, d.champ);
    if (!c) { console.log(`${d.Y} champion ${d.champName} not on board`); continue; }
    const fr = f => 1 + d.Bf.teams.filter(t => d.field.has(t.id) && FEAT[f].dir * ((t[f] ?? -1e9 * FEAT[f].dir) - (c[f] ?? -1e9 * FEAT[f].dir)) > 0).length;
    console.log(`${d.Y} ${String(c.name).padEnd(16)} ${c.rec.padEnd(7)} ` + Object.keys(FEAT).map(f => `${f} #${c['r_' + f]}`).join(' ') + ` | wp ${fmtV('wp', c.wp)} vsTop ${fmtV('wpTop', c.wpTop)} (${c.nTop}g) | in-field SRS #${fr('srs')} of ${d.field.size} | D1 ${d.Bf.teams.length}`);
  }
  console.log('\nper stat: champion ranks (sorted) | median | 90%-of-champs cutoff -> teams/season inside it (all D1 · field) | every-champ cutoff -> teams/season');
  for (const f of Object.keys(FEAT)) {
    const rk = H.map(d => champOn(d.Bf, d.champ)['r_' + f]).sort((a, b) => a - b);
    const c90 = rk[Math.ceil(0.9 * rk.length) - 1], cAll = rk[rk.length - 1];
    const sel = (cut, fld) => mean(H.map(d => d.Bf.teams.filter(t => t['r_' + f] <= cut && (!fld || d.field.has(t.id))).length));
    console.log(`${f.padEnd(6)} ${rk.join(',').padEnd(52)} | med ${String(rk[Math.floor(rk.length / 2)]).padEnd(3)} | 90% #${String(c90).padEnd(3)} -> ${sel(c90).toFixed(1).padStart(5)} · ${sel(c90, 1).toFixed(1).padStart(4)} | all #${String(cAll).padEnd(3)} -> ${sel(cAll).toFixed(1).padStart(5)}`);
  }
  for (const f of ['wp', 'wpTop']) {
    const v = H.map(d => champOn(d.Bf, d.champ)[f]).map(x => x == null ? null : +x.toFixed(3));
    console.log(`${f} champion values: ${v.join(', ')}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- dump (input for study/criteria.mjs, the "every champion" search)
if (mode === 'dump') {
  const H = await history(null), K = ['srs', 'adjO', 'adjD', 'wp', 'off', 'def', 'mgn', 'sos', 'rpi', 'wpTop', 'l'];
  const out = {sport: sk, label: A.label, when: 'games before the NCAA bracket', fieldLabel: 'the NCAA tournament field', universeLabel: 'every D1 team',
    cands: [{k: 'srs', dir: 1, label: 'Rating (SRS)'}, {k: 'adjO', dir: 1, label: 'Adj offense'}, {k: 'adjD', dir: -1, label: 'Adj defense'}, {k: 'wp', dir: 1, label: 'Win%', value: true},
      {k: 'off', dir: 1, label: 'Scoring'}, {k: 'def', dir: -1, label: 'Allowed'}, {k: 'mgn', dir: 1, label: 'Margin'}, {k: 'sos', dir: 1, label: 'SOS'}, {k: 'rpi', dir: 1, label: 'RPI', value: true},
      {k: 'wpTop', dir: 1, label: 'Win% vs top', value: true}, {k: 'l', dir: -1, label: 'Losses', value: true, rank: false, dec: 0}],
    seasons: H.map(d => ({Y: d.Y, champ: d.champ, champName: d.champName, field: [...d.field], rows: d.Bf.teams.map(t => Object.fromEntries([['id', t.id], ['name', t.name], ...K.map(k => [k, t[k] ?? null])]))}))};
  fs.mkdirSync('C:/Users/User/baseball-blueprint/study/data', {recursive: true});
  fs.writeFileSync(`C:/Users/User/baseball-blueprint/study/data/${sk}.json`, JSON.stringify(out));
  console.log(`dumped ${out.seasons.length} seasons -> study/data/${sk}.json`);
  process.exit(0);
}

// ---------------------------------------------------------------- backtest
if (mode === 'backtest') {
  const mmdd = arg('--asof');
  const H = await history(mmdd);
  const POOLS = {field: {b: 'Bf', f: d => d.Bf.teams.filter(t => d.field.has(t.id)), label: 'at the bracket (field known)'},
                 all: {b: 'Bf', f: d => d.Bf.teams, label: 'at the bracket, before the field is known (all D1)'}};
  if (mmdd) POOLS.asof = {b: 'Ba', f: d => d.Ba.teams, label: `as of ${mmdd} each season (all D1)`};
  const n = H.length, half = Math.ceil(n / 2);
  console.log(`${A.label} -- leave-one-season-out over ${n} seasons (${H[0].Y}-${H[n - 1].Y}); criteria: ${C.crit.map(c => c.f + '(' + c.kind + ')').join(', ')}; cover ${C.cover}`);
  const passDist = {};
  for (const [pk, P] of Object.entries(POOLS)) {
    const res = [], HH = pk === 'asof' ? H.filter(d => d.Ba.teams.length && champOn(d.Ba, d.champ)) : H, nn = HH.length, hh = Math.ceil(nn / 2);   // as-of: skip seasons not started yet (2021 hockey)
    for (let h = 0; h < nn; h++) {
      const train = HH.filter((_, i) => i !== h), d = HH[h];
      const cut = cutoffs(train.map(x => champOn(x.Bf, x.champ)), C.crit, C.cover);
      for (const x of HH) scoreTeams(x[P.b].teams, C.crit, cut);
      if (pk === 'field') { const cc = champOn(d.Bf, d.champ); scoreTeams([cc], C.crit, cut); passDist[cc.score] = (passDist[cc.score] || 0) + 1; }
      const t = tune(train, P.f);
      const L = fair(P.f(d), t.prm), e = evalPool(L, d.champ), s = evalPool(srsSoft(P.f(d), t.beta), d.champ);
      const c = d[P.b].teams.find(x => x.id === d.champ);
      res.push({Y: d.Y, name: d.champName, sc: c ? c.score : null, r: e.r, p: e.p, sr: s.r, sp: s.p, nPool: P.f(d).length, top: L[0].t.name, topP: L[0].p, prm: t.prm, beta: t.beta,
        n5: P.f(d).filter(x => x.score === 5).length, n4: P.f(d).filter(x => x.score >= 4).length});
    }
    const sum = rs => ({one: rs.filter(r => r.r === 1).length, t3: rs.filter(r => r.r && r.r <= 3).length, t5: rs.filter(r => r.r && r.r <= 5).length, p: mean(rs.map(r => r.p)), ll: mean(rs.map(r => LL(r.p))),
      s1: rs.filter(r => r.sr === 1).length, s3: rs.filter(r => r.sr && r.sr <= 3).length, sp: mean(rs.map(r => r.sp)), sll: mean(rs.map(r => LL(r.sp))), ull: mean(rs.map(r => Math.log(r.nPool))), n: rs.length});
    console.log(`\n=== ${P.label} ===`);
    if (pk !== 'all') {
      console.log('season champion          score  blueprint rank   p      | SRS-only rank   p     | blueprint #1 (p)            | k/tier/cap  beta | 5/5, 4+/5 teams in pool');
      for (const r of res) console.log(`${r.Y}   ${String(r.name).padEnd(18)} ${r.sc}/5   #${String(r.r ?? '–').padEnd(3)} ${(100 * r.p).toFixed(1).padStart(5)}%      | #${String(r.sr ?? '–').padEnd(3)} ${(100 * r.sp).toFixed(1).padStart(5)}% | ${String(r.top).padEnd(18)} ${(100 * r.topP).toFixed(0).padStart(3)}%    | ${r.prm.k}/${r.prm.tier}/${r.prm.cap}  ${r.beta}  | ${r.n5}, ${r.n4}`);
    }
    for (const [lab, rs] of [['ALL', res], [`1st half ${res[0].Y}-${res[hh - 1].Y}`, res.slice(0, hh)], [`2nd half ${res[hh].Y}-${res[nn - 1].Y}`, res.slice(hh)]]) {
      const s = sum(rs);
      console.log(`${lab.padEnd(22)} blueprint: #1 ${s.one}/${s.n} · top-3 ${s.t3}/${s.n} · top-5 ${s.t5}/${s.n} · champ p ${(100 * s.p).toFixed(1)}% · log-loss ${s.ll.toFixed(3)}  ||  SRS-only: #1 ${s.s1}/${s.n} · top-3 ${s.s3}/${s.n} · p ${(100 * s.sp).toFixed(1)}% · LL ${s.sll.toFixed(3)}  ||  coin-flip LL ${s.ull.toFixed(3)}`);
    }
  }
  console.log(`\nheld-out champions vs criteria fitted WITHOUT them: ` + Object.entries(passDist).sort((a, b) => b[0] - a[0]).map(([k, v]) => `${k}/5: ${v}`).join(' · '));
  const all = cutoffs(H.map(x => champOn(x.Bf, x.champ)), C.crit, C.cover);
  console.log('cutoffs fitted on all seasons: ' + C.crit.map((c, i) => critLabel(c, all[i])).join(' · '));
  process.exit(0);
}

// ---------------------------------------------------------------- live board
let Y = A.currentSeason(today);
let {S, tr} = await seasonData(Y);
// offseason (fixed 2026-11-07): the season flips on a calendar date (FCS Jul 1, volleyball Jun 1, hockey Jul 1) weeks before its first game; until this
// season has a completed game, show the last one (the board used to be empty -- 0 teams -- and the site's FCS build crashed every day)
if (!S.games.some(g => g.fin)) { Y -= 1; ({S, tr} = await seasonData(Y)); }
const fieldKnown = tr.field.size >= (A.fieldMin || 8);
// betting window (fixed 2026-11-07): the user never bets within the playoffs. Once a bracket game has been played the board is FROZEN at the start of
// the bracket -- stats from games before it, odds over the field (the same board the backtest scored) -- and the survivors / champion are marked.
// Before this fix the live board kept pricing every field team (eliminated ones too) on stats that counted the playoff games.
// stage: regular (no field yet) | field (field set, no bracket game played: window open) | playoffs | done
const TG = S.games.filter(g => g.round), winnerOf = g => g.as > g.bs ? g.a : g.bs > g.as ? g.b : g.aw ? g.a : g.bw ? g.b : null;
const stage = tr.champ ? 'done' : TG.some(g => g.fin) ? 'playoffs' : fieldKnown ? 'field' : 'regular', frozen = stage === 'playoffs' || stage === 'done';
const alive = new Set(tr.field); for (const g of TG.filter(g => g.fin)) { const w = winnerOf(g); if (w) alive.delete(w === g.a ? g.b : g.a); }
const B = board(S, frozen ? tr.start : addDays(today, 1), A.cfg);
indexTeams(B.teams, C.W);
const mmdd = today.slice(5);
const H = await history(fieldKnown ? null : mmdd);
const cut = cutoffs(H.map(x => champOn(x.Bf, x.champ)), C.crit, C.cover);
const HT = fieldKnown ? H : H.filter(d => d.Ba.teams.length && champOn(d.Ba, d.champ));   // seasons not started by this date drop out of the tuning
for (const x of HT) scoreTeams((fieldKnown ? x.Bf : x.Ba).teams, C.crit, cut);
const tuned = tune(HT, fieldKnown ? d => d.Bf.teams.filter(t => d.field.has(t.id)) : d => d.Ba.teams);
scoreTeams(B.teams, C.crit, cut);
const poolT = fieldKnown ? B.teams.filter(t => tr.field.has(t.id)) : B.teams;
const F = A.oddsModel === 'srs' ? srsSoft(poolT, tuned.beta) : fair(poolT, tuned.prm);   // hockey: the profile did not beat the plain rating, so odds = rating
const byNorm = new Map(B.teams.map(t => [norm(t.name), t]));
const alias = A.alias || {};
const P = new Map(F.map(x => [x.t, x.p]));
const ALT = new Map((A.oddsModel === 'srs' ? fair(poolT, tuned.prm) : srsSoft(poolT, tuned.beta)).map(x => [x.t, x.p]));   // the other model, shown for comparison
const altName = A.oddsModel === 'srs' ? 'profile' : 'rating-only';
console.log(`${A.label} blueprint -- ${Y} season, games through ${today} · ${B.games} games · D1 teams ${B.teams.length} · games played ${B.gpMin}-${B.gpMax} (median ${B.gpMed})`);
console.log(`criteria (${C.cover >= 1 ? `every one of the ${H.length} champions ${H[0].Y}-${H[H.length - 1].Y} cleared all ${C.crit.length} before the bracket` : `cutoff = what ${Math.round(C.cover * 100)}% of the ${H.length} champions cleared`}): ` + C.crit.map((c, i) => critLabel(c, cut[i])).join(' · '));
console.log(frozen ? `${stage === 'done' ? `SEASON OVER -- champion ${S.names.get(tr.champ)}` : `PLAYOFFS UNDER WAY -- ${[...alive].length} of ${tr.field.size} teams left`} · board + odds FROZEN at the start of the bracket (${tr.start}): you never bet within the playoffs`
  : fieldKnown ? `FIELD SET: ${tr.field.size} teams -- odds over the field only (window open until the first bracket game)` : `pre-bracket: odds over every D1 team, tuned on past seasons' boards as of ${mmdd} (field not set yet)`);
console.log(A.oddsModel === 'srs' ? `odds settings: rating (SRS) model, spread ${tuned.beta} -- the 5-stat profile did not beat it in the backtest, tiers are context only` : `odds settings: idx^${tuned.prm.k}, tiers ${tuned.prm.tier}, top cap ${tuned.prm.cap === 1 ? 'none' : Math.round(100 * tuned.prm.cap) + '%'}`);
const tierName = {5: '🏆 Best (5/5)', 4: '🔵 Great (4/5)', 3: '🟢 Good (3/5)', 2: '🟡 Outside (2/5)'};
for (const s of [5, 4, 3]) {
  const L = B.teams.filter(t => t.score === s).sort((a, b) => b.idx - a.idx);
  console.log(`\n${tierName[s]} -- ${L.length} team(s)`);
  for (const t of L.slice(0, 14)) console.log(`  ${String(t.name).padEnd(20)} ${t.rec.padEnd(8)} idx ${t.idx.toFixed(1).padStart(5)} | ` + C.crit.map((c, i) => `${t.q[i] ? '✓' : '✗'} ${FEAT[c.f].label} ${fmtV(c.f, t[c.f])} #${t['r_' + c.f]}`).join(' | ') + ` | SRS #${t.r_srs} · SOS #${t.r_sos}${fieldKnown || !tr.field.size ? '' : ''}`);
  if (L.length > 14) console.log(`  … +${L.length - 14} more`);
}
console.log(`\nFAIR TITLE ODDS -- bet only at a sportsbook price LONGER than fair. No odds feed for this sport: post a DraftKings (else FanDuel) screenshot and rerun with --book`);
for (const x of F.slice(0, 15)) console.log(`  ${String(x.t.name).padEnd(20)}${frozen ? (x.t.id === tr.champ ? ' 🏆 ' : alive.has(x.t.id) ? ' ◀  ' : ' out') : ''} ${x.t.score}/5  fair ${(100 * x.p).toFixed(1).padStart(5)}% (${american(x.p).padStart(6)}) [${altName} ${(100 * (ALT.get(x.t) || 0)).toFixed(1)}%]`);
const bookArg = arg('--book');   // pasted sportsbook board: --book "South Dakota State:+275,Montana State:+380,..."
if (bookArg) {
  const ev = v => `${v >= 0 ? '+' : ''}${Math.round(100 * v)}%`;
  console.log(`\nBOOK PRICES (pasted) -- EV = model p x decimal odds - 1`);
  for (const pair of bookArg.split(',')) {
    const m = pair.trim().match(/^(.*?):\s*([+-]?\d+)$/);
    if (!m) continue;
    const am = +m[2], dec = am > 0 ? 1 + am / 100 : 1 + 100 / -am, nk = norm(m[1]), t = byNorm.get(alias[nk] || nk);
    if (!t) { console.log(`  ${m[1].trim().padEnd(20)} ${m[2].padStart(7)} -- not on the board`); continue; }
    const p = P.get(t) || 0, pa = ALT.get(t) || 0;
    console.log(`  ${String(t.name).padEnd(20)} ${m[2].padStart(7)} (implied ${(100 / dec).toFixed(1)}%) | ${t.score}/5 fair ${(100 * p).toFixed(1)}% -> EV ${ev(p * dec - 1)} | ${altName} ${(100 * pa).toFixed(1)}% -> EV ${ev(pa * dec - 1)} | SRS #${t.r_srs} SOS #${t.r_sos} ${t.rec}`);
  }
}

if (arg('--export')) {   // board JSON for the blueprint dashboard (blueprint-dashboard/scripts/build.py build_fcs; this file is copied there)
  const SHORT = {adjO: 'Adj off', adjD: 'Adj def', wp: 'Win%', def: 'Allowed', off: 'Scoring', rpi: 'RPI', wpTop: 'vs top', srs: 'Rating', sos: 'SOS'};
  const keep = B.teams.filter(t => (P.get(t) || 0) >= 0.002 || (ALT.get(t) || 0) >= 0.01 || t.score >= 3);   // blueprint or rating-only contenders
  const out = {sport: A.sport, label: A.label, season: Y, generated: new Date().toISOString(), today, field_known: fieldKnown, field_size: tr.field.size,
    stage, first_playoff: tr.start, champion: tr.champ ? S.names.get(tr.champ) : null,
    gp_min: B.gpMin, gp_max: B.gpMax, gp_med: B.gpMed, champions: H.length, alt_name: altName, weights: C.W,
    odds_model: A.oddsModel === 'srs' ? `rating model, spread ${tuned.beta}` : `tier x index^${tuned.prm.k} (tiers ${tuned.prm.tier})`,
    cats: C.crit.map((c, i) => critLabel(c, cut[i])), labels: C.crit.map(c => SHORT[c.f] || FEAT[c.f].label),
    teams: keep.map(t => ({name: t.name, rec: t.rec, gp: t.gp, score: t.score, q: t.q, vals: C.crit.map(c => `${fmtV(c.f, t[c.f])} #${t['r_' + c.f]}`),
      idx: +t.idx.toFixed(1), p: P.get(t) || 0, alt: ALT.get(t) || 0, srs: +(t.srs ?? 0).toFixed(2), r_srs: t.r_srs, sos: +(t.sos ?? 0).toFixed(3), r_sos: t.r_sos,
      in_field: tr.field.has(t.id), alive: frozen ? alive.has(t.id) : null, champion: !!tr.champ && t.id === tr.champ}))};
  fs.writeFileSync(arg('--export'), JSON.stringify(out));
  console.log('exported -> ' + arg('--export'));
}

if (rest.includes('--log')) {
  const file = `C:/Users/User/baseball-blueprint/${A.sport}-history.md`;
  const head = `# ${A.label} Blueprint — Run History\n\nEach run prepends a dated snapshot (engine: baseball-blueprint/college/run.mjs ${sk}). Criteria: ${C.crit.map((c, i) => critLabel(c, cut[i])).join(' · ')}.\n\n---\n\n`;
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : head;
  const i = old.indexOf('---\n\n');
  const tiers = [5, 4, 3].map(s => `| ${tierName[s]} | ${B.teams.filter(t => t.score === s).sort((a, b) => b.idx - a.idx).slice(0, 10).map(t => `${t.name} ${t.idx.toFixed(1)}`).join(', ') || '—'} |`).join('\n');
  const odds = F.slice(0, 8).map(x => `${x.t.name} ${(100 * x.p).toFixed(1)}% (${american(x.p)})`).join(' · ');
  const entry = `## ${today} (${Y} season, games played ${B.gpMin}-${B.gpMax}${frozen ? `, ${stage === 'done' ? 'season over' : 'playoffs'}: frozen at the start of the bracket` : fieldKnown ? ', FIELD SET' : ', pre-bracket'})\n\n| Tier | Teams (index) |\n|---|---|\n${tiers}\n\n**Fair odds:** ${odds}\n\n`;
  let body = i >= 0 ? old.slice(i + 5) : '';
  if (body.startsWith(`## ${today} `)) { const nx = body.indexOf('\n## '); body = nx >= 0 ? body.slice(nx + 1) : ''; }   // same-day rerun replaces that day's entry
  fs.writeFileSync(file, i >= 0 ? old.slice(0, i + 5) + entry + body : old + entry);
  console.log('\nlogged to ' + file);
}
