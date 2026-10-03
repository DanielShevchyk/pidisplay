import { h } from '../../core/dom';
import { defineWidget } from '../../core/types';
import { formatIn } from '../../core/timers';
import { formatWhen, reminders, type Reminder } from '../../core/reminders';
import { openRemindersSheet, renderPanel } from './panel';
import './reminders.css';

const nextAt = (r: Reminder) => (r.state === 'snoozed' ? r.snoozeUntil : r.enabled && !r.completedAt ? r.nextAt : null);

export default defineWidget({
  type: 'reminders',
  name: 'Reminders',
  description: 'Scheduled and repeating reminders with a notification and sound',
  icon: '📌',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'large',
  defaultConfig: {},

  mount(el, { placement }) {
    if (placement === 'tall' || placement === 'large' || placement === 'xlarge' || placement === 'full') {
      return { destroy: renderPanel(el, { compact: placement === 'tall' }) };
    }

    // Small tiles: what's due or next; tap for the full list in a sheet.
    const main = h('div', { class: 'rem-sum-main' });
    const sub = h('div', { class: 'rem-sum-sub' });
    const root = h('button', { class: `rem-sum size-${placement}`, onclick: () => openRemindersSheet() }, main, sub);
    el.append(root);

    const render = () => {
      const s = reminders.state;
      if (!s) return;
      const now = reminders.now();
      const due = reminders.due();
      const next = s.reminders
        .filter((r) => r.state !== 'due' && nextAt(r) !== null)
        .sort((a, b) => nextAt(a)! - nextAt(b)!)[0];
      root.classList.toggle('due', due.length > 0);
      if (due.length) {
        main.textContent = due.length === 1 ? `📌 ${due[0].title}` : `📌 ${due.length} due`;
        sub.textContent = 'Due now · tap to see';
      } else if (next) {
        main.textContent = next.title;
        sub.textContent = placement === 'small' ? formatIn(nextAt(next)! - now) : `${formatWhen(nextAt(next)!, new Date(now))} · ${formatIn(nextAt(next)! - now)}`;
      } else {
        main.textContent = '📌';
        sub.textContent = 'No reminders';
      }
    };
    const off = reminders.subscribe(render);
    const timer = window.setInterval(render, 1000);
    render();
    return {
      destroy() {
        off();
        clearInterval(timer);
      },
    };
  },
});
