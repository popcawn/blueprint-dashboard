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
import json, math, os, re, sys, time, datetime, urllib.request

YEAR = int(os.environ.get("SEASON_YEAR", datetime.datetime.now().year if datetime.datetime.now().month >= 7 else datetime.datetime.now().year - 1))
ODDS_KEY = os.environ.get("ODDS_API_KEY", "").strip()
LEAGUES = [x.strip() for x in os.environ.get("LEAGUES", "nfl,cfb,nhl,nba,wnba,mlb,cbb,wcbb,mls,fcs,cfl,nwsl,afl,nrl,superleague").split(",") if x.strip()]  # which to build (run-button inputs)
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")
SEASON_GAMES = {"nfl": 17, "cfb": 12, "nhl": 82, "nba": 82, "wnba": 44, "mlb": 162, "cbb": 31, "wcbb": 30, "mls": 34, "fcs": 11, "cfl": 18, "nwsl": 30, "afl": 23, "nrl": 24, "superleague": 27}   # regular-season games per team (for season %)

def season_pct(rows, sport):
    if not rows: return 0
    avg = sum(t["gp"] for t in rows) / len(rows)
    return max(1, min(100, round(avg / SEASON_GAMES[sport] * 100)))

# Signal reliability: stat stabilization is an ABSOLUTE game count (~15-20), not a %,
# so short football seasons never reach a big sample (lean on point differential) while
# NHL/NBA firm up at ~25% of the season. Thresholds = games played by the leaders (gp_max).
#  trust (>=): board is actionable on stats | firming: directional | early: records are schedule-noise.
SIGNAL_THRESH = {"nfl": (8, 5), "cfb": (6, 4), "nhl": (20, 12), "nba": (15, 10), "wnba": (14, 8), "mlb": (50, 25), "cbb": (15, 8), "wcbb": (15, 8), "mls": (17, 10), "fcs": (6, 4), "cfl": (9, 5), "nwsl": (15, 9), "afl": (10, 6), "nrl": (10, 6), "superleague": (10, 6)}

def _price_num(mk):
    """Parse a stored American-odds string like '+1500' / '-120' to int, or None."""
    if not mk: return None
    try: return int(str(mk).replace("+", ""))
    except Exception: return None

def value_plays(teams, maxcat, sport=None):
    """QUALIFIED VALUE = complete profile (score >= maxcat-1) + a 🟢 trust read + positive EV
       + a believable price (<= +2500). Backtested on 5 odds-era seasons (2021-22..2025-26):
       isolates the value-DOG champions (GSW '22 +68%, DEN '23 +100%, NYK '26 +140/+174%) and
       correctly stays empty when the champ is chalk (BOS '24, OKC '25 — fade or bet the favorite).
       This replaces raw 'best EV', which lights up junk longshots (e.g. a 40000-1 phantom line)."""
    out = []
    if sport == "cfb":
        # CFB: the NBA 'complete profile + trust read' gate contradicts the CFB backtest, where 3/5 champions are
        # normal (2020 Alabama, 2024 Ohio State) and the champion-picker is the uncapped index x schedule order
        # (10/12). CFB value = model top-4 in that order + schedule-verified (SRS top-10, so not a soft-slate
        # mirage) + EV >= +10% at a believable price (<= +2500). Not odds-backtested: no historical CFB futures.
        order = sorted([t for t in teams if t.get("mw")], key=lambda t: -t["mw"])[:4]
        for t in order:
            p = _price_num(t.get("market"))
            if (t.get("ev") or 0) >= 10 and p is not None and p <= 2500 and (t.get("srsrank") or 999) <= 10:
                out.append({"name": t["name"], "ev": t["ev"], "market": t.get("market"), "fair_odds": t.get("fair_odds")})
        out.sort(key=lambda x: -x["ev"])
        return out
    if sport == "mls":
        # MLS (2026-11-06): only teams that clear all 5 every-champion criteria (every champion 2010-25 had all 5; a hidden
        # season's champion still did 11/15) + EV >= +10% at a believable price (<= +2500). Not odds-backtested: no
        # historical MLS Cup prices without Kalshi, which the user doesn't use.
        for t in teams:
            p = _price_num(t.get("market"))
            if t.get("bet_ok", True) and t.get("score") == 5 and (t.get("ev") or 0) >= 10 and p is not None and p <= 2500:   # bet_ok: not within the playoffs
                out.append({"name": t["name"], "ev": t["ev"], "market": t.get("market"), "fair_odds": t.get("fair_odds")})
        out.sort(key=lambda x: -x["ev"])
        return out
    if sport in ("afl", "nrl", "superleague"):
        # AFL / NRL / Super League (2026-11-07), all fair-rated, small stakes. Only while the betting window is open (regular season: not
        # within the finals, and not the untested preseason stage -> bet_ok), EV >= +15% at a believable price (<= +2500), and
        # AFL/NRL: all 5 every-champion criteria · Super League: a top-2 ladder spot (a top-2 seed won 9 of the 10 title seasons tested;
        # its profile did no better than a coin flip). Not odds-backtested: no title-price history for these leagues.
        for t in teams:
            p = _price_num(t.get("market"))
            ok = t.get("score") == 5 if sport != "superleague" else (t.get("pos") or 99) <= 2
            if t.get("bet_ok") and ok and (t.get("ev") or 0) >= 15 and p is not None and p <= 2500:
                out.append({"name": t["name"], "ev": t["ev"], "market": t.get("market"), "fair_odds": t.get("fair_odds")})
        out.sort(key=lambda x: -x["ev"])
        return out
    if sport == "nwsl":
        # NWSL (2026-11-07) is NOT bet-able: knockout matches have been no better than "the home side advances" and the title a coin
        # flip since 2022. Odds exist only once the bracket is set, and EV only until the first playoff game (the user never bets within
        # the playoffs), so a value play needs a wide margin: 5/5 + EV >= +25% + price <= +2500.
        for t in teams:
            p = _price_num(t.get("market"))
            # bet_ok (2026-11-07): the frozen board keeps each card's EV vs the pre-playoff prices, but crowns no value play once a playoff game is played
            if t.get("bet_ok", True) and (t.get("score") or 0) >= 5 and (t.get("ev") or 0) >= 25 and p is not None and p <= 2500:
                out.append({"name": t["name"], "ev": t["ev"], "market": t.get("market"), "fair_odds": t.get("fair_odds")})
        out.sort(key=lambda x: -x["ev"])
        return out
    if sport == "cfl":
        # CFL (2026-11-06) is NOT bet-able (once four teams are left the model has been worse than a coin flip since 2017), so a value
        # play needs a WIDE margin: alive + EV >= +25% + price <= +2500 + 4/5 or better. Check injuries first (QB news moves CFL prices).
        for t in teams:
            p = _price_num(t.get("market"))
            if t.get("alive") and (t.get("score") or 0) >= 4 and (t.get("ev") or 0) >= 25 and p is not None and p <= 2500:
                out.append({"name": t["name"], "ev": t["ev"], "market": t.get("market"), "fair_odds": t.get("fair_odds")})
        out.sort(key=lambda x: -x["ev"])
        return out
    if sport == "fcs":
        # FCS (2026-11-06) is PAPER: 10 of the 15 titles 2010-25 were North Dakota State (now FBS). If a screenshot is posted,
        # a value play must be 5/5 + EV >= +10% at <= +2500 + longer than the RATING-ONLY fair odds too (alt_ev >= 0) +
        # SRS top-15 (the soft-schedule check: Stephen F. Austin / Tarleton-type records). Not odds-backtested.
        for t in teams:
            p = _price_num(t.get("market"))
            if (t.get("bet_ok", True) and t.get("score") == 5 and (t.get("ev") or 0) >= 10 and p is not None and p <= 2500   # bet_ok: not within the playoffs
                    and (t.get("alt_ev") or -1) >= 0 and (t.get("srsrank") or 999) <= 15):
                out.append({"name": t["name"], "ev": t["ev"], "market": t.get("market"), "fair_odds": t.get("fair_odds")})
        out.sort(key=lambda x: -x["ev"])
        return out
    if sport in ("cbb", "wcbb"):
        # College hoops has no trust reads. Value = the backtested shortlist (by fair title odds: men top-5 —
        # champion top-5 in 11/15; women top-3 — top-3 in 8/9) + EV >= +10% at <= +5000 (college futures run
        # longer than pro). Not odds-backtested (no historical college-hoops futures).
        n = 5 if sport == "cbb" else 3
        for t in sorted([t for t in teams if t.get("fair_pct")], key=lambda t: -t["fair_pct"])[:n]:
            p = _price_num(t.get("market"))
            if (t.get("ev") or 0) >= 10 and p is not None and p <= 5000:
                out.append({"name": t["name"], "ev": t["ev"], "market": t.get("market"), "fair_odds": t.get("fair_odds")})
        out.sort(key=lambda x: -x["ev"])
        return out
    for t in teams:
        if t.get("score", 0) < maxcat - 1: continue
        if (t.get("read") or {}).get("v") != "trust": continue
        if t.get("ev") is None or t["ev"] <= 0: continue
        p = _price_num(t.get("market"))
        if p is None or p > 2500: continue
        out.append({"name": t["name"], "ev": t["ev"], "market": t.get("market"), "fair_odds": t.get("fair_odds")})
    out.sort(key=lambda x: -x["ev"])
    return out

def signal_status(sport, gp):
    trust, firm = SIGNAL_THRESH[sport]
    if gp >= trust:
        return {"status": "trust", "emoji": "🟢", "label": "Trust the board",
                "note": f"{gp} games in — stats have stabilized; the read is actionable."}
    if gp >= firm:
        return {"status": "firming", "emoji": "🟡", "label": "Firming up",
                "note": f"{gp} games in — directional, but records still carry schedule noise. Lean on point differential."}
    return {"status": "early", "emoji": "🔴", "label": "Too early",
            "note": f"only {gp} games — records are mostly schedule luck; don't bet the board on stats alone yet."}

def get(url, timeout=50):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (blueprint-dashboard)"})
    return json.load(urllib.request.urlopen(req, timeout=timeout))

def get_text(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (blueprint-dashboard)"})
    return urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8", "replace")

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
    if p < 1/501: return "+50000+"   # bottom-of-board teams: books cap around here, a 7-digit price is just noise
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
# (restored 2026-11-07: the Kalshi-removal commit 0c6fcff deleted this set along with fetch_kalshi, and every NFL build since crashed
#  with NameError -- the board sat frozen at the Nov 6 12:45Z data)
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
    # fair odds: AFC/NFC split, cap 22%. Raised from 17% after a 16-season calibration backtest
    # (2010-2025): the model's #1 fair-odds team won the SB in 4/16 seasons (~25%), so a 17% cap
    # systematically UNDER-rated dominant favorites and made the model fade eventual champions
    # (e.g. 2025 Seattle: 17% fair vs the market's 20.4% = a wrong fade; at 22% it's correctly valued).
    # Champion IDENTIFICATION (categories/index) was already near-optimal -- reweighting it did NOT
    # survive split-half validation, and turnover differential did not help -- so the cap was the fix.
    # every team on the board gets a price: 0-1/5 teams join the pool at the bottom of the tier ladder
    # (it only shaves the pool's odds; the 2/5+ order and the cap are unchanged). Tail weights are set so
    # the below-pool teams hold ~5-8% combined -- champions almost never come from these tiers.
    pool = list(rows)
    tm = {5:1.6,4:1.25,3:1.0,2:0.7,1:0.3,0:0.15}
    for cf in ("AFC","NFC"):
        cs = [t for t in pool if t["conf"] == cf]; tot = sum((max(t["index"], 5)**3)/1e5*tm[t["score"]] for t in cs)
        for t in cs: t["_pc"] = ((max(t["index"], 5)**3)/1e5*tm[t["score"]]) / tot if tot else 0
    for t in pool: t["p"] = t.get("_pc", 0) * 0.5
    cap_odds(pool, 0.22)
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
        "rtg": round(t['pdg'], 1),
        "fair_pct": round(t["p"]*100, 1) if t.get("p") else None, "fair_odds": t.get("fair_odds"),
        "market": t.get("market"), "ev": t.get("ev"), "verdict": t.get("verdict"), "read": t.get("read")}

# ----------------------------------------------------------------------------- CFB
def build_cfb():
    # 1) byteam stats
    bt = get(f"https://site.web.api.espn.com/apis/common/v3/sports/football/college-football/statistics/byteam?region=us&lang=en&contentorigin=espn&season={YEAR}&seasontype=2")
    pc = [c for c in bt["categories"] if c["name"] == "passing"][0]
    PI, YI = pc["names"].index("totalPointsPerGame"), pc["names"].index("yardsPerGame")
    stats = {}
    id2name = {str(t["team"]["id"]): t["team"]["displayName"] for t in bt["teams"]}
    for t in bt["teams"]:
        nm = t["team"]["displayName"]; own = opp = None
        for c in t["categories"]:
            if c.get("name") == "passing" and c.get("displayName") == "Own Passing": own = c["values"]
            if c.get("name") == "passing" and c.get("displayName") == "Opponent Passing": opp = c["values"]
        if own and opp and own[PI] is not None and opp[PI] is not None and opp[YI] is not None:
            stats[nm] = {"ppg": own[PI], "oppppg": opp[PI], "oppypg": opp[YI], "margin": own[PI] - opp[PI]}
    # 2) records / win%
    sd = get(f"https://cdn.espn.com/core/college-football/standings?xhr=1&season={YEAR}")
    recs, wp, conf = {}, {}, {}
    CFB_CONF = {"Southeastern": "SEC", "Big Ten": "B1G", "Big 12": "Big 12", "Atlantic Coast": "ACC", "Pac-12": "Pac-12", "FBS Independents": "Ind"}
    def walk(o):
        if isinstance(o, dict):
            stx = o.get("standings") if isinstance(o.get("standings"), dict) else None
            if stx and isinstance(stx.get("entries"), list):
                gname = o.get("name") or ""; tag = next((v for k, v in CFB_CONF.items() if k in gname), "G5")
                for e in stx["entries"]:
                    nm = e.get("team", {}).get("displayName"); ov = None
                    for x in e.get("stats", []):
                        if x.get("type") == "total" or x.get("name") == "overall": ov = x.get("displayValue")
                    if nm:
                        conf[nm] = tag
                        if ov and "-" in str(ov):
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
        teams.append({"name": nm, "conf": conf.get(nm, "G5"), "rec": recs[nm], "gp": gp, "winpct": w/gp,
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
        t["srs"] = srs.get(t["name"], 0.0)
    for t in teams: t["read"] = team_read(t, "cfb", len(teams), 5)
    # fair odds: weight = index^3 * SOS^3 (NO tier multiplier), cap 24%. Backtested 2026-10-28 on all
    # 12 CFP-era seasons (2014-2025, rebuilt from game data via cfb-sos-backtest.mjs): dropping the
    # tier multiplier lifts the champion to the model's #1 fair-odds pick in 10/12 seasons (avg rank
    # 1.42), vs 8/12 (avg 1.83) with tier x index^3. The tier boost was docking elite 3/5 champions
    # (2020 Alabama #4->#1, 2024 Ohio State #2->#1) below less-complete 4-5/5 teams; index^3 already
    # rewards quality, so the extra tier weight was redundant and harmful. Robust across k=1-3 and
    # both SOS methods. Remaining misses: 2016 Clemson, 2019 LSU (genuinely low-index champions).
    pool = [t for t in teams if t["score"] >= 3]
    tot = sum((t["index"]**3)/1e5*(t["sos"]/avg)**3 for t in pool)
    for t in pool: t["p"] = ((t["index"]**3)/1e5*(t["sos"]/avg)**3) / tot if tot else 0
    for t in pool: t["mw"] = t["p"]   # uncapped weight: THE backtested order (10/12) — the 24% cap ties the top teams
    # 2/5 teams are on the board too: price them at quarter weight. (FCS-to-FBS movers like 2026 North Dakota State
    # count: the NCAA dropped the 2-year postseason ban on 2026-06-24, so they are CFP-eligible in year one.)
    # They get a fair price but no mw, so the backtested ranking/pick above is untouched.
    tail = [t for t in teams if t["score"] == 2 and t.get("sos")]
    if tail and tot:
        tw = {t["name"]: 0.25*(t["index"]**3)/1e5*(t["sos"]/avg)**3 / tot for t in tail}
        scale = 1 / (1 + sum(tw.values()))
        for t in pool: t["p"] *= scale
        for t in tail: t["p"] = tw[t["name"]] * scale
        pool = pool + tail
    # 3) committee selection: a futures ticket is dead if the team misses the 12-team field, so once the CFP
    # committee has ranked teams, every weight (fair odds AND the mw pick order) is multiplied by P(make the field
    # | latest committee rank). Rates = how teams at each first-ranking rank finished (final top-12), 2014-25.
    # Backtest 2026-11-04 (board rebuilt from games before each season's first release, rates leave-one-season-out,
    # baseball-blueprint/cfb-firstcfp-backtest.mjs): champ top-3 7/12 -> 8/12, champ avg prob 20% -> 27%,
    # log-loss 2.20 -> 2.12, #1 pick unchanged 6/12. The one champion it hurt: 2014 Ohio State (first ranked #16).
    cfp, cfp_week = fetch_cfp_ranks(id2name)
    if cfp:
        for t in pool:
            r = cfp.get(t["name"]); t["cfp"] = r; t["infield"] = cfp_infield(r)
            t["p"] *= t["infield"]
            if t.get("mw"): t["mw"] *= t["infield"]
        tp = sum(t["p"] for t in pool); tm_ = sum(t.get("mw") or 0 for t in pool)
        for t in pool:
            t["p"] = t["p"] / tp if tp else 0
            if t.get("mw"): t["mw"] /= tm_
    cap_odds(pool, 0.24)
    fd, rem = fetch_futures("americanfootball_ncaaf_championship_winner")
    attach(teams, pool, fd, srs_rank)
    # the pick IS the backtested #1 (uncapped index x schedule) — not the cleanest-read team
    ranked = sorted([t for t in pool if t.get("mw")], key=lambda t: -t["mw"])
    if ranked:
        a = ranked[0]; odds = a.get("fair_odds")
        tie = f" Dead even with <b>{ranked[1]['name']}</b> at the 24% cap — {a['name']} edges it on schedule." if len(ranked) > 1 and ranked[1]["p"] >= a["p"] - 1e-9 else ""
        sel = f" Committee has it <b>#{a['cfp']}</b> ({round(a['infield']*100)}% to make the field)." if a.get("cfp") else ""
        pred = {"pick": a["name"], "why": f"<b>{a['name']}</b> is the pick — the model's #1 by index × schedule{' × playoff odds' if cfp else ''}{f' (fair {odds})' if odds else ''}, the order that picked 10 of 12 CFP champions.{sel}{tie} {a['read']['why']}"}
    else:
        pred = make_prediction(teams, 5)
    teams.sort(key=lambda t: (-t["score"], -t["index"]))
    # gauntlet watch: SRS top-10 not in pool
    poolnames = {t["name"] for t in pool if t.get("mw")}
    gauntlet = [{"name": t, "srsrank": srs_rank[t]} for t, _ in sorted(srs.items(), key=lambda kv: -kv[1])[:10] if t not in poolnames]
    return {"sport": "CFB", "season": f"{YEAR}", "generated": now_iso(), "odds_remaining": rem, "prediction": pred,
            "gp_min": min(t["gp"] for t in teams), "gp_max": max(t["gp"] for t in teams),
            "season_pct": season_pct(teams, "cfb"),
            "cats": ["Win% ≥.900", "PPG top-15", "Opp PPG top-10", "Opp YPG top-10", "Margin top-5"],
            "labels": ["Win%", "PPG", "Opp PPG", "Opp YPG", "Margin"],
            "teams": [cfb_row(t) for t in teams if t["score"] >= 2], "gauntlet": gauntlet, "cfp_week": cfp_week}

def cfb_row(t):
    sr = t["srsrank"]
    # Backtested champion band: every clean CFP champion was SRS top-6.
    srs_flag = "elite" if sr <= 6 else ("ok" if sr <= 15 else "mirage")
    return {"name": t["name"], "conf": t.get("conf"), "rec": t["rec"], "score": t["score"], "index": t["index"],
        "q": [bool(x) for x in t["q"]], "sosrank": t["sosrank"], "srsrank": sr,
        "srs_flag": srs_flag,
        "vals": [f"{t['winpct']:.3f}", f"{t['ppg']:.1f} #{t['rk_ppg']}", f"{t['oppppg']:.1f} #{t['rk_oppppg']}",
                 f"{t['oppypg']:.0f} #{t['rk_oppypg']}", f"{t['margin']:+.1f} #{t['rk_margin']}"],
        # Matchup rating blends raw margin with opponent-adjusted SRS (both in points).
        # Backtested 2026-10-26 (2431 games, walk-forward): 0.5m+0.5srs beats pure margin
        # out-of-sample (70.8% vs 70.0%, Brier .1916 vs .1969) by deflating soft-schedule margins.
        "rtg": round(0.5 * t['margin'] + 0.5 * t.get('srs', 0.0), 1),
        "fair_pct": round(t["p"]*100, 1) if t.get("p") else None, "fair_odds": t.get("fair_odds"),
        "market": t.get("market"), "ev": t.get("ev"), "verdict": t.get("verdict"), "read": t.get("read"),
        "mw": round(t["mw"]*100, 2) if t.get("mw") else None,
        "cfp": t.get("cfp"), "infield": round(t["infield"]*100) if t.get("infield") is not None else None}

CFP_INFIELD = [(8, .85), (12, .66), (18, .28), (25, .04)]   # P(final top-12 | committee rank), 2014-25 first->final rankings
def cfp_infield(r):
    if r is None: return .01
    return next((p for hi, p in CFP_INFIELD if r <= hi), .01)

def fetch_cfp_ranks(id2name):
    """Latest CFP committee top 25 as {ESPN displayName: rank}, plus its ESPN week; ({}, None) before the first release."""
    try:
        idx = get(f"https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/{YEAR}/rankings/21?limit=50")
        tw = lambda u: (int(re.search(r"types/(\d+)", u).group(1)), int(re.search(r"weeks/(\d+)", u).group(1)))
        refs = sorted((r["$ref"] for r in (idx or {}).get("rankings", []) if r.get("$ref")), key=tw)
        if not refs: return {}, None
        j = get(refs[-1].replace("http://", "https://"))
        out = {}
        for r in j.get("ranks", []):
            nm = id2name.get(re.search(r"teams/(\d+)", r["team"]["$ref"]).group(1))
            if nm: out[nm] = r["current"]
        return out, tw(refs[-1])[1]
    except Exception as e:
        print(f"  cfp rankings pull failed: {e}", file=sys.stderr)
        return {}, None

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
            gf_all = float(a["goalsFor"]); axgf, axga = float(a["xGoalsFor"]), float(a["xGoalsAgainst"])
        except Exception: continue
        name, conf = NHL_TEAMS[ab]
        rows.append({"name": name, "ab": ab, "conf": conf, "rec": None, "gp": gp,
            "esdiff": gf - ga5, "essv": (saved/sa*100) if sa else 0, "corsi": corsi, "totalGA": total_ga,
            "gdpg": (gf_all - total_ga)/gp if gp else 0,                       # overall goal diff / game — best champ signal
            "xgpct": (axgf/(axgf+axga)*100) if (axgf+axga) else 0})            # all-situations expected-goals share
    rk_ed = ranks(rows, "esdiff", True); rk_sv = ranks(rows, "essv", True)   # rk_sv/rk_cf still feed the hot-goalie Read
    rk_cf = ranks(rows, "corsi", True); rk_ga = ranks(rows, "totalGA", False)
    rk_gd = ranks(rows, "gdpg", True); rk_xg = ranks(rows, "xgpct", True)
    for t in rows:
        t["rk_ed"], t["rk_sv"], t["rk_cf"], t["rk_ga"] = rk_ed[t["name"]], rk_sv[t["name"]], rk_cf[t["name"]], rk_ga[t["name"]]
        t["rk_gd"], t["rk_xg"] = rk_gd[t["name"]], rk_xg[t["name"]]
        # Categories reweighted 2026-10-28 after a 15-season champion backtest (champs 2012-2026,
        # authoritative MoneyPuck season data). ES save% was the single WORST champion predictor
        # (champ top-5 only 5/15) so it is dropped; overall goal diff/game and all-situations xG% are
        # added (best predictors). Corsi is KEPT — it was actually a strong predictor (best top-3/5).
        t["q"] = [t["rk_gd"] <= 10, t["rk_cf"] <= 14, t["rk_xg"] <= 12, t["rk_ga"] <= 12]
        t["score"] = sum(t["q"])
    # Index 15-season backtest vs old (esdiff.30/essv.25/GA.25/corsi.20): identical top-3 (7/15) and
    # top-5 (9/15) champion-PICKING, but top-8 12/15 vs 10/15 -- a strictly better CONTENDER POOL with
    # no regression. NHL is the lowest-chalk sport: this sharpens the filter, it does not pick winners.
    # Dropping ES save% also aligns the index with the Read (which flags hot sv% as unsustainable).
    ngd = norm(rows, "gdpg", True); ncf = norm(rows, "corsi", True); nxg = norm(rows, "xgpct", True); nga = norm(rows, "totalGA", False)
    for t in rows:
        t["index"] = round(ngd[t["name"]]*.30 + ncf[t["name"]]*.25 + nxg[t["name"]]*.25 + nga[t["name"]]*.20, 1)
    for t in rows: t["read"] = team_read(t, "nhl", len(rows), 4)
    # Odds fixes (2026-11-07, user: "can we improve the nhl blend, currently its weak"; scratchpad nhl/nhl_title*.py, Cups 2014-26):
    # (1) a 0/4 team keeps a small share (tier 0.3) instead of 0% -- the 2018 Capitals were 0/4 and won the Cup;
    # (2) once the playoff bracket exists, only the 16 playoff teams are priced.
    # Champion log-loss 2.541 vs 2.925 before, better in both halves (2014-19 2.804 vs 3.547; 2020-26 2.316 vs 2.392).
    # The index blend itself stays: on 225 playoff series 2012-26 it beat every single stat and a fresh weight search
    # (series log-loss 0.662 vs 0.669 best single stat, 0.677 searched blend, 0.693 coin; the higher seed won only 56%).
    field = set()
    try:
        br = get(f"https://api-web.nhle.com/v1/playoff-bracket/{YEAR + 1}")
        for sr in br.get("series", []):
            if sr.get("playoffRound") == 1:
                for k in ("topSeedTeam", "bottomSeedTeam"):
                    ab2 = (sr.get(k) or {}).get("abbrev")
                    if ab2: field.add({"PHX": "ARI"}.get(ab2, ab2))
    except Exception:
        field = set()
    if len(field) < 16: field = set()
    pool = [t for t in rows if not field or t["ab"] in field]   # every team in-season (0/4 at the bottom of the ladder); the 16 playoff teams once the bracket is set
    tm = {4:1.6,3:1.15,2:0.8,1:0.5,0:0.3}
    for cf in ("E","W"):
        cs = [t for t in pool if t["conf"] == cf]; tot = sum((max(t["index"], 5)**3)/1e5*tm[t["score"]] for t in cs)
        for t in cs: t["_pc"] = ((max(t["index"], 5)**3)/1e5*tm[t["score"]]) / tot if tot else 0
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
            "cats": ["Goal diff/game top-10", "Corsi top-14", "xGoals% top-12", "Goals Against top-12"],
            "labels": ["GD/g", "Corsi", "xG%", "GA"],
            "teams": [nhl_row(t) for t in rows if t["score"] >= 1 or (t.get("p") or 0) >= 0.01]}

def nhl_row(t):
    return {"name": t["name"], "conf": t["conf"], "rec": f"{t['gp']} GP", "score": t["score"], "index": t["index"],
        "q": [bool(x) for x in t["q"]],
        "vals": [f"{t['gdpg']:+.2f} #{t['rk_gd']}", f"{t['corsi']:.1f} #{t['rk_cf']}",
                 f"{t['xgpct']:.1f} #{t['rk_xg']}", f"{t['totalGA']:.0f} #{t['rk_ga']}"],
        # Possession-regressed rating: raw ES goal diff over a small sample is inflated by
        # save% variance (hot goaltending), which the blueprint Read flags as a pretender signal.
        # Corsi (shot share) is the sustainable part, so blend them — hot-goalie teams get pulled
        # toward their possession level, matching "that gap closes in a seven-game series."
        "rtg": round(0.4 * (t['esdiff'] / t['gp']) + 0.6 * ((t['corsi'] - 50) * 0.11), 2) if t.get('gp') else 0,
        "fair_pct": round(t["p"]*100, 1) if t.get("p") else None, "fair_odds": t.get("fair_odds"),
        "market": t.get("market"), "ev": t.get("ev"), "verdict": t.get("verdict"), "read": t.get("read")}

# ----------------------------------------------------------------------------- NBA (ESPN; live once the season tips off ~late Oct)
NBA_EAST = {"Boston Celtics","Brooklyn Nets","New York Knicks","Philadelphia 76ers","Toronto Raptors",
    "Chicago Bulls","Cleveland Cavaliers","Detroit Pistons","Indiana Pacers","Milwaukee Bucks",
    "Atlanta Hawks","Charlotte Hornets","Miami Heat","Orlando Magic","Washington Wizards"}
MLB_AL = {"Orioles","Red Sox","Yankees","Rays","Blue Jays","Guardians","Royals","Tigers","Twins",
    "White Sox","Astros","Angels","Athletics","Mariners","Rangers"}   # statsapi short names; rest = NL
# WNBA has NO conferences since 2022 (single 1-8 seeding by record) — no conf tag.

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
    """Pull per-team PPG / Opp PPG from ESPN byteam. Returns {name:(ppg,oppppg)} or {} if the season hasn't started.
       ESPN empties the per-team `names` arrays — the field order lives in the top-level `categories` glossary
       and the per-team `values` align to it by index. The 'offensive' category's avgPoints (idx 0) = PPG;
       the 'Opponent Offensive' split's same index = Opp PPG."""
    try:
        bt = get(f"https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byteam?region=us&lang=en&contentorigin=espn&season={season}&seasontype=2")
    except Exception:
        return {}
    # glossary: for each category, the entry that still carries names defines the value order
    gloss = {}
    for c in bt.get("categories", []):
        if c.get("names"):
            gloss[c["name"]] = {n: i for i, n in enumerate(c["names"])}
    oi = None
    for cat in ("offensive", "general"):
        for fld in ("avgPoints", "points"):
            if cat in gloss and fld in gloss[cat]:
                oi = (cat, gloss[cat][fld]); break
        if oi: break
    if not oi:
        return {}
    cat, idx = oi
    out = {}
    for t in bt.get("teams", []):
        nm = t.get("team", {}).get("displayName")
        own = opp = None
        for c in t.get("categories", []):
            if c.get("name") != cat: continue
            vals = c.get("values", []); dn = (c.get("displayName") or "").lower()
            if idx >= len(vals): continue
            if "opponent" in dn: opp = vals[idx]
            else: own = vals[idx]
        if nm and own is not None and opp is not None:
            out[nm] = (own, opp)
    return out

def forty_twenty(w, l, log=None):
    """Champion pedigree flag — reached 40 wins before 20 losses? 8/10 recent champions did,
       but NYK '26 (40th win @ game 62, 22 L) and MIL '21 (@ game 64, 24 L) won WITHOUT it,
       so it's a POSITIVE signal, not a disqualifier. Resolvable only ~game 50+; 'pending' until then.
       From current W-L alone it resolves every case except (w>=40 and l>=20), which needs the log."""
    if log:
        cw = cl = 0
        for win in log:
            if win: cw += 1
            else: cl += 1
            if cw == 40: return "pass" if cl < 20 else "fail"
            if cl == 20 and cw < 40: return "fail"
        return "pending"
    if w >= 40 and l < 20: return "pass"
    if l >= 20 and w < 40: return "fail"
    if w < 40 and l < 20: return "pending"
    return "ambiguous"   # w>=40 and l>=20 -> order matters, need the game log

def nba_team_ids():
    try:
        d = get("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams?limit=40")
        return {t["team"]["displayName"]: t["team"]["id"] for t in d["sports"][0]["leagues"][0]["teams"]}
    except Exception:
        return {}

def nba_wl_log(tid, season):
    try:
        d = get(f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{tid}/schedule?season={season}")
    except Exception:
        return None
    g = []
    for ev in d.get("events", []):
        if str(ev.get("seasonType", {}).get("type")) != "2": continue
        comp = ev.get("competitions", [{}])[0]
        if not comp.get("status", {}).get("type", {}).get("completed"): continue
        dt = None
        try: dt = datetime.datetime.fromisoformat(ev["date"].replace("Z", "+00:00")).date()
        except Exception: pass
        win = None
        for c in comp.get("competitors", []):
            if str(c.get("team", {}).get("id")) == str(tid): win = c.get("winner")
        if win is not None: g.append((dt, win))
    g.sort(key=lambda x: x[0] or datetime.date.min)
    return [x[1] for x in g]

VS500_MIN_GP = 25   # record vs .500+ teams is noise until every team has ~25 games

def nba_vs500(season, winpct):
    """{team displayName: (w, l)} vs opponents currently above .500, from ESPN team schedules.
       Backtested 2026-10-29 over 15 champions (2011-2025): this single stat put the champion top-3 in
       12/15 seasons (index 10/15), better in BOTH halves (6/7 & 6/8 vs 5/7 & 5/8) — the one stat out of
       53 tested (and 888k blends, all overfit) that held up out of sample."""
    ids = nba_team_ids()
    name_of = {str(v): k for k, v in ids.items()}
    out = {}
    for nm, tid in ids.items():
        try:
            d = get(f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{tid}/schedule?season={season}")
        except Exception:
            continue
        w = l = 0
        for ev in d.get("events", []):
            if str(ev.get("seasonType", {}).get("type")) != "2": continue
            comp = ev.get("competitions", [{}])[0]
            if not comp.get("status", {}).get("type", {}).get("completed"): continue
            me = [c for c in comp.get("competitors", []) if str(c.get("team", {}).get("id")) == str(tid)]
            op = [c for c in comp.get("competitors", []) if str(c.get("team", {}).get("id")) != str(tid)]
            if not me or not op or winpct.get(name_of.get(str(op[0]["team"]["id"])), 0) <= .5: continue
            if me[0].get("winner"): w += 1
            else: l += 1
        out[nm] = (w, l)
    return out

# ----------------------------------------------------------------------------- beat-reporter reads
SPORT_PATH = {"nfl": "football/nfl", "cfb": "football/college-football", "nhl": "hockey/nhl", "nba": "basketball/nba", "wnba": "basketball/wnba", "mlb": "baseball/mlb",
              "cbb": "basketball/mens-college-basketball", "wcbb": "basketball/womens-college-basketball"}

def espn_news(path, tid, n=4):
    """Recent ESPN headlines+blurbs for one team — the storyline fuel for the beat-reporter read."""
    try:
        d = get(f"https://site.api.espn.com/apis/site/v2/sports/{path}/news?team={tid}&limit={n+4}")
    except Exception:
        return []
    out = []
    for a in d.get("articles", []):
        h = (a.get("headline") or "").strip()
        if not h or "Where to watch" in h or h.lower().startswith("fantasy"): continue
        desc = (a.get("description") or "").strip()
        out.append(h + (f" — {desc}" if desc else ""))
        if len(out) >= n: break
    return out

def espn_team_ids(path, limit=400):
    """{displayName: id} for a league, to fetch per-team news."""
    try:
        d = get(f"https://site.api.espn.com/apis/site/v2/sports/{path}/teams?limit={limit}")
        return {t["team"]["displayName"]: t["team"]["id"] for t in d["sports"][0]["leagues"][0]["teams"]}
    except Exception:
        return {}

def _pos(ath):
    p = ath.get("position")
    if isinstance(p, dict): return p.get("abbreviation") or p.get("name")
    return p if isinstance(p, str) else None

def roster_snapshot(path, tid, keep_pos):
    """Depth at the positions in keep_pos (name + age) + IR, so the read can judge roster construction —
       star dependence, aging players, thin/unproven groups. The model knows the named players' caliber.
       Returns a compact string or ''."""
    try:
        d = get(f"https://site.api.espn.com/apis/site/v2/sports/{path}/teams/{tid}/roster")
    except Exception:
        return ""
    groups = {}; ir = []
    for g in d.get("athletes", []):
        active = g.get("position") not in ("injuredReserveOrOut", "suspended", "practiceSquad")
        for p in g.get("items", []):
            pos = (p.get("position") or {}).get("abbreviation")
            if pos not in keep_pos: continue
            nm = p.get("displayName"); age = p.get("age")
            if not active: ir.append(f"{nm}({pos}, IR)")
            else: groups.setdefault(pos, []).append(f"{nm}{f' {age}' if age else ''}")
    if not groups and not ir: return ""
    order = [p for p in keep_pos if p in groups] or list(groups)
    s = "Roster (names listed ALPHABETICALLY, not by depth — the established starter is set) — " + "; ".join(f"{pos}: {', '.join(groups[pos][:5])}" for pos in order)
    if ir: s += " | out long-term (IR): " + ", ".join(ir[:6])
    return s

def nba_ppg_by_name(season):
    """{player displayName: PPG} for NBA injury weighting (feed has no athlete id → match by name).
       Current season for this year's role + prior season as fallback (early PPG is thin / rookies miss)."""
    ppg = {}
    def _load(seas, fill_only):
        try:
            d = get(f"https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete?region=us&lang=en&contentorigin=espn&season={seas}&seasontype=2&limit=600")
        except Exception:
            return
        gl = {}
        for c in d.get("categories", []):
            if c.get("names"): gl[c["name"]] = {nmx: i for i, nmx in enumerate(c["names"])}
        oi = gl.get("offensive", {}).get("avgPoints")
        if oi is None: return
        for a in d.get("athletes", []):
            nm = a.get("athlete", {}).get("displayName")
            if not nm or (fill_only and nm in ppg): continue
            for c in a.get("categories", []):
                if c.get("name") == "offensive":
                    v = c.get("values", [])
                    if oi < len(v): ppg[nm] = v[oi]
                    break
    _load(season, False)
    _load(season - 1, True)
    return ppg

_LONG_KW = ("season-ending", "out for the season", "season ending", "torn", " acl", "ruptur",
            "out indefinitely", "placed on injured reserve", "miss the remainder", "miss significant")

def _injury_timeline(it):
    """Classify an injury by FORWARD availability — title-relevant only if the player stays out a long
       time (season-ending, or multi-week recovery). The IR label alone is not enough: an IR player
       being activated this week (near returnDate) is effectively healthy going forward, so DROP it.
       Returns a short timeline label, or None to drop."""
    s = (it.get("status") or "")
    d = it.get("details") or {}
    comment = ((it.get("shortComment") or "") + " " + (it.get("longComment") or "")).lower()
    is_ir = "reserve" in s.lower()
    not_playing = is_ir or s == "Out"
    season_ending = any(k in comment for k in _LONG_KW)
    days = None
    rd = d.get("returnDate")
    if rd:
        try: days = (datetime.date.fromisoformat(rd[:10]) - datetime.date.today()).days
        except Exception: days = None
    if season_ending:
        return "out for the season"
    if days is not None:
        # a concrete return date: title-relevant only if it's still 4+ weeks away
        if days >= 28 and not_playing:
            return f"{'on IR, ' if is_ir else ''}out ~{round(days / 7)}+ wks"
        return None   # near-term return (incl. IR players activating soon) -> not a title factor
    # no return date + genuinely out -> indefinite / likely serious
    return "out indefinitely" if not_playing else None

def espn_injuries(path, ppg_by_name=None):
    """Only SEASON-ENDING or long-recovery injuries (what matters for a title run). Short-term game
       statuses (Questionable/Doubtful/Day-To-Day) are dropped. Each: (player, status, note) where
       note carries the recovery timeline + position/PPG. {team: [...]}"""
    try:
        inj = get(f"https://site.api.espn.com/apis/site/v2/sports/{path}/injuries").get("injuries", [])
    except Exception:
        return {}
    out = {}
    for t in inj:
        team = t.get("displayName"); lst = []
        for it in t.get("injuries", []):
            ath = it.get("athlete", {}); nm = ath.get("displayName")
            if not nm: continue
            tl = _injury_timeline(it)
            if not tl: continue
            if ppg_by_name is not None:   # NBA: only impactful players (starters / key rotation), not deep bench
                pv = ppg_by_name.get(nm)
                if pv is None or pv < 10: continue
            who = (f"{ppg_by_name[nm]:.0f} ppg" if (ppg_by_name is not None and nm in ppg_by_name) else _pos(ath))
            note = f"{who}, {tl}" if who else tl
            lst.append((nm, it.get("status"), note))
        if team and lst: out[team] = lst
    return out

def beat_sheet(t, labels, news, inj_list, roster=""):
    """Compact, blueprint-anchored fact sheet handed to the model. Facts only — no narrative."""
    vals = t.get("vals", [])
    cats = "; ".join(f"{labels[i]} {vals[i]}" for i in range(min(len(labels), len(vals))))
    lines = [
        f"Team: {t['name']}{f' ({t['conf']})' if t.get('conf') else ''}, {t.get('rec','')}",
        f"Blueprint: tier {t['score']}, index {t['index']}, box-score verdict '{t['read']['v']}' ({t['read']['why']})",
        f"Category ranks: {cats}",
        (f"Futures: fair {t.get('fair_odds')} vs FanDuel {t.get('market')}, EV {t.get('ev')}%" if t.get("market") else "Futures: n/a"),
    ]
    if t.get("ftt"): lines.append(f"40-before-20: {t['ftt']}")
    if roster: lines.append(roster)
    news_blob = " ".join(news).lower()
    def _val(x):   # NBA scoring value if the note carries it ("28 ppg, ...")
        try: return float(x[2].split()[0]) if (x[2] and "ppg" in x[2]) else 0
        except Exception: return 0
    def _innews(x): return 0 if (x[0] and x[0].lower() in news_blob) else 1   # a hurt player the beat is writing about = the one that matters
    # inj_list is already filtered to season-ending / long-recovery injuries only
    if inj_list:
        shown = sorted(inj_list, key=lambda x: (_innews(x), -_val(x)))[:5]
        lines.append("Season-ending / long-term injuries: " + "; ".join(f"{p} ({note or s})" for p, s, note in shown))
    if news:
        lines.append("Headlines: " + " | ".join(news))
    return "\n".join(lines)

_BANNED = re.compile(r"\b(but|however|though)\b|the catch is|the question is", re.I)   # crutch phrases that make reads read alike

# Beat-reporter reads: Sonnet writes them (far less likely to mislabel a position or invent an injury
# than Haiku), Haiku fact-checks them (a cheaper discriminative task). Override via env if desired.
GEN_MODEL = os.environ.get("READ_GEN_MODEL", "claude-sonnet-5-5")
VERIFY_MODEL = os.environ.get("READ_VERIFY_MODEL", "claude-haiku-5-5")

def _anthropic_json(system, user, max_tokens=120, model=VERIFY_MODEL):
    """One model call returning the parsed JSON object the model replies with (or None)."""
    if not os.environ.get("ANTHROPIC_API_KEY"): return None
    body = json.dumps({"model": model, "max_tokens": max_tokens,
                       "thinking": {"type": "disabled"},   # plain JSON task — no thinking (default effort = medium, so 'disabled' is accepted)
                       "system": system,
                       "messages": [{"role": "user", "content": user}]}).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body,
        headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01", "content-type": "application/json"})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=45))
        txt = next((b.get("text", "") for b in r.get("content", []) if b.get("type") == "text"), "").strip()
        if not txt: return None
        if txt.startswith("```"): txt = txt.strip("`").split("\n", 1)[-1].rsplit("```", 1)[0]
        return json.loads(txt[txt.find("{"): txt.rfind("}") + 1])
    except Exception:
        return None

def _anthropic_read(system, sheet):
    o = _anthropic_json(system, sheet, model=GEN_MODEL)
    if o and o.get("why"): return {"beat": o["why"].strip(), "tier": o.get("tier")}
    return None

# Any wording that asserts an injury — only allowed when the fact sheet actually lists one.
_INJURY_RE = re.compile(
    r"\b(acl|mcl|ucl|pcl|torn|tear|ruptur\w*|achilles|hamstring|quad|groin|concussion|fractur\w*|"
    r"broke\w*|surger\w*|injur\w*|sidelined|out for the (?:season|year)|season[- ]ending|"
    r"placed on ir|\bir\b|disabled list|day[- ]to[- ]day|ligament|sprain\w*|strain\w*)\b", re.I)

_VERIFY_SYS = (
    "You are a STRICT fact-checker for a one-line sports 'read'. You get FACTS and a DRAFT read. "
    "Flag the draft if it makes ANY claim not directly supported by the facts: a named player not in the facts; "
    "a player's position, role, or team not stated in the facts; an injury (its existence, type, severity, or who) "
    "not in the facts; any stat, rank, record, price, quote, or event not in the facts; or any characterization "
    "that contradicts the facts. Plain blueprint-level description that matches the facts (elite / middling / leaky "
    "defense, complete vs one-dimensional, pretender / contender / champion, strong or soft record) is allowed. "
    'Reply JSON only: {"ok": true|false, "problems": ["short phrase", ...]}. ok must be false if ANY claim is unsupported.')

def validate_read(beat, sheet):
    """Fact-check a generated read against its OWN fact sheet. Returns (ok, problems).
       Two layers: a deterministic backstop for the worst class (a phantom injury — the exact failure
       that produced 'torn ACL to Allen'/'Chase and Higgins at tight end'), plus a strict Haiku
       fact-check pass for everything else (unsupported players, positions, roles, events)."""
    problems = []
    low = sheet.lower()
    if _INJURY_RE.search(beat) and "injur" not in low:
        problems.append("states an injury the facts do not list")
    chk = _anthropic_json(_VERIFY_SYS, f"FACTS:\n{sheet}\n\nDRAFT READ:\n{beat}")
    if chk is not None and chk.get("ok") is False:
        ps = [p.strip() for p in (chk.get("problems") or []) if isinstance(p, str) and p.strip()]
        problems.extend(ps[:3] or ["a claim in the read is not supported by the facts"])
    return (not problems, problems)

def llm_read(sheet, sport):
    """Claude writes a BRIEF, blueprint-accurate beat-reporter read from the fact sheet.
       Returns {beat, tier} or None (→ caller keeps the deterministic template read). Facts-only."""
    if not os.environ.get("ANTHROPIC_API_KEY"): return None
    ctx = READ_CTX.get(sport, "the playoffs punish a one-dimensional team")
    system = (
        f"You are a scout writing a VERY SHORT read for a {sport.upper()} championship-blueprint tool. "
        "Sort this team on the spectrum pretender -> contender -> champion. "
        f"Playoff reality for this sport: {ctx}. "
        "Write like a sharp beat reporter: ONE or TWO short sentences, 30 words HARD MAX. "
        "There is NO template. Write each read as its own thing, shaped by whatever is actually true and most telling about THIS team — "
        "some reads are a single clean point, some a contrast, some a warning, some a surprise. Never force a structure. "
        "BANNED words/phrases — do not use ANY of them: 'but', 'however', 'though', 'the catch is', 'the question is', 'what keeps them'. "
        "They are crutches that make every read sound alike. Many of the best reads are a SINGLE declarative statement with no pivot at all "
        "(e.g. 'A complete team built for a deep run — believe it' or 'All offense, no stops; this one gets exposed in May'). When a strength "
        "and a flaw both matter, show it with a semicolon or a second sentence, phrased fresh — never the same construction twice. "
        "Avoid stock scouting clichés too: no 'defense that travels', 'built for January', 'playoff series expose'. Say it in your own plain words. "
        "NEVER cite a number, rank, stat line, or betting price — translate them into plain words (elite / top-five / middling / leaky / "
        "bottom-tier). Write 'an elite defense', never 'a top-4 defense (18.3 PPG allowed)'. The card already shows the numbers. "
        "Do NOT manufacture a flaw for every team. When a real, material weakness exists (star-dependence, an aging key player, a thin / "
        "unproven group), name it; when a team is genuinely complete and elite, a short confident read is the right call — e.g. 'A complete "
        "team built for a deep run — believe it.' Not every team needs a caveat. "
        "The roster list is ALPHABETICAL, not a depth chart: NEVER infer a starting competition, an 'unsettled' spot, or a 'question at QB' "
        "from multiple players being listed. Assume each team's established starter is locked in — call a position a battle ONLY if the "
        "headlines explicitly say so. INJURIES ARE OPTIONAL — most reads should not mention one. Raise an injury ONLY if it genuinely threatens the title: "
        "an impactful starter or key contributor whose absence the team has NOT absorbed and cannot easily cover. If the team is winning and "
        "dominant despite the absence, they have absorbed it — stay silent on it. A deep team filling a short-term void is not a title factor; "
        "a thin team losing its one difference-maker is. Never mention minor or day-to-day injuries. "
        "GROUNDING — every concrete claim must trace to the FACTS you are given: if you name a player, that exact name "
        "must appear in the facts; NEVER state a player's position, role, or team unless the facts give it; NEVER describe "
        "an injury (its existence, type, severity, or who) unless the facts list it. Do not invent players, injuries, stats, "
        "prices, quotes, or events, and do not fill gaps from memory — when unsure, describe only the blueprint profile in "
        "plain words (a named player you cannot ground is never worth the risk; leave them out). "
        'Reply as JSON only: {"tier":"pretender|contender|champion","why":"..."}.'
    )
    out = _anthropic_read(system, sheet)
    if out and _BANNED.search(out["beat"]):   # it slipped a crutch word in — one rewrite pass
        strict = system + " Your previous draft used a forbidden word (but/however/though). Rewrite it with NONE of those words."
        retry = _anthropic_read(strict, sheet)
        if retry: out = retry
    if not out:
        return None
    # VALIDATION FILTER — fact-check the read against its own sheet; one targeted rewrite, else drop it
    # so the caller keeps the deterministic (always-accurate) template read instead of a hallucination.
    ok, problems = validate_read(out["beat"], sheet)
    if not ok:
        fix = (system + " Your previous draft made claims NOT supported by the facts: " + "; ".join(problems) +
               ". Rewrite using ONLY what the facts state. Name no player, position, role, or injury that is not in "
               "the facts; if that leaves nothing specific, describe only the blueprint profile in plain words.")
        retry = _anthropic_read(fix, sheet)
        if retry and validate_read(retry["beat"], sheet)[0]:
            return retry
        return None   # could not produce a fact-checked read → fall back to the template read
    return out

def attach_beat_reads(name, data):
    """Generate beat-reporter reads for the top contenders of one sport, in place on data['teams'].
       No-op unless ANTHROPIC_API_KEY is set. CI-safe curl + per team: one Sonnet write then a Haiku
       fact-check (+ one rewrite if it fails); an unverifiable read is dropped for the template read."""
    if not os.environ.get("ANTHROPIC_API_KEY"): return
    teams = data.get("teams", []); labels = data.get("labels", [])
    if not teams: return
    maxcat = len(data.get("cats", [])) or 4
    min_score = max(2, maxcat - 2)        # NBA/NHL(4)->2, NFL/CFB(5)->3
    path = SPORT_PATH[name]
    ppg = nba_ppg_by_name(YEAR + 1) if name == "nba" else None
    injuries = espn_injuries(path, ppg)
    ids = espn_team_ids(path)
    keep_pos = {"nfl": ["QB", "RB", "FB", "WR", "TE"]}.get(name)   # offense skill depth exposes roster weaknesses
    done = 0
    for t in sorted(teams, key=lambda x: -x.get("index", 0)):
        if t.get("score", 0) < min_score or done >= 15: continue
        tid = ids.get(t["name"])
        news = espn_news(path, tid) if tid else []
        roster = roster_snapshot(path, tid, keep_pos) if (keep_pos and tid) else ""
        br = llm_read(beat_sheet(t, labels, news, injuries.get(t["name"], []), roster), name)
        if br and t.get("read"):
            t["read"]["beat"] = br["beat"]
            if br.get("tier"): t["read"]["tier"] = br["tier"]
        done += 1
    # Reconcile the banner prediction with the read TIERS so it never contradicts the cards:
    # the pick is the team the reads actually crown (champion > contender > pretender), best index among them.
    tagged = [t for t in teams if (t.get("read") or {}).get("beat") and t["read"].get("tier")]
    if tagged and name != "cfb":   # CFB's pick is the backtested index x schedule #1 (build_cfb)
        tr = {"champion": 0, "contender": 1, "pretender": 2}
        best = sorted(tagged, key=lambda t: (tr.get(t["read"]["tier"], 3), -t.get("index", 0)))[0]
        data["prediction"] = {"pick": best["name"], "why": f"<b>{best['name']}</b> is the pick — {best['read']['beat']}"}

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
            "w": w, "l": l, "winpct": w/g, "ppg": ppg, "oppppg": opp, "pdg": ppg - opp, "depth": depth.get(nm, 0)})
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
    # Index reweighted 2026-10-28 after a 15-season champion backtest (2011-2025, ESPN standings):
    # WIN% is the single BEST champion predictor (champ top-3 10/15) but was weighted only .13, while
    # raw offense (ppg, .20) is a weak standalone predictor and redundant with net rating. Bumping
    # win% .13->.23 and trimming offense .20->.12 lifts the champ to top-3 11/15 (was 9) and avg rank
    # #2.9 (was #3.2); it held or improved on BOTH split-halves (unlike the NFL reweight, which overfit).
    # Depth (scoring balance) stays .15, net rating .30; neutral if the depth feed is unavailable.
    for t in rows:
        t["index"] = round(npd[t["name"]]*.30 + no[t["name"]]*.20 + nf[t["name"]]*.12 + nw[t["name"]]*.23
                           + (ndp[t["name"]]*.15 if has_depth else npd[t["name"]]*.15), 1)
    # From game 25: index = 50% the above + 50% record vs .500+ teams (see nba_vs500 for the backtest;
    # this exact 0-100 blend reproduces it: champ top-3 12/15, top-5 14/15, avg rank 2.67 vs 3.00).
    vs500_on = min(t["gp"] for t in rows) >= VS500_MIN_GP
    vs = nba_vs500(season, {t["name"]: t["winpct"] for t in rows}) if vs500_on else {}
    vs500_on = vs500_on and bool(vs)
    if vs500_on:
        for t in rows:
            w_, l_ = vs.get(t["name"], (0, 0))
            t["vs500_rec"] = f"{w_}-{l_}"; t["vs500"] = w_/(w_+l_) if w_+l_ else None
        known = [t["vs500"] for t in rows if t["vs500"] is not None]
        for t in rows:
            if t["vs500"] is None: t["vs500"] = sum(known)/len(known)   # no games vs .500+ yet -> league average
        nv = norm(rows, "vs500", True)
        for t in rows: t["index"] = round(t["index"]*.5 + nv[t["name"]]*.5, 1)
    for t in rows: t["read"] = team_read(t, "nba", len(rows), 4)
    # 40-wins-before-20-losses pedigree flag (display-only positive signal, not a gate)
    _ids = None
    for t in rows:
        st = forty_twenty(t["w"], t["l"])
        if st == "ambiguous":
            if _ids is None: _ids = nba_team_ids()
            log = nba_wl_log(_ids.get(t["name"]), season) if _ids.get(t["name"]) else None
            st = forty_twenty(t["w"], t["l"], log) if log else "pending"
        t["ftt"] = st
    pool = [t for t in rows if t["score"] >= 1]   # 1/5 teams are on the board too -> price them at the bottom of the ladder
    tm = {4:1.7,3:1.2,2:0.8,1:0.25}
    for cf in ("E","W"):
        cs = [t for t in pool if t["conf"] == cf]; tot = sum((max(t["index"], 5)**3)/1e5*tm[t["score"]] for t in cs)
        for t in cs: t["_pc"] = ((max(t["index"], 5)**3)/1e5*tm[t["score"]]) / tot if tot else 0
    for t in pool: t["p"] = t.get("_pc", 0) * 0.5
    cap_odds(pool, 0.24)   # NBA is the chalkiest sport -> let the top team run
    fd, rem = fetch_futures("basketball_nba_championship_winner")
    attach(rows, pool, fd)
    pred = make_prediction(rows, 4)
    rows.sort(key=lambda t: (-t["score"], -t["index"]))
    base.update({"odds_remaining": rem, "prediction": pred, "season_pct": season_pct(rows, "nba"),
        "gp_min": min(t["gp"] for t in rows), "gp_max": max(t["gp"] for t in rows), "has_depth": has_depth, "vs500_on": vs500_on,
        "cats": ["Win% ≥.600", "Net/g top-5", "PPG top-10", "Opp PPG top-10"],
        "labels": ["Win%", "Net/g", "PPG", "Opp PPG"],
        "teams": [{"name": t["name"], "conf": t["conf"], "rec": t["rec"], "score": t["score"], "index": t["index"],
            "q": [bool(x) for x in t["q"]],
            "vals": [f"{t['winpct']:.3f}", f"{t['pdg']:+.1f} #{t['rk_pd']}", f"{t['ppg']:.1f} #{t['rk_ppg']}", f"{t['oppppg']:.1f} #{t['rk_opp']}"],
            "rtg": round(t['pdg'], 1),
            "fair_pct": round(t["p"]*100,1) if t.get("p") else None, "fair_odds": t.get("fair_odds"),
            "market": t.get("market"), "ev": t.get("ev"), "verdict": t.get("verdict"), "read": t.get("read"), "ftt": t.get("ftt"), "vs500": t.get("vs500_rec")} for t in rows if t["score"] >= 1]})
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
        t["mk"] = mk
        t["market"] = (f"+{mk}" if mk > 0 else str(mk)) if mk is not None else None
        p = pmap.get(t["name"], 0)
        if mk is not None and p > 0:
            dec = 1 + mk/100 if mk > 0 else 1 + 100/abs(mk)
            t["ev"] = round((p*dec - 1)*100)
        else:
            t["ev"] = None
    assign_verdicts(allteams)

def assign_verdicts(teams):
    """Market EV verdict per team — the value/fade spectrum from the chat runs. ONE price cap is
       used everywhere: <= +2500 is a 'believable' price (the same cap value_plays uses), so a
       positive-EV team priced LONGER than that is 'longshot value', never 'value'/'BEST VALUE'.
       'trap' = positive EV on a team the playoff-translation read distrusts (fool's gold /
       pretender / SRS mirage) — a mirage price, not a bet. The single BEST VALUE crown is NOT set
       here: crown_best_value() awards it to the top QUALIFIED value play (value_plays[0]) so the
       card crown and the header 'Value play' are always the same team."""
    for t in teams:
        ev = t.get("ev"); mk = t.get("mk"); rd = t.get("read") or {}
        if ev is None or mk is None:
            t["verdict"] = None; continue
        unsustain = (rd.get("v") == "fools_gold" or rd.get("tier") == "pretender"
                     or (t.get("srsrank") is not None and t["srsrank"] > 15))
        if ev >= 10 and unsustain:
            v = {"kind": "trap", "label": "trap"}
        elif ev >= 10 and mk > 2500:
            v = {"kind": "longshot", "label": "longshot value"}
        elif ev >= 10:
            v = {"kind": "value", "label": "value"}
        elif ev >= 3:
            v = {"kind": "small", "label": "small value"}
        elif ev > -10:
            v = {"kind": "fair", "label": "≈ fair"}
        elif ev > -40:
            v = {"kind": "fade", "label": "fade"}
        else:
            v = {"kind": "bigfade", "label": "big fade"}
        v["ev"] = ev
        t["verdict"] = v


def crown_best_value(teams, vp):
    """Award the single BEST VALUE to the top qualified value play (vp[0]) — the exact team the
       header shows as 'Value play'. Guarantees the card crown and the header can never name
       different teams. No qualified value play => no card crowned (header shows 'none')."""
    if not vp:
        return
    top = vp[0]
    for t in teams:
        if t.get("name") == top["name"]:
            t["verdict"] = {"kind": "best", "label": "BEST VALUE", "ev": top["ev"]}
            break

def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

READ_CTX = {
    "nfl": "single-elimination January football punishes a leaky defense",
    "cfb": "a 12-team playoff gauntlet runs a one-sided team off the field",
    "nhl": "goaltending decides best-of-seven series",
    "nba": "offense goes cold in a seven-game series — defense travels",
    "wnba": "offense goes cold in a playoff series — defense travels",
    "mlb": "October is decided by pitching and timely hitting — bats go cold in a short series",
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

    if sport in ("nba", "wnba"):
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

    if sport == "mlb":
        rd, off, pit = t["rk_rd"], t["rk_runs"], t["rk_era"]
        if pit > good and (off <= good or rd <= el):                  # offense-carried, pitching lags (the Cubs shape)
            return {"v": "fools_gold", "why": _pick([
                f"A #{off} offense papering over #{pit} pitching. October is started by aces and decided in the bullpen — bats go cold and the staff can't cover. Fade.",
                f"All bats (#{off}), no arms (#{pit} ERA). Playoff runs are built on run prevention; this one gets out-pitched in a short series. The classic trap."], nm)}
        if pit <= el and off <= good:                                 # complete, October-proof
            return {"v": "trust", "why": _pick([
                f"Elite run prevention (#{pit}) with a real lineup — the complete, October-proof shape. Pitching wins in the playoffs and this team has it.",
                f"A #{pit} staff that travels into October, plus enough offense. Built for a short series, not just 162 games. Trust it."], nm)}
        if top and rd <= el:
            return {"v": "trust", "why": f"A #{rd} run differential — the master signal of a title team. Balanced and built for a deep run."}
        return {"v": "caution", "why": f"Run-diff-driven (#{rd}) but tilts one way; the #{max(off, pit)} side is where a playoff series exposes it."}

    # CFB — dominance vs schedule
    cats = [("offense", t["rk_ppg"]), ("scoring defense", t["rk_oppppg"]), ("total defense", t["rk_oppypg"]), ("margin", t["rk_margin"])]
    worst = max(cats, key=lambda c: c[1]); best = min(cats, key=lambda c: c[1]); b, br, w, wr = best[0], best[1], worst[0], worst[1]
    sr = t.get("srsrank", 999)
    off = t["rk_ppg"]   # (2026-11-07) was never set in this branch: a 4/5+ team with SRS #7-15 raised UnboundLocalError and the whole CFB build failed
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
    if sr <= 6:                                                   # one soft spot, but proven against real teams
        return {"v": "caution", "why": f"Leads with its #{br} {b}; the #{wr} {w} is the one soft spot — but SRS #{sr} says it's done this against a real schedule, not cupcakes."}
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
    """Append a compact dated snapshot of the contenders to data/history/<name>.json (keep last 400 runs — a full season of daily runs, so streaks aren't truncated).
       This is the week-over-week tracker — it's what surfaces season-long consistency + market drift."""
    if data.get("status") == "preseason" or not data.get("teams") or data.get("hist_off"): return
    hp = os.path.join(DATA, "history", f"{name}.json")
    os.makedirs(os.path.dirname(hp), exist_ok=True)
    try: hist = json.load(open(hp, encoding="utf-8"))
    except Exception: hist = []
    snap = {"date": data["generated"][:10], "gp": data.get("gp_max"),
            "teams": {t["name"]: {"sc": t["score"], "idx": t["index"], "fp": t.get("fair_pct"),
                                  "mkt": t.get("market"), "ev": t.get("ev"), **({"mw": t["mw"]} if t.get("mw") is not None else {})} for t in data["teams"]}}   # mw: CFB's pick order
    if hist and hist[-1]["date"] == snap["date"]: hist[-1] = snap   # same-day re-run replaces
    else: hist.append(snap)
    json.dump(hist[-400:], open(hp, "w", encoding="utf-8"), indent=1)

def wnba_scoring(season):
    """Per-team scoring from ESPN WNBA byteam (same glossary-index trick as NBA): {team: {ppg, opp, poss, ortg, drtg, nrtg}}.
       Per-100 ratings (2026-11-07): possessions/g = FGA - OREB + TOV + 0.44*FTA, averaged over the team and its opponents.
       Checked against Basketball-Reference for 2026: same team order, net rating within ~0.3 (B-Ref's possession formula runs
       ~3 lower, so its ratings are ~3 points higher on both ends; the gaps between teams match)."""
    try:
        bt = get(f"https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba/statistics/byteam?region=us&lang=en&contentorigin=espn&season={season}&seasontype=2")
    except Exception:
        return {}
    gloss = {c["name"]: {n: i for i, n in enumerate(c["names"])} for c in bt.get("categories", []) if c.get("names")}
    o = gloss.get("offensive", {})
    need = ("avgPoints", "avgFieldGoalsAttempted", "avgOffensiveRebounds", "avgTurnovers", "avgFreeThrowsAttempted")
    if not all(k in o for k in need): return {}
    out = {}
    for t in bt.get("teams", []):
        nm = t.get("team", {}).get("displayName"); own = opp = None
        for c in t.get("categories", []):
            if c.get("name") != "offensive": continue
            vals = c.get("values", [])
            if max(o[k] for k in need) >= len(vals): continue
            if "opponent" in (c.get("displayName") or "").lower(): opp = vals
            else: own = vals
        if not (nm and own and opp): continue
        pos = lambda v: v[o["avgFieldGoalsAttempted"]] - v[o["avgOffensiveRebounds"]] + v[o["avgTurnovers"]] + 0.44*v[o["avgFreeThrowsAttempted"]]
        poss = (pos(own) + pos(opp)) / 2
        if poss <= 0: continue
        ppg, opg = own[o["avgPoints"]], opp[o["avgPoints"]]
        out[nm] = {"ppg": ppg, "opp": opg, "poss": poss, "ortg": 100*ppg/poss, "drtg": 100*opg/poss, "nrtg": 100*(ppg - opg)/poss}
    return out

def build_wnba():
    season = YEAR   # ESPN tags the WNBA season by its own year
    base = {"sport": "WNBA", "season": str(season), "generated": now_iso()}
    scoring = wnba_scoring(season)
    if not scoring:
        base.update({"status": "preseason", "odds_remaining": None,
            "note": "The WNBA tips off in May — the blueprint goes live on the first games.", "teams": []})
        return base
    sd = get(f"https://cdn.espn.com/core/wnba/standings?xhr=1&season={season}")
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
    for nm, s in scoring.items():
        w, l = wl.get(nm, (0, 0)); g = w + l
        if g == 0: continue
        rows.append({"name": nm, "rec": f"{w}-{l}", "gp": g, "winpct": w/g, "ppg": s["ppg"], "oppppg": s["opp"], "pdg": s["ppg"] - s["opp"],
                     "ortg": s["ortg"], "drtg": s["drtg"], "nrtg": s["nrtg"]})
    if not rows:
        base.update({"status": "preseason", "odds_remaining": None, "note": "The WNBA tips off in May.", "teams": []}); return base
    # Backtest 2026-11-07 (30 champions, 1997-2026, Basketball-Reference season tables; scratchpad wnba_*.py):
    # - per-100 ratings replace per-game ones: the champion was top-6 in Def RATING 27/30 vs top-6 in Opp PPG only 21/30 (pace distorts).
    # - index = net rating alone: champion #1 22/30, avg #1.5, vs #1 17/30, avg #2.0 for the old Net 45 / Def 30 / Win% 25 blend.
    #   Net-only was the ONLY weighting that never lost a half (1997-2011, 2012-26) at season end or at the 75% mark; net rating
    #   already contains defense, so the separate defense/win% weights only diluted it.
    # - fair odds = softmax(0.32 x net rating): the old index^3 x tier with a 24% cap priced the favourite ~24% while the
    #   model's #1 won 20/30. Log-loss on the champion: 1.06 vs 1.82 old vs 2.02 equal odds; at the 75% mark 1.22 vs 2.08;
    #   better in both halves; b fit on 2012-26 only (0.32; the 1997-2011 era was chalkier). 2012-26: favourite priced ~57%, won 9/15.
    rk_pd = ranks(rows, "nrtg", True); rk_opp = ranks(rows, "drtg", False); rk_ppg = ranks(rows, "ortg", True)
    for t in rows:
        t["rk_pd"], t["rk_opp"], t["rk_ppg"] = rk_pd[t["name"]], rk_opp[t["name"]], rk_ppg[t["name"]]
        t["q"] = [t["winpct"] >= 0.680, t["rk_pd"] <= 4, t["rk_opp"] <= 6]   # Win% / Net rating top-4 / Def rating top-6
        t["score"] = sum(t["q"])
    nn = norm(rows, "nrtg", True)
    for t in rows: t["index"] = round(nn[t["name"]], 1)
    for t in rows: t["read"] = team_read(t, "wnba", len(rows), 3)
    # field: every team in-season; once every team has played its full schedule, the top 8 by record (the playoff field)
    done = min(t["gp"] for t in rows) >= SEASON_GAMES["wnba"]
    field = sorted(rows, key=lambda t: (-t["winpct"], -t["nrtg"]))[:8] if done else rows
    z = {t["name"]: math.exp(0.32 * t["nrtg"]) for t in field}; zs = sum(z.values())
    for t in rows:
        t["p"] = z.get(t["name"], 0) / zs if zs else 0
        t["fair_odds"] = american(t["p"]) if t["p"] else None
    attach(rows, [t for t in rows if t["p"] > 0], {})   # WNBA has no futures market
    pred = make_prediction(rows, 3)
    rows.sort(key=lambda t: (-t["score"], -t["index"]))
    base.update({"odds_remaining": None, "prediction": pred, "season_pct": season_pct(rows, "wnba"),
        "hist_off": done,   # (2026-11-07) the regular season is over -> the board can't change; daily snapshots only padded the streak badges all offseason
        "gp_min": min(t["gp"] for t in rows), "gp_max": max(t["gp"] for t in rows),
        "cats": ["Win% ≥.680", "Net rtg top-4", "Def rtg top-6"], "labels": ["Win%", "Net rtg", "Def rtg"],
        "teams": [{"name": t["name"], "rec": t["rec"], "score": t["score"], "index": t["index"],
            "q": [bool(x) for x in t["q"]],
            "vals": [f"{t['winpct']:.3f}", f"{t['nrtg']:+.1f} #{t['rk_pd']}", f"{t['drtg']:.1f} #{t['rk_opp']}"],
            "rtg": round(t["pdg"], 1),
            "fair_pct": round(t["p"]*100, 1) if t.get("p") else None, "fair_odds": t.get("fair_odds"),
            "market": t.get("market"), "ev": t.get("ev"), "verdict": t.get("verdict"), "read": t.get("read")} for t in rows if t["score"] >= 1 or t["p"] >= 0.01]})
    return base

def mlb_data(season):
    """Blueprint stats via CI-safe curl: statsapi (Win%/RunDiff/RBI/ERA, + pBABIP and DEF computed) joined
       by id with Baseball Savant OAA (the DRS metric). WAR is the one blueprint category with no curl-able
       source (FanGraphs is Cloudflare-blocked) — ERA stands in for it. /blueprint has the true 7 via Chrome."""
    try:
        st = get(f"https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season={season}&standingsTypes=regularSeason")
    except Exception:
        return {}
    by = {}
    for rec in st.get("records", []):
        for t in rec.get("teamRecords", []):
            tid = t["team"]["id"]; w = t.get("wins", 0); l = t.get("losses", 0); g = w + l
            if g == 0: continue
            by[tid] = {"name": t["team"]["name"], "w": w, "l": l, "gp": g, "winpct": w/g, "rd": t.get("runDifferential", 0), "oaa": None}
    for grp in ("hitting", "pitching", "fielding"):
        try:
            d = get(f"https://statsapi.mlb.com/api/v1/teams/stats?season={season}&group={grp}&stats=season&sportId=1")
            for s in d.get("stats", [{}])[0].get("splits", []):
                tid = s["team"]["id"]
                if tid not in by: continue
                stt = s["stat"]
                if grp == "hitting":
                    by[tid]["rbi"] = float(stt.get("rbi", 0) or 0)
                elif grp == "pitching":
                    by[tid]["era"] = float(stt.get("era", 9) or 9)
                    H, HR, SO, AB, SF = [float(stt.get(k, 0) or 0) for k in ("hits", "homeRuns", "strikeOuts", "atBats", "sacFlies")]
                    den = AB - SO - HR + SF; by[tid]["pbabip"] = round((H - HR)/den, 3) if den else 0.300
                elif grp == "fielding":
                    by[tid]["deff"] = float(stt.get("fielding", 0) or 0)
        except Exception:
            pass
    try:   # Baseball Savant Outs Above Average = DRS (the one external source; graceful if it fails)
        txt = get_text(f"https://baseballsavant.mlb.com/leaderboard/outs_above_average?type=Fielding_Team&year={season}&csv=true")
        lines = txt.strip().split("\n"); hdr = [h.strip('"') for h in lines[0].replace("﻿", "").split(",")]
        oi, ti = hdr.index("outs_above_average"), hdr.index("team_id")
        for ln in lines[1:]:
            c = ln.split(",")
            try: tid = int(c[ti].strip('"'))
            except Exception: continue
            if tid in by: by[tid]["oaa"] = float(c[oi])
    except Exception:
        pass
    return {v["name"]: v for v in by.values() if "era" in v and "rbi" in v}

def build_mlb():
    season = YEAR
    base = {"sport": "MLB", "season": str(season), "generated": now_iso()}
    data = mlb_data(season)
    if not data:
        base.update({"status": "preseason", "odds_remaining": None,
            "note": "MLB opens in late March — the blueprint goes live on the first games.", "teams": []})
        return base
    rows = [{"name": nm, "conf": "AL" if nm in MLB_AL else "NL", "rec": f"{d['w']}-{d['l']}", "gp": d["gp"],
             "winpct": d["winpct"], "rd": d["rd"], "rdg": d["rd"]/d["gp"], "rbi": d.get("rbi", 0), "era": d.get("era", 9),
             "pbabip": d.get("pbabip", 0.300), "deff": d.get("deff", 0), "oaa": d.get("oaa")} for nm, d in data.items()]
    oaa_rows = [t for t in rows if t["oaa"] is not None]; has_oaa = len(oaa_rows) >= 10
    rk_rd = ranks(rows, "rd", True); rk_rbi = ranks(rows, "rbi", True); rk_era = ranks(rows, "era", False)
    rk_pb = ranks(rows, "pbabip", False); rk_def = ranks(rows, "deff", True)
    rk_drs = ranks(oaa_rows, "oaa", True) if has_oaa else {}
    for t in rows:
        t["rk_rd"], t["rk_rbi"], t["rk_era"] = rk_rd[t["name"]], rk_rbi[t["name"]], rk_era[t["name"]]
        t["rk_pb"], t["rk_def"], t["rk_drs"] = rk_pb[t["name"]], rk_def[t["name"]], rk_drs.get(t["name"], 99)
        # Win% / RBI / RunDiff / ERA(≈WAR) / pBABIP / DEF / DRS(OAA)
        t["q"] = [t["winpct"] > 0.543, t["rk_rbi"] <= 11, t["rk_rd"] <= 10, t["rk_era"] <= 10,
                  t["rk_pb"] <= 17, t["rk_def"] <= 15, t["rk_drs"] <= 15]
        t["rk_runs"] = t["rk_rbi"]   # alias for team_read
        t["score"] = sum(t["q"])
    nrd = norm(rows, "rd", True); nrb = norm(rows, "rbi", True); ner = norm(rows, "era", False)
    npb = norm(rows, "pbabip", False); ndf = norm(rows, "deff", True); nw = norm(rows, "winpct", True)
    ndr = norm(oaa_rows, "oaa", True) if has_oaa else {}
    for t in rows:
        t["index"] = round(nrd[t["name"]]*.22 + ner[t["name"]]*.16 + ndr.get(t["name"], 50)*.14 + nrb[t["name"]]*.13
                           + nw[t["name"]]*.12 + npb[t["name"]]*.12 + ndf[t["name"]]*.11, 1)
    for t in rows: t["read"] = team_read(t, "mlb", len(rows), 7)
    pool = [t for t in rows if t["score"] >= 1]; tm = {7: 1.9, 6: 1.6, 5: 1.3, 4: 1.0, 3: 0.7, 2: 0.5, 1: 0.35}   # 1-2/7 board teams priced at the bottom of the ladder
    tot = sum((max(t["index"], 5)**3)/1e5*tm.get(t["score"], 0.5) for t in pool)
    for t in pool: t["p"] = ((max(t["index"], 5)**3)/1e5*tm.get(t["score"], 0.5))/tot if tot else 0
    cap_odds(pool, 0.18)   # MLB is low-chalk (huge playoff variance) -> let the field stay wide
    fd, rem = fetch_futures("baseball_mlb_world_series_winner")
    attach(rows, pool, fd)
    pred = make_prediction(rows, 7)
    rows.sort(key=lambda t: (-t["score"], -t["index"]))
    base.update({"odds_remaining": rem, "prediction": pred, "season_pct": season_pct(rows, "mlb"), "mlb_waronly": True,
        "gp_min": min(t["gp"] for t in rows), "gp_max": max(t["gp"] for t in rows),
        "cats": ["Win% >.543", "RBI top-11", "Run diff top-10", "ERA top-10 (≈WAR)", "pBABIP top-17", "DEF top-15", "DRS top-15"],
        "labels": ["Win%", "RBI", "Run diff", "ERA", "pBABIP", "DEF", "DRS"],
        "teams": [{"name": t["name"], "conf": t["conf"], "rec": t["rec"], "score": t["score"], "index": t["index"],
            "q": [bool(x) for x in t["q"]],
            "vals": [f"{t['winpct']:.3f}", f"{t['rbi']:.0f} #{t['rk_rbi']}", f"{t['rd']:+.0f} #{t['rk_rd']}", f"{t['era']:.2f} #{t['rk_era']}",
                     f"{t['pbabip']:.3f} #{t['rk_pb']}", f"{t['deff']:.3f} #{t['rk_def']}", (f"{t['oaa']:+.0f} #{t['rk_drs']}" if t['oaa'] is not None else "n/a")],
            "rtg": round(t["rdg"], 2),
            "fair_pct": round(t["p"]*100, 1) if t.get("p") else None, "fair_odds": t.get("fair_odds"),
            "market": t.get("market"), "ev": t.get("ev"), "verdict": t.get("verdict"), "read": t.get("read")} for t in rows if t["score"] >= 1]})
    return base

# ----------------------------------------------------------------------------- College basketball (men + women)
def build_college_bb(key):
    """Scoring lives in scripts/cbb.py (pandas). Men's market = FanDuel via the Odds API. The Odds API has no women's
       futures and the user doesn't use Kalshi (2026-11-06), so the women's market is the user's sportsbook screenshot in
       data/wcbb_fd.json (saved from the site's 📷 Update prices box, or by hand), shown while it's <= 14 days old."""
    import cbb as C
    fd_raw, rem, asof, alt_raw, mname, alt_name = {}, None, None, None, "FanDuel", None
    if key == "cbb":
        fd_raw, rem = fetch_futures("basketball_ncaab_championship_winner")
    else:
        snap = {}
        try: snap = json.load(open(os.path.join(DATA, "wcbb_fd.json"), encoding="utf-8"))
        except Exception: pass
        d0 = snap.get("date")
        if snap.get("odds") and d0 and (datetime.date.today() - datetime.date.fromisoformat(d0)).days <= 14:
            dd = datetime.date.fromisoformat(d0)
            fd_raw, asof, mname = snap["odds"], f"{dd:%b} {dd.day}", snap.get("book", "FanDuel")
    base = C.build(key, DATA, fd_raw, YEAR, alt_raw)
    base["generated"] = now_iso(); base["odds_remaining"] = rem; base["market_asof"] = asof
    base["market_name"] = mname; base["alt_name"] = alt_name
    if base.get("status") == "preseason": return base
    rows = base["teams"]
    for t in rows:
        t["fair_pct"] = round(t["p"] * 100, 1) if t["p"] else None; t["fair_odds"] = american(t["p"]) if t["p"] else None; t["read"] = None
    attach(rows, [t for t in rows if t["p"] > 0], {t["name"]: t["mk"] for t in rows if t.get("mk") is not None})
    top = max(rows, key=lambda t: t["p"]) if rows else None
    if top:
        src = "preseason roster projection" if base.get("use_pre") else "blueprint (index × fair odds)"
        conf = "" if not base.get("use_pre") else (" — lineup confirmed in real games" if top.get("confirmed") else " — lineup NOT yet confirmed in real games")
        base["prediction"] = {"pick": top["name"], "why": f"<b>{top['name']}</b> is the model's #1 by the {src} (fair {top['fair_odds']}){conf}."}
    base.update({"season_pct": season_pct(rows, key) if any(t["gp"] for t in rows) else 0,
                 "gp_min": min(t["gp"] for t in rows) if rows else 0, "gp_max": max(t["gp"] for t in rows) if rows else 0})
    for t in rows: t.pop("p", None)
    return base

def _mls_key(s):
    s = re.sub(r"[^a-z ]", " ", str(s).lower().replace("saint", "st"))
    return re.sub(r"\s+", " ", re.sub(r"\b(fc|sc|cf|the|united|city)\b", " ", s)).strip()

def build_mls():
    """MLS Cup board (added 2026-11-06, user: "Add MLS to the site blueprint"). The engine is Node: scripts/mls/soccer.mjs,
       copied from baseball-blueprint/pro. It fits Poisson team ratings (attack x defence x home edge, 240-day half-life)
       and runs 20,000 simulations of the remaining regular season plus the whole playoff bracket.
       Tiers = the every-champion profile: all 15 champions 2010-25 had all 5 at the start of the playoffs, and a hidden
       season's champion still did 11/15.
       Market: no odds feed has MLS Cup futures and the user doesn't use Kalshi, so it is the user's hand-entered DraftKings
       screenshot in data/mls_dk.json, shown while it is <= 14 days old."""
    import subprocess, tempfile
    out = os.path.join(tempfile.gettempdir(), "mls_export.json")
    subprocess.run(["node", os.path.join(HERE, "scripts", "mls", "soccer.mjs"), "mls", "--export", out], check=True, timeout=1500, stdout=subprocess.DEVNULL)
    E = json.load(open(out, encoding="utf-8"))
    # betting window (2026-11-07 fix): the engine now FREEZES the odds at the start of the playoffs (before, its sim ignored playoff results and
    # eliminated clubs kept their odds). Once a playoff match is played: EV only against a screenshot saved BEFORE the first playoff match of
    # this season, and no value play (the user never bets within the playoffs).
    stage = E.get("stage") or "regular"; closed = stage in ("playoffs", "done"); first = E.get("first_playoff")
    snap = {}
    try: snap = json.load(open(os.path.join(DATA, "mls_dk.json"), encoding="utf-8"))
    except Exception: pass
    asof = snap.get("date")
    d0 = datetime.date.fromisoformat(asof) if asof else None
    pre_px = bool(snap.get("odds")) and d0 is not None and bool(first) and d0.isoformat() < first and d0.year == int(E["season"])
    fresh = (not closed and bool(snap.get("odds")) and d0 is not None and (datetime.date.today() - d0).days <= 14) or (closed and pre_px)
    # index (2026-11-06): the engine's champion-weighted index -- Win% 25 · Overall 25 · Attack 20 · Form8 15 · Form5 15, each 0-100
    # across all teams (hidden-season test: champion's avg rank in the playoff field 2.7 vs 3.5 for the old overall-rating-only
    # index). Falls back to the overall rating scaled 0-100 if the export has no idx.
    smin, smax = min(t["str"] for t in E["teams"]), max(t["str"] for t in E["teams"])
    old_idx = lambda t: round(100 * (t["str"] - smin) / (smax - smin), 1) if smax > smin else 50.0
    rows = [{"name": t["name"], "conf": "East" if t["conf"] == "E" else "West", "rec": f"{t['w']}-{t['l']}-{t['d']} · {t['pts']} pts",
             "gp": t["gp"], "score": t["score"], "q": t["q"], "vals": t["vals"], "rtg": t["rtg"], "p": t["p"], "conf_pct": round(100 * t["pconf"], 1),
             "index": t["idx"] if t.get("idx") is not None else old_idx(t),
             "alive": t.get("alive"), "next": t.get("next"), "champion": bool(E.get("champion")) and t["name"] == E.get("champion"), "bet_ok": not closed} for t in E["teams"]]
    for t in rows:
        t["fair_pct"] = round(t["p"] * 100, 1) if t["p"] else None
        t["fair_odds"] = american(t["p"]) if t["p"] else None
        t["read"] = None
    fd = {}
    if fresh:
        keys = {_mls_key(t["name"]): t["name"] for t in rows}
        for nm, price in snap["odds"].items():
            k = _mls_key(nm)
            hit = keys.get(k) or next((v for kk, v in keys.items() if kk.startswith(k) or k.startswith(kk)), None)
            if hit: fd[hit] = int(price)
    attach(rows, [t for t in rows if t["p"] > 0], fd)
    for t in rows:   # a +EV price on a team that misses the every-champion profile is not a bet on this board
        v = t.get("verdict") or {}
        if t["score"] < 5 and v.get("kind") in ("value", "small", "longshot"):
            t["verdict"] = {"kind": "trap", "label": "fails profile", "ev": v.get("ev")}
    rows.sort(key=lambda t: (-t["score"], -t["p"]))   # tier first, then title odds (the order the cards show)
    top = max(rows, key=lambda t: t["p"])
    if closed:
        alive = [t["name"] for t in sorted(rows, key=lambda t: -t["p"]) if t.get("alive")]
        status = (f"<b>{E['champion']}</b> won MLS Cup {E['season']}." if stage == "done" and E.get("champion")
                  else f"Still alive: {', '.join(alive)}." if alive else "The playoffs are underway.")
        why = (f"{status} Going into the playoffs the model's #1 was <b>{top['name']}</b>: {top['fair_pct']}% to win MLS Cup (fair {top['fair_odds']}). "
               f"The betting window is closed: these fair odds are frozen at the start of the playoffs (you don't bet within the playoffs)"
               + (f"; EV is against the prices you saved before them ({d0:%b} {d0.day})." if fresh else ", so no EV is shown against in-playoff prices."))
    else:
        why = (f"<b>{top['name']}</b> is the model's #1: {top['fair_pct']}% to win MLS Cup (fair {top['fair_odds']}) and {top['conf_pct']}% to win the {top['conf']}. "
               + (f"{E['games_left']} regular-season games left are simulated, then the full bracket ({E['sims']:,} runs)." if E["games_left"]
                  else f"Seeding is final; the full bracket is simulated ({E['sims']:,} runs). Betting window open until the first playoff match."))
    base = {"sport": "MLS", "season": str(E["season"]), "generated": now_iso(), "cats": E["cats"], "labels": E["labels"], "teams": rows,
            "odds_remaining": None, "market_name": snap.get("book", "DraftKings"), "market_asof": f"{d0:%b} {d0.day}" if fresh else None,
            "games_left": E["games_left"], "sims": E["sims"], "stage": stage, "window_closed": closed, "first_playoff": first, "champion": E.get("champion"),
            "prediction": {"pick": top["name"], "why": why},
            "season_pct": 100 if closed else season_pct(rows, "mls"), "gp_min": min(t["gp"] for t in rows), "gp_max": max(t["gp"] for t in rows),
            "hist_off": stage == "done"}   # a finished board doesn't change -> no daily history (streaks would keep growing in the offseason)
    for t in rows: t.pop("p", None)
    return base

def _college_key(s):
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]", " ", str(s).lower().replace("&", "and"))).strip()

def build_fcs():
    """FCS national-title board (added 2026-11-06, user: "add fcs to site"). The engine is Node: scripts/college/run.mjs fcs, copied
       from baseball-blueprint/college (run.mjs + lib.mjs + fcs.mjs, keep in sync). ESPN FCS scoreboards (groups=81); every team's
       numbers come from game results (SRS, two-way adjusted offense/defense, RPI, win% vs the top teams).
       Tiers = the every-champion profile (all 15 champions 2010-25 cleared all 5 before the bracket). Index = SRS 30 · adj defense 20
       · RPI 20 · adj offense 15 · win% 15. Fair odds = tier x index^k, tuned on past seasons' boards as of the same date (the bracket
       model once the 24-team field is set); the plain-rating ("rating-only") odds ride along as a check.
       Verdict: PAPER -- at the bracket the #1 pick won 10/15, but 9 of those 10 were North Dakota State (now FBS).
       Market: no odds feed and no Kalshi -> the user's screenshot in data/fcs_book.json, if any, shown while <= 14 days old."""
    import subprocess, tempfile
    out = os.path.join(tempfile.gettempdir(), "fcs_export.json")
    subprocess.run(["node", os.path.join(HERE, "scripts", "college", "run.mjs"), "fcs", "--export", out], check=True, timeout=1500, stdout=subprocess.DEVNULL)
    E = json.load(open(out, encoding="utf-8"))
    snap = {}
    try: snap = json.load(open(os.path.join(DATA, "fcs_book.json"), encoding="utf-8"))
    except Exception: pass
    asof = snap.get("date")
    d0 = datetime.date.fromisoformat(asof) if asof else None
    # betting window (2026-11-07 fix): once a bracket game is played the engine FREEZES the board at the start of the bracket; EV then only vs a
    # screenshot dated before the first bracket game of this season, and no value play (the user never bets within the playoffs)
    stg = E.get("stage") or ("field" if E["field_known"] else "regular"); closed = stg in ("playoffs", "done"); first = E.get("first_playoff")
    pre_px = bool(snap.get("odds")) and d0 is not None and bool(first) and d0.isoformat() < first and d0.year == int(E["season"])
    fresh = (not closed and bool(snap.get("odds")) and d0 is not None and (datetime.date.today() - d0).days <= 14) or (closed and pre_px)
    if not E.get("teams"): raise RuntimeError(f"FCS engine returned no teams for {E.get('season')}")
    rows = [{"name": t["name"], "conf": "FCS", "rec": t["rec"], "gp": t["gp"], "score": t["score"], "q": t["q"], "vals": t["vals"],
             "index": t["idx"], "rtg": t["srs"], "p": t["p"], "alt_p": t["alt"], "alt_pct": round(100 * t["alt"], 1),
             "srsrank": t["r_srs"], "sosrank": t["r_sos"], "in_field": t["in_field"],
             "alive": t.get("alive"), "champion": bool(t.get("champion")), "bet_ok": not closed} for t in E["teams"]]
    for t in rows:
        t["fair_pct"] = round(t["p"] * 100, 1) if t["p"] else None
        t["fair_odds"] = american(t["p"]) if t["p"] else None
        t["read"] = None
    fd = {}
    if fresh:
        keys = {_college_key(t["name"]): t["name"] for t in rows}
        for nm, price in snap["odds"].items():
            k = _college_key(nm)
            hit = keys.get(k) or next((v for kk, v in keys.items() if kk.startswith(k) or k.startswith(kk)), None)
            if hit: fd[hit] = int(price)
    attach(rows, [t for t in rows if t["p"] > 0], fd)   # sets market/ev/verdict; SRS rank > 15 with +EV is tagged a trap (soft schedule)
    for t in rows:
        mk = t.get("mk")
        t["alt_ev"] = round((t["alt_p"] * ((1 + mk / 100) if mk > 0 else (1 + 100 / abs(mk))) - 1) * 100) if mk is not None and t["alt_p"] > 0 else None
        v = t.get("verdict") or {}
        if v.get("kind") in ("value", "small", "longshot") and t["score"] < 5:
            t["verdict"] = {"kind": "trap", "label": "fails profile", "ev": v.get("ev")}
        elif v.get("kind") in ("value", "small") and (t["alt_ev"] or -1) < 0:
            t["verdict"] = {"kind": "trap", "label": "rating disagrees", "ev": v.get("ev")}
    rows.sort(key=lambda t: (-t["score"], -t["p"]))   # tier first, then fair title odds
    top = max(rows, key=lambda t: t["p"])
    if closed:
        alive = [t["name"] for t in sorted(rows, key=lambda t: -t["p"]) if t.get("alive")]
        status = (f"<b>{E['champion']}</b> won the {E['season']} FCS title." if stg == "done" and E.get("champion")
                  else f"{len(alive)} teams still alive: {', '.join(alive[:6])}{' …' if len(alive) > 6 else ''}.")
        why = (f"{status} Going into the playoffs the model's #1 was <b>{top['name']}</b>: {top['fair_pct']}% to win the FCS title (fair {top['fair_odds']}). "
               f"The betting window is closed: these fair odds are frozen at the start of the bracket (you don't bet within the playoffs)"
               + (f"; EV is against the prices you saved before it ({d0:%b} {d0.day})." if fresh else ", so no EV is shown against in-playoff prices."))
    else:
        stage = (f"Field set ({E['field_size']} teams) — odds over the bracket only; betting window open until the first bracket game." if E["field_known"]
                 else "Pre-bracket: odds over every FCS team, tuned on past seasons' boards as of this date. The 24-team field is announced the Sunday before Thanksgiving.")
        why = (f"<b>{top['name']}</b> is the model's #1: {top['fair_pct']}% to win the FCS title (fair {top['fair_odds']}); "
               f"the plain power rating alone gives {top['alt_pct']}%. {stage}")
    base = {"sport": "FCS", "season": str(E["season"]), "generated": now_iso(), "cats": E["cats"], "labels": E["labels"], "teams": rows,
            "odds_remaining": None, "market_name": snap.get("book", "DraftKings"), "market_asof": f"{d0:%b} {d0.day}" if fresh else None,
            "field_known": E["field_known"], "stage": stg, "window_closed": closed, "first_playoff": first, "champion": E.get("champion"),
            "prediction": {"pick": top["name"], "why": why},
            "season_pct": 100 if closed else season_pct(rows, "fcs"), "gp_min": E["gp_min"], "gp_max": E["gp_max"],
            "hist_off": stg == "done"}   # a finished board doesn't change -> no daily history
    for t in rows:
        for k in ("p", "alt_p"): t.pop(k, None)
    return base

def build_cfl():
    """CFL Grey Cup board (added 2026-11-06, user: "add grey cup to site ... or cfl"). The engine is Node: scripts/college/cfl.mjs,
       copied from baseball-blueprint/college (keep in sync). It reads Wikipedia's raw standings templates and playoff bracket.
       Title odds = bracket simulation on points-per-game margin (home edge ~10.5, spread 16, fit on 17 seasons of playoff games) that
       respects every result already in (division finals, Grey Cup). Tiers = the every-champion profile (all 17 Grey Cup winners
       2008-25 had all 5).
       Market: the user's sportsbook screenshot in data/cfl_book.json (from the site's 📷 box or chat), shown while <= 14 days old.
       BETTING WINDOW (user 2026-11-07: "i want fair odds to be before playoffs. i never want to bet within the playoffs"):
       until a playoff result is in, this is the live pre-playoff board (fair odds + EV vs the screenshot). Once the playoffs are
       underway the fair odds are FROZEN at the start of the playoffs (the engine's --preplayoff run: the six-team field, results
       ignored) and no EV / value plays are computed. Cards still show who is alive and the next game.
       Backtest at the start of the playoffs (17 seasons, leave-one-out): bracket sim log-loss 1.51 vs coin flip 1.79, better in
       both halves (2008-16 1.33, 2017-25 1.71); 12 of 17 Grey Cup winners had a first-round bye. With four teams left it is a coin
       flip (2017-25 worse than one) -- the stage the user never bets."""
    import subprocess, tempfile
    eng = os.path.join(HERE, "scripts", "college", "cfl.mjs")
    out = os.path.join(tempfile.gettempdir(), "cfl_export.json")
    subprocess.run(["node", eng, "--export", out], check=True, timeout=1500, stdout=subprocess.DEVNULL)
    E = json.load(open(out, encoding="utf-8"))
    stage = E.get("stage")
    if not E.get("teams"): raise RuntimeError(f"CFL engine returned no teams for {E.get('season')} (stage {stage})")
    # stages: regular (no playoff field yet: tiers + index only, added 2026-11-07) | field (window open) | final4 / final / done (closed)
    closed = stage not in ("field", "regular")   # a playoff result is in -> the user's betting window is closed
    pre = {}
    if closed:
        outp = os.path.join(tempfile.gettempdir(), "cfl_export_pre.json")
        subprocess.run(["node", eng, "--preplayoff", "--export", outp], check=True, timeout=1500, stdout=subprocess.DEVNULL)
        pre = {t["name"]: t["p"] for t in json.load(open(outp, encoding="utf-8"))["teams"]}
    snap = {}
    try: snap = json.load(open(os.path.join(DATA, "cfl_book.json"), encoding="utf-8"))
    except Exception: pass
    asof = snap.get("date")
    d0 = datetime.date.fromisoformat(asof) if asof else None
    fresh = bool(snap.get("odds")) and d0 is not None and (datetime.date.today() - d0).days <= 14 and not closed
    rows = [{"name": t["name"], "conf": t["div"], "rec": f"{t['rec']} · {t['div']} #{t['place']}", "gp": t["gp"], "score": t["score"], "q": t["q"],
             "vals": t["vals"], "index": t["idx"], "rtg": t["mgn"], "p": pre.get(t["name"], 0) if closed else (t["p"] if t["alive"] else 0),
             "alive": t["alive"], "next": t["next"]} for t in E["teams"]]
    for t in rows:
        t["fair_pct"] = round(t["p"] * 100, 1) if t["p"] else None
        t["fair_odds"] = american(t["p"]) if t["p"] else None
        t["read"] = None
    fd = {}
    if fresh:
        keys = {_college_key(t["name"]): t["name"] for t in rows}
        for nm, price in snap["odds"].items():
            k = _college_key(nm)
            hit = keys.get(k) or next((v for kk, v in keys.items() if kk.startswith(k) or k.startswith(kk) or kk.split()[-1] == k.split()[-1]), None)
            if hit: fd[hit] = int(price)
    attach(rows, [t for t in rows if t["p"] > 0], fd)
    for t in rows:
        v = t.get("verdict") or {}
        if v.get("kind") in ("value", "small", "longshot") and t["score"] < 4:
            t["verdict"] = {"kind": "trap", "label": "fails profile", "ev": v.get("ev")}
    rows.sort(key=lambda t: (-t["p"], -t["score"], -t["index"]))   # by Grey Cup chance (frozen pre-playoff order once the playoffs start)
    top = max(rows, key=lambda t: (t["p"], t["index"]))
    nx = top.get("next") or {}
    if stage == "regular":
        why = (f"<b>{top['name']}</b> leads the index ({top['index']}). Grey Cup odds appear once the six-team playoff field is set — the model "
               f"simulates the bracket, not the rest of the regular season.")
    elif closed:
        alive = [t["name"] for t in rows if t["alive"]]
        status = (f"<b>{alive[0]}</b> won the {E['season']} Grey Cup." if stage == "done" and len(alive) == 1
                  else f"Still alive: {', '.join(alive)}.")
        why = (f"{status} Going into the playoffs the model's #1 was <b>{top['name']}</b>: {top['fair_pct']}% to win the Grey Cup "
               f"(fair {top['fair_odds']}). The betting window is closed: these fair odds are frozen at the start of the playoffs "
               f"(you don't bet within the playoffs), so no EV is shown against in-playoff prices.")
    elif stage == "done":
        why = f"<b>{top['name']}</b> won the {E['season']} Grey Cup."
    else:
        where = {"home": "hosts", "away": "at", "neutral": "vs"}.get(nx.get("site"), "vs")
        nxt = f" Next: {nx.get('round')} — {where} {nx.get('opp')}." if nx else ""
        why = (f"<b>{top['name']}</b> is the model's #1: {top['fair_pct']}% to win the Grey Cup (fair {top['fair_odds']}).{nxt} "
               f"Odds come from simulating the rest of the bracket on each team's scoring margin; results already played are locked in.")
    base = {"sport": "CFL", "season": str(E["season"]), "generated": now_iso(), "cats": E["cats"], "labels": E["labels"], "teams": rows,
            "odds_remaining": None, "market_name": snap.get("book", "FanDuel"), "market_asof": f"{d0:%b} {d0.day}" if fresh else None,
            "stage": stage, "window_closed": closed, "prediction": {"pick": top["name"], "why": why},
            "season_pct": season_pct(rows, "cfl"), "gp_min": min(t["gp"] for t in rows), "gp_max": max(t["gp"] for t in rows)}
    for t in rows: t.pop("p", None)
    return base

def build_nwsl():
    """NWSL board (added 2026-11-07, user: "add nwsl to the site"). Engine: scripts/mls/soccer.mjs (the same file as MLS, copied from
       baseball-blueprint/pro -- keep in sync), run with `nwsl --export`. Title odds = the playoff bracket simulated with Poisson attack x
       defence ratings (goals only: xG did not help NWSL knockouts, 2026-11-07 test). The engine has no rest-of-regular-season sim, so odds
       exist only once the bracket is set; they are FROZEN at the start of the playoffs (ratings fit on games before the first playoff
       match, results ignored) because the user never bets within the playoffs. Tiers = every-champion profile (all 8 clean champions
       2017-25 had all 5). Verdict: NOT bet-able. Market: data/nwsl_book.json (the user's screenshot via the 📷 box), used only while the
       betting window is open (bracket set, no playoff game played) and <= 14 days old."""
    import subprocess, tempfile
    out = os.path.join(tempfile.gettempdir(), "nwsl_export.json")
    subprocess.run(["node", os.path.join(HERE, "scripts", "mls", "soccer.mjs"), "nwsl", "--export", out], check=True, timeout=1500, stdout=subprocess.DEVNULL)
    E = json.load(open(out, encoding="utf-8"))
    stage = E.get("stage")
    closed = stage in ("playoffs", "done")
    snap = {}
    try: snap = json.load(open(os.path.join(DATA, "nwsl_book.json"), encoding="utf-8"))
    except Exception: pass
    asof = snap.get("date")
    d0 = datetime.date.fromisoformat(asof) if asof else None
    first = E.get("first_playoff")   # UTC date of the first playoff match
    pre_px = bool(snap.get("odds")) and d0 is not None and bool(first) and d0.isoformat() < first and d0.year == int(E["season"])   # prices taken BEFORE this season's playoffs (the year check, added 2026-11-07, keeps last year's screenshot off next year's frozen board)
    # EV only against pre-playoff prices: live while the window is open (<= 14 days old), and kept once the playoffs start so the
    # frozen board still shows what the value was going in (user 2026-11-07: "pull the nwsl odds i sent yesterday").
    fresh = (stage == "bracket" and bool(snap.get("odds")) and d0 is not None and (datetime.date.today() - d0).days <= 14) or (closed and pre_px)
    rows = [{"name": t["name"], "conf": f"seed {t['seed']}", "rec": f"{t['w']}-{t['d']}-{t['l']} · {t['pts']} pts", "gp": t["gp"], "score": t["score"],
             "q": t["q"], "vals": t["vals"], "index": t["idx"] if t["idx"] is not None else 0, "rtg": t["rtg"], "p": t["p"],
             "alive": t["alive"] if stage != "regular" else None, "next": t["next"], "seed": t["seed"],
             "bet_ok": stage == "bracket"} for t in E["teams"]]   # value play only while the window is open (bracket set, no playoff game yet)
    for t in rows:
        t["fair_pct"] = round(t["p"] * 100, 1) if t["p"] else None
        t["fair_odds"] = american(t["p"]) if t["p"] else None
        t["read"] = None
    fd = {}
    if fresh:
        keys = {_mls_key(t["name"]): t["name"] for t in rows}
        for nm, price in snap["odds"].items():
            k = _mls_key(nm)
            hit = keys.get(k) or next((v for kk, v in keys.items() if kk.startswith(k) or k.startswith(kk) or kk.split()[-1] == k.split()[-1]), None)
            if hit: fd[hit] = int(price)
    attach(rows, [t for t in rows if t["p"] > 0], fd)
    for t in rows:   # a +EV price on a team that misses the every-champion profile is not a bet on this board
        v = t.get("verdict") or {}
        if v.get("kind") in ("value", "small", "longshot") and t["score"] < 5:
            t["verdict"] = {"kind": "trap", "label": "fails profile", "ev": v.get("ev")}
    rows.sort(key=lambda t: (-t["p"], -t["score"], -t["index"]))
    top = max(rows, key=lambda t: (t["p"], t["index"]))
    if stage == "regular":
        why = (f"<b>{top['name']}</b> leads the index ({top['index']}). Title odds appear once the playoff bracket is set — this model "
               f"can't simulate the rest of the regular season yet.")
    elif not closed:
        nx = top.get("next") or {}
        where = {"home": "hosts", "away": "at", "neutral": "vs"}.get(nx.get("site"), "vs")
        nxt = f" First game: {nx.get('round')} — {where} {nx.get('opp')}." if nx else ""
        why = (f"<b>{top['name']}</b> is the model's #1: {top['fair_pct']}% to win the title (fair {top['fair_odds']}).{nxt} "
               f"Betting window open until the first playoff game.")
    else:
        alive = [t["name"] for t in rows if t.get("alive")]
        status = (f"<b>{alive[0]}</b> won the {E['season']} NWSL Championship." if stage == "done" and len(alive) == 1
                  else f"Still alive: {', '.join(alive)}.")
        why = (f"{status} Going into the playoffs the model's #1 was <b>{top['name']}</b>: {top['fair_pct']}% to win the title "
               f"(fair {top['fair_odds']}). The betting window is closed: these fair odds are frozen at the start of the playoffs "
               f"(you don't bet within the playoffs)" + (f"; EV is against the pre-playoff prices you saved ({d0:%b} {d0.day})." if fresh else ", so no EV is shown against in-playoff prices."))
    base = {"sport": "NWSL", "season": str(E["season"]), "generated": now_iso(), "cats": E["cats"], "labels": E["labels"], "teams": rows,
            "odds_remaining": None, "market_name": snap.get("book", "DraftKings"), "market_asof": f"{d0:%b} {d0.day}" if fresh else None,
            "stage": stage, "window_closed": closed, "prediction": {"pick": top["name"], "why": why},
            "season_pct": season_pct(rows, "nwsl"), "gp_min": min(t["gp"] for t in rows), "gp_max": max(t["gp"] for t in rows)}
    for t in rows: t.pop("p", None)
    return base

# ----------------------------------------------------------------------------- AFL / NRL / Super League (added 2026-11-07)
# User 2026-11-07: "Add NRL, AFL, super league to site." Engines are Node, copied from baseball-blueprint/pro (keep in sync):
# scripts/pro/afl.mjs (Squiggle API) and scripts/pro/rugby.mjs nrl|superleague (Rugby League Project results pages), + tiers.mjs.
# Same model in all three: team ratings from game margins (recency-weighted ridge regression, home edge split by travel),
# P(win) = Phi(margin / sigma); the rest of the regular season and the whole finals series are simulated (20,000 runs).
# Tiers = every-champion profile at the end of the regular season (study/criteria.mjs). The user never bets within the finals, so
# once a final is played the fair odds are FROZEN at the start of the finals and EV is only shown against prices saved before them.
# Preseason (no game played yet): odds = next season's whole fixture simulated from ratings that fade toward average (an untested
# stage -> no value play), tiers/index = last season's end-of-regular-season profile, ladder shown = last season's.
FOOTY = {
    "afl": {"sport": "AFL", "eng": ["afl.mjs"], "title": "premiership", "finals": "finals", "book": "afl_book.json",
            "alias": {"gws": "greater western sydney", "gws giants": "greater western sydney", "giants": "greater western sydney",
                      "sydney swans": "sydney", "swans": "sydney", "brisbane": "brisbane lions", "lions": "brisbane lions"}},
    "nrl": {"sport": "NRL", "eng": ["rugby.mjs", "nrl"], "title": "premiership", "finals": "finals", "book": "nrl_book.json",
            "alias": {"souths": "south sydney rabbitohs", "rabbitohs": "south sydney rabbitohs", "nz warriors": "new zealand warriors",
                      "warriors": "new zealand warriors", "st george": "st george illawarra dragons", "dragons": "st george illawarra dragons",
                      "manly": "manly warringah sea eagles", "sea eagles": "manly warringah sea eagles", "cronulla": "cronulla sutherland sharks",
                      "sharks": "cronulla sutherland sharks", "canterbury": "canterbury bankstown bulldogs", "bulldogs": "canterbury bankstown bulldogs",
                      "north queensland": "north queensland cowboys", "cowboys": "north queensland cowboys", "roosters": "sydney roosters",
                      "storm": "melbourne storm", "melbourne": "melbourne storm", "redcliffe dolphins": "dolphins"}},
    "superleague": {"sport": "Super League", "eng": ["rugby.mjs", "superleague"], "title": "Super League title", "finals": "play-offs",
                    "book": "superleague_book.json",
                    "alias": {"hull kr": "hull kingston rovers", "hkr": "hull kingston rovers", "saints": "st helens", "wigan": "wigan warriors",
                              "leeds": "leeds rhinos", "warrington": "warrington wolves", "catalans": "catalans dragons", "leigh": "leigh leopards",
                              "wakefield": "wakefield trinity", "salford red devils": "salford", "salford rlfc": "salford", "york": "york knights",
                              "huddersfield": "huddersfield giants", "castleford": "castleford tigers", "toulouse": "toulouse olympique",
                              "bradford": "bradford bulls"}},
}

def _footy_key(s):
    s = re.sub(r"[^a-z ]", " ", str(s).lower().replace("&", " and ").replace("-", " ").replace(".", ""))
    return re.sub(r"\s+", " ", re.sub(r"\b(fc|rlfc|club|the)\b", " ", s)).strip()

def _footy_match(raw, keys, alias):
    """Board name for a sportsbook name: exact, alias, prefix either way, then a nickname only one club has."""
    k = _footy_key(raw); k = alias.get(k, k)
    if k in keys: return keys[k]
    hits = [v for kk, v in keys.items() if len(k) >= 5 and (kk.startswith(k) or k.startswith(kk))]
    if len(hits) == 1: return hits[0]
    nick = k.split()[-1] if k else ""
    hits = [v for kk, v in keys.items() if len(nick) >= 4 and kk.split()[-1] == nick]
    return hits[0] if len(hits) == 1 else None

def _ordinal(n):
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"

def build_footy(key):
    import subprocess, tempfile
    C = FOOTY[key]
    out = os.path.join(tempfile.gettempdir(), f"{key}_export.json")
    subprocess.run(["node", os.path.join(HERE, "scripts", "pro", C["eng"][0]), *C["eng"][1:], "--export", out], check=True, timeout=1500, stdout=subprocess.DEVNULL)
    E = json.load(open(out, encoding="utf-8"))
    stage, Y, PY = E["stage"], E["season"], E["profile_season"]
    closed, pre = stage in ("finals", "done"), stage == "preseason"
    snap = {}
    try: snap = json.load(open(os.path.join(DATA, C["book"]), encoding="utf-8"))
    except Exception: pass
    d0 = datetime.date.fromisoformat(snap["date"]) if snap.get("date") else None
    first = E.get("first_final")
    # EV only against prices saved BEFORE the finals: live while the window is open (<= 14 days old); once the finals start, the frozen
    # board keeps the EV vs the last pre-finals screenshot of that season (the value going in), never vs in-finals prices
    pre_px = bool(snap.get("odds")) and d0 is not None and bool(first) and d0.isoformat() < first and d0.year == int(Y)
    fresh = (not closed and bool(snap.get("odds")) and d0 is not None and (datetime.date.today() - d0).days <= 14) or (closed and pre_px)
    rows = []
    for t in E["teams"]:
        rec = f"{t['w']}-{t['l']}" + (f"-{t['d']}" if t.get("d") else "") + f" · {t['pts']} pts"
        if key == "afl" and t.get("pct"): rec += f" · {t['pct']:.1f}%"
        elif t.get("gp"): rec += f" · {t['pf'] - t['pa']:+d}"
        if pre: rec = (rec + f" ({PY})") if t.get("gp") else f"new in {Y}"
        rows.append({"name": t["name"], "conf": (f"{PY}: " if pre else "") + _ordinal(t["pos"]) if t.get("pos") else None, "rec": rec,
                     "gp": t["gp"], "score": t["score"], "q": t["q"], "vals": t["vals"], "index": t["idx"] if t["idx"] is not None else 0,
                     "rtg": t["rtg"], "reg": t["reg"], "p": t["p"], "pos": t.get("pos"),
                     "minor_pct": round(100 * t["minor"], 1) if not closed and t.get("minor") else None,
                     "premier": bool(E.get("premier")) and t["name"] == E["premier"], "bet_ok": stage == "regular"})
    for t in rows:
        t["fair_pct"] = round(t["p"] * 100, 1) if t["p"] else None
        t["fair_odds"] = american(t["p"]) if t["p"] else None
        t["read"] = None
    fd = {}
    if fresh:
        keys = {_footy_key(t["name"]): t["name"] for t in rows}
        for nm, price in snap["odds"].items():
            hit = _footy_match(nm, keys, C["alias"])
            if hit: fd[hit] = int(price)
    attach(rows, [t for t in rows if t["p"] > 0], fd)
    for t in rows:   # +EV on a team the board's rule rules out is not a bet here (AFL/NRL: the 5/5 profile; Super League: a top-2 ladder spot)
        v = t.get("verdict") or {}
        if v.get("kind") in ("value", "small", "longshot"):
            if key in ("afl", "nrl") and t["score"] < 5: t["verdict"] = {"kind": "trap", "label": "fails profile", "ev": v.get("ev")}
            elif key == "superleague" and not (t.get("pos") or 99) <= 2: t["verdict"] = {"kind": "trap", "label": "outside top 2", "ev": v.get("ev")}
    rows.sort(key=lambda t: (-t["p"], -t["score"], -t["index"]))
    top = max(rows, key=lambda t: (t["p"], t["index"]))
    rank = {t["name"]: i + 1 for i, t in enumerate(rows)}
    title, fin = C["title"], C["finals"]
    if pre:
        why = (f"<b>{top['name']}</b> is the model's #1 for {Y}: {top['fair_pct']}% to win the {title} (fair {top['fair_odds']}). "
               f"Preseason projection — the whole {Y} fixture simulated from last season's ratings fading toward average (an untested stage, so no value play yet). "
               f"Tiers and index are {PY}'s end-of-season profile.")
    elif stage == "regular":
        why = (f"<b>{top['name']}</b> is the model's #1: {top['fair_pct']}% to win the {title} (fair {top['fair_odds']}). "
               f"{E['games_left']} regular-season games left are simulated, then the {fin} ({E['sims']:,} runs). Bet window open until the first final.")
    else:
        pm = next((t for t in rows if t.get("premier")), None)
        lead = (f"<b>{pm['name']}</b> won the {Y} {'Grand Final' if key != 'superleague' else 'Super League Grand Final'} — "
                f"{pm['fair_pct'] or 0}% (#{rank[pm['name']]}) on the model going into the {fin}. " if pm else f"The {fin} are underway. ")
        why = (lead + f"Going into the {fin} the model's #1 was <b>{top['name']}</b>: {top['fair_pct']}% (fair {top['fair_odds']}). "
               f"The betting window is closed: these fair odds are frozen at the start of the {fin} (you don't bet within the {fin})"
               + (f"; EV is against the prices you saved before them ({d0:%b} {d0.day})." if fresh else "."))
    gmin, gmax = E["gp_now"]
    base = {"sport": C["sport"], "season": str(Y), "generated": now_iso(), "cats": E["cats"], "labels": E["labels"], "teams": rows,
            "odds_remaining": None, "market_name": snap.get("book", "DraftKings"), "market_asof": f"{d0:%b} {d0.day}" if fresh else None,
            "stage": stage, "window_closed": closed, "profile_season": PY, "premier": E.get("premier"), "games_left": E["games_left"], "sims": E["sims"],
            "hfa2": E["hfa"], "sig": E["sig"], "prediction": {"pick": top["name"], "why": why},
            "season_pct": 100 if closed else round(100 * (gmin + gmax) / 2 / SEASON_GAMES[key]) if gmax else 0, "gp_min": gmin, "gp_max": gmax,
            "hist_off": pre or stage == "done"}   # a preseason / finished board doesn't change -> no daily history (streaks would grow in the offseason)
    for t in rows: t.pop("p", None)
    return base

def build_afl(): return build_footy("afl")
def build_nrl(): return build_footy("nrl")
def build_superleague(): return build_footy("superleague")

def build_cbb(): return build_college_bb("cbb")
def build_wcbb(): return build_college_bb("wcbb")

def main():
    os.makedirs(DATA, exist_ok=True)
    built = {}
    # per-board build status, kept across runs in index.json (2026-11-07: the NFL build crashed silently for a day and a half -- a failed league
    # just kept its old file). The site flags a board whose last refresh failed; the Action log gets a ::warning:: annotation.
    try: builds = json.load(open(os.path.join(DATA, "index.json"), encoding="utf-8")).get("builds") or {}
    except Exception: builds = {}
    for name, fn in [("nfl", build_nfl), ("cfb", build_cfb), ("nhl", build_nhl), ("nba", build_nba), ("wnba", build_wnba), ("mlb", build_mlb), ("cbb", build_cbb), ("wcbb", build_wcbb), ("mls", build_mls), ("fcs", build_fcs), ("cfl", build_cfl), ("nwsl", build_nwsl), ("afl", build_afl), ("nrl", build_nrl), ("superleague", build_superleague)]:
        if name not in LEAGUES:
            continue
        try:
            print(f"building {name}...")
            data = fn()
            if data.get("status") != "preseason" and data.get("gp_max") is not None:
                data["signal"] = signal_status(name, data["gp_max"])
                if data.get("stage") == "preseason":   # AFL / NRL / Super League before their first game
                    data["signal"] = {"status": "early", "emoji": "🔴", "label": "Preseason",
                                      "note": f"No {data['season']} games yet — the odds are a preseason projection (an untested stage) and the tiers are last season's profile. Don't bet the board until the season is underway."}
                elif data.get("window_closed"):   # (2026-11-07) playoffs under way / season over: "Trust the board — the read is actionable" contradicted the never-bet-in-the-playoffs rule
                    done = data.get("stage") == "done"
                    data["signal"] = {"status": "closed", "emoji": "🔒", "label": "Season over" if done else "Window closed",
                                      "note": ("The season is decided — the board shows the fair odds frozen at the start of the playoffs, for the record." if done else
                                               "The playoffs are under way — you never bet within them. The fair odds are frozen at the start of the playoffs; nothing here is a bet now.")}
                data["value_plays"] = value_plays(data.get("teams", []), len(data.get("cats", [])) or 4, name)
                crown_best_value(data.get("teams", []), data["value_plays"])
                if name not in ("cbb", "wcbb", "mls", "fcs", "cfl", "nwsl", "afl", "nrl", "superleague"): attach_beat_reads(name, data)   # LLM beat-reporter reads (no-op without ANTHROPIC_API_KEY); CBB has no reads
            with open(os.path.join(DATA, f"{name}.json"), "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            log_history(name, data)
            if data.get("status") == "preseason":
                built[name] = "preseason (no games yet)"
            else:
                built[name] = f"{len(data['teams'])} teams, GP {data['gp_min']}-{data['gp_max']}, odds_remaining={data.get('odds_remaining')}"
            builds[name] = {"ok": True, "at": now_iso()}
        except Exception as e:
            msg = f"{type(e).__name__}: {e}"
            print(f"  FAILED {name}: {msg}", file=sys.stderr)
            print(f"::warning title={name} build failed::{msg[:300]}")   # GitHub Actions annotation (shows on the run's summary page)
            built[name] = f"FAILED: {msg}"
            builds[name] = {"ok": False, "at": now_iso(), "error": msg[:300]}
    with open(os.path.join(DATA, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"sports": ["nfl", "cfb", "nhl", "nba", "wnba", "mlb", "cbb", "wcbb", "mls", "fcs", "cfl", "nwsl", "afl", "nrl", "superleague"], "generated": now_iso(),
                   "builds": builds}, f, indent=2)
    print("done:", json.dumps(built, indent=2))

if __name__ == "__main__":
    main()
