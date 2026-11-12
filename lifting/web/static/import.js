// Paste (or pick) an export in the lifting_backfill.json format and import it.
import { api, currentPerson, h, nav, peopleReady } from './common.js';

nav('import');
const main = document.getElementById('main');
const area = h('textarea', { class: 'json', placeholder: 'Paste JSON here: { "sessions": [ … ], "measurements": [ … ] }', spellcheck: false });
const file = h('input', { type: 'file', accept: '.json,application/json,text/plain' });
const result = h('div', { class: 'result' });
const go = h('button', { class: 'btn btn-primary' }, 'Import');

try {
  area.value = localStorage.getItem('lifting-import-draft') || '';
} catch {}
area.addEventListener('input', () => {
  try {
    localStorage.setItem('lifting-import-draft', area.value);
  } catch {}
});
file.addEventListener('change', async () => {
  const f = file.files?.[0];
  if (f) area.value = await f.text();
});

go.addEventListener('click', async () => {
  const text = area.value.trim();
  if (!text) return result.replaceChildren(h('p', { class: 'error' }, 'Paste some JSON first.'));
  go.disabled = true;
  result.replaceChildren(h('p', { class: 'dim' }, 'Importing…'));
  try {
    const r = await api('import', { method: 'POST', body: text, headers: { 'Content-Type': 'application/json' } });
    const line = (label, n) => (n ? h('li', {}, `${label}: ${n}`) : null);
    result.replaceChildren(
      h('p', { class: 'ok' }, `✓ Imported for ${r.person}${r.person_created ? ' (new person)' : ''}.`),
      h('ul', {},
        line('Sessions added', r.sessions_created), line('Sessions with new notes', r.sessions_updated),
        line('Sets added', r.sets_added), line('Sets changed', r.sets_updated), line('Sets already there', r.sets_unchanged),
        line('New exercises', r.exercises_created),
        line('Measurements added', r.measurements_added), line('Measurements changed', r.measurements_updated), line('Measurements already there', r.measurements_unchanged)),
      h('p', {}, h('a', { href: './#trend' }, 'See trends'), ' · ', h('a', { href: 'log' }, 'Check the log')),
    );
    try {
      localStorage.removeItem('lifting-import-draft');
    } catch {}
  } catch (e) {
    const errs = e.data?.errors || [e.message];
    result.replaceChildren(h('p', { class: 'error' }, 'Nothing was imported. Fix these and try again:'), h('ul', { class: 'error' }, ...errs.slice(0, 40).map((x) => h('li', {}, x))));
  } finally {
    go.disabled = false;
  }
});

const forWhom = h('span', {});
peopleReady.then(() => forWhom.replaceChildren(currentPerson()?.name ?? 'the first person'));
main.append(
  h('h2', { style: 'margin:0 0 8px' }, 'Import sessions for ', forWhom),
  h('p', { class: 'dim', style: 'margin:0 0 6px' }, 'Change who with 👤 at the top, or put "person": "Name" in the JSON (a new name adds that person).'),
  h('p', { class: 'dim', style: 'margin:0 0 12px' }, 'Re-importing is safe: sessions match by date + day, sets by exercise, variation, set number and segment, so repeats update instead of duplicating.'),
  area,
  h('div', { class: 'row', style: 'margin:12px 0' }, go, h('button', { class: 'btn', onclick: () => { area.value = ''; area.dispatchEvent(new Event('input')); result.replaceChildren(); } }, 'Clear'), h('label', { class: 'field' }, 'Or pick a file', file)),
  result,
  h('details', { style: 'margin-top:20px' }, h('summary', {}, 'Format'), h('pre', { class: 'example' }, `{
  "person": "Dan",            (optional: otherwise the person picked at the top)
  "sessions": [
    { "date": "2026-11-03", "day": "A", "notes": "optional",
      "sets": [
        { "exercise": "Belt squat", "variation": "standard stance", "set_number": 1,
          "set_type": "working", "weight_lb": 270, "load_basis": "total", "reps": 8 },
        { "exercise": "Spider curl", "variation": "incline, dumbbell", "set_number": 1,
          "set_type": "mechanical_drop", "segment": 2, "weight_lb": 37.5,
          "load_basis": "per_hand", "reps": 3, "approx": true, "notes": "neutral grip" }
      ] }
  ],
  "measurements": [
    { "date": "2026-11-03", "type": "standing_touch_height", "value_in": 111, "approx": true }
  ]
}
set_type: warmup | working | mechanical_drop    load_basis: total | per_hand | per_arm | per_side
Optional per set: segment (default 1), duration_s, height_in, approx, inferred, notes,
muscle_group and equipment (otherwise guessed from the name; change them on Log › Exercises).
Measurement types: bodyweight, standing_touch_height, approach_touch_height, box_jump_height
(value + unit, or value_in / value_lb / value_cm).`)),
);
