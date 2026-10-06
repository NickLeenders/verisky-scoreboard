/**
 * Display-unit conversion (metric ⇄ imperial).
 *
 * Scoring stays in metric — the 0–100 scores are unit-independent — so only the
 * physical quantities shown on the page (temperatures, wind speeds, rain
 * amounts) pass through here at render time. Each location defaults to US
 * units for country US, metric elsewhere. A manual choice lasts until the
 * location changes. Safe to import in Node (the bake), defaulting to metric.
 */

let system = 'metric';
let locationKey = null;

/** Apply before rendering, including the initial URL location. */
export function useLocationUnits(city) {
  const country = city.country?.toUpperCase();
  // City/airport switches and retries keep a manual choice for the same place.
  const key = `${country ?? ''}:${city.id ?? `${city.lat},${city.lon}`}`;
  if (key === locationKey) return;
  locationKey = key;
  setUnitSystem(country === 'US' ? 'imperial' : 'metric');
}

export function unitSystem() {
  return system;
}

export function isImperial() {
  return system === 'imperial';
}

export function setUnitSystem(next) {
  system = next === 'imperial' ? 'imperial' : 'metric';
}

// ── Value conversion (nulls pass through untouched) ──────────────────────────

/** Absolute temperature: °C → °F. */
export const asTemp = (c) => (c == null ? null : isImperial() ? c * 9 / 5 + 32 : c);

/** A temperature *difference* (MAE / bias / delta): scale only, no +32 offset. */
export const asTempDelta = (c) => (c == null ? null : isImperial() ? c * 9 / 5 : c);

/** Wind speed: km/h → mph. Differences scale the same way, so this covers both. */
export const asWind = (k) => (k == null ? null : isImperial() ? k * 0.621371 : k);

/** Rain amount: mm → inches. Differences scale the same way. */
export const asRain = (m) => (m == null ? null : isImperial() ? m * 0.0393701 : m);

// ── Unit labels ──────────────────────────────────────────────────────────────

export const tempUnit = () => (isImperial() ? '°F' : '°C');
export const windUnit = () => (isImperial() ? 'mph' : 'km/h');
export const rainUnit = () => (isImperial() ? 'in' : 'mm');

/** Rain totals need more precision in inches (0.1 mm ≈ 0.004 in). */
export const rainDecimals = () => (isImperial() ? 2 : 1);
