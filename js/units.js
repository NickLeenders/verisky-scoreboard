/**
 * Display-unit conversion (metric ⇄ imperial).
 *
 * Scoring stays in metric — the 0–100 scores are unit-independent — so only the
 * physical quantities shown on the page (temperatures, wind speeds, rain
 * amounts) pass through here at render time. The choice lives in localStorage
 * and defaults to metric. Safe to import in Node (the bake): touching
 * localStorage there throws and is swallowed, leaving the metric default.
 */

const KEY = 'verisky:units';

let system = 'metric';
try {
  const saved = localStorage.getItem(KEY);
  if (saved === 'imperial' || saved === 'metric') system = saved;
} catch { /* no storage (private mode / Node) — keep the default */ }

export function unitSystem() {
  return system;
}

export function isImperial() {
  return system === 'imperial';
}

export function setUnitSystem(next) {
  system = next === 'imperial' ? 'imperial' : 'metric';
  try { localStorage.setItem(KEY, system); } catch { /* ignore */ }
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
