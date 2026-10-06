/** Native country headings keep the picker accessible and keyboard-friendly. */
export function populateCityOptions(select, cities) {
  const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
  const groups = new Map();
  for (const city of cities) {
    const country = city.country ? countryNames.of(city.country) : 'Other';
    if (!groups.has(country)) groups.set(country, []);
    groups.get(country).push(city);
  }

  select.replaceChildren();
  for (const [country, members] of [...groups].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const group = document.createElement('optgroup');
    group.label = country;
    for (const city of [...members].sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const option = document.createElement('option');
      option.value = city.id;
      option.textContent = city.name;
      group.appendChild(option);
    }
    select.appendChild(group);
  }
}
