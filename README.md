# Championship Blueprint — dashboard

A static web UI for the NFL & CFB title blueprints. A GitHub Actions bot pulls live data
(ESPN, free) plus FanDuel futures (The Odds API), computes the boards, and commits `data/*.json`;
the static page renders tier cards, fair odds, live EV, and (for CFB) the SOS-weighted odds +
SRS reality-check column. Same pattern as the UFC / TD / NBA-prop apps — bot commits JSON, Pages serves it.

## What it shows
- **Tier cards** (5/5 → longshot) with the qualifying-category grid (green chip = qualifies).
- **Fair odds** (model), **FanDuel** market, and **EV** (green = value, red = fade).
- **CFB only:** SOS-weighted fair odds (exponent 3, backtested: champion = model #1 in 5/5 seasons),
  a display-only **SRS reality-check** column (⚑ = schedule-flattered mirage; every real champion was SRS top-6),
  and a **gauntlet watch** (elite schedule-adjusted teams the blueprint zeroes).
- Small-sample warnings early in the season.

## Deploy (one-time)
1. Create a GitHub repo (e.g. `blueprint-dashboard`) and push these files.
2. **Add the Odds API key** as a secret: repo → *Settings → Secrets and variables → Actions → New repository secret*
   → name `ODDS_API_KEY`, value = your key (the same one in `nfl-td-predictor/.odds-key`).
   *(Without it the board still builds — just with no market/EV columns.)*
3. **Enable Pages:** repo → *Settings → Pages → Source: Deploy from a branch → `main` / root*.
4. The site is live at `https://<user>.github.io/blueprint-dashboard/`.
5. Run the bot once: *Actions → Refresh blueprint data → Run workflow* (or wait for the Tue/Sat cron).

## Local dev
```bash
# generate data (ODDS_API_KEY optional)
ODDS_API_KEY=xxxx python scripts/build.py
# serve (file:// blocks the JSON fetch, so use a server)
python -m http.server 8777
# open http://127.0.0.1:8777/index.html
```

## Data sources (all pure `curl` — no browser, CI-safe)
- **NFL:** ESPN standings (`cdn.espn.com/core/nfl/standings`).
- **CFB:** ESPN byteam stats + standings + weekly scoreboards (for SOS & SRS).
- **NHL:** MoneyPuck season CSV (`moneypuck.com/.../seasonSummary/<year>/regular/teams.csv`) — 5v5 Corsi, GF/GA,
  shots/saves (for ES save%). This replaced the Cloudflare-walled Natural Stat Trick, so **no Playwright needed.**
- **Futures:** The Odds API `outrights` market, FanDuel book. Reports `x-requests-remaining`.

## Views & sports
- **⭐ Best EV (default view):** scans every sport's board and ranks the *actionable* +EV plays, pushes early-season
  NHL/NBA noise into a separate "ignore" bucket, lists biggest fades, and filters out CFB schedule-mirages.
- **Per-sport tabs:** each category chip is labelled with its stat (e.g. `Pt Diff +61 #1`), green = qualifies.
- **Live:** NFL, CFB, NHL.
- **NBA:** scaffolded; shows a preseason placeholder until the regular season tips off (~late Oct), then auto-populates.
  Source = ESPN standings (win%) + ESPN byteam (PPG/Opp PPG); the exact scoring field mapping should be verified on
  the first real run. Categories: Win% ≥.600 · Net/g top-5 · PPG top-10 · Opp PPG top-10 (chalkiest sport → top team uncapped-ish).
- **MLB — deferred:** FanGraphs inputs (WAR / pBABIP / DRS) are Cloudflare-blocked with no clean curl source,
  *and* the 2026 regular season is over (nothing live until spring 2027). Engine logic already exists in the `/blueprint` command.

## Refresh schedule
`.github/workflows/refresh.yml` runs Tue & Sat 14:00 UTC in-season, plus manual dispatch.
Each run costs ~1 Odds-API credit per sport (3/run now).
