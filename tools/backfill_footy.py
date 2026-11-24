"""Week-by-week index history for boards built on build_footy (2026-11-24, user: "when adding to site, make sure all indexes are recorded
week by week"). EuroLeague, NBL, A-League and Liiga joined the site mid-season, so their cards had no trajectory. This replays the SITE'S
OWN board (build_footy -> the Node engine with BP_TODAY=<Monday>, which turns every later game into an unplayed fixture -- checked in each
engine's `check` mode) for every Monday from the season's first game to the last Monday before today, and stores one snapshot per week
(index, checks, fair %) marked backfill. No prices: weekly EV is not backfilled.
Usage: python -X utf8 tools/backfill_footy.py euroleague nbl aleague liiga [--write]   (--write merges into data/history/<key>.json)"""
import sys, os, json, datetime
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "scripts"))
os.environ.setdefault("ODDS_API_KEY", "")
import build as B

START = {"euroleague": "2026-09-29", "nbl": "2026-09-17", "aleague": "2026-10-17", "liiga": "2026-09-10",
         "afl": None, "nrl": None, "superleague": None}

def mondays(first, last):
    d = first + datetime.timedelta(days=(7 - first.weekday()) % 7 or 7)
    while d <= last:
        yield d; d += datetime.timedelta(days=7)

def run(key, write):
    today = datetime.date.today()
    first = datetime.date.fromisoformat(START[key]); last = today - datetime.timedelta(days=1)
    snaps = []
    for d in mondays(first, last):
        os.environ["BP_TODAY"] = d.isoformat()
        try: data = B.build_footy(key)
        except Exception as e: print(f"  {key} {d}: FAILED {e}"); continue
        if data.get("stage") in ("preseason",) or not data.get("teams"): print(f"  {key} {d}: {data.get('stage')} -- skipped"); continue
        s = {"date": d.isoformat(), "gp": data.get("gp_max"), "backfill": True,
             "teams": {t["name"]: {"sc": t["score"], "idx": t["index"], "fp": t.get("fair_pct"), "mkt": None, "ev": None} for t in data["teams"]}}
        top = max(data["teams"], key=lambda t: t.get("fair_pct") or 0)
        print(f"  {key} {d}: gp {s['gp']} · #1 {top['name']} {top.get('fair_pct')}% · idx#1 {max(data['teams'], key=lambda t: t['index'])['name']}")
        snaps.append(s)
    os.environ.pop("BP_TODAY", None)
    json.dump(snaps, open(os.path.join(HERE, "tools", f"backfill_{key}.json"), "w", encoding="utf-8"), indent=1)
    if write:
        hp = os.path.join(B.DATA, "history", f"{key}.json")
        try: hist = json.load(open(hp, encoding="utf-8"))
        except Exception: hist = []
        have = {s["date"] for s in snaps}
        merged = sorted([h for h in hist if h["date"] not in have] + snaps, key=lambda h: h["date"])
        json.dump(merged[-400:], open(hp, "w", encoding="utf-8"), indent=1)
        print(f"  {key}: {len(snaps)} weekly snapshots merged -> {hp} ({len(merged)} total)")

if __name__ == "__main__":
    keys = [a for a in sys.argv[1:] if not a.startswith("--")]
    for k in keys: run(k, "--write" in sys.argv)
