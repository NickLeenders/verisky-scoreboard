/**
 * localStorage cache (plan.md §5).
 *
 * Keyed by city|modelset|date with a ~6h TTL. What's stored is the raw fetch
 * payloads (truth + normalized predictions) — align + score re-run on read,
 * which is cheap and keeps the scoring logic the single source of truth.
 *
 * Read semantics (stale-while-revalidate):
 *  - entry younger than TTL → render from it, skip the network entirely
 *    (this is what halves the API footprint);
 *  - entry older than TTL (or from a previous UTC date) → render from it
 *    instantly, then refresh in the background and re-render;
 *  - no entry → network only.
 *
 * The date in the key means a new day naturally misses the cache. Old entries
 * for the same city are pruned on write; a quota error evicts everything under
 * our prefix and retries once.
 */

import { resolveRoster } from './config.js';

const PREFIX = 'vsky:1:';
const TTL_MS = 6 * 60 * 60 * 1000;

// The roster is country-aware (§1a), so the modelset is per-city — it keys the
// cache entry so a city rendered with a different roster misses cleanly.
const modelSetKey = (city) => resolveRoster(city).map((m) => m.id).join(',');

const utcDate = () => new Date().toISOString().slice(0, 10);

/** Stable cache identity for a city (presets by id, searched cities by coords). */
export function cityKey(city) {
  return city.id ?? `geo:${city.lat.toFixed(2)},${city.lon.toFixed(2)}`;
}

const storageKey = (city, date) => `${PREFIX}${cityKey(city)}|${modelSetKey(city)}|${date}`;

function safeStorage() {
  try {
    return globalThis.localStorage ?? null; // absent in Node (smoke test / bake)
  } catch {
    return null; // privacy modes can throw on access
  }
}

/**
 * @returns {{payload:Object, fresh:boolean}|null} The newest cached payload for
 * this city+modelset, with `fresh` false when a background refresh is due.
 */
export function readCache(city) {
  const store = safeStorage();
  if (!store) return null;
  const keyPrefix = `${PREFIX}${cityKey(city)}|${modelSetKey(city)}|`;
  let best = null;
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key || !key.startsWith(keyPrefix)) continue;
    try {
      const entry = JSON.parse(store.getItem(key));
      if (!entry || !entry.truth || !entry.predictions) continue;
      if (!best || entry.fetchedAt > best.fetchedAt) best = entry;
    } catch {
      // corrupt entry — ignore; it gets pruned on the next write
    }
  }
  if (!best) return null;
  const fresh =
    Date.now() - best.fetchedAt < TTL_MS && best.date === utcDate();
  return { payload: { truth: best.truth, predictions: best.predictions }, fresh };
}

/** Store one city's fetch payloads, pruning that city's older entries. */
export function writeCache(city, { truth, predictions }) {
  const store = safeStorage();
  if (!store) return;
  const date = utcDate();
  const key = storageKey(city, date);
  const value = JSON.stringify({ fetchedAt: Date.now(), date, truth, predictions });

  // Prune other entries for this city (older dates / older modelsets).
  const cityPrefix = `${PREFIX}${cityKey(city)}|`;
  for (const k of allKeys(store)) {
    if (k.startsWith(cityPrefix) && k !== key) store.removeItem(k);
  }

  try {
    store.setItem(key, value);
  } catch {
    // Quota: evict everything under our prefix and retry once.
    for (const k of allKeys(store)) {
      if (k.startsWith(PREFIX)) store.removeItem(k);
    }
    try {
      store.setItem(key, value);
    } catch {
      // Still no room — run cacheless.
    }
  }
}

function allKeys(store) {
  const keys = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k) keys.push(k);
  }
  return keys;
}
