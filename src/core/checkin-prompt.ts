// The morning side of the check-in: during the morning window, while anyone in the
// popup hasn't checked in today, a popup and a "☀️ Check in" chip in the top bar.
// With several people the popup first asks who is checking in, and comes back to
// that question until everyone is done. "Later" hides the popup on every screen for
// the rest of the day; the chip stays until the window ends. Lives in the shell so
// it works without a tile.
import { h } from './dom';
import { checkin, type Profile } from './checkin';
import { renderForm } from '../widgets/checkin/form';
import '../widgets/checkin/checkin.css';

export class CheckinPrompt {
  private title = h('h2', {});
  private sub = h('span', { class: 'ci-pop-sub' });
  private body = h('div', { class: 'ci-pop-body' });
  private overlay = h(
    'div',
    { class: 'ci-pop', hidden: true, role: 'dialog', 'aria-label': 'Morning check-in' },
    h('div', { class: 'ci-pop-box' }, h('div', { class: 'ci-pop-head' }, this.title, this.sub), this.body),
  );
  private chipText = h('span', {});
  readonly chip = h('button', { class: 'btn btn-ghost bar-btn ci-chip', hidden: true, onclick: () => this.open() }, this.chipText);
  /** Opened from the chip after Later; stays open until everyone is done or Later again. */
  private forced = false;
  /** Set at once on Later, before the server confirms, so a refresh can't reopen it. */
  private laterDay: string | null = null;
  /** Who the open form is for; null while showing the picker. */
  private person: string | null = null;
  /** What the popup shows now, so a background refresh never rebuilds it mid-answer. */
  private shown = '';

  constructor(host: HTMLElement) {
    host.append(this.overlay);
    checkin.subscribe(() => this.render());
    setInterval(() => this.render(), 30000);
  }

  private inWindow(): boolean {
    const s = checkin.state;
    if (!s?.settings.prompt) return false;
    const d = new Date();
    const m = d.getHours() * 60 + d.getMinutes();
    return m >= s.settings.promptAt && m < s.settings.promptUntil;
  }

  private render() {
    const s = checkin.state;
    if (!s) return;
    const waiting = this.inWindow() ? checkin.waiting() : [];
    this.chip.hidden = waiting.length === 0;
    this.chipText.textContent = waiting.length > 1 ? `☀️ ${waiting.length} to check in` : '☀️ Check in';

    const later = s.skipped === s.today || this.laterDay === s.today;
    const show = waiting.length > 0 && (this.forced || !later);
    if (!show) {
      this.forced = false;
      this.person = null;
      this.shown = '';
      this.overlay.hidden = true;
      return;
    }
    // The person whose form is open finished elsewhere: back to the picker.
    if (this.person && !waiting.some((p) => p.id === this.person)) this.person = null;
    // Only one person waiting and nobody else in the household: skip the picker.
    if (!this.person && waiting.length === 1 && s.profiles.length === 1) this.person = waiting[0].id;

    const key = this.person ? `form:${this.person}` : `pick:${waiting.map((p) => p.id).join(',')}`;
    if (key !== this.shown) {
      this.shown = key;
      if (this.person) this.showForm(waiting.find((p) => p.id === this.person)!, s.today, s.profiles.length > 1);
      else this.showPicker(waiting);
    }
    this.overlay.hidden = false;
  }

  private showPicker(waiting: Profile[]) {
    this.title.textContent = '☀️ Good morning';
    this.sub.textContent = "Who's checking in?";
    this.body.replaceChildren(
      h(
        'div',
        { class: 'ci-pick' },
        ...waiting.map((p) =>
          h(
            'button',
            { class: 'ci-pick-person', onclick: () => ((this.person = p.id), this.render()) },
            h('span', { class: 'ci-pick-emoji' }, p.emoji),
            h('span', {}, p.name),
          ),
        ),
      ),
      h('div', { class: 'ci-actions' }, h('button', { class: 'btn ci-later', onclick: () => this.later() }, 'Later')),
    );
  }

  private showForm(p: Profile, today: string, several: boolean) {
    this.title.textContent = several ? `${p.emoji} Good morning, ${p.name}` : '☀️ Good morning';
    this.sub.textContent = 'How are you today?';
    this.body.replaceChildren(
      renderForm({
        profile: p.id,
        date: today,
        // Saving re-renders from the new state: the picker for anyone left, or closed.
        onDone: () => {
          this.person = null;
          this.render();
        },
        onLater: several
          ? () => {
              this.person = null;
              this.render();
            }
          : () => this.later(),
        laterLabel: several ? 'Back' : 'Later',
      }),
    );
  }

  private later() {
    const s = checkin.state;
    if (s) this.laterDay = s.today;
    this.forced = false;
    this.render();
    void checkin.skipToday().catch((err) => console.error(err));
  }

  private open() {
    this.forced = true;
    this.render();
  }
}
