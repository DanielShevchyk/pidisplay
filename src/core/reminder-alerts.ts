// The always-on side of reminders: a popup listing what's due (Done / Snooze),
// the chime when one comes due, and a top-bar chip while anything is waiting.
// Lives in the shell so it works on every page, with or without a Reminders tile.
import { onServerEvent } from './api';
import { h } from './dom';
import { play } from './tones';
import type { ToneId } from './timers';
import { formatWhen, reminders, type Reminder } from './reminders';
import { openRemindersSheet } from '../widgets/reminders/panel';

const SNOOZES: [number, string][] = [
  [10, '10 min'],
  [60, '1 hr'],
  [180, '3 hr'],
];

export class ReminderAlerts {
  private cards = h('div', { class: 'remd-cards' });
  private overlay = h(
    'div',
    { class: 'remd-overlay', hidden: true, role: 'alertdialog', 'aria-label': 'Reminders' },
    h(
      'div',
      { class: 'remd-box' },
      h(
        'div',
        { class: 'remd-head' },
        h('h2', {}, '📌 Reminder'),
        h('button', { class: 'btn btn-ghost', onclick: () => this.hide() }, 'Hide'),
      ),
      this.cards,
    ),
  );
  private chipText = h('span', {});
  readonly chip = h('button', { class: 'btn btn-ghost bar-btn remd-chip', hidden: true, onclick: () => this.chipTapped() }, this.chipText);
  private dueKey = '';
  /** Ids the person hid the popup for; a newly due reminder shows it again. */
  private hidden = new Set<string>();

  constructor(host: HTMLElement) {
    host.append(this.overlay);
    reminders.subscribe(() => this.render());
    onServerEvent<{ id: string; sound: ToneId; volume: number; repeats: number }>('reminder-sound', (s) => {
      // A fresh chime for something hidden earlier (snoozed and due again, or a repeat) shows it again.
      this.hidden.delete(s.id);
      try {
        play(s.sound, { volume: s.volume, cycles: s.repeats });
      } catch (err) {
        console.error('Could not play the reminder sound', err);
      }
      this.render();
    });
  }

  private render() {
    const due = reminders.due();
    const ids = new Set(due.map((r) => r.id));
    for (const id of this.hidden) if (!ids.has(id)) this.hidden.delete(id);
    const key = JSON.stringify(due.map((r) => [r.id, r.dueAt, r.title, r.notes]));
    if (key !== this.dueKey) {
      this.dueKey = key;
      this.cards.replaceChildren(...due.map((r) => this.card(r)));
    }
    this.overlay.hidden = due.length === 0 || due.every((r) => this.hidden.has(r.id));
    this.chip.hidden = due.length === 0;
    this.chipText.textContent = `📌 ${due.length} due`;
  }

  private card(r: Reminder): HTMLElement {
    const busy = (fn: () => Promise<void>) => (e: Event) => {
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      fn().catch((err) => {
        console.error(err);
        btn.disabled = false;
      });
    };
    return h(
      'div',
      { class: 'remd-card' },
      h('div', { class: 'remd-title' }, r.title),
      r.notes && h('div', { class: 'remd-notes' }, r.notes),
      r.dueAt !== null && h('div', { class: 'remd-when' }, formatWhen(r.dueAt)),
      h(
        'div',
        { class: 'remd-actions' },
        h('button', { class: 'btn btn-primary remd-done', onclick: busy(() => reminders.done(r.id)) }, '✓ Done'),
        ...SNOOZES.map(([m, label]) => h('button', { class: 'btn remd-snooze', onclick: busy(() => reminders.snooze(r.id, m)) }, `💤 ${label}`)),
      ),
    );
  }

  private hide() {
    reminders.due().forEach((r) => this.hidden.add(r.id));
    this.overlay.hidden = true;
  }

  private chipTapped() {
    if (reminders.due().length) {
      this.hidden.clear();
      this.overlay.hidden = false;
    } else openRemindersSheet();
  }
}
