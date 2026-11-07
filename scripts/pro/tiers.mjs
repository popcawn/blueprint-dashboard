// Shared champion-profile tiers for the pro engines (added 2026-11-05, user: "i want teirs for all bp").
// 5 stats per sport; each cutoff = what `cover` (90%) of past champions cleared at the same point of their season.
// Tiers are a profile, not the odds -- each engine's odds still come from its backtested model.
export const TIER_NAME = s => s >= 5 ? '🏆 Best (5/5)' : s === 4 ? '🔵 Great (4/5)' : s === 3 ? '🟢 Good (3/5)' : s === 2 ? '🟡 Outside (2/5)' : '⚪ Longshot (0-1/5)';
export function rankRows(rows, feats) {
  for (const f of feats) {
    const v = r => r[f.k] == null || !isFinite(r[f.k]) ? (f.dir > 0 ? -Infinity : Infinity) : r[f.k];
    for (const r of rows) r['r_' + f.k] = 1 + rows.filter(o => (f.dir > 0 ? v(o) > v(r) : v(o) < v(r))).length;
  }
  return rows;
}
export function cutoffs(champs, feats, cover = 0.9) {
  const k = Math.max(1, Math.ceil(cover * champs.length)) - 1;
  return feats.map(f => {
    if (f.kind === 'rank') return champs.map(c => c['r_' + f.k]).sort((a, b) => a - b)[k];
    return champs.map(c => c[f.k] ?? (f.dir > 0 ? -Infinity : Infinity)).sort((a, b) => f.dir > 0 ? b - a : a - b)[k];
  });
}
export function score(r, feats, cuts) {
  r.q = feats.map((f, i) => f.kind === 'rank' ? r['r_' + f.k] <= cuts[i] : (r[f.k] != null && (f.dir > 0 ? r[f.k] >= cuts[i] - 1e-9 : r[f.k] <= cuts[i] + 1e-9)));
  r.score = r.q.filter(Boolean).length;
  return r;
}
export const cutLabel = (f, c, fmt = v => (+v).toFixed(2)) => f.kind === 'rank' ? `${f.label} top-${c}` : `${f.label} ${f.dir > 0 ? '≥' : '≤'} ${fmt(c)}`;
// seasons: [{Y, rows: all teams (ranked), champ: row, field: rows that could win}] -> printable backtest lines
export function tierBacktest(seasons, feats, cover = 0.9, fmt) {
  const out = [], dist = {}, per = {5: 0, 4: 0, 3: 0}, n = seasons.length;
  for (const S of seasons) {
    const train = seasons.filter(x => x !== S).map(x => x.champ), cuts = cutoffs(train, feats, cover);
    const c = score({...S.champ}, feats, cuts);
    dist[c.score] = (dist[c.score] || 0) + 1;
    const f = S.field.map(r => score({...r}, feats, cuts));
    for (const t of [5, 4, 3]) per[t] += f.filter(r => r.score >= t).length;
    const top = Math.max(...f.map(r => r.score));
    out.push(`  ${S.Y} ${String(S.champName).padEnd(26)} ${c.score}/5 [${c.q.map(x => x ? '✓' : '✗').join('')}]  (field's best tier that year: ${top}/5, ${f.filter(r => r.score === top).length} team(s))`);
  }
  const all = cutoffs(seasons.map(s => s.champ), feats, cover);
  return [
    `champion profile cutoffs (what ${Math.round(cover * 100)}% of ${n} champions cleared): ${feats.map((f, i) => cutLabel(f, all[i], fmt)).join(' · ')}`,
    `held-out champions vs criteria fitted WITHOUT them: ${Object.entries(dist).sort((a, b) => b[0] - a[0]).map(([k, v]) => `${k}/5: ${v}`).join(' · ')}`,
    `teams per season in the playoff field at 5/5: ${(per[5] / n).toFixed(1)} · at 4/5+: ${(per[4] / n).toFixed(1)} · at 3/5+: ${(per[3] / n).toFixed(1)}`,
    ...out,
  ];
}
