# VeriSky Scoreboard

A static web scoreboard that ranks public and commercial weather models by how
accurate their forecasts turned out to be over the last 30 days. Public-model
data comes from Open-Meteo; preset cities add server-computed aggregate scores
for Apple Weather, OpenWeatherMap, WeatherAPI, Visual Crossing, and Foreca.
Models are ranked on the app's **score v2** — a tolerance hit rate plus an
extreme-event score rather than RMSE, so a forecast cannot climb the table by
hedging toward an average (see [Score model v2](#score-model-v2-the-anti-blur-score)).
There's no
build step or framework, just ES modules and plain HTML and CSS.

## Running it

You need a static file server, because browsers won't load ES modules over
`file://`. Anything will do:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000.

On a cold start the page fetches from Open-Meteo and scores everything in the
browser, so give it a moment. Results are cached in localStorage for about six
hours, so reloads are instant. For the preset cities it also reads a small
aggregate-only scoreboard from `api.verisky.app`; custom locations remain
public-model-only.

### Airport boards (the ✈ City ⇄ Airport toggle)

Most preset cities have an **airport twin**: the same board re-scored at the
city's main airport, whose METAR weather station reports real instrument
readings around the clock. The topbar's City ⇄ Airport toggle switches between
them (unavailable views are greyed out), a banner above the standings
names the station (e.g. *Schiphol (EHAM)*), and `?city=london&site=airport` is
the shareable URL form. On airport boards the server verifies **temperature and
wind against the station's own METAR observations** instead of the model
analysis; rain keeps the analysis. The server publishes them as
`/scoreboard/v1/<city>-airport.json` (same shape as the city boards plus a
`station: { icao, name }` field), and the bake writes matching
`data/<city>-airport.json` payloads plus `scores.json` entries. Airport
metadata lives on each city in `js/config.js` (`airport: { icao, name, lat,
lon }`); coordinates must match the server's airport presets the same way city
coordinates must. Chicago, Mexico City and Sydney's city boards already sit on
their airport's grid cell (`sameCell: true`), so their two views read the same
measurement point.

The UK presets also include Cambridge (city and EGSC airport), Southampton
(EGHI airport only), and Sumburgh (EGPB airport only). Airport-only presets open
in Airport mode, disable City, and bake only their `-airport` payload. Custom
searched locations disable Airport. Lisbon (LPPT), Seattle (KSEA), and Phoenix
(KPHX) are also airport-only presets. Southampton, Seattle, and Phoenix use
model analysis rather than METAR truth; their station banners identify this.
Airport-only locations are excluded from the city-only long-term history page.

You can also run the scoring outside the browser with Node 18+:

```sh
node scripts/check.mjs                     # offline checks (scoring math, breakdown, payload)
node scripts/smoke.mjs amsterdam           # score one city and print the standings
node scripts/smoke.mjs amsterdam-airport   # same pipeline at the airport station
node scripts/bake.mjs                      # score all preset cities + airports, write data/*.json
```

`check.mjs` needs no network and runs in CI before the bake. It covers the
score-v2 math (SEDI edge cases, the event gate folding back, the rain sample
gate, a double-penalty fixture where a blurred forecast wins RMSE and loses the
v2 score), the breakdown block's "null draws nothing, zero draws an empty
track" rule, the lead-time grid's ranking rules (short-horizon models can win a
column but not the average) and its absolute colour bands, and the server
payload's dual-score hydration in both directions.

`bake.mjs` is optional. It precomputes the standings into `data/` and injects
them into `index.html` so a fresh visit shows real numbers right away instead of
loading skeletons. The page works fine without it.

### Commercial score boundary

The browser never receives full commercial forecasts or provider credentials.
`/scoreboard/v1/<preset>.json` accepts only the compiled-in preset slugs (each
city plus its `<city>-airport` twin) and
returns stored aggregate scores (standings, form, rain record, and per-lead
skill). It accepts no coordinates, model ids, provider ids, or run selectors,
does not trigger a score refresh or provider request, and excludes AccuWeather.
Daily Compare uses the same fixed-preset route with `?compare=YYYY-MM-DD&lead=1`.
This separate response contains only the requested day's temperature maximum
(°C), wind maximum (km/h), rain total (mm), and wet-hour ranges (0–23), with
model IDs and date/lead/timezone metadata. It accepts completed days within the
last 30 days and leads 1–7, rejects extra selectors, and reads one stored run
per provider nearest 06:00 local on the issue day (within that day's 00:00–12:00
window). It makes no upstream requests. The server caches summaries for 15
minutes; the browser keeps them in memory only, outside localStorage and bakes.
Missing/partial readings remain unavailable. AccuWeather stays excluded.
Commercial hourly forecast-vs-observed lab charts remain unavailable.

### Daily Compare

The Compare card follows VeriSky's Verify readouts: shared number lines for
daily maximum temperature and wind, plus rain timing lanes. Select up to five
models (including commercial providers on preset boards), any completed day in
the loaded 30-day window, and a forecast
lead from one to seven days. The three highest-ranked models in the displayed
standings with daily data are selected automatically, updating with refreshed
rankings until you make a manual pick. Date arrows step through available days;
the dropdown jumps directly to a date. Unit changes and background refreshes
keep manual selections; changing location resets to the new location's top three.

This archive supplies previous-day lead buckets, not the app's exact run-time
slider. It contains temperature, wind and rain, so the app's sky comparison is
not shown. Green marks are the scoreboard's observation-fed analysis, including
on airport boards; airport METAR truth applies only to server aggregate scores.
Daily highs need at least 20 valid hours; rain totals and timing require a full
24-hour local-clock series. Missing readings are labelled rather than treated
as dry weather. Rain timing uses the app's 0.2 mm threshold and ±1 hour match.

## Score map (`map.html`)

The **Score map** link opens an edge-to-edge world map, also linked from Model
trends. It carries the selected board location across, with shareable map centre,
zoom, metric and window in the URL. Choose Overall, Temperature, Rain, Wind or
Sun and a 7/14/30/60/90-day lookback (30 days by default). The app's feathered
winner overlay, model colours, OpenFreeMap basemap and airport markers are
ported from `VeriSky/src/components/map/modelMapHtml.ts`.

Tap a grid location for the top two models from the same stored winner planes
that paint the map; these scores are quantized in 0.4-point steps. Tap an airport
for its top four models. Grey areas are within one point of a tie. The legend
shows area-weighted shares of the visible map; Blend remains a separate footnote.
Airport popups link to their existing preset board when available; grid popups
link to a custom-location board (whose client-scored roster/window can differ).

The page fetches **aggregate data only**, without an app token, from three exact
public routes on `api.verisky.app`: `/scoreboard/map/grid?window=&metric=`,
`/scoreboard/map/stations?window=`, and
`/scoreboard/map/point?window=&metric=&lat=&lon=`. These routes are handled by
`/srv/openmeteo/dashboard/src/public-map.js`, with the Caddy exact-path allowlist
in `/srv/openmeteo/caddy/Caddyfile`. Point lookups read five bytes from the
existing map raster; they never call the scorer or a forecast provider. The
routes validate their selectors, exclude AccuWeather, and are rate limited.
Nothing needs baking into this repository for the map to stay current.

Map libraries are vendored under `vendor/map` so the page needs no library CDN
at runtime. The basemap still fetches OpenFreeMap tiles. Run
`node scripts/check-map.mjs` for the binary-contract, geographic-boundary and
navigation checks (also run in CI).

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
- `?city=tokyo&site=airport` loads that city's airport weather-station board
- `?name=Utrecht&lat=52.09&lon=5.12` loads any location by coordinates
- `&lab=ecmwf_ifs025` opens a specific model's detail row on load

Both pages automatically use Fahrenheit, mph and inches for US locations, and
Celsius, km/h and mm elsewhere, including when opening a location link directly.
The unit toggle overrides this for the current location; selecting another
location restores its country default. Switching between a city's city and
airport boards keeps the manual choice. Custom location links carry their
`country` code from search; links without one default to metric.


## Notes on the scoring

- Every model is checked against the same reference series: `best_match` with
  `past_days`. For past hours this is the highest-resolution model at the
  location at lead zero, i.e. an observation-fed analysis (a model
  reconstruction of the observed weather), not raw station readings. The
  methodology footer on the page spells out the caveats.
- The headline number weights the nearer lead days more heavily (1/day), then
  scales by how many days the model actually covers. A short-range model can
  still score well at day 1–2, while longer-range models get credit for covering
  more of the table.
- The ▲▼ movement compares today's ranking to the ranking from a week ago.
- Rain win/loss and the form dots only look at next-day (day 1) forecasts. A
  form dot fills when that day's skill is 70 or higher.

### "Skill by lead time" — the two views

The card carries the app's two views over the same per-lead numbers, and the
**grid is the default**. A preset board carries thirteen models; one line each is
thirteen lines through the same few points of vertical space, and no palette
separates them — the curve view could show the shape of the decay but never
answer "who do I trust three days out".

- **Grid** (`js/leadTimeGrid.js`) — models × lead-days, cell brightness = score.
  Bands are absolute (`RAMP_BREAKS`: 50/60/70/80 for temperature and wind,
  30/40/50/60 for rain, 45/55/65/75 for the combined skill), so a cell means the
  same thing on every board and two cities can be compared by eye. Column headers
  sort by that lead day; `avg` (or a second click) returns to the average, which
  ranks full-coverage models above short-horizon ones and mutes the average of any
  row that doesn't reach every column. `123` prints the numbers in the cells.
- **Curves** (`leadTimeChart` in `js/charts.js`) — every model drawn, at most
  `LEAD_FOCUS_LIMIT` (4) coloured, the rest in one context gray; coloured lines
  are labelled where they end, and hovering the chart puts a crosshair on a lead
  day with the top three at that horizon above it. Picking a fifth model drops the
  oldest pick rather than doing nothing.

The chosen view persists in `localStorage` (`verisky.leadView`). Both views read
`buildLeadSeries` from `js/derive.js`, so they cannot disagree, and the grid's
average ranking is what the curve view colours by default.

### Score model v2 (the anti-blur score)

Since **2026-08-17** the headline is the VeriSky app's **score v2**, matching
the app release (`docs/design/score-v2.md` in the app repo). Temperature and
wind are no longer RMSE: each is `0.7 · Accuracy + 0.3 · Extremes`.

- **Accuracy** — share of hours inside a tolerance band (2 °C; wind
  `max(5 km/h, 20%)`). Beyond the band, a 3 °C miss and a 9 °C miss cost the
  same, so hedging toward the mean stops buying points.
- **Extremes** — SEDI over a 2×2 table of hours that were unusual *for this
  location*, false alarms included. Needs ≥ 8 event and ≥ 8 quiet hours; below
  that the weight folds back into Accuracy, so a calm window is not penalised.
- **Sharpness** — σ(forecast)/σ(observed), shown in the expanded row and
  deliberately kept out of the score.
- **Rain and the aggregation are unchanged**, except that a model's rain is
  only scored when its own sample holds ≥ 8 observed wet hours.

RMSE keeps being computed as `errorScore`. Every expanded row says where the
model would have ranked under it, `js/derive.js` ranks it, and
`scripts/history-backfill.mjs` charts it — see below.

Both ends carry the two score models **side by side**, and nothing negotiates a
version:

- `/scoreboard/v1/<preset>.json` still answers `version: 1` with the v1
  `skill`/`metricSkill`/`perLead`, and adds `skillV2`, `metricSkillV2`,
  `perLeadV2`, `components`, `movementV2`, `formDotsV2` and `v2CoveredDays`.
  The v2 fields are absent until the cell has banked 7 days of counters, so
  either end can be deployed first.
- `js/server-scoreboard.js` prefers v2 field by field and falls back to v1,
  then re-ranks by whatever it ended up showing.
- In the browser, event thresholds come from the scored window itself rather
  than a 90-day climatology (the app's documented on-device fallback), so the
  numbers for a searched location can differ slightly from a preset city's
  server-computed ones.

**`history.html` deliberately stays on the error score.** v2 defines "extreme"
against a location's climate, and a one-month bucket can only derive that from
itself, so the yardstick would drift with the season and a five-year line would
partly chart its own thresholds. The committed history series is therefore all
v1, old months and new alike, and is not comparable with the live board.
