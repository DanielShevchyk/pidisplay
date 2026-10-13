// The morning side of the check-in: during the morning window, until today's is
// done, a popup with the survey and a "☀️ Check in" chip in the top bar. "Later"
// hides the popup on every screen for the rest of the day; the chip stays until noon
// (or whenever the window ends). Lives in the shell so it works without a tile.
import { h } from './dom';
import { checkin } from './checkin';
import { renderForm } from '../widgets/checkin/form';
import '../widgets/checkin/checkin.css';

export class CheckinPrompt {
  private body = h('div', { class: 'ci-pop-body' });
  private overlay = h(
    'div',
    { class: 'ci-pop', hidden: true, role: 'dialog', 'aria-label': 'Morning check-in' },
    h('div', { class: 'ci-pop-box' }, h('div', { class: 'ci-pop-head' }, h('h2', {}, '☀️ Good morning'), h('span', { class: 'ci-pop-sub' }, 'How are you today?')), this.body),
  );
  readonly chip = h('button', { class: 'btn btn-ghost bar-btn ci-chip', hidden: true, onclick: () => this.open() }, '☀️ Check in');
  /** Opened from the chip after Later; stays open until saved or Later again. */
  private forced = false;
  /** Set at once on Later, before the server confirms, so a refresh can't reopen it. */
  private laterDay: string | null = null;

  constructor(host: HTMLElement) {
    host.append(this.overlay);
    checkin.subscribe(() => this.render());
    setInterval(() => this.render(), 30000);
  }

  private inWindow(): boolean {
    const s = checkin.state;
    if (!s?.settings.prompt || checkin.todayEntry()) return false;
    const d = new Date();
    const m = d.getHours() * 60 + d.getMinutes();
    return m >= s.settings.promptAt && m < s.settings.promptUntil;
  }

  private render() {
    const s = checkin.state;
    if (!s) return;
    const due = this.inWindow();
    this.chip.hidden = !due;
    const show = (due && s.skipped !== s.today && this.laterDay !== s.today) || (this.forced && !checkin.todayEntry());
    if (!show) this.forced = false;
    if (show && this.overlay.hidden) {
      // Build the form only when opening, so a background refresh never wipes taps.
      this.body.replaceChildren(
        renderForm({
          date: s.today,
          onDone: () => this.close(),
          onLater: () => {
            this.laterDay = s.today;
            this.close();
            void checkin.skipToday().catch((err) => console.error(err));
          },
        }),
      );
    }
    this.overlay.hidden = !show;
  }

  private open() {
    this.forced = true;
    this.render();
  }

  private close() {
    this.forced = false;
    this.overlay.hidden = true;
  }
}
