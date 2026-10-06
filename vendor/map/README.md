# Map libraries

Copied from the VeriSky app's vendored map assets, 2026-10-06. Loaded as local
scripts/styles so the scoreboard does not depend on a JavaScript CDN.

- Leaflet 1.9.4: `https://unpkg.com/leaflet@1.9.4/dist/leaflet.js` and `leaflet.css`.
- MapLibre GL JS 5.24.0: `https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js` and `maplibre-gl.css`.
- MapLibre GL Leaflet bridge 0.1.3: `https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.3/leaflet-maplibre-gl.js`.

The upstream licences are included alongside the files. Source-map trailers
were removed; library contents are otherwise unchanged. The page uses canvas
circle markers, so Leaflet's optional marker-image files are not required.
