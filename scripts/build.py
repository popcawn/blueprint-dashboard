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
LEAGUES = [x.strip() for x in os.environ.get("LEAGUES", "nfl,cfb,nhl,nba").split(",") if x.strip()]  # which to build (run-button inputs)
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
SEASON_GAMES = {"nfl": 17, "cfb": 12, "nhl": 82, "nba": 82}   # regular-season games per team (for season %)

def season_pct(rows, sport):
    if not rows: return 0
    avg = sum(t["gp"] for t in rows) / len(rows)
    return max(1, min(100, round(avg / SEASON_GAMES[sport] * 100)))

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
    rk_pd = ranks(rows, "ptdiff", True); rk_ppg = ranks(rows, "ppg", True); rk_opp = ranks(rows, "oppppg", False); rk_win = ranks(rows, "winpct", True)
    for t in rows:
        t["rk_pd"], t["rk_ppg"], t["rk_opp"], t["rk_win"] = rk_pd[t["name"]], rk_ppg[t["name"]], rk_opp[t["name"]], rk_win[t["name"]]
        t["q"] = [t["winpct"] >= 0.625, t["rk_pd"] <= 6, t["rk_ppg"] <= 10, t["rk_opp"] <= 10, t["pdg"] >= 5.0]
        t["score"] = sum(t["q"])
    npd = norm(rows, "ptdiff", True); npg = norm(rows, "pdg", True); no = norm(rows, "oppppg", False)
    nf = norm(rows, "ppg", True); nw = norm(rows, "winpct", True)
    for t in rows:
        t["index"] = round(npd[t["name"]]*.25 + npg[t["name"]]*.20 + no[t["name"]]*.20 + nf[t["name"]]*.20 + nw[t["name"]]*.15, 1)
    for t in rows: t["read"] = team_read(t, "nfl", len(rows), 5)
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
    pred = make_prediction(rows, 5)
    rows.sort(key=lambda t: (-t["score"], -t["index"]))
    return {"sport": "NFL", "season": f"{YEAR}", "generated": now_iso(), "odds_remaining": rem, "prediction": pred,
            "gp_min": min(t["gp"] for t in rows), "gp_max": max(t["gp"] for t in rows),
            "season_pct": season_pct(rows, "nfl"),
            "cats": ["Win% ≥.625", "Pt Diff top-6", "PPG top-10", "Opp PPG top-10", "PD/g ≥+5"],
            "labels": ["Win%", "Pt Diff", "PPG", "Opp PPG", "PD/g"],
            "teams": [nfl_row(t) for t in rows]}

def nfl_row(t):
    return {"name": t["name"], "conf": t["conf"], "rec": t["rec"], "score": t["score"], "index": t["index"],
        "q": [bool(x) for x in t["q"]],
        "vals": [f"{t['winpct']:.3f}", f"{t['ptdiff']:+.0f} #{t['rk_pd']}", f"{t['ppg']:.1f} #{t['rk_ppg']}",
                 f"{t['oppppg']:.1f} #{t['rk_opp']}", f"{t['pdg']:+.1f}"],
        "fair_pct": round(t["p"]*100, 1) if t.get("p") else None, "fair_odds": t.get("fair_odds"),
        "market": t.get("market"), "ev": t.get("ev"), "read": t.get("read")}

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
    for t in teams: t["read"] = team_read(t, "cfb", len(teams), 5)
    # fair odds: SOS-weighted ^3, cap 24%
    pool = [t for t in teams if t["score"] >= 3 and "North Dakota State" not in t["name"]]
    tm = {5:1.7,4:1.3,3:1.0}
    tot = sum((t["index"]**3)/1e5*tm[t["score"]]*(t["sos"]/avg)**3 for t in pool)
    for t in pool: t["p"] = ((t["index"]**3)/1e5*tm[t["score"]]*(t["sos"]/avg)**3) / tot if tot else 0
    cap_odds(pool, 0.24)
    fd, rem = fetch_futures("americanfootball_ncaaf_championship_winner")
    attach(teams, pool, fd, srs_rank)
    pred = make_prediction(teams, 5)
    teams.sort(key=lambda t: (-t["score"], -t["index"]))
    # gauntlet watch: SRS top-10 not in pool
    poolnames = {t["name"] for t in pool}
    gauntlet = [{"name": t, "srsrank": srs_rank[t]} for t, _ in sorted(srs.items(), key=lambda kv: -kv[1])[:10] if t not in poolnames]
    return {"sport": "CFB", "season": f"{YEAR}", "generated": now_iso(), "odds_remaining": rem, "prediction": pred,
            "gp_min": min(t["gp"] for t in teams), "gp_max": max(t["gp"] for t in teams),
            "season_pct": season_pct(teams, "cfb"),
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
        "market": t.get("market"), "ev": t.get("ev"), "read": t.get("read")}

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
    for t in rows: t["read"] = team_read(t, "nhl", len(rows), 4)
    pool = [t for t in rows if t["score"] >= 2]
    tm = {4:1.6,3:1.15,2:0.8}
    for cf in ("E","W"):
        cs = [t for t in pool if t["conf"] == cf]; tot = sum((t["index"]**3)/1e5*tm[t["score"]] for t in cs)
        for t in cs: t["_pc"] = ((t["index"]**3)/1e5*tm[t["score"]]) / tot if tot else 0
    for t in pool: t["p"] = t.get("_pc", 0) * 0.5
    cap_odds(pool, 0.13)
    fd, rem = fetch_futures("icehockey_nhl_championship_winner")
    attach(rows, pool, fd)
    pred = make_prediction(rows, 4)
    if pred and max(t["gp"] for t in rows) < 20:
        pred["why"] += " (It's early and the NHL is the lowest-chalk sport — treat it as 'best profile,' not a lock.)"
    rows.sort(key=lambda t: (-t["score"], -t["index"]))
    return {"sport": "NHL", "season": f"{YEAR}-{str(YEAR+1)[2:]}", "generated": now_iso(), "odds_remaining": rem, "prediction": pred,
            "gp_min": min(t["gp"] for t in rows), "gp_max": max(t["gp"] for t in rows),
            "season_pct": season_pct(rows, "nhl"),
            "cats": ["ES goal diff top-11", "ES save% top-12", "Corsi top-16", "Goals Against top-14"],
            "labels": ["ES Diff", "ES SV%", "Corsi", "GA"],
            "teams": [nhl_row(t) for t in rows if t["score"] >= 1]}

def nhl_row(t):
    return {"name": t["name"], "conf": t["conf"], "rec": f"{t['gp']} GP", "score": t["score"], "index": t["index"],
        "q": [bool(x) for x in t["q"]],
        "vals": [f"{t['esdiff']:+.0f} #{t['rk_ed']}", f"{t['essv']:.1f} #{t['rk_sv']}",
                 f"{t['corsi']:.1f} #{t['rk_cf']}", f"{t['totalGA']:.0f} #{t['rk_ga']}"],
        "fair_pct": round(t["p"]*100, 1) if t.get("p") else None, "fair_odds": t.get("fair_odds"),
        "market": t.get("market"), "ev": t.get("ev"), "read": t.get("read")}

# ----------------------------------------------------------------------------- NBA (ESPN; live once the season tips off ~late Oct)
NBA_EAST = {"Boston Celtics","Brooklyn Nets","New York Knicks","Philadelphia 76ers","Toronto Raptors",
    "Chicago Bulls","Cleveland Cavaliers","Detroit Pistons","Indiana Pacers","Milwaukee Bucks",
    "Atlanta Hawks","Charlotte Hornets","Miami Heat","Orlando Magic","Washington Wizards"}

def nba_depth(season):
    """Scoring depth = # of players on a team averaging >=10 PPG (balanced rosters win in the NBA).
       Defensive: returns {team_displayName: count} or {} if ESPN's athlete feed isn't available yet."""
    try:
        d = get(f"https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete?region=us&lang=en&contentorigin=espn&season={season}&seasontype=2&limit=600")
    except Exception:
        return {}
    out = {}
    for a in d.get("athletes", []):
        try:
            tm = a.get("athlete", {}).get("team", {}).get("displayName")
            ppg = None
            for c in a.get("categories", []):
                nm = c.get("names", [])
                for cand in ("avgPoints", "points"):
                    if cand in nm: ppg = c["values"][nm.index(cand)]; break
            if tm and ppg is not None and ppg >= 10: out[tm] = out.get(tm, 0) + 1
        except Exception:
            continue
    return out

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
    depth = nba_depth(season)
    rows = []
    for nm, (ppg, opp) in scoring.items():
        w, l = wl.get(nm, (0, 0)); g = w + l
        if g == 0: continue
        rows.append({"name": nm, "conf": "E" if nm in NBA_EAST else "W", "rec": f"{w}-{l}", "gp": g,
            "winpct": w/g, "ppg": ppg, "oppppg": opp, "pdg": ppg - opp, "depth": depth.get(nm, 0)})
    if not rows:
        base.update({"status": "preseason", "odds_remaining": None,
            "note": "NBA regular season tips off in late October — the blueprint goes live on the first real games.", "teams": []})
        return base
    rk_pd = ranks(rows, "pdg", True); rk_ppg = ranks(rows, "ppg", True); rk_opp = ranks(rows, "oppppg", False)
    for t in rows:
        t["rk_pd"], t["rk_ppg"], t["rk_opp"] = rk_pd[t["name"]], rk_ppg[t["name"]], rk_opp[t["name"]]
        t["q"] = [t["winpct"] >= 0.600, t["rk_pd"] <= 5, t["rk_ppg"] <= 10, t["rk_opp"] <= 10]
        t["score"] = sum(t["q"])
    npd = norm(rows, "pdg", True); no = norm(rows, "oppppg", False); nf = norm(rows, "ppg", True)
    nw = norm(rows, "winpct", True); ndp = norm(rows, "depth", True)
    has_depth = any(t["depth"] for t in rows)
    for t in rows:  # Depth (scoring balance) rewarded in the index; neutral if the feed is unavailable
        t["index"] = round(npd[t["name"]]*.30 + no[t["name"]]*.22 + nf[t["name"]]*.20 + nw[t["name"]]*.13
                           + (ndp[t["name"]]*.15 if has_depth else npd[t["name"]]*.15), 1)
    for t in rows: t["read"] = team_read(t, "nba", len(rows), 4)
    pool = [t for t in rows if t["score"] >= 2]
    tm = {4:1.7,3:1.2,2:0.8}
    for cf in ("E","W"):
        cs = [t for t in pool if t["conf"] == cf]; tot = sum((t["index"]**3)/1e5*tm[t["score"]] for t in cs)
        for t in cs: t["_pc"] = ((t["index"]**3)/1e5*tm[t["score"]]) / tot if tot else 0
    for t in pool: t["p"] = t.get("_pc", 0) * 0.5
    cap_odds(pool, 0.24)   # NBA is the chalkiest sport -> let the top team run
    fd, rem = fetch_futures("basketball_nba_championship_winner")
    attach(rows, pool, fd)
    pred = make_prediction(rows, 4)
    rows.sort(key=lambda t: (-t["score"], -t["index"]))
    base.update({"odds_remaining": rem, "prediction": pred, "season_pct": season_pct(rows, "nba"),
        "gp_min": min(t["gp"] for t in rows), "gp_max": max(t["gp"] for t in rows), "has_depth": has_depth,
        "cats": ["Win% ≥.600", "Net/g top-5", "PPG top-10", "Opp PPG top-10"],
        "labels": ["Win%", "Net/g", "PPG", "Opp PPG"],
        "teams": [{"name": t["name"], "conf": t["conf"], "rec": t["rec"], "score": t["score"], "index": t["index"],
            "q": [bool(x) for x in t["q"]],
            "vals": [f"{t['winpct']:.3f}", f"{t['pdg']:+.1f} #{t['rk_pd']}", f"{t['ppg']:.1f} #{t['rk_ppg']}", f"{t['oppppg']:.1f} #{t['rk_opp']}"],
            "fair_pct": round(t["p"]*100,1) if t.get("p") else None, "fair_odds": t.get("fair_odds"),
            "market": t.get("market"), "ev": t.get("ev"), "read": t.get("read")} for t in rows if t["score"] >= 1]})
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

READ_CTX = {
    "nfl": "single-elimination January football punishes a leaky defense",
    "cfb": "a 12-team playoff gauntlet runs a one-sided team off the field",
    "nhl": "goaltending decides best-of-seven series",
    "nba": "offense goes cold in a seven-game series — defense travels",
}

def _pick(opts, seed):
    return opts[sum(ord(c) for c in seed) % len(opts)]

def team_read(t, sport, n, maxcat):
    """Playoff-translation read: judges each team by what ACTUALLY wins in the playoffs —
       NFL margin+defense (and close-game luck), NHL possession vs goaltending variance,
       NBA half-court defense vs pace-padded scoring, CFB dominance-vs-schedule."""
    nm = t["name"]; top = t["score"] >= maxcat - 1
    el = max(5, int(n * 0.15)); good = max(10, int(n * 0.40)); half = n * 0.5

    if sport == "nfl":
        pd, off, dfn, win = t["rk_pd"], t["rk_ppg"], t["rk_opp"], t.get("rk_win", t["rk_pd"])
        if win <= el and pd - win >= max(6, int(n * 0.22)):          # record outrunning margin
            return {"v": "caution", "why": _pick([
                f"A record that outruns the margin — #{win} by win%, only #{pd} in point differential. Close-game records don't persist, and single-elimination January is where they come due.",
                f"Winning the games it shouldn't — #{win} record on a #{pd} scoring margin. The blueprint buys margin of victory, not one-score luck; regression is the base case."], nm)}
        if off <= el and dfn > half:                                  # shootout offense, no defense
            return {"v": "fools_gold", "why": _pick([
                f"All gas, no brakes — #{off} offense but a #{dfn} defense. Playoff football tightens and defense travels; the first time they're held near their floor, they're done.",
                f"Shootout-or-bust: a #{off} offense papering over a #{dfn} defense. You can't out-score a real team in January when you can't get a stop. Fade."], nm)}
        if top and pd <= 6 and dfn <= good:                           # the complete, cold-weather profile
            return {"v": "trust", "why": _pick([
                f"Built for January — a real #{pd} point margin AND a #{dfn} defense that travels. No shootout required, no luck baked in; this is the shape that wins when games slow down.",
                f"The two traits that survive single-elimination: dominant margin (#{pd}) and a top-{dfn} defense. Complete and earned — trust it."], nm)}
        if dfn <= el and off > good:                                  # defense-led grinder
            return {"v": "caution", "why": _pick([
                f"Defense-first — a #{dfn} unit keeps every game winnable, which is exactly what holds up in January. The only question is whether a #{off} offense scratches out enough.",
                f"Wins ugly, and that plays in the playoffs — elite #{dfn} defense, but a #{off} offense that can't go cold at the wrong time."], nm)}
        return {"v": "caution", "why": f"A middling profile — leads with its #{min(pd,off,dfn)} unit, but the #{max(pd,off,dfn)} area is where a good playoff team picks it apart."}

    if sport == "nhl":
        ed, sv, cf, ga = t["rk_ed"], t["rk_sv"], t["rk_cf"], t["rk_ga"]
        if sv <= el and cf > half:                                    # hot goalie / PDO
            return {"v": "caution", "why": _pick([
                f"That #{sv} save% is riding variance — they're #{cf} in possession (Corsi), so the goalie is masking thin even-strength play. Playoff save%s regress to the underlying game.",
                f"Goalie-carried: #{sv} in net, only #{cf} driving play. A hot crease wins you a round and loses you the next — the numbers underneath don't back it yet."], nm)}
        if cf <= el and sv > n * 0.45:                                # possession monster, shaky net
            return {"v": "caution", "why": _pick([
                f"Drives play like a champion (#{cf} Corsi) but the goaltending (#{sv}) has to show up. Elite underlying game held hostage to the crease — one hot goalie from a deep run, one cold week from a first-round exit.",
                f"Controls the puck (#{cf}) but can't fully trust the net (#{sv}). The dangerous kind of team: the process says contender, the goaltending says coin flip."], nm)}
        if top and ga > half and ed <= good:                          # run-and-gun, leaky
            return {"v": "fools_gold", "why": _pick([
                f"Outscores its problems in the regular season, but playoff hockey tightens and a #{ga} goals-against is exactly what gets punished when goals dry up in May.",
                f"A run-and-gun look that doesn't translate — #{ed} goal differential built on offense, but #{ga} goal-prevention. Low-event playoff series expose it. Fade."], nm)}
        if top and cf <= good and sv <= good:                         # the real Cup shape
            return {"v": "trust", "why": _pick([
                f"Drives play AND gets saves — underlying numbers (#{cf} Corsi) and goaltending (#{sv}) both hold up, which is the rare combination that survives four rounds. The genuine Cup shape.",
                f"No goaltending asterisk, no possession hole — #{cf} driving play and #{sv} in net. The team you want when the games get low-scoring and tight. Trust it."], nm)}
        return {"v": "caution", "why": f"Carried by its #{ed} goal differential, but the #{max(sv,cf,ga)} spot is the one a seven-game series finds."}

    if sport == "nba":
        net, off, dfn = t["rk_pd"], t["rk_ppg"], t["rk_opp"]
        if off <= el and dfn > half:                                  # pace-padded scoring
            return {"v": "fools_gold", "why": _pick([
                f"Scoreboard-stuffing against regular-season pace — but playoff games crawl into the half-court, and a #{dfn} defense can't get the stop when it matters. Points don't travel; defense does.",
                f"All offense (#{off}), no stops (#{dfn} defense). In a half-court playoff series the easy buckets vanish and this profile can't grind one out. Fade."], nm)}
        if dfn <= el:                                                 # defense travels
            return {"v": "trust", "why": _pick([
                f"Elite defense (#{dfn}) — the one trait that shows up every single playoff night. Offense slumps in a series; defense doesn't. The playoff-proof profile.",
                f"Defense wins in May — a #{dfn} unit that travels, forces the half-court, and keeps every game winnable when shots stop falling. Trust it."], nm)}
        if top and net <= el:
            return {"v": "trust", "why": f"A #{net} net rating — the single best predictor of a title run — with no obvious end to attack. Balanced and battle-ready."}
        return {"v": "caution", "why": f"Net-rating-driven (#{net}) but leans one way; the #{max(off,dfn)} end is where a playoff defense makes it uncomfortable."}

    # CFB — dominance vs schedule
    cats = [("offense", t["rk_ppg"]), ("scoring defense", t["rk_oppppg"]), ("total defense", t["rk_oppypg"]), ("margin", t["rk_margin"])]
    worst = max(cats, key=lambda c: c[1]); best = min(cats, key=lambda c: c[1]); b, br, w, wr = best[0], best[1], worst[0], worst[1]
    sr = t.get("srsrank", 999)
    if sr > 15 and top:
        return {"v": "fools_gold", "why": _pick([
            f"A schedule mirage — #{br} {b} on paper, but opponent-adjusted they're SRS #{sr}. The record's real; the dominance is inflated against a soft slate. A 12-team gauntlet eats this profile.",
            f"Padded against cupcakes — the #{br} {b} evaporates once you adjust for who they've played (SRS #{sr}). Not a longshot, a warning. Fade."], nm)}
    if top and sr <= 6 and wr <= good:
        return {"v": "trust", "why": _pick([
            f"The genuine article — complete (worst spot: {w} #{wr}) and SRS #{sr} proves it's earned against real teams, not padded. Exactly what wins a 12-team playoff.",
            f"Dominant AND tested — #{br} {b}, no soft category, and a top-{sr} schedule-adjusted rating. This is the one to trust all the way."], nm)}
    if top and off <= el and (t["rk_oppppg"] > half or t["rk_oppypg"] > half):
        return {"v": "fools_gold", "why": f"One-sided — #{off} offense but a defense outside the top half. In a bracket of elite teams, the shootout eventually goes the other way. Fade."}
    return {"v": "caution", "why": f"Leads with its #{br} {b}; the #{wr} {w} is the crack a playoff-caliber opponent widens — and SRS #{sr} says the schedule hasn't fully tested it yet."}

def make_prediction(scored, maxcat):
    """Predict a CHAMPION consistent with the Read — prefer the team the model TRUSTS, not just
       the top tier. If nothing is clean, say so. Guarantees the banner never confidently picks a
       team its own card flags as caution/fool's gold."""
    cand = [t for t in scored if t["score"] >= maxcat - 1 and t.get("read")] or [t for t in scored if t.get("read")]
    if not cand: return None
    vw = {"trust": 2, "caution": 1, "fools_gold": 0}
    top = sorted(cand, key=lambda t: (vw.get(t["read"]["v"], 1), t["score"], t["index"]), reverse=True)[0]
    rd = top["read"]; odds = top.get("fair_odds")
    any_trust = any(t["read"]["v"] == "trust" for t in cand)
    if rd["v"] == "trust":
        lead = f"<b>{top['name']}</b> is the pick — the top team the model actually trusts{f' (fair {odds})' if odds else ''}. "
    elif not any_trust:
        lead = f"<b>{top['name']}</b> is the pick by default — no team on the board is clean right now, so this is the least-flawed. "
    else:
        lead = f"<b>{top['name']}</b> is the pick{f' (fair {odds})' if odds else ''}. "
    return {"pick": top["name"], "why": lead + rd["why"]}

def pick_gap(pool):
    ps = sorted(pool, key=lambda t: (-t["score"], -t["index"]))
    if not ps: return None, 0, False
    gap = ps[0]["index"] - (ps[1]["index"] if len(ps) > 1 else 0)
    return ps[0], gap, len(ps) > 1 and ps[0]["score"] >= ps[1]["score"] and gap >= 6.0

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
        if name not in LEAGUES:
            continue
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
