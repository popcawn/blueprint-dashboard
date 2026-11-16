"""Week-by-week history for a finished WNBA / MLB season (2026-11-16, user: "run the index trajectory back for the wnba and mlb seasons,
week by week over the course of the seasons"). Those two boards joined the site after their seasons ended, so their cards had no
trajectory. This rebuilds the board as of every Monday of the regular season with the SITE'S OWN build functions (scripts/build.py),
feeding them stats through that date only:
  WNBA  per-game box scores from ESPN (points, FGA, OREB, turnovers, FTA for both sides) -> per-100 ratings exactly as wnba_scoring()
  MLB   statsapi standings ?date= and team stats byDateRange (RBI, ERA, pBABIP parts, fielding %). Outs Above Average has no dated
        feed, so the season-final figure is used in every week (it is a rank / min-max input, so scaling it by the share of the
        season played would give the same result).
No prices: weekly EV is not backfilled. Output: tools/backfill_<sport>.json (list of history snapshots) + a printout.
Usage: python -X utf8 tools/backfill_history.py wnba|mlb|nfl [--write]   (nfl = weeks 1-5 only, see run_nfl)   (--write merges into data/history/<sport>.json)"""
import sys, os, json, datetime, urllib.request, time
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "scripts"))
os.environ.setdefault("ODDS_API_KEY", "")
import build as B
CACHE = os.path.join(os.environ.get("TEMP", "/tmp"), "bp_backfill"); os.makedirs(CACHE, exist_ok=True)
SEASON = 2026

def get(url, key=None):
    f = os.path.join(CACHE, key + ".json") if key else None
    if f and os.path.exists(f): return json.load(open(f, encoding="utf-8"))
    for i in range(4):
        try:
            d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=40)); break
        except Exception as e:
            if i == 3: raise
            time.sleep(1.5 * (i + 1))
    if f: json.dump(d, open(f, "w", encoding="utf-8"))
    return d

def mondays(first, last):
    d = first + datetime.timedelta(days=(7 - first.weekday()) % 7 or 7)   # first Monday after opening day
    while d <= last:
        yield d; d += datetime.timedelta(days=7)

def snap(date, data):
    return {"date": date.isoformat(), "gp": data.get("gp_max"),
            "teams": {t["name"]: {"sc": t["score"], "idx": t["index"], "fp": t.get("fair_pct"), "mkt": None, "ev": None} for t in data["teams"]}}

# ----------------------------------------------------------------------------- WNBA
def wnba_games():
    games = []; d = datetime.date(SEASON, 5, 1)
    while d <= datetime.date(SEASON, 9, 30):
        sb = get(f"https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates={d:%Y%m%d}&limit=100", f"wnba_sb_{d:%Y%m%d}")
        for e in sb.get("events", []):
            if (e.get("season") or {}).get("type") != 2 or not e["status"]["type"].get("completed"): continue
            comp = e["competitions"][0]
            if (comp.get("type") or {}).get("abbreviation") != "STD": continue   # not the Commissioner's Cup final or the All-Star game
            side = []
            try:
                s = get(f"https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/summary?event={e['id']}", f"wnba_g_{e['id']}")
                pts = {c["team"]["displayName"]: float(c["score"]) for c in s["header"]["competitions"][0]["competitors"]}
                for t in s["boxscore"]["teams"]:
                    st = {x["name"]: x["displayValue"] for x in t["statistics"]}
                    side.append({"team": t["team"]["displayName"], "pts": pts[t["team"]["displayName"]],
                                 "fga": float(st["fieldGoalsMade-fieldGoalsAttempted"].split("-")[1]), "oreb": float(st["offensiveRebounds"]),
                                 "tov": float(st["totalTurnovers"]), "fta": float(st["freeThrowsMade-freeThrowsAttempted"].split("-")[1])})
            except Exception:   # two 2026 games have no summary page: the core API still has their team box scores
                side = []
                for c in comp["competitors"]:
                    cs = get(f"https://sports.core.api.espn.com/v2/sports/basketball/leagues/wnba/events/{e['id']}/competitions/{e['id']}/competitors/{c['team']['id']}/statistics?lang=en&region=us", f"wnba_c_{e['id']}_{c['team']['id']}")
                    st = {x["name"]: x["value"] for cat in cs["splits"]["categories"] for x in cat["stats"]}
                    side.append({"team": c["team"]["displayName"], "pts": float(c["score"]), "fga": st["fieldGoalsAttempted"], "oreb": st["offensiveRebounds"],
                                 "tov": st["totalTurnovers"], "fta": st["freeThrowsAttempted"]})
            if len(side) == 2: games.append((d, side))
        d += datetime.timedelta(days=1)
    return games

def wnba_asof(games, day):
    """({team: scoring dict as wnba_scoring returns}, {team: (w, l)}) from games played on or before `day`."""
    tot = {}
    for d, (a, b) in games:
        if d > day: continue
        for me, op in ((a, b), (b, a)):
            t = tot.setdefault(me["team"], {"g": 0, "w": 0, "own": [0.0] * 5, "opp": [0.0] * 5})
            t["g"] += 1; t["w"] += me["pts"] > op["pts"]
            for i, k in enumerate(("pts", "fga", "oreb", "tov", "fta")): t["own"][i] += me[k]; t["opp"][i] += op[k]
    sc, wl = {}, {}
    for nm, t in tot.items():
        g = t["g"]; pos = lambda v: (v[1] - v[2] + v[3] + 0.44 * v[4]) / g; poss = (pos(t["own"]) + pos(t["opp"])) / 2
        ppg, opg = t["own"][0] / g, t["opp"][0] / g
        sc[nm] = {"ppg": ppg, "opp": opg, "poss": poss, "ortg": 100 * ppg / poss, "drtg": 100 * opg / poss, "nrtg": 100 * (ppg - opg) / poss}
        wl[nm] = (t["w"], g - t["w"])
    return sc, wl

def run_wnba():
    games = wnba_games(); first = min(d for d, _ in games); last = max(d for d, _ in games)
    print(f"WNBA {SEASON}: {len(games)} regular-season games, {first} to {last}")
    gp = {}
    for _, side in games:
        for x in side: gp[x["team"]] = gp.get(x["team"], 0) + 1
    print("  games per team:", sorted(gp.items(), key=lambda kv: kv[1]))
    B.wnba_postseason = lambda s: (None, None); B.preplayoff_book = lambda *a: ({}, {}, None)
    real_get = B.get; out = []
    for day in list(mondays(first, last)) + [last + datetime.timedelta(days=1)]:
        sc, wl = wnba_asof(games, day - datetime.timedelta(days=1))
        if min(w + l for w, l in wl.values()) < 3: continue   # a board on 1-2 games is noise
        B.cal_season = lambda f, sc=sc: (SEASON, sc)
        B.get = lambda url, timeout=50, wl=wl: {"entries": [{"team": {"displayName": n}, "stats": [{"name": "wins", "value": w}, {"name": "losses", "value": l}]} for n, (w, l) in wl.items()]}
        data = B.build_wnba(); B.get = real_get
        out.append((day, data))
    return out, last

# ----------------------------------------------------------------------------- MLB
def mlb_asof(day, oaa):
    st = get(f"https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season={SEASON}&date={day}&standingsTypes=regularSeason", f"mlb_st_{day}")
    by = {}
    for rec in st.get("records", []):
        for t in rec.get("teamRecords", []):
            w, l = t.get("wins", 0), t.get("losses", 0)
            if w + l: by[t["team"]["id"]] = {"name": t["team"]["name"], "w": w, "l": l, "gp": w + l, "winpct": w / (w + l), "rd": t.get("runDifferential", 0), "oaa": oaa.get(t["team"]["id"])}
    for grp in ("hitting", "pitching", "fielding"):
        d = get(f"https://statsapi.mlb.com/api/v1/teams/stats?season={SEASON}&group={grp}&stats=byDateRange&startDate={SEASON}-03-01&endDate={day}&sportId=1&gameType=R", f"mlb_{grp}_{day}")
        for s in d.get("stats", [{}])[0].get("splits", []):
            tid = s["team"]["id"]; x = s["stat"]
            if tid not in by: continue
            if grp == "hitting": by[tid]["rbi"] = float(x.get("rbi", 0) or 0)
            elif grp == "pitching":
                by[tid]["era"] = float(x.get("era", 9) or 9)
                H, HR, SO, AB, SF = [float(x.get(k, 0) or 0) for k in ("hits", "homeRuns", "strikeOuts", "atBats", "sacFlies")]
                den = AB - SO - HR + SF; by[tid]["pbabip"] = round((H - HR) / den, 3) if den else 0.300
            else: by[tid]["deff"] = float(x.get("fielding", 0) or 0)
    return {v["name"]: v for v in by.values() if "era" in v and "rbi" in v}

def run_mlb():
    full = B.mlb_data(SEASON); oaa = {}
    ids = {t["team"]["name"]: t["team"]["id"] for rec in get(f"https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season={SEASON}&standingsTypes=regularSeason", "mlb_st_final").get("records", []) for t in rec["teamRecords"]}
    for nm, v in full.items():
        if v.get("oaa") is not None: oaa[ids[nm]] = v["oaa"]
    sched = get(f"https://statsapi.mlb.com/api/v1/schedule?sportId=1&season={SEASON}&gameType=R", "mlb_sched")
    days = sorted(d["date"] for d in sched.get("dates", []) if any(g["status"].get("abstractGameState") == "Final" for g in d["games"]))
    first, last = datetime.date.fromisoformat(days[0]), datetime.date.fromisoformat(days[-1])
    print(f"MLB {SEASON}: regular season {first} to {last}; OAA (season-final) for {len(oaa)} teams")
    B.mlb_postseason = lambda s: (None, [], None); B.fetch_futures = lambda k: ({}, None); B.preplayoff_book = lambda *a: ({}, {}, None)
    out = []
    for day in list(mondays(first, last)) + [last + datetime.timedelta(days=1)]:
        data = mlb_asof((day - datetime.timedelta(days=1)).isoformat(), oaa)
        if not data or min(v["gp"] for v in data.values()) < 8: continue
        B.cal_season = lambda f, data=data: (SEASON, data)
        out.append((day, B.build_mlb()))
    return out, last

# ----------------------------------------------------------------------------- NFL
def run_nfl(weeks=(1, 2, 3, 4, 5)):
    """(2026-11-16, user: "4 weeks are missing from index traj. nfl") The bot's NFL history starts Oct 15 (after week 5, and that day only
    kept 9 teams), so the cards' trajectory had no weeks 1-4. This rebuilds the board after each of those weeks with build_nfl() itself:
    standings through that week from nflverse games.csv (the file the season sim already reads), and the season sim scored through that
    week (nfl_season_odds through_week). No prices. Each snapshot is dated the Tuesday after the week's Monday game."""
    import csv, io
    txt = B.get_text("https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv", timeout=60)
    reg = [g for g in csv.DictReader(io.StringIO(txt)) if g["season"] == str(SEASON) and g["game_type"] == "REG" and g["home_score"] not in ("", "NA")]
    name = {c: n for n, c in B.NFL_CODE.items()}
    real_st, real_sim = B.nfl_standings, B.nfl_season_odds
    B.fetch_futures = lambda k: (B.Prices(), None); B.fetch_game_lines = lambda *a, **k: (None, None); B.nfl_load_adjust = lambda *a, **k: {}
    out = []
    for w in weeks:
        st = {}
        for g in reg:
            if int(g["week"]) > w: continue
            hs, as_ = float(g["home_score"]), float(g["away_score"])
            for code, pf, pa in ((g["home_team"], hs, as_), (g["away_team"], as_, hs)):
                t = st.setdefault(name[code], {"wins": 0, "losses": 0, "ties": 0, "pointsFor": 0.0, "pointsAgainst": 0.0})
                t["pointsFor"] += pf; t["pointsAgainst"] += pa; t["wins" if pf > pa else "losses" if pf < pa else "ties"] += 1
        B.nfl_standings = lambda season, st=st: st if season == B.YEAR else real_st(season)
        B.nfl_season_odds = lambda year, w=w, **k: real_sim(year, through_week=w, games_csv=txt, **k)
        last = max(datetime.date.fromisoformat(g["gameday"]) for g in reg if int(g["week"]) == w)
        out.append((last + datetime.timedelta(days=1), B.build_nfl()))
    B.nfl_standings, B.nfl_season_odds = real_st, real_sim
    return out

def main_nfl():
    weeks = run_nfl(); hp = os.path.join(HERE, "data", "history", "nfl.json"); hist = json.load(open(hp, encoding="utf-8"))
    print(f"\n  {'dated':<11} {'GP':>4}  top 5 by index (index, tier)")
    for day, d in weeks:
        top = sorted(d["teams"], key=lambda t: -t["index"])[:5]
        print(f"  {day.isoformat():<11} {d['gp_min']}-{d['gp_max']}  " + " · ".join(f"{t['name'].split()[-1]} {t['index']} {t['score']}/5" for t in top))
    snaps = [snap(day, d) for day, d in weeks]
    # check: the bot's own first snapshot (Oct 15, before the week-6 Thursday game) must equal the rebuilt week 5 for the teams it kept
    first = next(x for x in hist if x["date"] >= "2026-10-15")
    bad = [(n, v["idx"], snaps[-1]["teams"][n]["idx"], v["sc"], snaps[-1]["teams"][n]["sc"]) for n, v in first["teams"].items()
           if abs(v["idx"] - snaps[-1]["teams"][n]["idx"]) > 0.11 or v["sc"] != snaps[-1]["teams"][n]["sc"]]
    print(f"  check vs the bot's {first['date']} snapshot ({len(first['teams'])} teams): " + ("index and tier match on every team" if not bad else f"MISMATCH {bad}"))
    json.dump(snaps, open(os.path.join(HERE, "tools", "backfill_nfl.json"), "w", encoding="utf-8"), indent=1)
    if "--write" in sys.argv:
        if bad: sys.exit("  not written: the rebuilt week 5 does not match the bot's own snapshot")
        new = {x["date"] for x in snaps}
        merged = sorted([x for x in hist if x["date"] not in new] + snaps, key=lambda x: x["date"])
        json.dump(merged, open(hp, "w", encoding="utf-8"), indent=1)
        print(f"  wrote {len(merged)} snapshots to data/history/nfl.json (was {len(hist)})")

# ----------------------------------------------------------------------------- report + merge
def main():
    if sys.argv[1] == "nfl": return main_nfl()
    sport = sys.argv[1]; champ = {"wnba": "Golden State Valkyries", "mlb": "Brewers"}[sport]
    weeks, last = run_wnba() if sport == "wnba" else run_mlb()
    print(f"\n  {'through':<11} {'GP':>7}  champion: rank by index / title odds   index  fair %   tier | board #1 by title odds")
    for day, d in weeks:
        T = d["teams"]; byi = sorted(T, key=lambda t: -t["index"]); byp = sorted(T, key=lambda t: -(t.get("fair_pct") or 0))
        c = next((t for t in T if t["name"] == champ), None); mx = len(d["cats"])
        thru = (day - datetime.timedelta(days=1)).isoformat()
        if c: print(f"  {thru:<11} {d['gp_min']:>3}-{d['gp_max']:<3}  {champ.split()[-1]:<10} #{byi.index(c) + 1:<2} / #{byp.index(c) + 1:<2}                   {c['index']:>5}  {c.get('fair_pct') or 0:>5}   {c['score']}/{mx}  | {byp[0]['name']} {byp[0].get('fair_pct')}%")
        else: print(f"  {thru:<11} {d['gp_min']:>3}-{d['gp_max']:<3}  {champ.split()[-1]} not on the board | {byp[0]['name']} {byp[0].get('fair_pct')}%")
    snaps = [snap(day - datetime.timedelta(days=1), d) for day, d in weeks]
    json.dump(snaps, open(os.path.join(HERE, "tools", f"backfill_{sport}.json"), "w", encoding="utf-8"), indent=1)
    if "--write" in sys.argv:
        hp = os.path.join(HERE, "data", "history", f"{sport}.json"); hist = json.load(open(hp, encoding="utf-8"))
        cur = json.load(open(os.path.join(HERE, "data", f"{sport}.json"), encoding="utf-8"))
        # the last point = the frozen board on the site (it carries the pre-playoff prices), dated at the last regular-season day
        final = {"date": last.isoformat(), "gp": cur.get("gp_max"),
                 "teams": {t["name"]: {"sc": t["score"], "idx": t["index"], "fp": t.get("fair_pct"), "mkt": t.get("market"), "ev": t.get("ev")} for t in cur["teams"]}}
        merged = []
        for sn in [x for x in snaps if x["date"] < final["date"]] + [final]:
            if merged and merged[-1]["teams"] == sn["teams"]: continue   # a week with no games (the September break) adds nothing
            merged.append(sn)
        json.dump(merged, open(hp, "w", encoding="utf-8"), indent=1)
        print(f"  wrote {len(merged)} snapshots to data/history/{sport}.json (was {len(hist)} offseason copies of the final board)")

if __name__ == "__main__":
    main()
