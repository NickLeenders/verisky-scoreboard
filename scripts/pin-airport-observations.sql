-- Run against verisky_scores after registering these scoreboard cells.
-- METAR truth is selected through airport_panel, not the station registry.
-- Pin the three analysis-only airports so future panel rebuilds retain them.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE scoreboard_airport_pins (icao text PRIMARY KEY, cell_id text) ON COMMIT DROP;
INSERT INTO scoreboard_airport_pins VALUES
  ('EGHI', '50.9,-1.4'), ('KSEA', '47.4,-122.3'), ('KPHX', '33.4,-112.0');
DO $$ BEGIN
  IF (SELECT count(*) FROM scoreboard_airport_pins p
      JOIN metar.station s ON s.icao_id = p.icao
      JOIN score_cell c ON c.cell_id = p.cell_id) <> 3 THEN
    RAISE EXCEPTION 'A scoreboard station or registered score cell is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM scoreboard_airport_pins p JOIN airport_panel a
             ON a.cell_id = p.cell_id AND a.icao_id <> p.icao) THEN
    RAISE EXCEPTION 'A different station already supplies one of these cells';
  END IF;
END $$;
INSERT INTO airport_panel
  (icao_id, iata_id, name, country, latitude, longitude, tier, cell_id, timezone, registered_at)
SELECT s.icao_id, s.iata_id, s.name, s.country, s.latitude, s.longitude,
       'scoreboard', c.cell_id, c.timezone, now()
FROM scoreboard_airport_pins p
JOIN metar.station s ON s.icao_id = p.icao
JOIN score_cell c ON c.cell_id = p.cell_id
ON CONFLICT (icao_id) DO UPDATE SET
  tier = EXCLUDED.tier, cell_id = EXCLUDED.cell_id, timezone = EXCLUDED.timezone,
  registered_at = COALESCE(airport_panel.registered_at, EXCLUDED.registered_at);
COMMIT;
