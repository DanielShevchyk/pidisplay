import { h } from '../../core/dom';
import { defineWidget } from '../../core/types';
import { formatAlarmTime, formatCountdown, formatIn, timeLeft, timers } from '../../core/timers';
import { openTimersSheet, renderPanel, type Tab } from './panel';
import './timers.css';

interface TimersConfig {
  tab: Tab;
  [key: string]: unknown;
}

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default defineWidget<TimersConfig>({
  type: 'timers',
  name: 'Timers & alarms',
  description: 'Countdown timers and wake-up alarms with sound and snooze',
  icon: '⏰',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'large',
  defaultConfig: { tab: 'timers' },
  settings: [
    {
      key: 'tab',
      label: 'Show first',
      type: 'select',
      options: [
        { value: 'timers', label: 'Timers' },
        { value: 'alarms', label: 'Alarms' },
      ],
    },
  ],

  mount(el, { config, placement }) {
    if (placement === 'large' || placement === 'xlarge' || placement === 'full') {
      return { destroy: renderPanel(el, { tab: config.tab }) };
    }

    // Small tiles: a glanceable summary; tap for the full panel in a sheet.
    const main = h('div', { class: 'tmr-sum-main' });
    const sub = h('div', { class: 'tmr-sum-sub' });
    const root = h('button', { class: `tmr-sum size-${placement}`, onclick: () => openTimersSheet() }, main, sub);
    el.append(root);

    const render = () => {
      const s = timers.state;
      if (!s) return;
      const now = timers.now();
      root.classList.toggle('ringing', timers.ringing().length > 0);
      const running = s.timers
        .filter((t) => t.state === 'running' || t.state === 'paused')
        .sort((a, b) => timeLeft(a, now) - timeLeft(b, now));
      const next = s.alarms
        .filter((a) => a.enabled && a.nextAt !== null)
        .sort((a, b) => a.nextAt! - b.nextAt!)[0];
      const alarmLine = next
        ? `⏰ ${formatAlarmTime(next.hour, next.minute)} ${DAY_SHORT[new Date(next.nextAt!).getDay()]}`
        : '';

      if (timers.ringing().length) {
        main.textContent = '⏰ Ringing';
        sub.textContent = 'Tap to see';
      } else if (running.length) {
        const t = running[0];
        main.textContent = `${t.state === 'paused' ? '⏸️ ' : ''}${formatCountdown(timeLeft(t, now))}`;
        const more = running.length > 1 ? ` · +${running.length - 1} more` : '';
        sub.textContent = `${t.label || 'Timer'}${more}${placement !== 'small' && alarmLine ? ` · ${alarmLine}` : ''}`;
      } else if (next) {
        main.textContent = formatAlarmTime(next.hour, next.minute);
        sub.textContent = `${next.label || 'Alarm'} · ${formatIn(next.nextAt! - now)}`;
      } else {
        main.textContent = '⏱️';
        sub.textContent = 'Timers & alarms';
      }
    };
    const off = timers.subscribe(render);
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
