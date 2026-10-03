// The reminders UI: due / upcoming / completed lists, the reminder editor and
// sound settings. Rendered inside big tiles, and in a sheet for small tiles and
// the top-bar chip (src/core/reminder-alerts.ts).
import { h } from '../../core/dom';
import { openSheet } from '../../core/sheet';
import { preview, stopPreview, toneName, TONES } from '../../core/tones';
import { formatAlarmTime, formatIn, uses12h, type ToneId } from '../../core/timers';
import {
  dayLabel,
  formatRepeat,
  formatWhen,
  fromDateKey,
  reminders,
  repeatUnit,
  toDateKey,
  type Reminder,
  type ReminderInput,
  type Repeat,
} from '../../core/reminders';
import { holdButton } from '../timers/panel';
import './reminders.css';

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const REPEATS: [Repeat, string][] = [
  ['none', 'Never'],
  ['hourly', 'Hourly'],
  ['daily', 'Daily'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly'],
  ['yearly', 'Yearly'],
];

const fail = (err: unknown) => console.error(err);

interface PanelOpts {
  /** Set when the panel lives in a sheet: editors reopen it when they close. */
  reopen?: () => void;
  /** Show only due and upcoming (narrow tiles). */
  compact?: boolean;
}

/** Renders the full panel into el. Returns a cleanup function. */
export function renderPanel(el: HTMLElement, opts: PanelOpts = {}): () => void {
  const back = () => opts.reopen?.();
  const list = h('div', { class: 'rem-list' });
  let showDone = false;
  let listKey = '';
  const tick: (() => void)[] = [];

  el.append(
    h(
      'div',
      { class: 'rem' },
      h(
        'div',
        { class: 'rem-head' },
        h('h3', { class: 'rem-heading' }, '📌 Reminders'),
        h('button', { class: 'btn btn-ghost rem-sounds', onclick: () => openSoundSettings(back) }, '🔔 Sound'),
      ),
      list,
      h('button', { class: 'btn btn-primary rem-add', onclick: () => openEditor(null, back) }, '＋ New reminder'),
    ),
  );

  function render() {
    const s = reminders.state;
    if (!s) {
      list.replaceChildren(h('p', { class: 'empty' }, 'Loading…'));
      return;
    }
    const key = JSON.stringify([s.reminders, showDone, new Date(reminders.now()).toDateString()]);
    if (key === listKey) return;
    listKey = key;
    tick.length = 0;

    const due = s.reminders.filter((r) => r.state === 'due').sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
    const upcoming = s.reminders
      .filter((r) => r.state !== 'due' && !r.completedAt && (r.state === 'snoozed' || (r.enabled && r.nextAt !== null)))
      .sort((a, b) => upcomingAt(a) - upcomingAt(b));
    const paused = s.reminders.filter((r) => r.state === 'idle' && !r.completedAt && (!r.enabled || r.nextAt === null));
    const done = s.reminders.filter((r) => r.completedAt && r.state === 'idle').sort((a, b) => b.completedAt! - a.completedAt!);

    const out: Node[] = [];
    if (due.length) out.push(h('div', { class: 'rem-group rem-group-due' }, 'Due now'), ...due.map(dueRow));
    let lastDay = '';
    for (const r of upcoming) {
      const day = dayLabel(new Date(upcomingAt(r)), new Date(reminders.now()));
      if (day !== lastDay) out.push(h('div', { class: 'rem-group' }, day));
      lastDay = day;
      out.push(row(r));
    }
    if (!opts.compact && paused.length) out.push(h('div', { class: 'rem-group' }, 'Off'), ...paused.map(row));
    if (!due.length && !upcoming.length && !(opts.compact ? 0 : paused.length)) {
      out.push(h('p', { class: 'empty' }, 'No reminders coming up'));
    }
    if (!opts.compact && done.length) {
      out.push(
        h(
          'div',
          { class: 'rem-done-head' },
          h('button', { class: 'btn btn-ghost', onclick: () => ((showDone = !showDone), render()) }, `${showDone ? '▾' : '▸'} Completed (${done.length})`),
          showDone && h('button', { class: 'btn btn-ghost', onclick: () => void reminders.clearCompleted().catch(fail) }, 'Clear'),
        ),
      );
      if (showDone) out.push(...done.map(row));
    }
    list.replaceChildren(...out);
    tick.forEach((fn) => fn());
  }

  function row(r: Reminder): HTMLElement {
    const when = h('span', { class: 'rem-in' });
    const at = r.state === 'snoozed' ? r.snoozeUntil : r.nextAt;
    tick.push(() => {
      const now = reminders.now();
      if (r.completedAt) when.textContent = `Done ${formatWhen(r.completedAt, new Date(now))}`;
      else if (r.state === 'snoozed' && r.snoozeUntil) when.textContent = `💤 ${formatIn(r.snoozeUntil - now)}`;
      else when.textContent = r.enabled && at ? formatIn(at - now) : 'Off';
    });
    const time = at ? new Date(at) : null;
    return h(
      'button',
      { class: `rem-row${r.completedAt ? ' done' : ''}${!r.enabled && !r.completedAt ? ' off' : ''}`, onclick: () => openEditor(r, back) },
      h('span', { class: 'rem-time' }, time ? formatAlarmTime(time.getHours(), time.getMinutes()) : formatAlarmTime(r.hour, r.minute)),
      h(
        'span',
        { class: 'rem-text' },
        h('span', { class: 'rem-title' }, r.title),
        h('span', { class: 'rem-meta' }, [formatRepeat(r), r.notes].filter(Boolean).join(' · '), ' · ', when),
      ),
    );
  }

  function dueRow(r: Reminder): HTMLElement {
    return h(
      'div',
      { class: 'rem-row rem-due' },
      h(
        'button',
        { class: 'rem-text', onclick: () => openEditor(r, back) },
        h('span', { class: 'rem-title' }, r.title),
        h('span', { class: 'rem-meta' }, [r.dueAt !== null ? formatWhen(r.dueAt) : '', r.notes].filter(Boolean).join(' · ')),
      ),
      h('button', { class: 'btn', onclick: () => void reminders.snooze(r.id, 10).catch(fail) }, '💤 10 min'),
      h('button', { class: 'btn btn-primary', onclick: () => void reminders.done(r.id).catch(fail) }, '✓ Done'),
    );
  }

  const off = reminders.subscribe(render);
  const timer = window.setInterval(() => {
    render();
    tick.forEach((fn) => fn());
  }, 1000);
  render();
  return () => {
    off();
    clearInterval(timer);
  };
}

const upcomingAt = (r: Reminder) => (r.state === 'snoozed' ? r.snoozeUntil : r.nextAt) ?? Infinity;

/** Opens the panel in a bottom sheet (small tiles and the top-bar chip). */
export function openRemindersSheet() {
  const body = h('div', { class: 'rem-sheet' });
  let cleanup = () => {};
  openSheet('Reminders', [body], { onClose: () => cleanup() });
  cleanup = renderPanel(body, { reopen: () => openRemindersSheet() });
}

// ---- Editor -------------------------------------------------------------------

function openEditor(existing: Reminder | null, back: () => void) {
  const now = new Date(reminders.now());
  // New reminders start at the next whole hour.
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1);
  const r: ReminderInput & { enabled: boolean } = {
    title: existing?.title ?? '',
    notes: existing?.notes ?? '',
    date: existing?.date ?? toDateKey(start),
    hour: existing?.hour ?? start.getHours(),
    minute: existing?.minute ?? 0,
    repeat: existing?.repeat ?? 'none',
    interval: existing?.interval ?? 1,
    days: [...(existing?.days ?? [])],
    until: existing?.until ?? null,
    sound: existing?.sound ?? null,
    enabled: existing?.enabled ?? true,
  };
  // A finished one-time reminder opened again starts from today, so Save brings it back.
  if (existing?.completedAt && existing.repeat === 'none') {
    r.date = toDateKey(start);
    r.hour = start.getHours();
    r.minute = 0;
  }

  const title = h('input', { type: 'text', class: 'rem-input', placeholder: 'What to remember', value: r.title, maxlength: 120 });
  const notes = h('input', { type: 'text', class: 'rem-input', placeholder: 'Notes (optional)', value: r.notes, maxlength: 500 });
  const quick = h('div', { class: 'chips' });
  const dateText = h('span', { class: 'rem-date-text' });
  const hourText = h('span', { class: 'rem-num' });
  const minuteText = h('span', { class: 'rem-num' });
  const ampm = h('div', { class: 'rem-ampm' });
  const repeatChips = h('div', { class: 'chips' });
  const repeatMore = h('div', { class: 'rem-repeat-more' });
  const warning = h('p', { class: 'rem-warning', hidden: true });
  const saveBtn = h('button', { class: 'btn btn-primary' }, 'Save');

  const dateOf = () => fromDateKey(r.date);
  const setDate = (d: Date) => (r.date = toDateKey(d));
  const shiftDate = (n: number) => {
    const d = dateOf();
    d.setDate(d.getDate() + n);
    setDate(d);
    show();
  };
  const setAt = (d: Date) => {
    setDate(d);
    r.hour = d.getHours();
    r.minute = d.getMinutes();
    show();
  };

  const presets: [string, () => Date][] = [
    ['In 1 hr', () => roundTo5(new Date(reminders.now() + 3600000))],
    ['Tonight 8 PM', () => withTime(new Date(reminders.now()), 20, 0)],
    ['Tomorrow 9 AM', () => withTime(addDays(new Date(reminders.now()), 1), 9, 0)],
    ['Next week', () => withTime(addDays(dateOf(), 7), r.hour, r.minute)],
  ];

  function show() {
    const t = reminders.now();
    const d = dateOf();
    dateText.textContent = `${dayLabel(d, new Date(t))}${['Today', 'Tomorrow', 'Yesterday'].includes(dayLabel(d, new Date(t))) ? ` · ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}`;
    hourText.textContent = uses12h ? String(r.hour % 12 || 12) : String(r.hour).padStart(2, '0');
    minuteText.textContent = String(r.minute).padStart(2, '0');
    if (uses12h) {
      ampm.replaceChildren(
        ...['AM', 'PM'].map((p, i) =>
          h('button', { class: `chip${(r.hour >= 12 ? 1 : 0) === i ? ' active' : ''}`, onclick: () => ((r.hour = (r.hour % 12) + i * 12), show()) }, p),
        ),
      );
    }
    quick.replaceChildren(...presets.map(([label, fn]) => h('button', { class: 'chip', onclick: () => setAt(fn()) }, label)));
    repeatChips.replaceChildren(
      ...REPEATS.map(([id, label]) =>
        h('button', { class: `chip${r.repeat === id ? ' active' : ''}`, onclick: () => ((r.repeat = id), (r.interval = 1), show()) }, label),
      ),
    );
    repeatMore.replaceChildren(...repeatOptions());

    const startAt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), r.hour, r.minute).getTime();
    let problem = '';
    if (r.repeat === 'none' && startAt <= t) problem = 'That time has already passed.';
    else if (r.until && r.until < r.date) problem = 'The end date is before the start date.';
    warning.hidden = !problem;
    warning.textContent = problem;
    saveBtn.disabled = Boolean(problem) || !title.value.trim();
  }

  function repeatOptions(): Node[] {
    if (r.repeat === 'none') return [];
    const unit = r.repeat;
    const out: Node[] = [
      h(
        'div',
        { class: 'rem-every' },
        h('span', {}, 'Every'),
        h('button', { class: 'btn', 'aria-label': 'Fewer', disabled: r.interval <= 1, onclick: () => ((r.interval = Math.max(1, r.interval - 1)), show()) }, '−'),
        h('span', { class: 'rem-every-n' }, String(r.interval)),
        h('button', { class: 'btn', 'aria-label': 'More', disabled: r.interval >= 99, onclick: () => ((r.interval = Math.min(99, r.interval + 1)), show()) }, '＋'),
        h('span', {}, repeatUnit(unit, r.interval)),
      ),
    ];
    if (unit === 'weekly') {
      const days = r.days.length ? r.days : [dateOf().getDay()];
      out.push(
        h(
          'div',
          { class: 'rem-days' },
          ...DAY_LETTERS.map((l, d) =>
            h(
              'button',
              {
                class: `rem-day${days.includes(d) ? ' active' : ''}`,
                'aria-label': DAY_NAMES[d],
                onclick: () => {
                  const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort();
                  r.days = next.length ? next : days;
                  show();
                },
              },
              l,
            ),
          ),
        ),
      );
    }
    const endDate = r.until ? fromDateKey(r.until) : null;
    out.push(
      h(
        'div',
        { class: 'rem-ends' },
        h('span', {}, 'Ends'),
        h('button', { class: `chip${!r.until ? ' active' : ''}`, onclick: () => ((r.until = null), show()) }, 'Never'),
        h(
          'button',
          { class: `chip${r.until ? ' active' : ''}`, onclick: () => ((r.until = r.until ?? toDateKey(addDays(dateOf(), 30))), show()) },
          'On a date',
        ),
        endDate &&
          h(
            'span',
            { class: 'rem-date-row' },
            holdButton('◀', 'Earlier end date', () => ((r.until = toDateKey(addDays(fromDateKey(r.until!), -1))), show())),
            h('span', { class: 'rem-date-text small' }, endDate.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })),
            holdButton('▶', 'Later end date', () => ((r.until = toDateKey(addDays(fromDateKey(r.until!), 1))), show())),
          ),
      ),
    );
    return out;
  }

  title.addEventListener('input', () => show());

  const sound = h(
    'select',
    { class: 'rem-sound', onchange: () => (r.sound = (sound.value || null) as ToneId | null) },
    h('option', { value: '', selected: !r.sound }, `Default (${toneName(reminders.state?.settings.sound ?? 'marimba')})`),
    ...TONES.map((t) => h('option', { value: t.id, selected: r.sound === t.id }, t.name)),
  );
  const enabled = h('input', { type: 'checkbox', class: 'toggle', checked: r.enabled, onchange: () => (r.enabled = enabled.checked) });

  let saved = false;
  const save = () => {
    if (saveBtn.disabled) return;
    saved = true;
    const body: ReminderInput & { enabled: boolean } = { ...r, title: title.value.trim(), notes: notes.value.trim() };
    if (body.repeat === 'weekly' && !body.days.length) body.days = [dateOf().getDay()];
    const doneP = existing ? reminders.update(existing.id, body) : reminders.create(body);
    doneP.then(back, fail);
    sheet.close();
  };
  saveBtn.onclick = save;

  let armed = false;
  const del = h(
    'button',
    {
      class: 'btn btn-danger',
      onclick: () => {
        if (!existing) return;
        if (!armed) {
          armed = true;
          del.textContent = 'Tap again to delete';
          return;
        }
        saved = true;
        reminders.remove(existing.id).then(back, fail);
        sheet.close();
      },
    },
    'Delete',
  );

  const timeCol = (text: HTMLElement, step: (d: number) => void, name: string) =>
    h('div', { class: 'rem-col' }, holdButton('▲', `Later ${name}`, () => step(1)), text, holdButton('▼', `Earlier ${name}`, () => step(-1)));

  const sheet = openSheet(existing ? 'Edit reminder' : 'New reminder', [
    h('div', { class: 'rem-editor' },
      title,
      notes,
      h('h3', {}, 'When'),
      quick,
      h(
        'div',
        { class: 'rem-when-row' },
        h('span', { class: 'rem-date-row' }, holdButton('◀', 'Day before', () => shiftDate(-1)), dateText, holdButton('▶', 'Day after', () => shiftDate(1))),
        h(
          'span',
          { class: 'rem-clock' },
          timeCol(hourText, (d) => ((r.hour = (r.hour + d + 24) % 24), show()), 'hour'),
          h('span', { class: 'rem-colon' }, ':'),
          timeCol(minuteText, (d) => ((r.minute = stepMinute(r.minute, d)), show()), 'minute'),
          uses12h && ampm,
        ),
      ),
      h('h3', {}, 'Repeat'),
      repeatChips,
      repeatMore,
      h(
        'label',
        { class: 'field' },
        h('span', {}, 'Sound'),
        h(
          'span',
          { class: 'rem-sound-row' },
          sound,
          h(
            'button',
            { class: 'btn', 'aria-label': 'Play sound', onclick: () => preview((sound.value || reminders.state?.settings.sound || 'marimba') as ToneId, reminders.state?.settings.volume ?? 80) },
            '▶',
          ),
        ),
      ),
      existing && !existing.completedAt && h('label', { class: 'field' }, h('span', {}, 'On'), enabled),
      warning,
      h(
        'div',
        { class: 'menu-actions' },
        existing && del,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: () => sheet.close() }, 'Cancel'),
        saveBtn,
      ),
    ),
  ], {
    onClose: () => {
      stopPreview();
      if (!saved) back();
    },
  });
  show();
  if (!existing) title.focus();
}

/** Steps through :00, :05, :10…, snapping an odd minute to the 5 in that direction. */
function stepMinute(minute: number, d: number): number {
  const next = d > 0 ? (Math.floor(minute / 5) + 1) * 5 : (Math.ceil(minute / 5) - 1) * 5;
  return (next + 60) % 60;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function withTime(d: Date, hour: number, minute: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute);
}

function roundTo5(d: Date): Date {
  const x = new Date(d);
  x.setSeconds(0, 0);
  x.setMinutes(Math.round(x.getMinutes() / 5) * 5);
  return x;
}

// ---- Sound settings ---------------------------------------------------------

function openSoundSettings(back: () => void) {
  const body = h('div', {});
  const sheet = openSheet('Reminder sound', [body], {
    onClose: () => {
      stopPreview();
      off();
      back();
    },
  });
  const save = (patch: Parameters<typeof reminders.saveSettings>[0]) => void reminders.saveSettings(patch).catch(fail);
  const chips = <T extends number | string>(values: T[], current: T, text: (v: T) => string, pick: (v: T) => void) =>
    h('div', { class: 'chips' }, ...values.map((v) => h('button', { class: `chip${v === current ? ' active' : ''}`, onclick: () => pick(v) }, text(v))));

  let volumeDrag = false;
  const render = () => {
    const s = reminders.state?.settings;
    if (!s || volumeDrag) return;
    const volumeLabel = h('span', { class: 'rem-volume-value' }, `${s.volume}%`);
    const volume = h('input', {
      type: 'range',
      class: 'rem-volume',
      min: 0,
      max: 100,
      step: 5,
      value: String(s.volume),
      oninput: () => {
        volumeDrag = true;
        volumeLabel.textContent = `${volume.value}%`;
      },
      onchange: () => {
        volumeDrag = false;
        save({ volume: Number(volume.value) });
        preview(s.sound, Number(volume.value));
      },
    });
    body.replaceChildren(
      h('h3', {}, 'Sound'),
      chips(
        TONES.map((t) => t.id),
        s.sound,
        (id) => `${id === s.sound ? '♪ ' : ''}${toneName(id)}`,
        (id) => {
          save({ sound: id });
          preview(id, s.volume);
        },
      ),
      h('h3', {}, 'Volume'),
      h('div', { class: 'rem-volume-row' }, h('span', {}, '🔈'), volume, h('span', {}, '🔊'), volumeLabel),
      h('h3', {}, 'Play the sound'),
      chips([1, 2, 3, 5], s.repeats, (n) => (n === 1 ? 'Once' : `${n} times`), (n) => save({ repeats: n })),
      h('h3', {}, 'Remind again until Done'),
      chips([0, 5, 10, 15, 30], s.nagMinutes, (m) => (m ? `Every ${m} min` : 'Off'), (m) => save({ nagMinutes: m })),
      h('p', { class: 'rem-hint' }, 'Repeat chimes stop after an hour.'),
      h(
        'button',
        {
          class: 'btn btn-wide',
          onclick: () => {
            void reminders.test().catch(fail);
            sheet.close();
          },
        },
        '▶ Test: remind me in 5 seconds',
      ),
    );
  };
  const off = reminders.subscribe(render);
  render();
}
