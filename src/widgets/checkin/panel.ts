// Check-in screens: the trends panel (big tiles and a sheet), the day-by-day
// history, and the questions & morning popup settings.
import { h } from '../../core/dom';
import { openSheet } from '../../core/sheet';
import {
  checkin,
  dayLabel,
  daysBack,
  formatAnswer,
  formatMinutes,
  goodness,
  goodnessColor,
  type CheckinSettings,
  type Question,
  type QuestionType,
} from '../../core/checkin';
import { renderForm } from './form';
import { drawChart, factorCard, factors, RANGES, SERIES, statCard, stats, type Range } from './trends';

export interface View {
  range: Range;
  /** Question ids shown in the chart; empty means the default (all 1-5 scales). */
  metrics: string[];
}

export const DEFAULT_VIEW: View = { range: '30d', metrics: [] };

export function openFormSheet(date?: string) {
  const s = checkin.state;
  if (!s) return;
  const day = date ?? s.today;
  const sheet = openSheet(day === s.today ? '☀️ Morning check-in' : 'Check-in', [
    renderForm({ date: day, onDone: () => sheet.close() }),
  ]);
}

/** Small answer pills for one day, colored good to bad. */
export function answerPills(date: string, limit = 99): HTMLElement[] {
  const s = checkin.state!;
  const e = s.entries[date];
  if (!e) return [];
  return s.questions
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

/** compact: tall and large tiles (no metric chips, stats or factors); narrow: tall tiles. */
export function renderPanel(
  el: HTMLElement,
  opts: { compact: boolean; narrow?: boolean; view: View; onView(v: View): void },
): () => void {
  let view = { ...opts.view };
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
      h('button', { class: 'btn btn-ghost', 'aria-label': 'Check-in history', onclick: () => openHistorySheet() }, opts.narrow ? '🗓' : 'History'),
      h('button', { class: 'btn btn-ghost', 'aria-label': 'Check-in settings', onclick: () => openSettingsSheet() }, '⚙'),
    ),
    today,
    ranges,
    metrics,
    chart,
    empty,
    statsRow,
    factorList,
  );
  el.append(root);

  const selected = (): Question[] => {
    const active = checkin.active().filter((q) => q.type !== 'yesno');
    const picked = active.filter((q) => view.metrics.includes(q.id));
    if (picked.length) return picked;
    // Two lines read better than six; sleep and mood when they're on.
    const scales = active.filter((q) => q.type === 'scale');
    const preferred = scales.filter((q) => q.id === 'sleep' || q.id === 'mood');
    return preferred.length ? preferred : scales.slice(0, 2);
  };
  const colorOf = (q: Question) => SERIES[Math.max(0, checkin.state!.questions.indexOf(q)) % SERIES.length];

  const setView = (v: View) => {
    view = v;
    opts.onView(v);
    render();
  };

  const toggleMetric = (q: Question) => {
    const cur = selected().map((x) => x.id);
    let next: string[];
    if (q.type === 'hours') next = cur.length === 1 && cur[0] === q.id ? [] : [q.id];
    else {
      const scales = cur.filter((id) => checkin.state!.questions.find((x) => x.id === id)?.type === 'scale');
      next = scales.includes(q.id) ? scales.filter((id) => id !== q.id) : [...scales, q.id];
    }
    setView({ ...view, metrics: next });
  };

  function render() {
    const s = checkin.state;
    if (!s) return;
    const entry = s.entries[s.today];
    today.replaceChildren(
      entry
        ? h(
            'button',
            { class: 'ci-today-done', onclick: () => openFormSheet() },
            h('span', { class: 'ci-today-label' }, '✓ Today'),
            ...answerPills(s.today, opts.narrow ? 2 : opts.compact ? 4 : 99),
          )
        : h('button', { class: 'btn btn-primary ci-start', onclick: () => openFormSheet() }, opts.compact ? 'Check in' : '☀️ Check in for today'),
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

    const sel = selected();
    legend.replaceChildren(...(opts.compact ? sel.map((q) => h('span', { style: `color:${colorOf(q)}` }, q.short)) : []));
    metrics.replaceChildren(
      ...checkin
        .active()
        .filter((q) => q.type !== 'yesno')
        .map((q) => {
          const on = sel.includes(q);
          return h(
            'button',
            { class: `chip ci-metric${on ? ' on' : ''}`, style: `--ci-c:${colorOf(q)}`, onclick: () => toggleMetric(q) },
            q.short,
          );
        }),
    );

    const answered = Object.keys(s.entries).length;
    empty.textContent = answered < 2 ? 'Trends show up here after a few mornings.' : '';
    empty.hidden = answered >= 2;
    drawChart(chart, s, sel.map((q) => ({ q, color: colorOf(q) })), view.range);
    statsRow.replaceChildren(...stats(s, checkin.active(), view.range).map(statCard));
    const fs = factors(s, checkin.active(), view.range);
    factorList.replaceChildren(...(fs.length ? [h('div', { class: 'ci-sub' }, 'What goes with what'), ...fs.map(factorCard)] : []));
  }

  const off = checkin.subscribe(render);
  const resize = new ResizeObserver(() => {
    const s = checkin.state;
    if (s) drawChart(chart, s, selected().map((q) => ({ q, color: colorOf(q) })), view.range);
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

export function openHistorySheet() {
  const list = h('div', { class: 'ci-history' });
  let off = () => {};
  openSheet('Check-in history', [list], { onClose: () => off() });
  off = checkin.subscribe(() => {
    const s = checkin.state!;
    // The last 60 days, plus any older answered days.
    const recent = daysBack(s.today, 60).reverse();
    const older = Object.keys(s.entries)
      .filter((d) => d < recent[recent.length - 1])
      .sort()
      .reverse();
    list.replaceChildren(
      ...[...recent, ...older].map((d) => {
        const pills = answerPills(d);
        const note = s.entries[d]?.note;
        return h(
          'button',
          { class: `ci-day${pills.length ? '' : ' missing'}`, onclick: () => openFormSheet(d) },
          h('span', { class: 'ci-day-date' }, dayLabel(d, s.today)),
          h(
            'span',
            { class: 'ci-day-vals' },
            ...(pills.length ? pills : [h('span', { class: 'ci-day-none' }, 'Not answered · tap to fill in')]),
            note && h('span', { class: 'ci-day-note' }, `“${note}”`),
          ),
        );
      }),
    );
  });
}

// ---- Settings ---------------------------------------------------------------

const STEP = 15;

export function openSettingsSheet() {
  const content = h('div', { class: 'ci-settings' });
  let error = '';
  let adding = false;
  let off = () => {};
  openSheet('Check-in settings', [content], { onClose: () => off() });

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
      error = '';
    } catch (err) {
      error = (err as Error).message;
      render();
    }
  };
  const saveSettings = (patch: Partial<CheckinSettings>) => run(() => checkin.saveSettings(patch));
  const saveQuestions = (qs: Question[]) => run(() => checkin.saveQuestions(qs));

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

  const typeName: Record<QuestionType, string> = { scale: '1–5', hours: 'hours', yesno: 'yes/no' };

  function addForm(): HTMLElement {
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
    const add = () => {
      const s = checkin.state!;
      const text = label.value.trim();
      if (!text) {
        error = 'Type the question first';
        render();
        return;
      }
      let id = `c-${text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'q'}`;
      while (s.questions.some((q) => q.id === id)) id += '-2';
      const q: Question = { id, label: text, short: short.value.trim(), type, enabled: true };
      if (type === 'scale') Object.assign(q, { low: low.value.trim(), high: high.value.trim(), lowerIsBetter });
      adding = false;
      void saveQuestions([...s.questions, q]);
    };
    return h(
      'div',
      { class: 'ci-add form' },
      label,
      short,
      typeChips,
      scaleBits,
      h(
        'div',
        { class: 'ci-actions' },
        h('button', { class: 'btn btn-primary', onclick: add }, 'Add question'),
        h('button', { class: 'btn', onclick: () => ((adding = false), render()) }, 'Cancel'),
      ),
    );
  }

  function render() {
    const s = checkin.state;
    if (!s) return;
    const st = s.settings;
    const rows = s.questions.map((q, i) =>
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
                onclick: () => void saveQuestions(s.questions.filter((x) => x.id !== q.id)),
              },
              '✕',
            ),
          toggle(q.enabled, (v) => void saveQuestions(s.questions.map((x, j) => (j === i ? { ...x, enabled: v } : x)))),
        ),
      ),
    );
    content.replaceChildren(
      h('label', { class: 'sleep-row' }, h('span', {}, 'Pop up in the morning'), toggle(st.prompt, (v) => void saveSettings({ prompt: v }))),
      ...(st.prompt ? [stepper('From', 'promptAt', st.promptAt), stepper('Until', 'promptUntil', st.promptUntil)] : []),
      h('label', { class: 'sleep-row' }, h('span', {}, 'Add a note field'), toggle(st.note, (v) => void saveSettings({ note: v }))),
      h('div', { class: 'ci-sub' }, 'Questions'),
      ...rows,
      error && h('p', { class: 'conn-error' }, error),
      adding ? addForm() : h('button', { class: 'btn btn-wide', onclick: () => ((adding = true), render()) }, '＋ Add your own question'),
      h(
        'button',
        { class: 'btn btn-ghost btn-wide ci-reset', onclick: () => void run(() => checkin.resetQuestions()) },
        'Reset to the built-in questions',
      ),
      h('p', { class: 'conn-hint' }, 'Turning a question off keeps its history. Answers are saved on the Pi in pidisplay-data/checkin.json; deploy\\checkin.ps1 on the laptop saves them as a spreadsheet (CSV).'),
    );
  }

  off = checkin.subscribe(() => {
    // Don't wipe a half-typed new question when a save lands.
    if (!adding) render();
  });
}
