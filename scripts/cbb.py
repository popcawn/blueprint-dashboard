"""Men's (cbb) and women's (wcbb) college basketball blueprint for the dashboard.

Criteria = the cutoffs EVERY one of the last 10 national champions cleared, on Selection-Sunday stats
(regular season + conference tournaments), with opponent-adjusted efficiency computed from ESPN box
scores (sportsdataverse mirror). Engine + backtests live in baseball-blueprint/cbb (cbb_live.py):
  men   — 15 seasons (2011-26): champion top-3 by fair odds in 9/15, top-5 in 11/15, #1 in 4/15
  women — 10 seasons (2016-26): champion #1 in 4/9, top-3 in 8/9, calibrated
Before ~8 games the fair odds come from the preseason roster projection (data/<key>_preseason.json,
exported by the engine with a per-team 'lineup confirmed' flag); after that, from the blueprint.
Needs pandas + pyarrow (installed in the Action)."""
import json, os, re, tempfile, urllib.request
import numpy as np, pandas as pd

REL = "https://github.com/sportsdataverse/sportsdataverse-data/releases/download"
CRIT = {"cbb":  [("adj_net", True, "rank", 8), ("adj_o", True, "rank", 18), ("adj_d", False, "rank", 29), ("wp", True, "val", .757), ("top50_wp", True, "val", .571)],
        "wcbb": [("adj_net", True, "rank", 5), ("adj_o", True, "rank", 8), ("adj_d", False, "rank", 17), ("wp", True, "val", .870), ("top50_wp", True, "val", .727)]}
CATS = {"cbb":  ["Adj net top-8", "Adj off top-18", "Adj def top-29", "Win% ≥.758", "vs top-50 ≥.571"],
        "wcbb": ["Adj net top-5", "Adj off top-8", "Adj def top-17", "Win% ≥.871", "vs top-50 ≥.727"]}
LABELS = ["Adj net", "Adj off", "Adj def", "Win%", "vs top-50"]
W = [.30, .20, .20, .15, .15]
K = {"cbb": 15, "wcbb": 10}; CAP = {"cbb": .20, "wcbb": .45}; POOL = {"cbb": 2, "wcbb": 3}
PRE_UNTIL = 8                                     # median games before the blueprint takes over from the projection

def _adjust(games, col_o, col_d, n=30):
    O = games.groupby("team_id")[col_o].mean().to_dict(); Dd = games.groupby("team_id")[col_d].mean().to_dict()
    avg = np.mean(list(O.values())); g = games[["team_id", "opponent_team_id", col_o, col_d]].values
    for _ in range(n):
        so = pd.DataFrame({"t": g[:, 0], "v": g[:, 2] - (np.array([Dd.get(x, avg) for x in g[:, 1]]) - avg)}).groupby("t").v.mean()
        sd = pd.DataFrame({"t": g[:, 0], "v": g[:, 3] - (np.array([O.get(x, avg) for x in g[:, 1]]) - avg)}).groupby("t").v.mean()
        O, Dd = so.to_dict(), sd.to_dict()
    return O, Dd

def features(t):
    """team-season features from ESPN team box scores (season_type 2 only)"""
    t = t[t.season_type == 2].copy()
    num = ["team_score", "opponent_team_score", "field_goals_attempted", "offensive_rebounds", "free_throws_attempted", "turnovers"]
    for c in num: t[c] = pd.to_numeric(t[c], errors="coerce")
    t["turnovers"] = t["turnovers"].fillna(pd.to_numeric(t.get("total_turnovers"), errors="coerce"))
    o = t[["game_id", "team_id"] + num[2:]].rename(columns={c: "o_" + c for c in num[2:]} | {"team_id": "opponent_team_id"})
    t = t.merge(o, on=["game_id", "opponent_team_id"], how="left")
    poss = lambda p: t[p + "field_goals_attempted"] - t[p + "offensive_rebounds"] + t[p + "turnovers"] + .475 * t[p + "free_throws_attempted"]
    t["poss"] = (poss("") + poss("o_")) / 2; t["ortg"] = t.team_score / t.poss * 100; t["drtg"] = t.opponent_team_score / t.poss * 100
    t["margin"] = t.team_score - t.opponent_team_score; t["win"] = (t.margin > 0).astype(float)
    gp = t.groupby("team_id").size(); d1 = gp[gp >= min(15, max(1, int(gp.median() * .6)))].index
    full = t[t.o_field_goals_attempted.notna() & t.poss.between(40, 110)]
    mov = t.groupby("team_id").margin.mean().to_dict(); srs = dict(mov); G_ = t[["team_id", "opponent_team_id"]].values
    for _ in range(40):
        opp = pd.DataFrame({"t": G_[:, 0], "v": [srs.get(x, -25.0) for x in G_[:, 1]]}).groupby("t").v.mean()
        srs = {k: mov[k] + opp.get(k, 0) for k in mov}; m = np.mean([srs[k] for k in d1 if k in srs]); srs = {k: v - m for k, v in srs.items()}
    adjO, adjD = _adjust(full, "ortg", "drtg") if len(full) else ({}, {})
    srank = pd.Series(srs).loc[[k for k in d1 if k in srs]].rank(ascending=False); top50 = set(srank[srank <= 50].index)
    rows = []
    for tid, g in t.groupby("team_id"):
        if tid not in d1: continue
        q1 = g[g.opponent_team_id.isin(top50)]
        rows.append(dict(team_id=tid, name=g.team_display_name.iloc[0], loc=g.team_location.iloc[0], gp=len(g), w=int(g.win.sum()),
                         wp=g.win.mean(), adj_o=adjO.get(tid, np.nan), adj_d=adjD.get(tid, np.nan),
                         adj_net=adjO.get(tid, np.nan) - adjD.get(tid, np.nan), top50_wp=q1.win.mean() if len(q1) else np.nan,
                         top50_rec=f"{int(q1.win.sum())}-{len(q1) - int(q1.win.sum())}"))
    return pd.DataFrame(rows)

def _key(s): return re.sub(r"[^a-z0-9 ]", "", s.lower().replace("&", " and ").replace("saint ", "st ").replace("state", "st")).replace("  ", " ").strip()

ALIAS = {"connecticut": "uconn", "miami fl": "miami", "nc st": "nc st", "uconn": "uconn"}
def match_names(market, F, locs):
    """market team names (FanDuel/Kalshi spelling) -> ESPN display names. locs = {display name: school}"""
    loc = {}
    for nm, l in locs.items(): loc[_key(l)] = nm; loc[_key(nm)] = nm
    for r in F.itertuples(): loc.setdefault(_key(r.name), r.name)
    out = {}
    for nm, v in market.items():
        k = _key(nm.replace(" (W)", "")); k = ALIAS.get(k, k); hit = loc.get(k)
        if hit is None:
            c = [n for kk, n in loc.items() if kk.startswith(k + " ") or k.startswith(kk + " ")]
            hit = c[0] if len(set(c)) == 1 else None
        if hit: out[hit] = v
    return out

def american(p): return None if not p else (f"+{round(100 * (1 - p) / p)}" if p < .5 else f"-{round(100 * p / (1 - p))}")

def build(key, data_dir, fd_raw, year):
    season = year + 1                                   # 2026-27 -> sportsdataverse season 2027
    g = "mens" if key == "cbb" else "womens"
    base = {"sport": "CBB" if key == "cbb" else "WCBB", "season": f"{season-1}-{str(season)[2:]}"}
    path = os.path.join(tempfile.gettempdir(), f"{g}_team_{season}.parquet")
    try:
        urllib.request.urlretrieve(f"{REL}/espn_{g}_college_basketball_team_boxscores/team_box_{season}.parquet", path)
        F = features(pd.read_parquet(path))
    except Exception as e:
        print(f"  {key}: no season data yet ({e})"); F = pd.DataFrame()
    locs = {}
    for yy in (season - 1, season):                      # school names for matching market spellings
        lp = os.path.join(tempfile.gettempdir(), f"{g}_team_{yy}.parquet")
        try:
            if not os.path.exists(lp) or yy == season - 1 and os.path.getsize(lp) < 1000: urllib.request.urlretrieve(f"{REL}/espn_{g}_college_basketball_team_boxscores/team_box_{yy}.parquet", lp)
            x = pd.read_parquet(lp, columns=["team_display_name", "team_location"]).drop_duplicates()
            locs.update(dict(zip(x.team_display_name, x.team_location)))
        except Exception: pass
    pre = None; pp = os.path.join(data_dir, f"{key}_preseason.json")
    if os.path.exists(pp): pre = json.load(open(pp, encoding="utf-8"))
    if F.empty and not pre:
        base.update({"status": "preseason", "note": "College basketball tips off in early November — the blueprint goes live on the first games.", "teams": []}); return base
    if pre:                                              # projected contenders who haven't played yet still get a row
        have = set(F.name) if len(F) else set()
        miss = [dict(team_id=None, name=t["name"], loc=t["name"], gp=0, w=0, wp=np.nan, adj_o=np.nan, adj_d=np.nan, adj_net=np.nan,
                     top50_wp=np.nan, top50_rec="0-0") for t in pre["teams"] if t["name"] not in have]
        F = pd.concat([F, pd.DataFrame(miss)], ignore_index=True) if len(F) else pd.DataFrame(miss)
    q = []
    for f, hi, kind, cut in CRIT[key]:
        v = F[f].fillna(F[f].min() if hi else F[f].max())
        q.append(((v.rank(ascending=not hi, method="min") <= cut) if kind == "rank" else ((v >= cut) if hi else (v <= cut))) & F[f].notna())
    F["q"] = [list(map(bool, x)) for x in zip(*q)]; F["score"] = [sum(x) for x in F.q]
    for f, hi, *_ in CRIT[key]: F["rk_" + f] = F[f].rank(ascending=not hi, method="min")
    idx = 0.0
    for w, (f, hi, *_) in zip(W, CRIT[key]):
        v = F[f].fillna(F[f].median()); rng = (v.max() - v.min()) or 1
        idx = idx + w * (((v - v.min()) / rng * 100) if hi else ((v.max() - v) / rng * 100))
    F["index"] = idx.fillna(0).round(1)
    med = float(F.gp.median()) if len(F) else 0
    use_pre = pre is not None and med < PRE_UNTIL
    if use_pre:
        pm = {t["name"]: t for t in pre["teams"]}
        F["p"] = [pm[n]["p"] if n in pm else 0.0 for n in F.name]
        F["confirmed"] = [pm[n].get("confirmed") if n in pm else None for n in F.name]
        F["pre_rank"] = [pm[n].get("rank") if n in pm else None for n in F.name]
        # projection phase: 1-3 games of criteria are noise, so tiers follow projected title odds (labelled on the page)
        F["score"] = [5 if p >= .10 else 4 if p >= .04 else 3 if p >= .02 else 2 if p >= .01 else 1 for p in F.p]
        F["q"] = [[False] * 5 for _ in range(len(F))]
    else:
        pool = F.score >= POOL[key]; wt = np.where(pool, (F["index"] / 100) ** K[key], 0); p = wt / wt.sum() if wt.sum() else wt
        for _ in range(20):
            over = p > CAP[key]
            if not over.any(): break
            ex = (p[over] - CAP[key]).sum(); p[over] = CAP[key]; r = (~over) & (p > 0); p[r] += ex * p[r] / p[r].sum()
        F["p"] = p; F["confirmed"] = None; F["pre_rank"] = None
    fd = match_names(fd_raw or {}, F, locs)
    F["mk"] = F.name.map(fd)
    rows = []
    show = F[(F.p >= .004)].copy() if use_pre else F[(F.score >= 2) | (F.p >= .004)].copy()
    for r in show.sort_values(["score", "p", "index"], ascending=False).itertuples():
        def val(f, fmt):
            v = getattr(r, f); return "—" if v != v else (fmt.format(v) + (f" #{int(getattr(r, 'rk_' + f))}" if f.startswith("adj") else ""))
        rows.append({"name": r.name, "rec": f"{r.w}-{r.gp - r.w}", "gp": int(r.gp), "score": int(r.score), "index": float(r.index) if r.gp else None, "q": r.q,
                     "vals": [val("adj_net", "{:+.1f}"), val("adj_o", "{:.1f}"), val("adj_d", "{:.1f}"), val("wp", "{:.3f}"),
                              (f"{r.top50_rec}" if r.top50_wp == r.top50_wp else "—")],
                     "rtg": None if r.adj_net != r.adj_net else round(float(r.adj_net), 1),
                     "p": float(r.p), "mk": None if r.mk != r.mk else int(r.mk),
                     "confirmed": r.confirmed, "pre_rank": r.pre_rank})
    base.update({"cats": CATS[key], "labels": LABELS, "teams": rows, "use_pre": use_pre, "median_gp": med,
                 "pre_generated": pre.get("generated") if pre else None, "pre_confirmed": pre.get("confirmed_teams") if pre else None})
    return base
