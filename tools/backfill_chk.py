"""Week-by-week history for the current college hockey season (2026-11-16, user: "update tier trajectory for college hockey").
The board joined the site on Nov 10, so its cards only had a week of history. The engine takes its date from BP_TODAY, so this
runs the site's own build (scripts/build.py build_chk -> scripts/college/run.mjs chk) as of each Sunday since the season began and
adds those snapshots in front of the bot's daily ones in data/history/chk.json. No prices for past weeks.
Usage: python -X utf8 tools/backfill_chk.py 2026-10-04 [--write]   (first Sunday to rebuild)"""
import sys, os, json, datetime
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "scripts")); os.environ.setdefault("ODDS_API_KEY", "")
import build as B
hp = os.path.join(HERE, "data", "history", "chk.json"); hist = json.load(open(hp, encoding="utf-8"))
first_bot = min(s["date"] for s in hist)
d = datetime.date.fromisoformat(sys.argv[1]); snaps = []
while d.isoformat() < first_bot:
    os.environ["BP_TODAY"] = d.isoformat()
    try:
        data = B.build_chk()
        T = data["teams"]; byp = sorted(T, key=lambda t: -(t.get("fair_pct") or 0))
        snaps.append({"date": d.isoformat(), "gp": data.get("gp_max"),
                      "teams": {t["name"]: {"sc": t["score"], "idx": t["index"], "fp": t.get("fair_pct"), "mkt": None, "ev": None} for t in T}})
        print(f"  through {d}  GP {data['gp_min']}-{data['gp_max']}  {len(T)} teams | top 5 by title odds: " + " · ".join(f"{t['name']} {t['fair_pct']}% ({t['score']}/5)" for t in byp[:5]))
    except Exception as e:
        print(f"  through {d}  no board ({type(e).__name__}: {str(e)[:90]})")
    d += datetime.timedelta(days=7)
os.environ.pop("BP_TODAY", None)
json.dump(snaps, open(os.path.join(HERE, "tools", "backfill_chk.json"), "w", encoding="utf-8"), indent=1)
if "--write" in sys.argv and snaps:
    json.dump(snaps + hist, open(hp, "w", encoding="utf-8"), indent=1)
    print(f"  wrote {len(snaps)} weekly snapshots in front of the bot's {len(hist)} daily ones")
