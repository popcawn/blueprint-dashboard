#!/usr/bin/env python3
"""
Blueprint Dashboard build script.
Pulls live data (ESPN, free) + optional FanDuel futures (Odds API, needs ODDS_API_KEY),
computes the NFL and CFB championship blueprints, and writes data/nfl.json + data/cfb.json.

Run locally:  python scripts/build.py
In CI:        ODDS_API_KEY=... python scripts/build.py   (key = repo secret)

Ported from the Claude Code /nfl-blueprint and /cfb-blueprint engines:
- NFL: 5 categories derived from 23 Super Bowl champions, AFC/NFC fair-odds split.
- CFB: 5 user criteria, SOS-weighted fair odds (exponent 3, backtested), + SRS reality-check column.
"""
import json, os, sys, time, datetime, urllib.request

YEAR = int(os.environ.get("SEASON_YEAR", datetime.datetime.now().year if datetime.datetime.now().month >= 7 else datetime.datetime.now().year - 1))
ODDS_KEY = os.environ.get("ODDS_API_KEY", "").strip()
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")

def get(url, timeout=50):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (blueprint-dashboard)"})
    return json.load(urllib.request.urlopen(req, timeout=timeout))

def ranks(items, key, reverse):
    order = sorted(items, key=lambda t: t[key], reverse=reverse)
    out, prev, r = {}, None, 0
    for i, t in enumerate(order):
        v = t[key]
        if v != prev:
            r, prev = i + 1, v
        out[t["name"]] = r
    return out

def norm(items, key, reverse):
    vals = [t[key] for t in items]
    lo, hi = min(vals), max(vals)
    out = {}
    for t in items:
        n = 50 if hi == lo else (t[key] - lo) / (hi - lo) * 100
        out[t["name"]] = n if reverse else 100 - n
    return out

def american(p):
    if p <= 0: return None
    return f"+{round(100*(1-p)/p)}" if p < 0.5 else f"-{round(100*p/(1-p))}"

def fetch_futures(sport_key):
    """Return {team: american_odds} from FanDuel, or {} if no key / error. Also returns remaining credits."""
    if not ODDS_KEY:
        return {}, None
    url = (f"https://api.the-odds-api.com/v4/sports/{sport_key}/odds/"
           f"?apiKey={ODDS_KEY}&regions=us&markets=outrights&oddsFormat=american&bookmakers=fanduel")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "blueprint-dashboard"})
        resp = urllib.request.urlopen(req, timeout=40)
        remaining = resp.headers.get("x-requests-remaining")
        d = json.load(resp)
        fd = [b for b in d[0]["bookmakers"] if b["key"] == "fanduel"][0]
        return {o["name"]: o["price"] for o in fd["markets"][0]["outcomes"]}, remaining
    except Exception as e:
        print(f"  odds pull failed ({sport_key}): {e}", file=sys.stderr)
        return {}, None

# ----------------------------------------------------------------------------- NFL
NFL_AFC = {"Baltimore Ravens","Cincinnati Bengals","Cleveland Browns","Pittsburgh Steelers","Buffalo Bills",
    "Miami Dolphins","New England Patriots","New York Jets","Houston Texans","Indianapolis Colts","Jacksonville Jaguars",
    "Tennessee Titans","Denver Broncos","Kansas City Chiefs","Las Vegas Raiders","Los Angeles Chargers"}

def build_nfl():
    d = get(f"https://cdn.espn.com/core/nfl/standings?xhr=1&season={YEAR}")
    teams = {}
    def walk(o):
        if isinstance(o, dict):
            if isinstance(o.get("entries"), list):
                for e in o["entries"]:
                    nm = e.get("team", {}).get("displayName")
                    if nm and nm not in teams:
                        teams[nm] = {s.get("name"): s.get("value") for s in e.get("stats", [])}
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    walk(d)
    rows = []
    for nm, st in teams.items():
        try:
            w = int(float(st.get("wins", 0))); l = int(float(st.get("losses", 0))); ti = int(float(st.get("ties", 0)))
            pf = float(st.get("pointsFor", 0)); pa = float(st.get("pointsAgainst", 0))
        except Exception: continue
        g = w + l + ti
        if g == 0: continue
        rows.append({"name": nm, "conf": "AFC" if nm in NFL_AFC else "NFC",
            "rec": f"{w}-{l}" + (f"-{ti}" if ti else ""), "gp": g,
            "winpct": (w + 0.5 * ti) / g, "ppg": pf / g, "oppppg": pa / g,
            "ptdiff": pf - pa, "pdg": (pf - pa) / g})
    rk_pd = ranks(rows, "ptdiff", True); rk_ppg = ranks(rows, "ppg", True); rk_opp = ranks(rows, "oppppg", False)
    for t in rows:
        t["rk_pd"], t["rk_ppg"], t["rk_opp"] = rk_pd[t["name"]], rk_ppg[t["name"]], rk_opp[t["name"]]
        t["q"] = [t["winpct"] >= 0.625, t["rk_pd"] <= 6, t["rk_ppg"] <= 10, t["rk_opp"] <= 10, t["pdg"] >= 5.0]
        t["score"] = sum(t["q"])
    npd = norm(rows, "ptdiff", True); npg = norm(rows, "pdg", True); no = norm(rows, "oppppg", False)
    nf = norm(rows, "ppg", True); nw = norm(rows, "winpct", True)
    for t in rows:
        t["index"] = round(npd[t["name"]]*.25 + npg[t["name"]]*.20 + no[t["name"]]*.20 + nf[t["name"]]*.20 + nw[t["name"]]*.15, 1)
    # fair odds: AFC/NFC split, cap 17%
    pool = [t for t in rows if t["score"] >= 2]
    tm = {5:1.6,4:1.25,3:1.0,2:0.7}
    for cf in ("AFC","NFC"):
        cs = [t for t in pool if t["conf"] == cf]; tot = sum((t["index"]**3)/1e5*tm[t["score"]] for t in cs)
        for t in cs: t["_pc"] = ((t["index"]**3)/1e5*tm[t["score"]]) / tot if tot else 0
    for t in pool: t["p"] = t.get("_pc", 0) * 0.5
    cap_odds(pool, 0.17)
    fd, rem = fetch_futures("americanfootball_nfl_super_bowl_winner")
    attach(rows, pool, fd)
    top, gap, run = pick_gap(pool)
    pred = None
    if top:
        pred = {"pick": top["name"], "why":
            f"<b>{top['name']}</b> are the blueprint's {'runaway ' if run else 'top '}pick — {top['rec']}, "
            f"a {top['score']}/5 with a {top['ptdiff']:+.0f} point differential (#{top['rk_pd']}, the strongest "
            f"Super-Bowl-champion signal) and an index of {top['index']}{', clear of the field' if run else ''}. "
            f"A lone dominant #1 is the profile that historically wins — but the NFL is single-elimination, so it's a strong favorite, not a lock."}
    rows.sort(key=lambda t: (-t["score"], -t["index"]))
    return {"sport": "NFL", "season": f"{YEAR}", "generated": now_iso(), "odds_remaining": rem, "prediction": pred,
            "gp_min": min(t["gp"] for t in rows), "gp_max": max(t["gp"] for t in rows),
            "cats": ["Win% ≥.625", "Pt Diff top-6", "PPG top-10", "Opp PPG top-10", "PD/g ≥+5"],
            "labels": ["Win%", "Pt Diff", "PPG", "Opp PPG", "PD/g"],
            "teams": [nfl_row(t) for t in rows]}

def nfl_row(t):
    return {"name": t["name"], "conf": t["conf"], "rec": t["rec"], "score": t["score"], "index": t["index"],
        "q": [bool(x) for x in t["q"]],
        "vals": [f"{t['winpct']:.3f}", f"{t['ptdiff']:+.0f} #{t['rk_pd']}", f"{t['ppg']:.1f} #{t['rk_ppg']}",
                 f"{t['oppppg']:.1f} #{t['rk_opp']}", f"{t['pdg']:+.1f}"],
        "fair_pct": round(t["p"]*100, 1) if t.get("p") else None, "fair_odds": t.get("fair_odds"),
        "market": t.get("market"), "ev": t.get("ev")}

# ----------------------------------------------------------------------------- CFB
def build_cfb():
    # 1) byteam stats
    bt = get(f"https://site.web.api.espn.com/apis/common/v3/sports/football/college-football/statistics/byteam?region=us&lang=en&contentorigin=espn&season={YEAR}&seasontype=2")
    pc = [c for c in bt["categories"] if c["name"] == "passing"][0]
    PI, YI = pc["names"].index("totalPointsPerGame"), pc["names"].index("yardsPerGame")
    stats = {}
    for t in bt["teams"]:
        nm = t["team"]["displayName"]; own = opp = None
        for c in t["categories"]:
            if c.get("name") == "passing" and c.get("displayName") == "Own Passing": own = c["values"]
            if c.get("name") == "passing" and c.get("displayName") == "Opponent Passing": opp = c["values"]
        if own and opp and own[PI] is not None and opp[PI] is not None and opp[YI] is not None:
            stats[nm] = {"ppg": own[PI], "oppppg": opp[PI], "oppypg": opp[YI], "margin": own[PI] - opp[PI]}
    # 2) records / win%
    sd = get(f"https://cdn.espn.com/core/college-football/standings?xhr=1&season={YEAR}")
    recs, wp = {}, {}
    def walk(o):
        if isinstance(o, dict):
            stx = o.get("standings") if isinstance(o.get("standings"), dict) else None
            if stx and isinstance(stx.get("entries"), list):
                for e in stx["entries"]:
                    nm = e.get("team", {}).get("displayName"); ov = None
                    for x in e.get("stats", []):
                        if x.get("type") == "total" or x.get("name") == "overall": ov = x.get("displayValue")
                    if nm and ov and "-" in str(ov):
                        try:
                            w, l = [int(z) for z in ov.split("-")[:2]]; recs[nm] = ov; wp[nm] = w/(w+l) if w+l else 0
                        except Exception: pass
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    walk(sd)
    # 3) scoreboards -> opponent lists (SOS) + game scores (SRS)
    opp_list, games = {}, []
    for wk in range(1, 17):
        try:
            d = get(f"https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates={YEAR}&seasontype=2&week={wk}&groups=80&limit=300")
        except Exception: continue
        for e in d.get("events", []):
            try:
                c = e["competitions"][0]
                if not c.get("status", {}).get("type", {}).get("completed"): continue
                cs = c["competitors"]
                if len(cs) != 2: continue
                a, b = cs[0]["team"]["displayName"], cs[1]["team"]["displayName"]
                opp_list.setdefault(a, []).append(b); opp_list.setdefault(b, []).append(a)
                games.append((a, b, int(cs[0]["score"]), int(cs[1]["score"])))
            except Exception: continue
    srs = compute_srs(games, set(stats.keys()))
    # build teams
    teams = []
    for nm, s in stats.items():
        if nm not in recs: continue
        try:
            w, l = [int(x) for x in recs[nm].split("-")[:2]]
        except Exception: continue
        gp = w + l
        if gp == 0: continue
        ops = opp_list.get(nm, [])
        teams.append({"name": nm, "rec": recs[nm], "gp": gp, "winpct": w/gp,
            "sos": sum(wp.get(x, 0.15) for x in ops)/len(ops) if ops else 0.30, **s})
    rp = ranks(teams, "ppg", True); ro = ranks(teams, "oppppg", False); ry = ranks(teams, "oppypg", False); rm = ranks(teams, "margin", True)
    for t in teams:
        t["rk_ppg"], t["rk_oppppg"], t["rk_oppypg"], t["rk_margin"] = rp[t["name"]], ro[t["name"]], ry[t["name"]], rm[t["name"]]
        t["q"] = [t["winpct"] >= 0.900, t["rk_ppg"] <= 15, t["rk_oppppg"] <= 10, t["rk_oppypg"] <= 10, t["rk_margin"] <= 5]
        t["score"] = sum(t["q"])
    nm_ = norm(teams, "margin", True); nw = norm(teams, "winpct", True); no = norm(teams, "oppppg", False)
    ny = norm(teams, "oppypg", False); npp = norm(teams, "ppg", True)
    for t in teams:
        t["index"] = round(nm_[t["name"]]*.30 + nw[t["name"]]*.20 + no[t["name"]]*.18 + ny[t["name"]]*.17 + npp[t["name"]]*.15, 1)
    avg = sum(t["sos"] for t in teams)/len(teams)
    srs_rank = {t: i+1 for i, (t, _) in enumerate(sorted(srs.items(), key=lambda kv: -kv[1]))}
    for t in teams:
        t["sosrank"] = sorted(teams, key=lambda x: -x["sos"]).index(t) + 1
        t["srsrank"] = srs_rank.get(t["name"], 999)
    # fair odds: SOS-weighted ^3, cap 24%
    pool = [t for t in teams if t["score"] >= 3 and "North Dakota State" not in t["name"]]
    tm = {5:1.7,4:1.3,3:1.0}
    tot = sum((t["index"]**3)/1e5*tm[t["score"]]*(t["sos"]/avg)**3 for t in pool)
    for t in pool: t["p"] = ((t["index"]**3)/1e5*tm[t["score"]]*(t["sos"]/avg)**3) / tot if tot else 0
    cap_odds(pool, 0.24)
    fd, rem = fetch_futures("americanfootball_ncaaf_championship_winner")
    attach(teams, pool, fd, srs_rank)
    top, gap, run = pick_gap(pool)
    pred = None
    if top:
        sr = top.get("srsrank", 999)
        srs_note = (f"SRS #{sr} confirms the dominance is earned" if sr <= 6
                    else f"though SRS #{sr} flags it as schedule-aided — a real but schedule-flattered #1")
        pred = {"pick": top["name"], "why":
            f"<b>{top['name']}</b> — {top['rec']}, a {top['score']}/5 with a {top['margin']:+.1f} scoring margin "
            f"(#{top['rk_margin']}, the master title signal) and index {top['index']}. {srs_note}. "
            f"In the 12-team CFP, a top team with a clean profile is the pick — but it's lower-chalk than it looks; read it as best contender, not a lock."}
    teams.sort(key=lambda t: (-t["score"], -t["index"]))
    # gauntlet watch: SRS top-10 not in pool
    poolnames = {t["name"] for t in pool}
    gauntlet = [{"name": t, "srsrank": srs_rank[t]} for t, _ in sorted(srs.items(), key=lambda kv: -kv[1])[:10] if t not in poolnames]
    return {"sport": "CFB", "season": f"{YEAR}", "generated": now_iso(), "odds_remaining": rem, "prediction": pred,
            "gp_min": min(t["gp"] for t in teams), "gp_max": max(t["gp"] for t in teams),
            "cats": ["Win% ≥.900", "PPG top-15", "Opp PPG top-10", "Opp YPG top-10", "Margin top-5"],
            "labels": ["Win%", "PPG", "Opp PPG", "Opp YPG", "Margin"],
            "teams": [cfb_row(t) for t in teams if t["score"] >= 2], "gauntlet": gauntlet}

def cfb_row(t):
    sr = t["srsrank"]
    # Backtested champion band: every clean CFP champion was SRS top-6.
    srs_flag = "elite" if sr <= 6 else ("ok" if sr <= 15 else "mirage")
    return {"name": t["name"], "rec": t["rec"], "score": t["score"], "index": t["index"],
        "q": [bool(x) for x in t["q"]], "sosrank": t["sosrank"], "srsrank": sr,
        "srs_flag": srs_flag,
        "vals": [f"{t['winpct']:.3f}", f"{t['ppg']:.1f} #{t['rk_ppg']}", f"{t['oppppg']:.1f} #{t['rk_oppppg']}",
                 f"{t['oppypg']:.0f} #{t['rk_oppypg']}", f"{t['margin']:+.1f} #{t['rk_margin']}"],
        "fair_pct": round(t["p"]*100, 1) if t.get("p") else None, "fair_odds": t.get("fair_odds"),
        "market": t.get("market"), "ev": t.get("ev")}

def compute_srs(games, fbs):
    sched = {}
    for an, bn, a, b in games:
        sched.setdefault(an, []).append((a, b, bn)); sched.setdefault(bn, []).append((b, a, an))
    teams = list(sched.keys())
    if not teams: return {}
    mov = {t: sum(pf-pa for pf, pa, o in sched[t])/len(sched[t]) for t in teams}
    srs = dict(mov)
    for _ in range(25):
        new = {t: mov[t] + sum(srs.get(o, 0) for pf, pa, o in sched[t])/len(sched[t]) for t in teams}
        m = sum(new.values())/len(new); srs = {t: new[t]-m for t in new}
    return {t: round(srs[t], 2) for t in teams if t in fbs}

# ----------------------------------------------------------------------------- NHL (MoneyPuck, curl-friendly)
NHL_TEAMS = {
  "BOS":("Boston Bruins","E"),"BUF":("Buffalo Sabres","E"),"DET":("Detroit Red Wings","E"),
  "FLA":("Florida Panthers","E"),"MTL":("Montreal Canadiens","E"),"OTT":("Ottawa Senators","E"),
  "TBL":("Tampa Bay Lightning","E"),"TOR":("Toronto Maple Leafs","E"),"CAR":("Carolina Hurricanes","E"),
  "CBJ":("Columbus Blue Jackets","E"),"NJD":("New Jersey Devils","E"),"NYI":("New York Islanders","E"),
  "NYR":("New York Rangers","E"),"PHI":("Philadelphia Flyers","E"),"PIT":("Pittsburgh Penguins","E"),
  "WSH":("Washington Capitals","E"),"ANA":("Anaheim Ducks","W"),"CGY":("Calgary Flames","W"),
  "COL":("Colorado Avalanche","W"),"DAL":("Dallas Stars","W"),"EDM":("Edmonton Oilers","W"),
  "LAK":("Los Angeles Kings","W"),"MIN":("Minnesota Wild","W"),"NSH":("Nashville Predators","W"),
  "SJS":("San Jose Sharks","W"),"SEA":("Seattle Kraken","W"),"STL":("St Louis Blues","W"),
  "VAN":("Vancouver Canucks","W"),"VGK":("Vegas Golden Knights","W"),"WPG":("Winnipeg Jets","W"),
  "UTA":("Utah Mammoth","W"),"CHI":("Chicago Blackhawks","W")}

def build_nhl():
    import csv, io
    req = urllib.request.Request(f"https://moneypuck.com/moneypuck/playerData/seasonSummary/{YEAR}/regular/teams.csv",
                                 headers={"User-Agent": "Mozilla/5.0 (blueprint-dashboard)"})
    text = urllib.request.urlopen(req, timeout=50).read().decode("utf-8", "replace")
    rows_raw = list(csv.DictReader(io.StringIO(text)))
    by = {}  # abbrev -> {situation: row}
    for r in rows_raw:
        by.setdefault(r["team"], {})[r["situation"]] = r
    rows = []
    for ab, sits in by.items():
        if ab not in NHL_TEAMS or "5on5" not in sits or "all" not in sits: continue
        f, a = sits["5on5"], sits["all"]
        try:
            gf, ga5 = float(f["goalsFor"]), float(f["goalsAgainst"])
            sa, saved = float(f["shotsOnGoalAgainst"]), float(f["savedShotsOnGoalAgainst"])
            corsi = float(f["corsiPercentage"]) * 100
            total_ga = float(a["goalsAgainst"]); gp = int(float(f["games_played"]))
        except Exception: continue
        name, conf = NHL_TEAMS[ab]
        rows.append({"name": name, "conf": conf, "rec": None, "gp": gp,
            "esdiff": gf - ga5, "essv": (saved/sa*100) if sa else 0, "corsi": corsi, "totalGA": total_ga})
    rk_ed = ranks(rows, "esdiff", True); rk_sv = ranks(rows, "essv", True)
    rk_cf = ranks(rows, "corsi", True); rk_ga = ranks(rows, "totalGA", False)
    for t in rows:
        t["rk_ed"], t["rk_sv"], t["rk_cf"], t["rk_ga"] = rk_ed[t["name"]], rk_sv[t["name"]], rk_cf[t["name"]], rk_ga[t["name"]]
        t["q"] = [t["rk_ed"] <= 11, t["rk_sv"] <= 12, t["rk_cf"] <= 16, t["rk_ga"] <= 14]
        t["score"] = sum(t["q"])
    ned = norm(rows, "esdiff", True); nsv = norm(rows, "essv", True); nga = norm(rows, "totalGA", False); ncf = norm(rows, "corsi", True)
    for t in rows:
        t["index"] = round(ned[t["name"]]*.30 + nsv[t["name"]]*.25 + nga[t["name"]]*.25 + ncf[t["name"]]*.20, 1)
    pool = [t for t in rows if t["score"] >= 2]
    tm = {4:1.6,3:1.15,2:0.8}
    for cf in ("E","W"):
        cs = [t for t in pool if t["conf"] == cf]; tot = sum((t["index"]**3)/1e5*tm[t["score"]] for t in cs)
        for t in cs: t["_pc"] = ((t["index"]**3)/1e5*tm[t["score"]]) / tot if tot else 0
    for t in pool: t["p"] = t.get("_pc", 0) * 0.5
    cap_odds(pool, 0.13)
    fd, rem = fetch_futures("icehockey_nhl_championship_winner")
    attach(rows, pool, fd)
    top, gap, run = pick_gap(pool)
    gpmax = max(t["gp"] for t in rows)
    pred = None
    if top:
        early = gpmax < 20
        pred = {"pick": top["name"], "why":
            f"<b>{top['name']}</b> — a {top['score']}/4 on the goaltending-and-defense profile that wins Cups "
            f"(#{top['rk_sv']} even-strength save%, #{top['rk_ga']} goals-against) and index {top['index']}. "
            + ("But it's only %d games in and the NHL is the lowest-chalk sport — early save-percentages regress hard, so this is 'best profile,' not a prediction yet." % gpmax
               if early else "The NHL is the lowest-chalk sport (goalie variance), so read a top profile as 'legit Cup team,' not 'the winner.'")}
    rows.sort(key=lambda t: (-t["score"], -t["index"]))
    return {"sport": "NHL", "season": f"{YEAR}-{str(YEAR+1)[2:]}", "generated": now_iso(), "odds_remaining": rem, "prediction": pred,
            "gp_min": min(t["gp"] for t in rows), "gp_max": max(t["gp"] for t in rows),
            "cats": ["ES goal diff top-11", "ES save% top-12", "Corsi top-16", "Goals Against top-14"],
            "labels": ["ES Diff", "ES SV%", "Corsi", "GA"],
            "teams": [nhl_row(t) for t in rows if t["score"] >= 1]}

def nhl_row(t):
    return {"name": t["name"], "conf": t["conf"], "rec": f"{t['gp']} GP", "score": t["score"], "index": t["index"],
        "q": [bool(x) for x in t["q"]],
        "vals": [f"{t['esdiff']:+.0f} #{t['rk_ed']}", f"{t['essv']:.1f} #{t['rk_sv']}",
                 f"{t['corsi']:.1f} #{t['rk_cf']}", f"{t['totalGA']:.0f} #{t['rk_ga']}"],
        "fair_pct": round(t["p"]*100, 1) if t.get("p") else None, "fair_odds": t.get("fair_odds"),
        "market": t.get("market"), "ev": t.get("ev")}

# ----------------------------------------------------------------------------- NBA (ESPN; live once the season tips off ~late Oct)
NBA_EAST = {"Boston Celtics","Brooklyn Nets","New York Knicks","Philadelphia 76ers","Toronto Raptors",
    "Chicago Bulls","Cleveland Cavaliers","Detroit Pistons","Indiana Pacers","Milwaukee Bucks",
    "Atlanta Hawks","Charlotte Hornets","Miami Heat","Orlando Magic","Washington Wizards"}

def nba_scoring(season):
    """Pull per-team PPG / Opp PPG from ESPN byteam. Returns {name:(ppg,oppppg)} or {} if the season hasn't started."""
    try:
        bt = get(f"https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byteam?region=us&lang=en&contentorigin=espn&season={season}&seasontype=2")
    except Exception:
        return {}
    out = {}
    for t in bt.get("teams", []):
        nm = t.get("team", {}).get("displayName")
        own = opp = None
        for c in t.get("categories", []):
            names = c.get("names", []); vals = c.get("values", []); dn = (c.get("displayName") or "").lower()
            idx = None
            for cand in ("avgPoints", "points", "avgPointsFor"):
                if cand in names: idx = names.index(cand); break
            if idx is None or idx >= len(vals): continue
            if "opponent" in dn: opp = vals[idx]
            elif own is None: own = vals[idx]
        if nm and own is not None and opp is not None:
            out[nm] = (own, opp)
    return out

def build_nba():
    season = YEAR + 1  # ESPN tags the NBA season by its end year (2026-27 -> 2027)
    base = {"sport": "NBA", "season": f"{YEAR}-{str(YEAR+1)[2:]}", "generated": now_iso()}
    scoring = nba_scoring(season)
    if not scoring:
        base.update({"status": "preseason", "odds_remaining": None,
            "note": "NBA regular season tips off in late October — the blueprint goes live on the first real games.", "teams": []})
        return base
    # win% / games from standings
    sd = get(f"https://cdn.espn.com/core/nba/standings?xhr=1&season={season}")
    wl = {}
    def walk(o):
        if isinstance(o, dict):
            if isinstance(o.get("entries"), list):
                for e in o["entries"]:
                    nm = e.get("team", {}).get("displayName"); st = {s.get("name"): s.get("value") for s in e.get("stats", [])}
                    if nm:
                        try: wl[nm] = (int(float(st.get("wins", 0))), int(float(st.get("losses", 0))))
                        except Exception: pass
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    walk(sd)
    rows = []
    for nm, (ppg, opp) in scoring.items():
        w, l = wl.get(nm, (0, 0)); g = w + l
        if g == 0: continue
        rows.append({"name": nm, "conf": "E" if nm in NBA_EAST else "W", "rec": f"{w}-{l}", "gp": g,
            "winpct": w/g, "ppg": ppg, "oppppg": opp, "pdg": ppg - opp})
    if not rows:
        base.update({"status": "preseason", "odds_remaining": None,
            "note": "NBA regular season tips off in late October — the blueprint goes live on the first real games.", "teams": []})
        return base
    rk_pd = ranks(rows, "pdg", True); rk_ppg = ranks(rows, "ppg", True); rk_opp = ranks(rows, "oppppg", False)
    for t in rows:
        t["rk_pd"], t["rk_ppg"], t["rk_opp"] = rk_pd[t["name"]], rk_ppg[t["name"]], rk_opp[t["name"]]
        t["q"] = [t["winpct"] >= 0.600, t["rk_pd"] <= 5, t["rk_ppg"] <= 10, t["rk_opp"] <= 10]
        t["score"] = sum(t["q"])
    npd = norm(rows, "pdg", True); no = norm(rows, "oppppg", False); nf = norm(rows, "ppg", True); nw = norm(rows, "winpct", True)
    for t in rows:
        t["index"] = round(npd[t["name"]]*.35 + no[t["name"]]*.25 + nf[t["name"]]*.25 + nw[t["name"]]*.15, 1)
    pool = [t for t in rows if t["score"] >= 2]
    tm = {4:1.7,3:1.2,2:0.8}
    for cf in ("E","W"):
        cs = [t for t in pool if t["conf"] == cf]; tot = sum((t["index"]**3)/1e5*tm[t["score"]] for t in cs)
        for t in cs: t["_pc"] = ((t["index"]**3)/1e5*tm[t["score"]]) / tot if tot else 0
    for t in pool: t["p"] = t.get("_pc", 0) * 0.5
    cap_odds(pool, 0.24)   # NBA is the chalkiest sport -> let the top team run
    fd, rem = fetch_futures("basketball_nba_championship_winner")
    attach(rows, pool, fd)
    top, gap, run = pick_gap(pool)
    pred = None
    if top:
        pred = {"pick": top["name"], "why":
            f"<b>{top['name']}</b> — a {top['score']}/4 with a {top['pdg']:+.1f} net rating per game "
            f"(#{top['rk_pd']}, the dominant NBA-champion signal) and index {top['index']}. "
            f"The NBA is the chalkiest sport — favorites are reliable, so a clear statistical #1 is a genuine prediction, not just a contender."}
    rows.sort(key=lambda t: (-t["score"], -t["index"]))
    base.update({"odds_remaining": rem, "prediction": pred, "gp_min": min(t["gp"] for t in rows), "gp_max": max(t["gp"] for t in rows),
        "cats": ["Win% ≥.600", "Net/g top-5", "PPG top-10", "Opp PPG top-10"],
        "labels": ["Win%", "Net/g", "PPG", "Opp PPG"],
        "teams": [{"name": t["name"], "conf": t["conf"], "rec": t["rec"], "score": t["score"], "index": t["index"],
            "q": [bool(x) for x in t["q"]],
            "vals": [f"{t['winpct']:.3f}", f"{t['pdg']:+.1f} #{t['rk_pd']}", f"{t['ppg']:.1f} #{t['rk_ppg']}", f"{t['oppppg']:.1f} #{t['rk_opp']}"],
            "fair_pct": round(t["p"]*100,1) if t.get("p") else None, "fair_odds": t.get("fair_odds"),
            "market": t.get("market"), "ev": t.get("ev")} for t in rows if t["score"] >= 1]})
    return base

# ----------------------------------------------------------------------------- shared
def cap_odds(pool, cap):
    for _ in range(10):
        over = [t for t in pool if t["p"] > cap]
        if not over: break
        ex = sum(t["p"]-cap for t in over)
        for t in over: t["p"] = cap
        under = [t for t in pool if t["p"] < cap]; sub = sum(t["p"] for t in under)
        for t in under: t["p"] += ex*t["p"]/sub if sub else 0
    for t in pool: t["fair_odds"] = american(t["p"])

def attach(allteams, pool, fd, srs_rank=None):
    pmap = {t["name"]: t["p"] for t in pool}
    for t in allteams:
        mk = fd.get(t["name"])
        t["market"] = (f"+{mk}" if mk > 0 else str(mk)) if mk is not None else None
        p = pmap.get(t["name"], 0)
        if mk is not None and p > 0:
            dec = 1 + mk/100 if mk > 0 else 1 + 100/abs(mk)
            t["ev"] = round((p*dec - 1)*100)
        else:
            t["ev"] = None

def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def pick_gap(pool):
    """Pick the best TEAM (score, then index — fair odds get capped/flattened so can't break ties).
       Return (top_team, index_gap_to_2nd, is_runaway)."""
    ps = sorted(pool, key=lambda t: (-t["score"], -t["index"]))
    if not ps: return None, 0, False
    gap = ps[0]["index"] - (ps[1]["index"] if len(ps) > 1 else 0)
    runaway = len(ps) > 1 and ps[0]["score"] >= ps[1]["score"] and gap >= 6.0
    return ps[0], gap, runaway

def log_history(name, data):
    """Append a compact dated snapshot of the contenders to data/history/<name>.json (keep last 30 runs).
       This is the week-over-week tracker — it's what surfaces season-long consistency + market drift."""
    if data.get("status") == "preseason" or not data.get("teams"): return
    hp = os.path.join(DATA, "history", f"{name}.json")
    os.makedirs(os.path.dirname(hp), exist_ok=True)
    try: hist = json.load(open(hp, encoding="utf-8"))
    except Exception: hist = []
    snap = {"date": data["generated"][:10], "gp": data.get("gp_max"),
            "teams": {t["name"]: {"sc": t["score"], "idx": t["index"], "fp": t.get("fair_pct"),
                                  "mkt": t.get("market"), "ev": t.get("ev")} for t in data["teams"]}}
    if hist and hist[-1]["date"] == snap["date"]: hist[-1] = snap   # same-day re-run replaces
    else: hist.append(snap)
    json.dump(hist[-30:], open(hp, "w", encoding="utf-8"), indent=1)

def main():
    os.makedirs(DATA, exist_ok=True)
    built = {}
    for name, fn in [("nfl", build_nfl), ("cfb", build_cfb), ("nhl", build_nhl), ("nba", build_nba)]:
        try:
            print(f"building {name}...")
            data = fn()
            with open(os.path.join(DATA, f"{name}.json"), "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            log_history(name, data)
            if data.get("status") == "preseason":
                built[name] = "preseason (no games yet)"
            else:
                built[name] = f"{len(data['teams'])} teams, GP {data['gp_min']}-{data['gp_max']}, odds_remaining={data.get('odds_remaining')}"
        except Exception as e:
            print(f"  FAILED {name}: {e}", file=sys.stderr)
            built[name] = f"FAILED: {e}"
    with open(os.path.join(DATA, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"sports": ["nfl", "cfb", "nhl", "nba"], "generated": now_iso()}, f, indent=2)
    print("done:", json.dumps(built, indent=2))

if __name__ == "__main__":
    main()
