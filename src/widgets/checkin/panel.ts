// Check-in screens: the trends panel (big tiles and a sheet), the day-by-day
// history, and the settings sheet (people, morning popup, each person's questions).
import { h } from '../../core/dom';
import { openSheet } from '../../core/sheet';
import {
  active,
  checkin,
  dayLabel,
  daysBack,
  formatAnswer,
  formatMinutes,
  goodness,
  goodnessColor,
  type Book,
  type CheckinSettings,
  type Profile,
  type Question,
  type QuestionType,
} from '../../core/checkin';
import { renderForm } from './form';
import { drawChart, factorCard, factors, isNumeric, ownAxis, RANGES, SERIES, statCard, stats, type Range } from './trends';

export interface View {
  range: Range;
  /** Question ids shown in the chart; empty means the default (sleep and mood). */
  metrics: string[];
  /** Whose check-in this tile shows; missing means the first person. */
  profile?: string;
}

export const DEFAULT_VIEW: View = { range: '30d', metrics: [] };

/** Icons offered for a person; matches EMOJIS in server/checkin.js. */
export const EMOJIS = ['🙂', '🌞', '🌙', '⭐', '🌸', '🍀', '🦊', '🐻', '🐱', '🐶', '🚀', '🎨'];

const possessive = (name: string) => (name.endsWith('s') ? `${name}'` : `${name}'s`);
const many = () => (checkin.state?.profiles.length ?? 0) > 1;

/** "Dan's check-in", or just "Check-in" while there is only one person. */
export function titleFor(p: Profile, what = 'check-in'): string {
  return many() ? `${p.emoji} ${possessive(p.name)} ${what}` : what[0].toUpperCase() + what.slice(1);
}

export function openFormSheet(profile: string | undefined, date?: string) {
  const s = checkin.state;
  const book = checkin.book(profile);
  if (!s || !book) return;
  const day = date ?? s.today;
  const title = day === s.today ? `☀️ ${titleFor(book)}` : titleFor(book);
  const sheet = openSheet(title, [renderForm({ profile: book.id, date: day, onDone: () => sheet.close() })]);
}

/** Small answer pills for one day, colored good to bad. */
export function answerPills(book: Book, date: string, limit = 99): HTMLElement[] {
  const e = book.entries[date];
  if (!e) return [];
  return book.questions
    .filter((q) => e.answers[q.id] !== undefined)
    .slice(0, limit)
    .map((q) => {
      const v = e.answers[q.id];
      const g = goodness(q, v);
      return h(
        'span',
        { class: 'ci-pill', style: g === null ? '' : `--ci-c:${goodnessColor(g)}` },
        h('span', { class: 'ci-pill-name' }, q.short),
        h('b', {}, formatAnswer(q, v)),
      );
    });
}

/** A row of person chips (only when there is more than one person). */
export function personChips(current: string, onPick: (id: string) => void, short = false): HTMLElement[] {
  const s = checkin.state;
  if (!s || s.profiles.length < 2) return [];
  return s.profiles.map((p) =>
    h(
      'button',
      { class: `chip ci-person${p.id === current ? ' active' : ''}`, 'aria-label': p.name, onclick: () => onPick(p.id) },
      short ? p.emoji : `${p.emoji} ${p.name}`,
    ),
  );
}

/** compact: tall and large tiles (no metric chips, stats or factors); narrow: tall tiles. */
export function renderPanel(
  el: HTMLElement,
  opts: { compact: boolean; narrow?: boolean; view: View; onView(v: View): void },
): () => void {
  let view = { ...opts.view };
  const people = h('div', { class: 'chips ci-people' });
  const today = h('div', { class: 'ci-today' });
  const ranges = h('div', { class: 'chips ci-ranges' });
  const metrics = h('div', { class: 'chips ci-metrics' });
  const chart = h('div', { class: 'ci-chart' });
  const statsRow = h('div', { class: 'ci-stats' });
  const factorList = h('div', { class: 'ci-factors' });
  const empty = h('div', { class: 'ci-empty' });
  // Small tiles have no metric chips, so name the lines next to the heading.
  const legend = h('div', { class: 'ci-legend' });
  const root = h(
    'div',
    { class: `ci-panel${opts.compact ? ' compact' : ''}` },
    h(
      'div',
      { class: 'ci-head' },
      h('h3', { class: 'ci-heading' }, opts.narrow ? '☀️' : '☀️ Check-in'),
      legend,
      h('button', { class: 'btn btn-ghost', 'aria-label': 'Check-in history', onclick: () => openHistorySheet(view.profile) }, opts.narrow ? '🗓' : 'History'),
      h('button', { class: 'btn btn-ghost', 'aria-label': 'Check-in settings', onclick: () => openSettingsSheet(view.profile) }, '⚙'),
    ),
    people,
    today,
    ranges,
    metrics,
    chart,
    empty,
    statsRow,
    factorList,
  );
  el.append(root);

  const book = () => checkin.book(view.profile);
  const selected = (b: Book): Question[] => {
    const shown = active(b).filter(isNumeric);
    const picked = shown.filter((q) => view.metrics.includes(q.id));
    if (picked.length) return picked;
    // Two lines read better than six; sleep and mood when they're on.
    const scales = shown.filter((q) => q.type === 'scale');
    const preferred = scales.filter((q) => q.id === 'sleep' || q.id === 'mood');
    return preferred.length ? preferred : scales.slice(0, 2);
  };
  const colorOf = (b: Book, q: Question) => SERIES[Math.max(0, b.questions.indexOf(q)) % SERIES.length];

  const setView = (v: View) => {
    view = v;
    opts.onView(v);
    render();
  };

  const toggleMetric = (b: Book, q: Question) => {
    const cur = selected(b).map((x) => x.id);
    let next: string[];
    if (ownAxis(q)) next = cur.length === 1 && cur[0] === q.id ? [] : [q.id];
    else {
      const scales = cur.filter((id) => b.questions.find((x) => x.id === id)?.type === 'scale');
      next = scales.includes(q.id) ? scales.filter((id) => id !== q.id) : [...scales, q.id];
    }
    setView({ ...view, metrics: next });
  };

  function render() {
    const b = book();
    if (!b) return;
    people.replaceChildren(...personChips(b.id, (id) => setView({ ...view, profile: id, metrics: [] }), opts.compact));
    people.hidden = !many();

    const entry = b.entries[b.today];
    const who = many() && !opts.compact ? ` · ${b.name}` : '';
    today.replaceChildren(
      entry
        ? h(
            'button',
            { class: 'ci-today-done', onclick: () => openFormSheet(b.id) },
            h('span', { class: 'ci-today-label' }, `✓ Today${who}`),
            ...answerPills(b, b.today, opts.narrow ? 2 : opts.compact ? 4 : 99),
          )
        : h(
            'button',
            { class: 'btn btn-primary ci-start', onclick: () => openFormSheet(b.id) },
            opts.compact ? 'Check in' : many() ? `☀️ Check in for ${b.name}` : '☀️ Check in for today',
          ),
    );

    ranges.replaceChildren(
      ...RANGES.map(([r, label, n]) =>
        h(
          'button',
          { class: `chip${view.range === r ? ' active' : ''}`, onclick: () => setView({ ...view, range: r }) },
          opts.compact ? (n === 365 ? '1Y' : `${n}D`) : label,
        ),
      ),
    );

    const sel = selected(b);
    legend.replaceChildren(...(opts.compact ? sel.map((q) => h('span', { style: `color:${colorOf(b, q)}` }, q.short)) : []));
    metrics.replaceChildren(
      ...active(b)
        .filter(isNumeric)
        .map((q) =>
          h(
            'button',
            { class: `chip ci-metric${sel.includes(q) ? ' on' : ''}`, style: `--ci-c:${colorOf(b, q)}`, onclick: () => toggleMetric(b, q) },
            q.short,
          ),
        ),
    );

    const answered = Object.keys(b.entries).length;
    empty.textContent = answered < 2 ? 'Trends show up here after a few mornings.' : '';
    empty.hidden = answered >= 2;
    drawChart(chart, b, sel.map((q) => ({ q, color: colorOf(b, q) })), view.range);
    statsRow.replaceChildren(...stats(b, active(b), view.range).map(statCard));
    const fs = factors(b, active(b), view.range);
    factorList.replaceChildren(...(fs.length ? [h('div', { class: 'ci-sub' }, 'What goes with what'), ...fs.map(factorCard)] : []));
  }

  const off = checkin.subscribe(render);
  const resize = new ResizeObserver(() => {
    const b = book();
    if (b) drawChart(chart, b, selected(b).map((q) => ({ q, color: colorOf(b, q) })), view.range);
  });
  resize.observe(chart);
  return () => {
    off();
    resize.disconnect();
  };
}

export function openTrendsSheet(view: View, onView: (v: View) => void) {
  const box = h('div', { class: 'ci-sheet' });
  let destroy = () => {};
  openSheet('Check-in trends', [box], { onClose: () => destroy() });
  destroy = renderPanel(box, { compact: false, view, onView });
}

// ---- History ----------------------------------------------------------------

export function openHistorySheet(profile: string | undefined) {
  let current = profile;
  const people = h('div', { class: 'chips ci-people' });
  const list = h('div', { class: 'ci-history' });
  let off = () => {};
  openSheet('Check-in history', [people, list], { onClose: () => off() });
  const render = () => {
    const b = checkin.book(current);
    if (!b) return;
    people.replaceChildren(...personChips(b.id, (id) => ((current = id), render())));
    people.hidden = !many();
    // The last 60 days, plus any older answered days.
    const recent = daysBack(b.today, 60).reverse();
    const older = Object.keys(b.entries)
      .filter((d) => d < recent[recent.length - 1])
      .sort()
      .reverse();
    list.replaceChildren(
      ...[...recent, ...older].map((d) => {
        const pills = answerPills(b, d);
        const note = b.entries[d]?.note;
        return h(
          'button',
          { class: `ci-day${pills.length ? '' : ' missing'}`, onclick: () => openFormSheet(b.id, d) },
          h('span', { class: 'ci-day-date' }, dayLabel(d, b.today)),
          h(
            'span',
            { class: 'ci-day-vals' },
            ...(pills.length ? pills : [h('span', { class: 'ci-day-none' }, 'Not answered · tap to fill in')]),
            note && h('span', { class: 'ci-day-note' }, `“${note}”`),
          ),
        );
      }),
    );
  };
  off = checkin.subscribe(render);
}

// ---- Settings ---------------------------------------------------------------

const STEP = 15;

export function openSettingsSheet(profile: string | undefined) {
  const content = h('div', { class: 'ci-settings' });
  let current = checkin.book(profile)?.id;
  let error = '';
  /** A form with typing in progress: 'question', 'person', or a person id being edited. */
  let editing: string | null = null;
  /** Person id whose Delete was tapped once. */
  let confirmDelete: string | null = null;
  let off = () => {};
  openSheet('Check-in settings', [content], { onClose: () => off() });

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
      error = '';
    } catch (err) {
      error = (err as Error).message;
    }
    render();
  };
  const saveSettings = (patch: Partial<CheckinSettings>) => run(() => checkin.saveSettings(patch));

  const toggle = (checked: boolean, onchange: (v: boolean) => void) =>
    h('input', { type: 'checkbox', class: 'toggle', checked, onchange: (e: Event) => onchange((e.target as HTMLInputElement).checked) });

  const stepper = (label: string, key: 'promptAt' | 'promptUntil', value: number) =>
    h(
      'div',
      { class: 'sleep-row' },
      h('span', {}, label),
      h(
        'div',
        { class: 'sleep-stepper' },
        h('button', { class: 'btn', 'aria-label': `${label} earlier`, onclick: () => saveSettings({ [key]: Math.max(0, value - STEP) }) }, '−'),
        h('span', { class: 'sleep-time' }, formatMinutes(value % (24 * 60))),
        h('button', { class: 'btn', 'aria-label': `${label} later`, onclick: () => saveSettings({ [key]: Math.min(24 * 60, value + STEP) }) }, '+'),
      ),
    );

  function emojiPicker(value: string, onPick: (e: string) => void): HTMLElement {
    const box = h('div', { class: 'chips ci-emojis' });
    const paint = (v: string) =>
      box.replaceChildren(...EMOJIS.map((e) => h('button', { class: `chip${e === v ? ' active' : ''}`, onclick: () => (onPick(e), paint(e)) }, e)));
    paint(value);
    return box;
  }

  /** Add a person, or edit one (name, icon, popup, delete). */
  function personForm(p: Profile | null): HTMLElement {
    const s = checkin.state!;
    let emoji = p?.emoji ?? EMOJIS[s.profiles.length % EMOJIS.length];
    let copyFrom = '';
    const name = h('input', { type: 'text', placeholder: 'Name', value: p?.name ?? '', maxlength: 30 });
    const copyChips = h('div', { class: 'chips' });
    const paintCopy = () =>
      copyChips.replaceChildren(
        h('button', { class: `chip${copyFrom === '' ? ' active' : ''}`, onclick: () => ((copyFrom = ''), paintCopy()) }, 'Built-in'),
        ...s.profiles.map((x) =>
          h('button', { class: `chip${copyFrom === x.id ? ' active' : ''}`, onclick: () => ((copyFrom = x.id), paintCopy()) }, `Same as ${x.name}`),
        ),
      );
    paintCopy();
    const save = () => {
      const fields = { name: name.value.trim(), emoji };
      editing = null;
      void run(async () => {
        if (p) await checkin.updateProfile(p.id, fields);
        else {
          await checkin.addProfile({ ...fields, ...(copyFrom ? { copyFrom } : {}) });
          // Show the new person's questions.
          current = checkin.state!.profiles[checkin.state!.profiles.length - 1].id;
        }
      });
    };
    return h(
      'div',
      { class: 'ci-add form' },
      name,
      emojiPicker(emoji, (e) => (emoji = e)),
      !p && h('div', { class: 'ci-hint' }, 'Questions to start with'),
      !p && copyChips,
      h(
        'div',
        { class: 'ci-actions' },
        h('button', { class: 'btn btn-primary', onclick: save }, p ? 'Save' : 'Add person'),
        h('button', { class: 'btn', onclick: () => ((editing = null), render()) }, 'Cancel'),
      ),
    );
  }

  function personRow(p: Profile): HTMLElement {
    if (editing === p.id) return personForm(p);
    const s = checkin.state!;
    const deleting = confirmDelete === p.id;
    return h(
      'div',
      { class: 'sleep-row ci-qrow' },
      h(
        'button',
        { class: 'ci-person-name', onclick: () => ((editing = p.id), (confirmDelete = null), render()) },
        h('span', {}, `${p.emoji} ${p.name}`),
        h('small', {}, `${Object.keys(p.entries).length} days answered · tap to rename`),
      ),
      h(
        'span',
        { class: 'ci-qrow-ctl' },
        s.profiles.length > 1 &&
          h(
            'button',
            {
              class: deleting ? 'btn btn-danger' : 'btn btn-ghost',
              'aria-label': `Delete ${p.name}`,
              onclick: () => {
                if (!deleting) {
                  confirmDelete = p.id;
                  render();
                  return;
                }
                confirmDelete = null;
                void run(() => checkin.deleteProfile(p.id));
              },
            },
            deleting ? `Delete ${p.name} and their answers` : '✕',
          ),
        h('span', { class: 'ci-toggle-label' }, 'Popup'),
        toggle(p.prompt, (v) => void run(() => checkin.updateProfile(p.id, { prompt: v }))),
      ),
    );
  }

  const typeName: Record<QuestionType, string> = { scale: '1–5', hours: 'hours', weight: 'pounds', yesno: 'yes/no', choice: 'choice' };

  function questionForm(b: Book): HTMLElement {
    let type: QuestionType = 'scale';
    let lowerIsBetter = false;
    const label = h('input', { type: 'text', placeholder: 'e.g. How focused do you feel?', maxlength: 120 });
    const short = h('input', { type: 'text', placeholder: 'Short name for charts, e.g. Focus', maxlength: 24 });
    const low = h('input', { type: 'text', placeholder: 'Word under 1 (optional)', maxlength: 24 });
    const high = h('input', { type: 'text', placeholder: 'Word under 5 (optional)', maxlength: 24 });
    const scaleBits = h(
      'div',
      { class: 'ci-add-scale' },
      h('div', { class: 'ci-add-ends' }, low, high),
      h('label', { class: 'sleep-row' }, h('span', {}, 'Lower is better (like stress)'), toggle(false, (v) => (lowerIsBetter = v))),
    );
    const typeChips = h('div', { class: 'chips' });
    const paintType = () => {
      typeChips.replaceChildren(
        ...(['scale', 'yesno'] as QuestionType[]).map((t) =>
          h('button', { class: `chip${type === t ? ' active' : ''}`, onclick: () => ((type = t), paintType()) }, t === 'scale' ? 'Scale 1–5' : 'Yes / no'),
        ),
      );
      scaleBits.hidden = type !== 'scale';
    };
    paintType();
    const formError = h('p', { class: 'conn-error' });
    const add = () => {
      const text = label.value.trim();
      if (!text) {
        formError.textContent = 'Type the question first';
        return;
      }
      let id = `c-${text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'q'}`;
      while (b.questions.some((q) => q.id === id)) id += '-2';
      const q: Question = { id, label: text, short: short.value.trim(), type, enabled: true };
      if (type === 'scale') Object.assign(q, { low: low.value.trim(), high: high.value.trim(), lowerIsBetter });
      editing = null;
      void run(() => checkin.saveQuestions(b.id, [...b.questions, q]));
    };
    return h(
      'div',
      { class: 'ci-add form' },
      label,
      short,
      typeChips,
      scaleBits,
      formError,
      h(
        'div',
        { class: 'ci-actions' },
        h('button', { class: 'btn btn-primary', onclick: add }, 'Add question'),
        h('button', { class: 'btn', onclick: () => ((editing = null), render()) }, 'Cancel'),
      ),
    );
  }

  function render() {
    const s = checkin.state;
    const b = checkin.book(current);
    if (!s || !b) return;
    current = b.id;
    const st = s.settings;
    const change = (i: number, patch: Partial<Question>) =>
      void run(() => checkin.saveQuestions(b.id, b.questions.map((x, j) => (j === i ? { ...x, ...patch } : x))));
    const questionRows = b.questions.map((q, i) =>
      h(
        'div',
        { class: 'sleep-row ci-qrow' },
        h('span', { class: 'ci-qrow-text' }, h('span', {}, q.label), h('small', {}, `${q.short} · ${typeName[q.type]}`)),
        h(
          'span',
          { class: 'ci-qrow-ctl' },
          q.custom &&
            h(
              'button',
              {
                class: 'btn btn-ghost',
                'aria-label': `Remove ${q.short}`,
                onclick: () => void run(() => checkin.saveQuestions(b.id, b.questions.filter((x) => x.id !== q.id))),
              },
              '✕',
            ),
          // Required: Save stays off until it's answered.
          q.enabled &&
            h(
              'button',
              { class: `chip ci-req${q.required ? ' active' : ''}`, onclick: () => change(i, { required: !q.required }) },
              q.required ? 'Required' : 'Optional',
            ),
          toggle(q.enabled, (v) => change(i, { enabled: v })),
        ),
      ),
    );
    content.replaceChildren(
      error ? h('p', { class: 'conn-error' }, error) : '',
      h('div', { class: 'ci-sub' }, 'People'),
      ...s.profiles.map(personRow),
      editing === 'person'
        ? personForm(null)
        : h('button', { class: 'btn btn-wide', onclick: () => ((editing = 'person'), render()) }, '＋ Add a person'),

      h('div', { class: 'ci-sub' }, 'Morning popup'),
      h('label', { class: 'sleep-row' }, h('span', {}, 'Pop up in the morning'), toggle(st.prompt, (v) => void saveSettings({ prompt: v }))),
      ...(st.prompt ? [stepper('From', 'promptAt', st.promptAt), stepper('Until', 'promptUntil', st.promptUntil)] : []),
      h('label', { class: 'sleep-row' }, h('span', {}, 'Add a note field'), toggle(st.note, (v) => void saveSettings({ note: v }))),

      h('div', { class: 'ci-sub' }, many() ? `Questions for ${b.name}` : 'Questions'),
      ...(many() ? [h('div', { class: 'chips ci-people' }, ...personChips(b.id, (id) => ((current = id), (editing = null), render())))] : []),
      ...questionRows,
      editing === 'question'
        ? questionForm(b)
        : h('button', { class: 'btn btn-wide', onclick: () => ((editing = 'question'), render()) }, '＋ Add your own question'),
      h(
        'button',
        { class: 'btn btn-ghost btn-wide ci-reset', onclick: () => void run(() => checkin.resetQuestions(b.id)) },
        'Reset to the built-in questions',
      ),
      h(
        'p',
        { class: 'conn-hint' },
        'Turning a question off keeps its history. Answers are saved on the Pi in pidisplay-data/checkin.json; deploy\\checkin.ps1 on the laptop saves everyone\'s as a spreadsheet (CSV).',
      ),
    );
  }

  off = checkin.subscribe(() => {
    // Don't wipe a half-typed form when a save lands.
    if (!editing) render();
  });
}
