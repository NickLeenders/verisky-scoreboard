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
