// The always-on side of timers and alarms: a full-screen "ringing" takeover
// with Snooze and Dismiss, the sound, and a top-bar chip showing what's
// running. Lives in the shell, so it works on every page whether or not a
// Timers tile is on screen.
import { h } from './dom';
import { play, soundBlocked } from './tones';
import {
  formatAlarmTime,
  formatCountdown,
  formatDuration,
  ringTitle,
  timeLeft,
  timers,
  type Ringable,
} from './timers';
import { openTimersSheet } from '../widgets/timers/panel';

export class Alerts {
  private overlay = h('div', { class: 'ring-overlay', hidden: true, role: 'alertdialog', 'aria-label': 'Alarm' });
  private clock = h('div', { class: 'ring-clock' });
  private cards = h('div', { class: 'ring-cards' });
  private hint = h('p', { class: 'ring-hint', hidden: true }, '🔇 Tap anywhere to turn on the sound');
  private chipText = h('span', { class: 'ring-chip-text' });
  readonly chip = h(
    'button',
    { class: 'btn btn-ghost bar-btn ring-chip', hidden: true, onclick: () => this.chipTapped() },
    this.chipText,
  );
  private ringKey = '';
  private soundKey = '';
  private stopSound: (() => void) | null = null;
  private clockFmt = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });

  constructor(host: HTMLElement) {
    this.overlay.append(
      h('div', { class: 'ring-pulse' }, h('div', { class: 'ring-icon' }, '⏰')),
      this.clock,
      this.cards,
      this.hint,
    );
    // Any touch on the takeover also unlocks audio in browsers that need a gesture.
    this.overlay.addEventListener('pointerdown', () => setTimeout(() => this.updateHint(), 100));
    host.append(this.overlay);
    timers.subscribe(() => this.render());
    setInterval(() => this.tick(), 1000);
  }

  private render() {
    const ringing = timers.ringing();
    const key = ringing.map((r) => `${r.kind}:${r.item.id}`).join(',');
    if (key !== this.ringKey) {
      this.ringKey = key;
      this.overlay.hidden = ringing.length === 0;
      this.cards.replaceChildren(...ringing.map((r) => this.card(r)));
      if (ringing.length > 1) {
        this.cards.append(
          h('button', { class: 'btn ring-all', onclick: () => ringing.forEach((r) => void timers.dismiss(r).catch(console.error)) }, 'Dismiss all'),
        );
      }
    }
    this.updateSound(ringing);
    this.tick();
  }

  private card(r: Ringable): HTMLElement {
    const snoozeMin = timers.state?.settings.snoozeMinutes ?? 9;
    const subtitle = r.kind === 'alarm' ? `Alarm · ${formatAlarmTime(r.item.hour, r.item.minute)}` : `${formatDuration(r.item.durationMs)} timer`;
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
      { class: `ring-card ring-${r.kind}` },
      h('div', { class: 'ring-title' }, `${r.kind === 'alarm' ? '⏰' : '⏱️'} ${ringTitle(r)}`),
      h('div', { class: 'ring-sub' }, subtitle),
      h(
        'div',
        { class: 'ring-actions' },
        h('button', { class: 'btn ring-snooze', onclick: busy(() => timers.snooze(r)) }, `💤 Snooze ${snoozeMin} min`),
        r.kind === 'timer' &&
          h('button', { class: 'btn ring-more', onclick: busy(() => timers.addTime(r.item.id, 60000)) }, '+1 min'),
        h('button', { class: 'btn ring-dismiss', onclick: busy(() => timers.dismiss(r)) }, 'Dismiss'),
      ),
    );
  }

  /** One sound at a time: the earliest ringing item's, falling back to the default. */
  private updateSound(ringing: Ringable[]) {
    const s = timers.state?.settings;
    const first = ringing[0];
    const key = first && s ? [first.item.id, first.item.sound ?? s.sound, s.volume, s.fadeIn].join('|') : '';
    if (key === this.soundKey) return;
    this.soundKey = key;
    this.stopSound?.();
    this.stopSound = null;
    if (first && s) {
      try {
        this.stopSound = play(first.item.sound ?? s.sound, { volume: s.volume, fadeIn: s.fadeIn });
      } catch (err) {
        console.error('Could not play the alarm sound', err);
      }
      setTimeout(() => this.updateHint(), 500);
    }
  }

  private updateHint() {
    this.hint.hidden = !this.stopSound || !soundBlocked();
  }

  private tick() {
    const s = timers.state;
    if (!this.overlay.hidden) this.clock.textContent = this.clockFmt.format(new Date());
    if (!s) return;
    const now = timers.now();
    let text = '';
    let mode = '';
    if (this.ringKey) {
      text = '⏰ Ringing';
      mode = 'ringing';
    } else {
      const snoozed = [...s.alarms, ...s.timers]
        .filter((x) => x.state === 'snoozed' && x.snoozeUntil !== null)
        .sort((a, b) => a.snoozeUntil! - b.snoozeUntil!)[0];
      const running = s.timers.filter((t) => t.state === 'running').sort((a, b) => a.endsAt! - b.endsAt!)[0];
      const paused = s.timers.find((t) => t.state === 'paused');
      if (snoozed) {
        text = `💤 ${formatCountdown(snoozed.snoozeUntil! - now)}`;
        mode = 'snoozed';
      } else if (running) {
        text = `⏱️ ${formatCountdown(timeLeft(running, now))}`;
      } else if (paused) {
        text = `⏸️ ${formatCountdown(timeLeft(paused, now))}`;
      }
    }
    this.chip.hidden = !text;
    this.chipText.textContent = text;
    this.chip.dataset.mode = mode;
  }

  private chipTapped() {
    if (this.ringKey) this.overlay.hidden = false;
    else openTimersSheet();
  }
}
