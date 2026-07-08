/**
 * Server-baked snapshots (plan.md §7).
 *
 * The daily GitHub Actions bake (`scripts/bake.mjs`) writes one
 * `data/<cityId>.json` per preset city, holding the same raw fetch payload the
 * localStorage cache stores (`{ truth, predictions }`). The app replays it
 * through the identical `scorePayload` path used for cached data, so a first
 * visit paints real baked numbers instantly — "live browser mode is the
 * interactive layer on top of baked numbers" — then refreshes live on top.
 *
 * Only preset cities (those with a stable `id`) are baked; a custom, geocoded
 * city has no snapshot and this resolves to null so the caller falls back to
 * skeletons + a live fetch. Any fetch/parse failure is swallowed to null: the
 * bake is an optimization, never a dependency.
 */

/** Relative to the page (index.html and data/ are both at the site root). */
const BAKED_BASE = 'data';

/**
 * The server-baked raw payload for a city, or null if there is none (custom
 * city, not yet baked, offline, or a malformed file).
 * @param {{id?:string|null}} city
 * @returns {Promise<{truth:Object, predictions:Object}|null>}
 */
export async function readBaked(city) {
  if (!city || !city.id) return null;
  try {
    const res = await fetch(`${BAKED_BASE}/${encodeURIComponent(city.id)}.json`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.truth || !data.predictions) return null;
    return { truth: data.truth, predictions: data.predictions };
  } catch {
    return null;
  }
}
