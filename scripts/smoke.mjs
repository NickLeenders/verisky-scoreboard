/**
 * Node smoke test: runs the real pipeline (live Open-Meteo calls) for one city
 * and prints the standings, so the fetch/align/score modules can be verified
 * without a browser. Usage: node scripts/smoke.mjs [cityId]
 */

import { CITIES, LEAD_DAYS } from '../js/config.js';
import { runCity } from '../js/pipeline.js';

const cityId = process.argv[2] ?? 'amsterdam';
const city = CITIES.find((c) => c.id === cityId);
if (!city) {
  console.error(`Unknown city "${cityId}". Options: ${CITIES.map((c) => c.id).join(', ')}`);
  process.exit(1);
}

const fmt = (v, d = 1) => (v == null ? '   —' : v.toFixed(d).padStart(5));

const { aligned, scores, timezone } = await runCity(city);
const days = aligned.scoredDates;
console.log(`${city.name} (${timezone}) — ${days.length} scored days: ${days[0]} → ${days[days.length - 1]}`);
const re = scores.rainEligibility;
console.log(
  `rain scoring ${re.rainScoreEligible ? 'ON' : 'OFF'} ` +
  `(${re.rainEventHours} rain-event hours, ${re.rainEventTotalMm.toFixed(1)} mm)\n`,
);

const ranked = scores.roster
  .map((m) => ({ m, s: scores.models[m.id] }))
  .filter((r) => r.s && r.s.skill != null)
  .sort((a, b) => b.s.skill - a.s.skill);

console.log('rank  model  skill   temp   rain   wind  rain record (D-1)');
ranked.forEach(({ m, s }, i) => {
  console.log(
    `${String(i + 1).padStart(3)}   ${m.label.padEnd(5)} ${fmt(s.skill)}  ${fmt(s.metricSkill.temperature)}  ` +
    `${fmt(s.metricSkill.rain)}  ${fmt(s.metricSkill.wind)}  ${s.rainRecord.wins}–${s.rainRecord.losses}`,
  );
});

for (const { m, s } of ranked) {
  console.log(`\n${m.label} per lead day (score / MAE / bias):`);
  for (const day of LEAD_DAYS) {
    const lead = s.perLead[day];
    if (!lead) continue;
    console.log(
      `  D-${day}  temp ${fmt(lead.temperature.score)} / ${fmt(lead.temperature.mae, 2)} / ${fmt(lead.temperature.bias, 2)}` +
      `   wind ${fmt(lead.wind.score)} / ${fmt(lead.wind.mae, 2)} / ${fmt(lead.wind.bias, 2)}` +
      `   rain F1 ${fmt(lead.rain.score)} hit ${fmt(lead.rain.hitRate)} amtMAE ${fmt(lead.rain.amountMae, 3)}` +
      `   n=${lead.temperature.count}`,
    );
  }
}
