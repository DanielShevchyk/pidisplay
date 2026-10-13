// The survey itself: every turned-on question on one screen, answered with big
// taps. Used by the morning popup, the tile's "Check in" button and the history
// list (to fill in or fix a past day).
import { h } from '../../core/dom';
import { active, checkin, dayLabel, goodness, goodnessColor, type Answer, type Book, type Question } from '../../core/checkin';

export interface FormOptions {
  profile: string;
  date: string;
  /** Called after a successful save or delete. */
  onDone(): void;
  /** Shows a "Later" button (the morning popup). */
  onLater?(): void;
  /** Text for that button; "Back" when the popup has a person picker. */
  laterLabel?: string;
}

/** The last hours-slept answer before `date`, as the stepper's starting point. */
function lastHours(book: Book, q: Question, date: string): number {
  const entries = book.entries;
  const prev = Object.keys(entries)
    .filter((d) => d < date && typeof entries[d].answers[q.id] === 'number')
    .sort()
    .pop();
  return prev ? (entries[prev].answers[q.id] as number) : 7;
}

export function renderForm(opts: FormOptions): HTMLElement {
  const s = checkin.state!;
  const book = checkin.book(opts.profile)!;
  const existing = book.entries[opts.date];
  const answers: Record<string, Answer | null> = { ...(existing?.answers ?? {}) };
  const questions = active(book);
  // Turned-off questions answered on this day keep their answers.
  for (const id of Object.keys(answers)) if (!questions.some((q) => q.id === id)) delete answers[id];

  const error = h('div', { class: 'ci-error' });
  const save = h('button', { class: 'btn btn-primary ci-save', onclick: () => void submit() }, existing ? 'Save changes' : 'Save');
  const note = h('input', {
    type: 'text',
    class: 'ci-note',
    placeholder: 'Anything else? (optional)',
    value: existing?.note ?? '',
    maxlength: 500,
  });

  const refreshSave = () => {
    save.disabled = !Object.values(answers).some((v) => v !== null && v !== undefined) && !note.value.trim();
  };
  note.addEventListener('input', refreshSave);

  function scaleRow(q: Question): HTMLElement {
    const buttons = [1, 2, 3, 4, 5].map((n) =>
      h('button', { class: 'ci-opt ci-num', 'data-v': n, onclick: () => pick(n) }, String(n)),
    );
    const paint = () =>
      buttons.forEach((b, i) => {
        const on = answers[q.id] === i + 1;
        b.classList.toggle('on', on);
        b.style.setProperty('--ci-c', on ? goodnessColor(goodness(q, i + 1)) : '');
      });
    const pick = (n: number) => {
      answers[q.id] = answers[q.id] === n ? null : n;
      paint();
      refreshSave();
    };
    paint();
    return h(
      'div',
      { class: 'ci-scale' },
      h('div', { class: 'ci-opts' }, ...buttons),
      (q.low || q.high) && h('div', { class: 'ci-ends' }, h('span', {}, q.low ?? ''), h('span', {}, q.high ?? '')),
    );
  }

  function hoursRow(q: Question): HTMLElement {
    const value = h('button', { class: 'ci-hours-value' });
    const paint = () => {
      const v = answers[q.id];
      value.classList.toggle('unset', typeof v !== 'number');
      value.style.setProperty('--ci-c', typeof v === 'number' ? goodnessColor(goodness(q, v)) : '');
      value.textContent = typeof v === 'number' ? `${v} h` : `${lastHours(book, q, opts.date)} h?`;
    };
    const step = (d: number) => {
      const cur = typeof answers[q.id] === 'number' ? (answers[q.id] as number) : lastHours(book, q, opts.date);
      answers[q.id] = Math.min(16, Math.max(0, cur + d));
      paint();
      refreshSave();
    };
    // Tapping the guess takes it as is; tapping a set value clears it.
    value.addEventListener('click', () => {
      answers[q.id] = typeof answers[q.id] === 'number' ? null : lastHours(book, q, opts.date);
      paint();
      refreshSave();
    });
    paint();
    return h(
      'div',
      { class: 'ci-hours' },
      h('button', { class: 'ci-opt', onclick: () => step(-0.5), 'aria-label': 'Half an hour less' }, '−'),
      value,
      h('button', { class: 'ci-opt', onclick: () => step(0.5), 'aria-label': 'Half an hour more' }, '+'),
    );
  }

  function yesNoRow(q: Question): HTMLElement {
    const make = (v: boolean) => h('button', { class: 'ci-opt ci-yn', onclick: () => pick(v) }, v ? 'Yes' : 'No');
    const no = make(false);
    const yes = make(true);
    const paint = () => {
      no.classList.toggle('on', answers[q.id] === false);
      yes.classList.toggle('on', answers[q.id] === true);
    };
    const pick = (v: boolean) => {
      answers[q.id] = answers[q.id] === v ? null : v;
      paint();
      refreshSave();
    };
    paint();
    return h('div', { class: 'ci-opts ci-opts-yn' }, no, yes);
  }

  async function submit() {
    save.disabled = true;
    error.textContent = '';
    try {
      await checkin.saveEntry(book.id, opts.date, answers, s.settings.note ? note.value : (existing?.note ?? ''));
      opts.onDone();
    } catch (err) {
      error.textContent = (err as Error).message;
      refreshSave();
    }
  }

  async function remove() {
    try {
      await checkin.deleteEntry(book.id, opts.date);
      opts.onDone();
    } catch (err) {
      error.textContent = (err as Error).message;
    }
  }

  const rows = questions.map((q) =>
    h(
      'div',
      { class: `ci-q ci-q-${q.type}` },
      h('div', { class: 'ci-label' }, q.label),
      q.type === 'scale' ? scaleRow(q) : q.type === 'hours' ? hoursRow(q) : yesNoRow(q),
    ),
  );
  refreshSave();

  return h(
    'div',
    { class: 'ci-form' },
    opts.date !== s.today && h('div', { class: 'ci-for' }, `For ${dayLabel(opts.date, s.today)}`),
    h('div', { class: 'ci-questions' }, ...rows, s.settings.note && note),
    error,
    h(
      'div',
      { class: 'ci-actions' },
      save,
      opts.onLater && h('button', { class: 'btn ci-later', onclick: () => opts.onLater!() }, opts.laterLabel ?? 'Later'),
      existing && !opts.onLater && h('button', { class: 'btn btn-danger', onclick: () => void remove() }, 'Delete day'),
    ),
  );
}
