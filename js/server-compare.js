/** Minimal daily commercial readouts; no raw forecasts or persistent browser cache. */
import { COMMERCIAL_MODEL_CATALOG, siteSlug } from './config.js';

const models = new Map(COMMERCIAL_MODEL_CATALOG.map((model) => [model.id, model]));
const cache = new Map();
const finiteOrNull = (value) => Number.isFinite(value) ? value : null;

export function hydrateCompare(payload, slug, date, lead) {
  if (payload?.version !== 1 || payload.city !== slug || payload.date !== date || payload.lead !== lead
    || typeof payload.timezone !== 'string' || !Array.isArray(payload.models)) {
    throw new Error('Invalid daily comparison response');
  }
  const seen = new Set();
  return payload.models.flatMap((row) => {
    const model = models.get(row?.modelId);
    if (!model || seen.has(model.id)) return [];
    seen.add(model.id);
    let rain = null;
    if (Number.isFinite(row.rain?.total) && row.rain.total >= 0 && Array.isArray(row.rain.segments)
      && row.rain.segments.length <= 24 && row.rain.segments.every((s) => Number.isInteger(s?.start)
        && Number.isInteger(s.end) && s.start >= 0 && s.end >= s.start && s.end < 24)) {
      rain = { total: row.rain.total, segments: row.rain.segments.map(({ start, end }) => ({ start, end })) };
    }
    return [{ model, temperature: finiteOrNull(row.temperature), wind: finiteOrNull(row.wind), rain }];
  });
}

export async function fetchPresetCompare(city, date, lead) {
  const slug = siteSlug(city);
  if (!slug) return [];
  const key = `${slug}:${date}:${lead}`;
  const saved = cache.get(key);
  if (saved && saved.expires > Date.now()) return saved.models;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`https://api.verisky.app/scoreboard/v1/${encodeURIComponent(slug)}.json?compare=${encodeURIComponent(date)}&lead=${lead}`,
      { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`Daily comparison unavailable (HTTP ${response.status})`);
    const result = hydrateCompare(await response.json(), slug, date, lead);
    if (cache.size >= 100) cache.delete(cache.keys().next().value);
    cache.set(key, { models: result, expires: Date.now() + 15 * 60 * 1000 });
    return result;
  } finally { clearTimeout(timeout); }
}
