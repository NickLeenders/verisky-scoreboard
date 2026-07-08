/**
 * Debug harness renderer. This is NOT the locked page design (plan.md §8) —
 * it is a plain verification view of the data + scoring pipeline (§1–§4), so
 * the numbers can be eyeballed against the app before the real UI goes on top.
 */

import { LEAD_DAYS } from './config.js';
import { runAllCities } from './pipeline.js';

const fmt = (v, digits = 1) => (v == null ? '—' : v.toFixed(digits));
const fmtSigned = (v, digits = 1) => {
  if (v == null) return '—';
  const s = v.toFixed(digits);
  return v >= 0 ? `+${s}` : s;
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function renderCity(outcome) {
  const section = el('section', 'city');
  const heading = el('h2', null, outcome.city.name);
  section.appendChild(heading);

  if (!outcome.ok) {
    section.appendChild(el('p', 'error', `Failed to load: ${outcome.error.message}`));
    return section;
  }

  const { aligned, scores, timezone } = outcome.result;
  const days = aligned.scoredDates;
  const meta =
    `${timezone} · ${days.length} scored days (${days[0]} → ${days[days.length - 1]}) · ` +
    (scores.rainEligibility.rainScoreEligible
      ? `rain scored (${scores.rainEligibility.rainEventHours} rain-event h, ${scores.rainEligibility.rainEventTotalMm.toFixed(1)} mm)`
      : `rain NOT scored — too dry (${scores.rainEligibility.rainEventHours} rain-event h, ${scores.rainEligibility.rainEventTotalMm.toFixed(1)} mm)`);
  section.appendChild(el('p', 'meta', meta));

  // Standings-style summary, ranked by headline skill.
  const ranked = scores.roster
    .map((m) => ({ model: m, s: scores.models[m.id] }))
    .filter((r) => r.s && r.s.skill != null)
    .sort((a, b) => b.s.skill - a.s.skill);

  const table = el('table');
  const head = el('tr');
  for (const h of ['#', 'model', 'skill', 'temp', 'rain', 'wind', 'rain record (D-1)']) {
    head.appendChild(el('th', null, h));
  }
  table.appendChild(head);
  ranked.forEach(({ model, s }, i) => {
    const tr = el('tr');
    tr.appendChild(el('td', null, String(i + 1)));
    const name = el('td', 'model');
    const dot = el('span', 'dot');
    dot.style.background = model.color;
    name.append(dot, ` ${model.label} · ${model.provider}`);
    tr.appendChild(name);
    tr.appendChild(el('td', 'num', fmt(s.skill, 1)));
    tr.appendChild(el('td', 'num', fmt(s.metricSkill.temperature, 1)));
    tr.appendChild(el('td', 'num', fmt(s.metricSkill.rain, 1)));
    tr.appendChild(el('td', 'num', fmt(s.metricSkill.wind, 1)));
    tr.appendChild(el('td', 'num', `${s.rainRecord.wins}–${s.rainRecord.losses}`));
    table.appendChild(tr);
  });
  section.appendChild(table);

  // Per-lead detail per model: score / MAE / bias by lead day.
  for (const { model, s } of ranked) {
    const detail = el('details');
    detail.appendChild(el('summary', null, `${model.label} — per lead day`));
    const t = el('table');
    const hr = el('tr');
    for (const h of ['lead', 'temp score', 'temp MAE °C', 'temp bias', 'wind score', 'wind MAE km/h', 'wind bias', 'rain F1', 'hit rate %', 'amount MAE mm', 'hours']) {
      hr.appendChild(el('th', null, h));
    }
    t.appendChild(hr);
    for (const day of LEAD_DAYS) {
      const lead = s.perLead[day];
      if (!lead) continue;
      const tr = el('tr');
      tr.appendChild(el('td', null, `D-${day}`));
      tr.appendChild(el('td', 'num', fmt(lead.temperature.score)));
      tr.appendChild(el('td', 'num', fmt(lead.temperature.mae, 2)));
      tr.appendChild(el('td', 'num', fmtSigned(lead.temperature.bias, 2)));
      tr.appendChild(el('td', 'num', fmt(lead.wind.score)));
      tr.appendChild(el('td', 'num', fmt(lead.wind.mae, 2)));
      tr.appendChild(el('td', 'num', fmtSigned(lead.wind.bias, 2)));
      tr.appendChild(el('td', 'num', fmt(lead.rain.score)));
      tr.appendChild(el('td', 'num', fmt(lead.rain.hitRate)));
      tr.appendChild(el('td', 'num', fmt(lead.rain.amountMae, 3)));
      tr.appendChild(el('td', 'num', String(lead.temperature.count)));
      t.appendChild(tr);
    }
    detail.appendChild(t);
    section.appendChild(detail);
  }

  return section;
}

async function main() {
  const root = document.getElementById('app');
  root.textContent = 'Fetching truth + previous-run forecasts…';
  try {
    const outcomes = await runAllCities();
    root.textContent = '';
    for (const outcome of outcomes) root.appendChild(renderCity(outcome));
  } catch (e) {
    root.textContent = `Pipeline failed: ${e.message}`;
  }
}

main();
