// Log: every set in a table, filterable by date and exercise, with inline edit and delete.
// Tabs for sessions, exercises (muscle group / equipment) and measurements too.
import { api, BASIS, h, longDate, nav, num, toast } from './common.js';

nav('log');
const main = document.getElementById('main');
const TABS = [['sets', 'Sets'], ['sessions', 'Sessions'], ['exercises', 'Exercises'], ['measurements', 'Measurements']];
const SET_TYPES = ['warmup', 'working', 'mechanical_drop'];
const TYPE_LABEL = { warmup: 'warmup', working: 'working', mechanical_drop: 'mech. drop' };
const MTYPES = ['bodyweight', 'standing_touch_height', 'approach_touch_height', 'box_jump_height'];

let filters = { from: '', to: '', exercise: '', warmups: true };
try {
  filters = { ...filters, ...JSON.parse(sessionStorage.getItem('lifting-log-filters') || '{}') };
} catch {}
const saveFilters = () => {
  try {
    sessionStorage.setItem('lifting-log-filters', JSON.stringify(filters));
  } catch {}
};

const tab = () => (TABS.some(([t]) => t === location.hash.slice(1)) ? location.hash.slice(1) : 'sets');
window.addEventListener('hashchange', render);
render();

async function render() {
  const t = tab();
  const body = h('div', {});
  main.replaceChildren(
    h('div', { class: 'chips' }, ...TABS.map(([id, label]) => h('a', { href: `#${id}`, class: `chip${id === t ? ' active' : ''}`, style: 'display:inline-flex;align-items:center;text-decoration:none;color:inherit' }, label))),
    body,
  );
  try {
    await { sets: renderSets, sessions: renderSessions, exercises: renderExercises, measurements: renderMeasurements }[t](body);
  } catch (e) {
    body.replaceChildren(h('p', { class: 'error' }, `Couldn't load: ${e.message}`));
  }
}

/** A delete button that asks once more before it fires. */
function deleteButton(onConfirm) {
  const b = h('button', { class: 'btn btn-sm btn-danger' }, 'Delete');
  let armed = false;
  let timer;
  b.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      b.textContent = 'Sure?';
      b.classList.add('btn-primary');
      timer = setTimeout(() => {
        armed = false;
        b.textContent = 'Delete';
        b.classList.remove('btn-primary');
      }, 3000);
      return;
    }
    clearTimeout(timer);
    b.disabled = true;
    try {
      await onConfirm();
    } catch (e) {
      toast(e.message, true);
      b.disabled = false;
    }
  });
  return b;
}

const numInput = (v, attrs = {}) => h('input', { type: 'text', inputmode: 'decimal', value: v ?? '', size: 5, ...attrs });
const parseNum = (input, integer = false) => {
  const s = input.value.trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) throw new Error(`"${input.value}" isn't a valid ${integer ? 'whole number' : 'number'}`);
  return n;
};
const select = (options, value) => h('select', {}, ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));

// ---- Sets ---------------------------------------------------------------------------

async function renderSets(el) {
  const exercises = await api('api/exercises');
  const names = [...new Set(exercises.map((e) => e.name))].sort();
  const exSelect = h('select', {},
    h('option', { value: '' }, 'All exercises'),
    ...names.map((n) => {
      const vars = exercises.filter((e) => e.name === n);
      return vars.length > 1
        ? h('optgroup', { label: n }, h('option', { value: `name:${n}`, selected: filters.exercise === `name:${n}` }, `${n} (all variations)`), ...vars.map((v) => h('option', { value: `id:${v.id}`, selected: filters.exercise === `id:${v.id}` }, `${n} · ${v.variation || 'standard'}`)))
        : h('option', { value: `id:${vars[0].id}`, selected: filters.exercise === `id:${vars[0].id}` }, vars[0].label);
    }));
  const from = h('input', { type: 'date', value: filters.from });
  const to = h('input', { type: 'date', value: filters.to });
  const warm = h('input', { type: 'checkbox', checked: filters.warmups });
  const apply = () => {
    filters = { from: from.value, to: to.value, exercise: exSelect.value, warmups: warm.checked };
    saveFilters();
    load();
  };
  for (const c of [from, to, exSelect, warm]) c.addEventListener('change', apply);
  const tableHolder = h('div', { class: 'table-wrap' });
  el.append(
    h('div', { class: 'row filters' },
      h('label', { class: 'field' }, 'From', from),
      h('label', { class: 'field' }, 'To', to),
      h('label', { class: 'field' }, 'Exercise', exSelect),
      h('label', { class: 'check' }, warm, 'Show warmups'),
      h('button', { class: 'btn', onclick: () => { from.value = ''; to.value = ''; exSelect.value = ''; warm.checked = true; apply(); } }, 'Clear filters')),
    tableHolder,
  );
  const exOptions = exercises.map((e) => [String(e.id), e.label]);

  async function load() {
    const q = new URLSearchParams();
    if (filters.from) q.set('from', filters.from);
    if (filters.to) q.set('to', filters.to);
    if (filters.exercise.startsWith('id:')) q.set('exercise_id', filters.exercise.slice(3));
    if (filters.exercise.startsWith('name:')) q.set('name', filters.exercise.slice(5));
    if (!filters.warmups) q.set('include_warmups', 'false');
    const rows = await api(`api/sets?${q}`);
    if (!rows.length) {
      tableHolder.replaceChildren(h('div', { class: 'empty' }, 'No sets match.'));
      return;
    }
    const tbody = h('tbody', {});
    let lastSession = null;
    for (const r of rows) {
      if (r.session_id !== lastSession) {
        lastSession = r.session_id;
        tbody.append(h('tr', { class: 'session-head' }, h('td', { colspan: 12 }, `${longDate(r.date)} · Day ${r.day_label || '–'}`)));
      }
      tbody.append(viewRow(r));
    }
    tableHolder.replaceChildren(h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ...['Exercise', 'Set', 'Seg', 'Type', 'Weight', 'Basis', 'Reps', 'Time', 'Height', 'e1RM', 'Notes', ''].map((x, i) => h('th', { class: i >= 4 && i <= 9 && i !== 5 ? 'num' : '' }, x)))),
      tbody));
  }

  function viewRow(r) {
    const flags = [r.approx ? '≈' : '', r.inferred ? 'assumed' : ''].filter(Boolean).join(' ');
    const tr = h('tr', { class: r.set_type === 'warmup' ? 'warmup' : '' },
      h('td', {}, r.name, r.variation ? h('div', { class: 'dim', style: 'font-size:15px' }, r.variation) : null),
      h('td', { class: 'num' }, String(r.set_number)),
      h('td', { class: 'num' }, r.segment > 1 || r.set_type === 'mechanical_drop' ? String(r.segment) : ''),
      h('td', {}, TYPE_LABEL[r.set_type]),
      h('td', { class: 'num' }, r.weight_lb !== null ? num(r.weight_lb) : '–'),
      h('td', { class: 'dim' }, r.load_basis ? BASIS[r.load_basis] : ''),
      h('td', { class: 'num' }, r.reps ?? '–'),
      h('td', { class: 'num' }, r.duration_s !== null ? `${num(r.duration_s)} s` : ''),
      h('td', { class: 'num' }, r.height_in !== null ? `${num(r.height_in)} in` : ''),
      h('td', { class: 'num dim' }, r.e1rm !== null ? num(r.e1rm) : ''),
      h('td', { class: 'dim', style: 'font-size:16px' }, [flags, r.notes].filter(Boolean).join(' · ')),
      h('td', { class: 'actions' },
        h('button', { class: 'btn btn-sm', onclick: () => tr.replaceWith(editRow(r)) }, 'Edit'),
        deleteButton(async () => {
          await api(`api/sets/${r.id}`, { method: 'DELETE' });
          tr.remove();
          toast('Set deleted');
        })),
    );
    return tr;
  }

  function editRow(r) {
    const f = {
      exercise: select(exOptions, String(r.exercise_id)),
      set_number: numInput(r.set_number, { inputmode: 'numeric', size: 3 }),
      segment: numInput(r.segment, { inputmode: 'numeric', size: 3 }),
      set_type: select(SET_TYPES.map((t) => [t, TYPE_LABEL[t]]), r.set_type),
      weight_lb: numInput(r.weight_lb),
      load_basis: select([['', '—'], ...Object.entries(BASIS)], r.load_basis ?? ''),
      reps: numInput(r.reps, { inputmode: 'numeric', size: 3 }),
      duration_s: numInput(r.duration_s),
      height_in: numInput(r.height_in),
      approx: h('input', { type: 'checkbox', checked: r.approx }),
      inferred: h('input', { type: 'checkbox', checked: r.inferred }),
      notes: h('input', { type: 'text', value: r.notes ?? '', class: 'wide' }),
    };
    const save = async () => {
      let body;
      try {
        body = {
          exercise_id: Number(f.exercise.value),
          set_number: parseNum(f.set_number, true),
          segment: parseNum(f.segment, true) ?? 1,
          set_type: f.set_type.value,
          weight_lb: parseNum(f.weight_lb),
          load_basis: f.load_basis.value || null,
          reps: parseNum(f.reps, true),
          duration_s: parseNum(f.duration_s),
          height_in: parseNum(f.height_in),
          approx: f.approx.checked,
          inferred: f.inferred.checked,
          notes: f.notes.value,
        };
        if (body.set_number === null) throw new Error('Set number is required');
        await api(`api/sets/${r.id}`, { method: 'PATCH', json: body });
      } catch (e) {
        return toast(e.message, true);
      }
      toast('Saved');
      load();
    };
    for (const input of Object.values(f)) input.addEventListener?.('keydown', (e) => e.key === 'Enter' && save());
    return h('tr', { class: 'editing' },
      h('td', {}, f.exercise),
      h('td', {}, f.set_number), h('td', {}, f.segment), h('td', {}, f.set_type),
      h('td', {}, f.weight_lb), h('td', {}, f.load_basis), h('td', {}, f.reps),
      h('td', {}, f.duration_s), h('td', {}, f.height_in),
      h('td', {}, h('div', { class: 'flags' }, h('label', { class: 'check' }, f.approx, 'approx'), h('label', { class: 'check' }, f.inferred, 'assumed'))),
      h('td', {}, f.notes),
      h('td', { class: 'actions' }, h('button', { class: 'btn btn-sm btn-primary', onclick: save }, 'Save'), h('button', { class: 'btn btn-sm', onclick: () => load() }, 'Cancel')),
    );
  }

  await load();
}

// ---- Sessions -----------------------------------------------------------------------

async function renderSessions(el) {
  const rows = await api('api/sessions');
  if (!rows.length) return el.append(h('div', { class: 'empty' }, 'No sessions yet.'));
  const tbody = h('tbody', {});
  const view = (s) => {
    const tr = h('tr', {},
      h('td', {}, longDate(s.date)), h('td', {}, s.day_label || '–'), h('td', { class: 'num' }, String(s.set_rows)),
      h('td', { class: 'dim', style: 'font-size:16px' }, s.notes || ''),
      h('td', { class: 'actions' },
        h('button', { class: 'btn btn-sm', onclick: () => tr.replaceWith(edit(s)) }, 'Edit'),
        deleteButton(async () => {
          await api(`api/sessions/${s.id}`, { method: 'DELETE' });
          tr.remove();
          toast(`Deleted the session and its ${s.set_rows} sets`);
        })));
    return tr;
  };
  const edit = (s) => {
    const date = h('input', { type: 'date', value: s.date });
    const day = h('input', { type: 'text', value: s.day_label, size: 3, maxlength: 8 });
    const notes = h('input', { type: 'text', value: s.notes || '', class: 'wide', style: 'width:100%' });
    const tr = h('tr', { class: 'editing' }, h('td', {}, date), h('td', {}, day), h('td', { class: 'num' }, String(s.set_rows)), h('td', {}, notes),
      h('td', { class: 'actions' },
        h('button', { class: 'btn btn-sm btn-primary', onclick: async () => {
          try {
            const next = await api(`api/sessions/${s.id}`, { method: 'PATCH', json: { date: date.value, day_label: day.value, notes: notes.value } });
            tr.replaceWith(view({ ...s, ...next }));
            toast('Saved');
          } catch (e) {
            toast(e.message, true);
          }
        } }, 'Save'),
        h('button', { class: 'btn btn-sm', onclick: () => tr.replaceWith(view(s)) }, 'Cancel')));
    return tr;
  };
  rows.forEach((s) => tbody.append(view(s)));
  el.append(
    h('p', { class: 'dim', style: 'margin:4px 0 12px' }, 'Deleting a session deletes its sets too.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Day'), h('th', { class: 'num' }, 'Set rows'), h('th', {}, 'Notes'), h('th', {}, ''))), tbody)),
  );
}

// ---- Exercises ----------------------------------------------------------------------

async function renderExercises(el) {
  const rows = await api('api/exercises');
  const groups = [...new Set(['Back', 'Biceps', 'Calves', 'Chest', 'Core', 'Glutes', 'Hamstrings', 'Plyometrics', 'Quads', 'Rear delts', 'Shoulders', 'Side delts', 'Triceps', ...rows.map((r) => r.muscle_group).filter(Boolean)])].sort();
  const list = h('datalist', { id: 'muscle-groups' }, ...groups.map((g) => h('option', { value: g })));
  const tbody = h('tbody', {});
  const view = (x) => {
    const tr = h('tr', {},
      h('td', {}, x.name), h('td', { class: 'dim' }, x.variation || '—'), h('td', {}, x.muscle_group || h('span', { class: 'dim' }, 'Other')), h('td', { class: 'dim' }, x.equipment || ''),
      h('td', { class: 'num' }, String(x.session_count)),
      h('td', {}, x.stalled ? h('span', { class: 'badge stall' }, 'stalled') : null),
      h('td', { class: 'actions' },
        h('button', { class: 'btn btn-sm', onclick: () => tr.replaceWith(edit(x)) }, 'Edit'),
        x.session_count ? null : deleteButton(async () => {
          await api(`api/exercises/${x.id}`, { method: 'DELETE' });
          tr.remove();
        })));
    return tr;
  };
  const edit = (x) => {
    const f = {
      name: h('input', { type: 'text', value: x.name }),
      variation: h('input', { type: 'text', value: x.variation }),
      muscle_group: h('input', { type: 'text', value: x.muscle_group || '', list: 'muscle-groups' }),
      equipment: h('input', { type: 'text', value: x.equipment || '' }),
    };
    const tr = h('tr', { class: 'editing' }, h('td', {}, f.name), h('td', {}, f.variation), h('td', {}, f.muscle_group), h('td', {}, f.equipment), h('td', { class: 'num' }, String(x.session_count)), h('td', {}),
      h('td', { class: 'actions' },
        h('button', { class: 'btn btn-sm btn-primary', onclick: async () => {
          try {
            const next = await api(`api/exercises/${x.id}`, { method: 'PATCH', json: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value])) });
            tr.replaceWith(view({ ...x, ...next }));
            toast('Saved');
          } catch (e) {
            toast(e.status === 409 ? 'An exercise with that name and variation already exists' : e.message, true);
          }
        } }, 'Save'),
        h('button', { class: 'btn btn-sm', onclick: () => tr.replaceWith(view(x)) }, 'Cancel')));
    return tr;
  };
  rows.forEach((x) => tbody.append(view(x)));
  el.append(list,
    h('p', { class: 'dim', style: 'margin:4px 0 12px' }, 'Muscle group drives the weekly volume chart. Name + variation identify an exercise on import, so renaming one means future imports with the old name create a new exercise.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, ...['Exercise', 'Variation', 'Muscle group', 'Equipment', 'Sessions', '', ''].map((x, i) => h('th', { class: i === 4 ? 'num' : '' }, x)))), tbody)));
}

// ---- Measurements -------------------------------------------------------------------

async function renderMeasurements(el) {
  const rows = await api('api/measurements');
  if (!rows.length) return el.append(h('div', { class: 'empty' }, 'No measurements yet. Add them on the Dunk goal page or import them.'));
  const label = (t) => t.replace(/_/g, ' ');
  const tbody = h('tbody', {});
  const view = (m) => {
    const tr = h('tr', {},
      h('td', {}, longDate(m.date)), h('td', {}, label(m.type)), h('td', { class: 'num' }, `${num(m.value)} ${m.unit}${m.approx ? ' ≈' : ''}`),
      h('td', { class: 'dim', style: 'font-size:16px' }, m.notes || ''),
      h('td', { class: 'actions' },
        h('button', { class: 'btn btn-sm', onclick: () => tr.replaceWith(edit(m)) }, 'Edit'),
        deleteButton(async () => {
          await api(`api/measurements/${m.id}`, { method: 'DELETE' });
          tr.remove();
        })));
    return tr;
  };
  const edit = (m) => {
    const date = h('input', { type: 'date', value: m.date });
    const type = select(MTYPES.map((t) => [t, label(t)]), m.type);
    const value = numInput(m.value);
    const unit = select([['in', 'in'], ['cm', 'cm'], ['lb', 'lb'], ['kg', 'kg']], m.unit);
    const approx = h('input', { type: 'checkbox', checked: m.approx });
    const notes = h('input', { type: 'text', value: m.notes || '', class: 'wide', style: 'width:100%' });
    const tr = h('tr', { class: 'editing' }, h('td', {}, date), h('td', {}, type), h('td', {}, h('div', { class: 'row' }, value, unit, h('label', { class: 'check' }, approx, '≈'))), h('td', {}, notes),
      h('td', { class: 'actions' },
        h('button', { class: 'btn btn-sm btn-primary', onclick: async () => {
          try {
            const v = parseNum(value);
            if (v === null) throw new Error('Value is required');
            const next = await api(`api/measurements/${m.id}`, { method: 'PATCH', json: { date: date.value, type: type.value, value: v, unit: unit.value, approx: approx.checked, notes: notes.value } });
            tr.replaceWith(view({ ...m, ...next, approx: !!next.approx }));
            toast('Saved');
          } catch (e) {
            toast(e.status === 409 ? 'There is already one of those on that date' : e.message, true);
          }
        } }, 'Save'),
        h('button', { class: 'btn btn-sm', onclick: () => tr.replaceWith(view(m)) }, 'Cancel')));
    return tr;
  };
  rows.forEach((m) => tbody.append(view(m)));
  el.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Type'), h('th', { class: 'num' }, 'Value'), h('th', {}, 'Notes'), h('th', {}, ''))), tbody)));
}
