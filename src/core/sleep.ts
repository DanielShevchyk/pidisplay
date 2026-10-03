// Screen sleep (server/sleep.js decides when). On the wall display a black shade
// covers the dashboard while the screen is off, so it's dark even if the screen
// couldn't be powered down, and it swallows the touch that wakes the screen so
// that touch doesn't also press whatever button was under the finger.
import { call, onServerEvent } from './api';
import { h } from './dom';
import { closeSheet } from './sheet';

export interface SleepSettings {
  schedule: boolean;
  wakeAt: number;
  sleepAt: number;
  nightIdleMinutes: number;
  dayIdleMinutes: number;
}

interface SleepStatus {
  settings: SleepSettings;
  asleep: boolean;
  awakeHours: boolean;
  screenError: string | null;
  touchWatching: number;
}

/** After waking, the shade keeps catching taps this long in case the waking touch arrives late. */
const CATCH_AFTER_WAKE_MS = 700;
/** The wall display reports touches this often, as a backup for the server's own touch reader. */
const ACTIVITY_PING_MS = 30_000;

export class SleepUI {
  asleep = false;
  private shade = h('div', { class: 'sleep-shade', 'aria-hidden': 'true' });
  private pointerDown = false;
  private releaseTimer = 0;

  constructor(
    root: HTMLElement,
    kiosk: boolean,
    private onWake: () => void,
  ) {
    onServerEvent<{ asleep: boolean }>('sleep', (s) => this.apply(s.asleep));
    void call<SleepStatus>('GET', '/api/sleep')
      .then((s) => this.apply(s.asleep))
      .catch(() => {});
    if (!kiosk) return;

    root.append(this.shade);
    this.shade.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.pointerDown = true;
      if (this.asleep) void wake('touch');
    });
    const up = () => {
      this.pointerDown = false;
      if (!this.asleep) this.release();
    };
    this.shade.addEventListener('pointerup', up);
    this.shade.addEventListener('pointercancel', up);

    let lastPing = 0;
    document.addEventListener(
      'pointerdown',
      () => {
        const t = Date.now();
        if (t - lastPing < ACTIVITY_PING_MS) return;
        lastPing = t;
        void wake('activity');
      },
      true,
    );
  }

  private apply(asleep: boolean) {
    if (asleep === this.asleep) return;
    this.asleep = asleep;
    clearTimeout(this.releaseTimer);
    if (asleep) {
      this.shade.classList.add('on', 'catch');
      // A sheet left open would still be there in the morning.
      closeSheet();
      return;
    }
    this.shade.classList.remove('on');
    this.onWake();
    if (!this.pointerDown) this.releaseTimer = window.setTimeout(() => this.release(), CATCH_AFTER_WAKE_MS);
  }

  private release() {
    clearTimeout(this.releaseTimer);
    this.shade.classList.remove('catch');
  }
}

function wake(reason: 'touch' | 'activity') {
  return call('POST', '/api/sleep/wake', { reason }).catch(() => {});
}

// ---- Gear menu screen -----------------------------------------------------

const STEP_MINUTES = 30;
const DAY = 24 * 60;
const NIGHT_IDLE = [1, 2, 5, 10, 15, 30];
const DAY_IDLE = [0, 5, 10, 15, 30, 60];

function formatTime(m: number) {
  return new Date(2000, 0, 1, Math.floor(m / 60), m % 60).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** Renders the Sleep screen into the settings sheet's body. */
export function showSleep(body: HTMLElement, back: () => void, closeSheet: () => void) {
  let status: SleepStatus | null = null;
  let error = '';
  const content = h('div', { class: 'conn' });
  body.replaceChildren(
    h(
      'div',
      {},
      h(
        'div',
        { class: 'conn-head' },
        h('button', { class: 'btn btn-ghost', onclick: back, 'aria-label': 'Back' }, '‹ Back'),
        h('h3', {}, 'Sleep'),
        h('span'),
      ),
      content,
    ),
  );

  const save = async (patch: Partial<SleepSettings>) => {
    if (status) status.settings = { ...status.settings, ...patch };
    render();
    try {
      status = await call<SleepStatus>('PUT', '/api/sleep/settings', patch);
      error = '';
    } catch (err) {
      error = (err as Error).message;
    }
    if (content.isConnected) render();
  };

  const stepper = (label: string, key: 'wakeAt' | 'sleepAt') => {
    const value = status!.settings[key];
    const step = (delta: number) => save({ [key]: (value + delta + DAY) % DAY });
    return h(
      'div',
      { class: 'sleep-row' },
      h('span', {}, label),
      h(
        'div',
        { class: 'sleep-stepper' },
        h('button', { class: 'btn', 'aria-label': `${label} earlier`, onclick: () => step(-STEP_MINUTES) }, '−'),
        h('span', { class: 'sleep-time' }, formatTime(value)),
        h('button', { class: 'btn', 'aria-label': `${label} later`, onclick: () => step(STEP_MINUTES) }, '+'),
      ),
    );
  };

  const chips = (values: number[], current: number, key: 'nightIdleMinutes' | 'dayIdleMinutes') =>
    h(
      'div',
      { class: 'chips' },
      ...values.map((v) =>
        h(
          'button',
          { class: `chip${v === current ? ' active' : ''}`, onclick: () => save({ [key]: v }) },
          v === 0 ? 'Never' : `${v} min`,
        ),
      ),
    );

  const render = () => {
    if (!status) {
      content.replaceChildren(h('p', { class: error ? 'conn-error' : 'conn-status' }, error || 'Loading…'));
      return;
    }
    const s = status.settings;
    const toggle = h('input', {
      type: 'checkbox',
      class: 'toggle',
      checked: s.schedule,
      onchange: (e: Event) => save({ schedule: (e.target as HTMLInputElement).checked }),
    });
    content.replaceChildren(
      h('label', { class: 'sleep-row' }, h('span', {}, 'Turn the screen off at night'), toggle),
      ...(s.schedule
        ? [
            stepper('Stay on from', 'wakeAt'),
            stepper('Until', 'sleepAt'),
            h('p', { class: 'conn-hint' }, 'At night, a touch keeps the screen on for'),
            chips(NIGHT_IDLE, s.nightIdleMinutes, 'nightIdleMinutes'),
          ]
        : []),
      h('p', { class: 'conn-hint' }, `${s.schedule ? 'During those hours, t' : 'T'}urn off after no touches for`),
      chips(DAY_IDLE, s.dayIdleMinutes, 'dayIdleMinutes'),
      h(
        'button',
        {
          class: 'btn btn-wide',
          onclick: async () => {
            closeSheet();
            await call('POST', '/api/sleep/now').catch(() => {});
          },
        },
        '🌙 Turn the screen off now',
      ),
      h(
        'p',
        { class: 'conn-hint' },
        'Touch the screen to wake it. Alarms, timers and reminders turn it on when they ring. The Pi itself stays on so they can: a Raspberry Pi 4 has no sleep mode a touch could wake it from.',
      ),
      ...(status.screenError
        ? [h('p', { class: 'conn-warn' }, `The screen couldn't be powered down (${status.screenError}), so the dashboard just goes black.`)]
        : []),
      ...(error ? [h('p', { class: 'conn-error' }, error)] : []),
    );
  };

  render();
  call<SleepStatus>('GET', '/api/sleep')
    .then((s) => (status = s))
    .catch((err) => (error = (err as Error).message))
    .finally(() => content.isConnected && render());
}
