/**
 * SEO / first-paint bake (plan.md §7).
 *
 * Runs the SAME fetch → align → score pipeline the browser runs, in Node, for
 * every preset city, and writes three kinds of artifact into the repo so a
 * deploy serves real numbers before any JavaScript executes:
 *
 *   data/<cityId>.json   raw fetch payload ({ generatedAt, city, truth,
 *                        predictions }) — the exact shape the localStorage
 *                        cache stores. The app replays it through `scorePayload`
 *                        for an instant first paint, then refreshes live on top.
 *   data/scores.json     a compact, machine-readable summary of every city's
 *                        standings + headline (the plan's named artifact).
 *   index.html           the default city's standings table, headline and a
 *                        "baked <date>" stamp are injected between <!-- BAKE:* -->
 *                        markers, so crawlers and no-JS visitors see the content.
 *
 * The scoring is never re-implemented here — it's imported from the same modules
 * the page uses (pipeline.js → align.js + score.js, derive.js → buildStandings),
 * so baked and live numbers can't drift.
 *
 * Usage:  node scripts/bake.mjs
 * Run daily by .github/workflows/pages.yml; the deploy step only runs if this
 * succeeds, so a bad bake leaves the previous deployment live.
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CITIES, DEFAULT_CITY_ID, WINDOW_PAST_DAYS, availableSites, siteSlug } from '../js/config.js';
import { fetchCityData } from '../js/fetch.js';
import { scorePayload } from '../js/pipeline.js';
import { buildStandings, scoreTone } from '../js/derive.js';
import { fetchPresetScoreboard } from '../js/server-scoreboard.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const INDEX_HTML = join(ROOT, 'index.html');

const CITY_CONCURRENCY = 2; // Open-Meteo's free tier 429s bursts (mirrors the app).

// Offline re-bake: replay the cached data/<id>.json payloads through the same
// score/HTML path instead of fetching live, and leave the raw payloads on disk
// untouched. Used to regenerate scores.json + index.html after a scoring-config
// change without churning the data snapshot.  Usage: BAKE_FROM_CACHE=1 node scripts/bake.mjs
const FROM_CACHE = process.env.BAKE_FROM_CACHE === '1';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);

const fmt = (v) => (v == null ? '—' : v.toFixed(0));
const round = (v) => (v == null ? null : Math.round(v));

// ── Concurrency pool (settled per item, so one failed city doesn't blank the rest) ──
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

// ── Static standings table (mirrors app.js renderStandings, same classes) ──────
function movementCell(m) {
  if (m == null || m === 0) return '<span class="move move-flat">—</span>';
  if (m > 0) return `<span class="move move-up">▲${m > 1 ? m : ''}</span>`;
  return `<span class="move move-down">▼${m < -1 ? -m : ''}</span>`;
}

function standingsTableHTML(rows, rainOff) {
  const head = `<table class="standings"><thead><tr>
    <th class="c-rank">#</th><th class="c-move"></th>
    <th>Model</th><th class="c-skill">Skill</th>
    <th class="c-metric">Temp</th><th class="c-metric">${rainOff ? 'Rain*' : 'Rain'}</th><th class="c-metric">Wind</th>
    <th class="c-record">Rain W–L</th><th class="c-form">Form</th>
  </tr></thead><tbody>`;
  const body = rows
    .map((r) => {
      const dots = r.formDots.map((d) => `<span class="fdot fdot-${d}"></span>`).join('');
      const metric = (v) => `<td class="num c-metric tone-${scoreTone(v)}">${fmt(v)}</td>`;
      return `<tr class="standing">
      <td class="c-rank num">${r.rank}</td>
      <td class="c-move">${movementCell(r.movement)}</td>
      <td class="c-model"><span class="mdot" style="background:${esc(r.model.color)}"></span>
        <span class="mlabel">${esc(r.model.label)}</span> <span class="mprov">${esc(r.model.provider)}</span></td>
      <td class="c-skill"><span class="num skill-num tone-${scoreTone(r.skill)}">${fmt(r.skill)}</span>
        <span class="bar"><span class="bar-fill tone-bg-${scoreTone(r.skill)}" style="width:${Math.max(2, r.skill ?? 0)}%"></span></span></td>
      ${metric(r.metricSkill.temperature)}${metric(r.metricSkill.rain)}${metric(r.metricSkill.wind)}
      <td class="num c-record">${r.rainRecord.wins}–${r.rainRecord.losses}</td>
      <td class="c-form">${dots}</td>
    </tr>`;
    })
    .join('\n');
  const foot = rainOff
    ? '<p class="foot-note">* rain not scored — the window was too dry for rain calls to mean anything.</p>'
    : '';
  return `${head}${body}</tbody></table>${foot}`;
}

// ── Headline + meta sentences (templated from the standings) ───────────────────
function headlineFor(cityName, scoredDays, rows) {
  const top = rows[0];
  if (!top) return `No verified forecast data yet for ${cityName}.`;
  const second = rows[1];
  let s = `${top.model.label} (${top.model.provider}) leads the ${cityName} scoreboard over the last ${scoredDays} days — verified skill ${round(top.skill)}/100`;
  if (second) s += `, ahead of ${second.model.label} (${round(second.skill)})`;
  return `${s}.`;
}

function metaFor(cityName, rows) {
  const top = rows[0];
  if (!top) {
    return `Weather models ranked by verified forecast accuracy over the last ${WINDOW_PAST_DAYS} days — scored against the same observed series (temperature, rain, wind, every lead time).`;
  }
  return `Which weather model is most accurate in ${cityName}? ${top.model.label} leads at ${round(top.skill)}/100 over the last ${WINDOW_PAST_DAYS} days — IFS, AIFS, GFS and ICON scored against the same observed series (temp, rain, wind, every lead time).`;
}

// ── index.html injection (idempotent — replaces between markers) ───────────────
function replaceRegion(html, name, inner) {
  const re = new RegExp(`<!-- BAKE:${name} -->[\\s\\S]*?<!-- /BAKE:${name} -->`);
  const block = `<!-- BAKE:${name} -->${inner}<!-- /BAKE:${name} -->`;
  if (!re.test(html)) {
    console.warn(`  ! marker BAKE:${name} not found in index.html — skipped`);
    return html;
  }
  return html.replace(re, block);
}

async function bakeIndexHtml(featured, generatedAt) {
  let html = await readFile(INDEX_HTML, 'utf8');
  if (featured) {
    html = replaceRegion(
      html,
      'META',
      `\n  <meta name="description" content="${esc(featured.meta)}" />\n  `,
    );
    html = replaceRegion(html, 'STANDINGS', `\n        ${featured.tableHTML}\n        `);
  }
  const stamp = new Date(generatedAt).toISOString().slice(0, 16).replace('T', ' ');
  html = replaceRegion(html, 'GENERATED', ` baked ${stamp} UTC · `);
  await writeFile(INDEX_HTML, html);
}

// ── Main ───────────────────────────────────────────────────────────────────────
const generatedAt = new Date().toISOString();
await mkdir(DATA_DIR, { recursive: true });

// Every available city and airport board (airports use data/<id>-airport.json,
// same shape). The airport runs the identical pipeline at the station's
// coordinates; its server board additionally carries METAR-verified standings.
const TARGETS = CITIES.flatMap(availableSites);

console.log(`Baking ${TARGETS.length} boards (${CITIES.length} cities + airports, window ${WINDOW_PAST_DAYS}d)${FROM_CACHE ? ' — from cache' : ''}…`);

const summary = {
  generatedAt,
  truthSource: 'best_match',
  // Which yardstick these numbers are on: v2 is Accuracy + Extremes (the
  // anti-blur score), v1 was RMSE-derived. Consumers of this artifact should
  // not compare a v1 series with a v2 one. `history.html` stays on v1 by
  // design — see scripts/history-backfill.mjs.
  scoreModel: 'v2',
  window: { pastDays: WINDOW_PAST_DAYS },
  cities: {},
  failures: [],
};

const results = await pool(TARGETS, CITY_CONCURRENCY, async (city) => {
  const slug = siteSlug(city);
  const [publicPayload, presetBoard] = await Promise.all([
    FROM_CACHE
      ? JSON.parse(await readFile(join(DATA_DIR, `${slug}.json`), 'utf8'))
      : fetchCityData(city),
    fetchPresetScoreboard(city).catch((error) => {
      console.warn(`  ! ${slug}: preset scoreboard unavailable (${error.message})`);
      return null;
    }),
  ]);
  const { truth, predictions } = publicPayload;
  const { aligned, scores, timezone } = scorePayload(city, { truth, predictions });
  return { city, truth, predictions, aligned, scores, timezone, presetBoard };
});

let ok = 0;
const perCity = {}; // site slug → { rows, scoredDays, rainOff }

for (let i = 0; i < TARGETS.length; i++) {
  const city = TARGETS[i];
  const slug = siteSlug(city);
  const isAirport = city.site === 'airport';
  const boardName = isAirport ? `${city.name} · ${city.airport.name}` : city.name;
  const r = results[i];
  if (!r.ok) {
    console.warn(`  ✗ ${boardName}: ${r.error.message}`);
    summary.failures.push({ id: slug, error: r.error.message });
    continue;
  }
  ok += 1;
  const { truth, predictions, aligned, scores, timezone, presetBoard } = r.value;

  // 1. Raw payload — the app replays this exactly like a cache hit.
  //    Skipped in from-cache mode: we're reading these, not refreshing them.
  if (!FROM_CACHE) {
    await writeFile(
      join(DATA_DIR, `${slug}.json`),
      JSON.stringify({ generatedAt, city, truth, predictions }),
    );
  }

  // 2. Summary rows (the same buildStandings the browser renders).
  const rows = presetBoard?.rows ?? buildStandings(aligned, scores);
  const dates = aligned.scoredDates;
  const scoredDays = presetBoard?.scoredDays ?? dates.length;
  const dateRange = presetBoard?.dateRange
    ?? (dates.length ? [dates[0], dates[dates.length - 1]] : null);
  const rainOff = !(presetBoard?.scores ?? scores).rainEligibility.rainScoreEligible;
  perCity[slug] = { rows, scoredDays, rainOff };

  summary.cities[slug] = {
    name: presetBoard?.city?.name ?? boardName,
    country: city.country ?? null,
    site: isAirport ? 'airport' : 'city',
    ...(isAirport ? { station: { icao: city.airport.icao, name: city.airport.name } } : {}),
    timezone: presetBoard?.timezone ?? timezone,
    scoredDays,
    dateRange,
    rainScored: !rainOff,
    // Days of the window whose stats carry the v2 counters (null when the
    // board was scored in-browser, where the whole window is covered).
    v2CoveredDays: presetBoard?.v2CoveredDays ?? null,
    headline: headlineFor(presetBoard?.city?.name ?? boardName, scoredDays, rows),
    standings: rows.map((row) => ({
      rank: row.rank,
      model: {
        id: row.model.id,
        label: row.model.label,
        provider: row.model.provider,
        color: row.model.color,
      },
      skill: round(row.skill),
      temp: round(row.metricSkill.temperature),
      rain: round(row.metricSkill.rain),
      wind: round(row.metricSkill.wind),
      rainRecord: { wins: row.rainRecord.wins, losses: row.rainRecord.losses },
      movement: row.movement,
      formDots: row.formDots,
    })),
  };
  console.log(
    `  ✓ ${boardName}: ${scoredDays} days, ${rows.length} models, leader ${rows[0]?.model.label ?? '—'} ${fmt(rows[0]?.skill)}`,
  );
}

if (ok === 0) {
  console.error('All cities failed — leaving the existing deployment in place.');
  process.exit(1);
}

// 3. scores.json summary.
await writeFile(join(DATA_DIR, 'scores.json'), `${JSON.stringify(summary, null, 2)}\n`);

// 4. Bake the featured (default) city into index.html — or the first that scored.
const featuredId = perCity[DEFAULT_CITY_ID] ? DEFAULT_CITY_ID : Object.keys(perCity)[0];
const feat = perCity[featuredId];
const featured = feat
  ? {
      meta: metaFor(summary.cities[featuredId].name, feat.rows),
      tableHTML: standingsTableHTML(feat.rows, feat.rainOff),
    }
  : null;
await bakeIndexHtml(featured, generatedAt);

console.log(
  `\nBaked ${ok}/${TARGETS.length} boards → data/*.json, data/scores.json, index.html` +
  `${featured ? ` (featured: ${summary.cities[featuredId].name})` : ''}.`,
);
