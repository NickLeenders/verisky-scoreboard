# VeriSky Scoreboard

A static web scoreboard that ranks weather models (IFS, AIFS, GFS, ICON) by how
accurate their forecasts turned out to be over the last 30 days. All data comes
from Open-Meteo. There's no build step, no server, and no framework, just ES
modules and plain HTML and CSS.

## Running it

You need a static file server, because browsers won't load ES modules over
`file://`. Anything will do:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000.

On a cold start the page fetches from Open-Meteo and scores everything in the
browser, so give it a moment. Results are cached in localStorage for about six
hours, so reloads are instant.

You can also run the scoring outside the browser with Node 18+:

```sh
node scripts/smoke.mjs amsterdam   # score one city and print the standings
node scripts/bake.mjs              # score all preset cities, write data/*.json
```

`bake.mjs` is optional. It precomputes the standings into `data/` and injects
them into `index.html` so a fresh visit shows real numbers right away instead of
loading skeletons. The page works fine without it.

## Long-term trends (`history.html`)

`history.html` charts how each model's error has moved over its **full**
previous-runs archive (up to ~5 years for GFS), one calendar month at a time —
the "have the models degraded?" view. It covers **every default city with its
full model roster** (a city selector switches between them), each model reaching
back as far as its archive allows. It reads a small baked JSON per city and is
generated separately from the daily bake:

```sh
node scripts/history-backfill.mjs                    # full backfill → data/history/newyork.json
node scripts/history-backfill.mjs --months=2025-05:2025-06   # smoke a short range
node scripts/history-backfill.mjs --dry-run          # print planned fetches, write nothing
node scripts/history-backfill.mjs --offline          # re-bake from cache only, no network
```

How it works and how to maintain it:

- Fetches one request per model per **complete** calendar month (all variables ×
  leads) from the previous-runs API, plus a matching `best_match` truth chunk
  from the historical-forecast API. Scoring reuses `js/align.js` + `js/score.js`
  unchanged, so a monthly bucket is scored just like the live 30-day window.
- Raw API responses are cached under `data/history-cache/` (gitignored).
  Complete months never change, so reruns are incremental and fully offline —
  the first full run is ~200 calls (well within Open-Meteo's free tier);
  later runs only fetch the newly-completed month.
- Output `data/history/<city>.json` (one per city) **is committed** (the `data/`
  dir is otherwise gitignored; `.gitignore` carves out `data/history`). GitHub
  Pages ships them as-is, so the daily CI bake is untouched.
- **To refresh:** run the full command on/after the 2nd of a new month and
  commit the updated JSON files. That's the only maintenance step.

Model selection is the city's live `resolveRoster(city)` (`js/history-config.js`);
per-model archive starts live in `HISTORY_START_HINTS`, clamped to
`HISTORY_FLOOR_MONTH` (2021). Models with no data at a location are dropped
automatically; HRRR is excluded structurally (it duplicates GFS at short lead).

### URL parameters

- `?city=tokyo` loads a preset city
- `?name=Utrecht&lat=52.09&lon=5.12` loads any location by coordinates
- `&lab=ecmwf_ifs025` opens a specific model's detail row on load



## Notes on the scoring

- Every model is checked against the same observed series (`best_match`), never
  against its own analysis.
- The headline number weights the nearer lead days more heavily (1/day), then
  scales by how many days the model actually covers. A short-range model can
  still score well at day 1–2, while longer-range models get credit for covering
  more of the table.
- The ▲▼ movement compares today's ranking to the ranking from a week ago.
- Rain win/loss and the form dots only look at next-day (day 1) forecasts. A
  form dot fills when that day's skill is 70 or higher.
