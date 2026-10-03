// The timers and alarms UI: lists, presets, number pad, alarm editor and sound
// settings. Rendered inside big tiles, and in a sheet for small tiles and the
// top-bar chip (src/core/alerts.ts).
import { h } from '../../core/dom';
import { openSheet } from '../../core/sheet';
import { preview, stopPreview, toneName, TONES } from '../../core/tones';
import {
  formatAlarmTime,
  formatCountdown,
  formatDays,
  formatDuration,
  formatIn,
  timeLeft,
  timers,
  uses12h,
  type AlarmItem,
  type TimerItem,
  type ToneId,
} from '../../core/timers';
import './timers.css';

export type Tab = 'timers' | 'alarms';

const PRESETS_MIN = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60];
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const fail = (err: unknown) => console.error(err);

interface PanelOpts {
  tab: Tab;
  /** Set when the panel lives in a sheet: editors reopen it on the same tab when they close. */
  reopen?: (tab: Tab) => void;
}

/** Renders the full panel into el. Returns a cleanup function. */
export function renderPanel(el: HTMLElement, opts: PanelOpts): () => void {
  let tab = opts.tab;
  let listKey = '';
  const tick: (() => void)[] = [];
  const back = () => opts.reopen?.(tab);

  const tabBtn = (id: Tab, label: string) =>
    h('button', { class: 'chip tmr-tab', 'data-tab': id, onclick: () => ((tab = id), (listKey = ''), render()) }, label);
  const tabs = [tabBtn('timers', '⏱️ Timers'), tabBtn('alarms', '⏰ Alarms')];
  const list = h('div', { class: 'tmr-list' });
  const footer = h('div', { class: 'tmr-footer' });
  el.append(
    h(
      'div',
      { class: 'tmr' },
      h(
        'div',
        { class: 'tmr-head' },
        ...tabs,
        h('button', { class: 'btn btn-ghost tmr-sounds', onclick: () => openSoundSettings(back) }, '🔔 Sounds'),
      ),
      list,
      footer,
    ),
  );

  function render() {
    const s = timers.state;
    tabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    if (!s) {
      list.replaceChildren(h('p', { class: 'empty' }, 'Loading…'));
      return;
    }
    // Rebuild rows only when something other than the countdown changed.
    const key = JSON.stringify([tab, tab === 'timers' ? s.timers : s.alarms, s.settings.snoozeMinutes]);
    if (key === listKey) return;
    listKey = key;
    tick.length = 0;
    if (tab === 'timers') {
      list.replaceChildren(...(s.timers.length ? s.timers.map(timerRow) : [h('p', { class: 'empty' }, 'No timers running')]));
      footer.replaceChildren(
        h(
          'div',
          { class: 'chips tmr-presets' },
          ...PRESETS_MIN.map((m) =>
            h('button', { class: 'chip', onclick: () => void timers.startTimer(m * 60000).catch(fail) }, m === 60 ? '1 hr' : `${m} min`),
          ),
          h('button', { class: 'chip chip-accent', onclick: () => openNumberPad(back) }, '⌨️ Custom'),
        ),
      );
    } else {
      const alarms = [...s.alarms].sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
      list.replaceChildren(...(alarms.length ? alarms.map(alarmRow) : [h('p', { class: 'empty' }, 'No alarms yet')]));
      footer.replaceChildren(h('button', { class: 'btn btn-primary tmr-add', onclick: () => openAlarmEditor(null, back) }, '＋ Add alarm'));
    }
    tick.forEach((fn) => fn());
  }

  function timerRow(t: TimerItem): HTMLElement {
    const time = h('div', { class: 'tmr-time' });
    const bar = h('div', { class: 'tmr-progress-fill' });
    const update = () => {
      const now = timers.now();
      const left = timeLeft(t, now);
      if (t.state === 'snoozed') time.textContent = `💤 ${formatCountdown((t.snoozeUntil ?? now) - now)}`;
      else if (t.state === 'ringing') time.textContent = 'Ringing';
      else time.textContent = formatCountdown(left);
      bar.style.width = `${t.state === 'running' || t.state === 'paused' ? (100 * left) / t.durationMs : 0}%`;
    };
    tick.push(update);
    const paused = t.state === 'paused';
    return h(
      'div',
      { class: `tmr-row state-${t.state}` },
      h(
        'div',
        { class: 'tmr-info' },
        h('div', { class: 'tmr-label' }, t.label || formatDuration(t.durationMs)),
        time,
        h('div', { class: 'tmr-progress' }, bar),
      ),
      h(
        'div',
        { class: 'tmr-btns' },
        (t.state === 'running' || paused) &&
          h(
            'button',
            { class: 'btn', 'aria-label': paused ? 'Resume' : 'Pause', onclick: () => void timers.timerAction(t.id, paused ? 'resume' : 'pause').catch(fail) },
            paused ? '▶️' : '⏸️',
          ),
        h('button', { class: 'btn', onclick: () => void timers.addTime(t.id, 60000).catch(fail) }, '+1 min'),
        h('button', { class: 'btn btn-ghost', 'aria-label': 'Cancel timer', onclick: () => void timers.cancelTimer(t.id).catch(fail) }, '✕'),
      ),
    );
  }

  function alarmRow(a: AlarmItem): HTMLElement {
    const when = h('span', { class: 'alm-when' });
    tick.push(() => {
      const now = timers.now();
      if (a.state === 'ringing') when.textContent = 'Ringing';
      else if (a.state === 'snoozed') when.textContent = `💤 Snoozed, rings ${formatIn((a.snoozeUntil ?? now) - now)}`;
      else when.textContent = a.enabled && a.nextAt ? formatIn(a.nextAt - now) : 'Off';
    });
    const toggle = h('input', {
      type: 'checkbox',
      class: 'toggle',
      checked: a.enabled,
      'aria-label': 'On',
      onchange: (e: Event) => void timers.updateAlarm(a.id, { enabled: (e.target as HTMLInputElement).checked }).catch(fail),
    });
    return h(
      'div',
      { class: `alm-row${a.enabled ? '' : ' off'}` },
      h(
        'button',
        { class: 'alm-main', onclick: () => openAlarmEditor(a, back) },
        h('span', { class: 'alm-time' }, formatAlarmTime(a.hour, a.minute)),
        h('span', { class: 'alm-meta' }, [a.label, formatDays(a.days)].filter(Boolean).join(' · '), ' · ', when),
      ),
      toggle,
    );
  }

  const offStore = timers.subscribe(render);
  const timer = window.setInterval(() => tick.forEach((fn) => fn()), 1000);
  render();
  return () => {
    offStore();
    clearInterval(timer);
  };
}

/** Opens the panel in a bottom sheet (small tiles and the top-bar chip). */
export function openTimersSheet(tab: Tab = defaultTab()) {
  const body = h('div', { class: 'tmr-sheet' });
  let cleanup = () => {};
  openSheet('Timers & alarms', [body], { onClose: () => cleanup() });
  cleanup = renderPanel(body, { tab, reopen: (t) => openTimersSheet(t) });
}

/** Timers first when any are running, else alarms if there are some. */
function defaultTab(): Tab {
  const s = timers.state;
  if (!s || s.timers.length || !s.alarms.length) return 'timers';
  return 'alarms';
}

// ---- Custom timer: number pad -------------------------------------------

function openNumberPad(back: () => void) {
  let digits = '';
  const display = h('div', { class: 'pad-display' });
  const label = h('input', { type: 'text', class: 'pad-label', placeholder: 'Label (optional)', maxlength: 60 });
  const start = h('button', { class: 'btn btn-primary pad-start' }, 'Start');
  const ms = () => {
    const d = digits.padStart(6, '0');
    return (Number(d.slice(0, 2)) * 3600 + Number(d.slice(2, 4)) * 60 + Number(d.slice(4, 6))) * 1000;
  };
  const show = () => {
    const d = digits.padStart(6, '0');
    display.replaceChildren(
      ...[
        [d.slice(0, 2), 'h'],
        [d.slice(2, 4), 'm'],
        [d.slice(4, 6), 's'],
      ].map(([n, unit], i) =>
        h('span', { class: `pad-part${digits.length > 4 - i * 2 ? ' set' : ''}` }, n, h('small', {}, unit)),
      ),
    );
    start.disabled = ms() === 0;
  };
  // Digits shift in from the right, like a phone's timer: 5, 0, 0 → 5m 00s.
  const press = (k: string) => {
    if (k === '⌫') digits = digits.slice(0, -1);
    else digits = (digits + k).replace(/^0+/, '').slice(0, 6);
    show();
  };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫'];
  let started = false;
  const sheet = openSheet('Custom timer', [
    display,
    h('div', { class: 'pad-keys' }, ...keys.map((k) => h('button', { class: 'btn pad-key', onclick: () => press(k) }, k))),
    label,
    h('div', { class: 'menu-actions' }, h('button', { class: 'btn', onclick: () => sheet.close() }, 'Cancel'), start),
  ], { onClose: () => !started && back() });
  start.onclick = () => {
    started = true;
    timers.startTimer(ms(), label.value).then(back, fail);
    sheet.close();
  };
  show();
}

// ---- Alarm editor ---------------------------------------------------------

function openAlarmEditor(existing: AlarmItem | null, back: () => void) {
  const a = {
    hour: existing?.hour ?? 7,
    minute: existing?.minute ?? 0,
    days: [...(existing?.days ?? [])],
    label: existing?.label ?? '',
    sound: existing?.sound ?? null,
  };
  const hourText = h('span', { class: 'alm-edit-num' });
  const minuteText = h('span', { class: 'alm-edit-num' });
  const ampm = h('div', { class: 'alm-ampm' });
  const days = h('div', { class: 'alm-days' });
  const quick = h('div', { class: 'chips' });

  const show = () => {
    hourText.textContent = uses12h ? String(a.hour % 12 || 12) : String(a.hour).padStart(2, '0');
    minuteText.textContent = String(a.minute).padStart(2, '0');
    if (uses12h) {
      ampm.replaceChildren(
        ...['AM', 'PM'].map((p, i) =>
          h('button', { class: `chip${(a.hour >= 12 ? 1 : 0) === i ? ' active' : ''}`, onclick: () => ((a.hour = (a.hour % 12) + i * 12), show()) }, p),
        ),
      );
    }
    days.replaceChildren(
      ...DAY_LETTERS.map((l, d) =>
        h(
          'button',
          {
            class: `alm-day${a.days.includes(d) ? ' active' : ''}`,
            'aria-label': DAY_NAMES[d],
            onclick: () => {
              a.days = a.days.includes(d) ? a.days.filter((x) => x !== d) : [...a.days, d].sort();
              show();
            },
          },
          l,
        ),
      ),
    );
    const sets: [string, number[]][] = [
      ['Once', []],
      ['Weekdays', [1, 2, 3, 4, 5]],
      ['Weekends', [0, 6]],
      ['Every day', [0, 1, 2, 3, 4, 5, 6]],
    ];
    quick.replaceChildren(
      ...sets.map(([name, set]) =>
        h('button', { class: `chip${set.join() === a.days.join() ? ' active' : ''}`, onclick: () => ((a.days = [...set]), show()) }, name),
      ),
    );
  };

  const stepHour = (d: number) => ((a.hour = (a.hour + d + 24) % 24), show());
  const stepMinute = (d: number) => ((a.minute = (a.minute + d + 60) % 60), show());
  const col = (text: HTMLElement, step: (d: number) => void, name: string) =>
    h('div', { class: 'alm-edit-col' }, holdButton('▲', `Later ${name}`, () => step(1)), text, holdButton('▼', `Earlier ${name}`, () => step(-1)));

  const label = h('input', { type: 'text', class: 'pad-label', placeholder: 'Label (optional)', value: a.label, maxlength: 60 });
  const sound = h(
    'select',
    { class: 'alm-sound', onchange: () => (a.sound = (sound.value || null) as ToneId | null) },
    h('option', { value: '', selected: !a.sound }, `Default (${toneName(timers.state?.settings.sound ?? 'chime')})`),
    ...TONES.map((t) => h('option', { value: t.id, selected: a.sound === t.id }, t.name)),
  );

  let saved = false;
  const save = () => {
    saved = true;
    const body = { ...a, label: label.value };
    const done = existing ? timers.updateAlarm(existing.id, { ...body, enabled: true }) : timers.createAlarm(body);
    done.then(back, fail);
    sheet.close();
  };
  let armed = false;
  const del = h(
    'button',
    {
      class: 'btn btn-danger',
      onclick: () => {
        if (!existing) return;
        if (!armed) {
          armed = true;
          del.textContent = 'Tap again to delete';
          return;
        }
        saved = true;
        timers.deleteAlarm(existing.id).then(back, fail);
        sheet.close();
      },
    },
    'Delete',
  );

  const sheet = openSheet(existing ? 'Edit alarm' : 'New alarm', [
    h(
      'div',
      { class: 'alm-edit-time' },
      col(hourText, stepHour, 'hour'),
      h('span', { class: 'alm-edit-colon' }, ':'),
      col(minuteText, stepMinute, 'minute'),
      uses12h && ampm,
    ),
    h('h3', {}, 'Repeat'),
    days,
    quick,
    h('h3', {}, 'Details'),
    label,
    h(
      'label',
      { class: 'field' },
      h('span', {}, 'Sound'),
      h(
        'span',
        { class: 'alm-sound-row' },
        sound,
        h('button', { class: 'btn', 'aria-label': 'Play sound', onclick: () => preview((sound.value || timers.state?.settings.sound || 'chime') as ToneId, timers.state?.settings.volume ?? 80) }, '▶'),
      ),
    ),
    h(
      'div',
      { class: 'menu-actions' },
      existing && del,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => sheet.close() }, 'Cancel'),
      h('button', { class: 'btn btn-primary', onclick: save }, 'Save'),
    ),
  ], {
    onClose: () => {
      stopPreview();
      if (!saved) back();
    },
  });
  show();
}

/** A button that repeats while held, speeding up, for stepping through times. */
export function holdButton(label: string, aria: string, fn: () => void): HTMLElement {
  let timer = 0;
  let count = 0;
  const stop = () => clearTimeout(timer);
  const repeat = () => {
    fn();
    count++;
    timer = window.setTimeout(repeat, count < 5 ? 220 : 70);
  };
  return h(
    'button',
    {
      class: 'btn alm-step',
      'aria-label': aria,
      onpointerdown: (e: PointerEvent) => {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        count = 0;
        fn();
        timer = window.setTimeout(repeat, 450);
      },
      onpointerup: stop,
      onpointercancel: stop,
      onlostpointercapture: stop,
    },
    label,
  );
}

// ---- Sound settings ---------------------------------------------------------

function openSoundSettings(back: () => void) {
  const body = h('div', {});
  const sheet = openSheet('Alarm sounds', [body], {
    onClose: () => {
      stopPreview();
      off();
      back();
    },
  });
  const save = (patch: Parameters<typeof timers.saveSettings>[0]) => void timers.saveSettings(patch).catch(fail);
  const chips = <T extends number | string>(values: T[], current: T, text: (v: T) => string, pick: (v: T) => void) =>
    h('div', { class: 'chips' }, ...values.map((v) => h('button', { class: `chip${v === current ? ' active' : ''}`, onclick: () => pick(v) }, text(v))));

  let volumeDrag = false;
  const render = () => {
    const s = timers.state?.settings;
    if (!s || volumeDrag) return;
    const volumeLabel = h('span', { class: 'snd-volume-value' }, `${s.volume}%`);
    const volume = h('input', {
      type: 'range',
      class: 'snd-volume',
      min: 0,
      max: 100,
      step: 5,
      value: String(s.volume),
      oninput: () => {
        volumeDrag = true;
        volumeLabel.textContent = `${volume.value}%`;
      },
      onchange: () => {
        volumeDrag = false;
        save({ volume: Number(volume.value) });
        preview(s.sound, Number(volume.value));
      },
    });
    body.replaceChildren(
      h('h3', {}, 'Sound'),
      chips(
        TONES.map((t) => t.id),
        s.sound,
        (id) => `${id === s.sound ? '♪ ' : ''}${toneName(id)}`,
        (id) => {
          save({ sound: id });
          preview(id, s.volume);
        },
      ),
      h('h3', {}, 'Volume'),
      h('div', { class: 'snd-volume-row' }, h('span', {}, '🔈'), volume, h('span', {}, '🔊'), volumeLabel),
      h(
        'label',
        { class: 'field' },
        h('span', {}, 'Start quiet and get louder'),
        h('input', { type: 'checkbox', class: 'toggle', checked: s.fadeIn, onchange: (e: Event) => save({ fadeIn: (e.target as HTMLInputElement).checked }) }),
      ),
      h('h3', {}, 'Snooze for'),
      chips([5, 9, 10, 15, 20], s.snoozeMinutes, (m) => `${m} min`, (m) => save({ snoozeMinutes: m })),
      h('h3', {}, 'Stop ringing after'),
      chips([1, 5, 10, 15, 30], s.ringMinutes, (m) => `${m} min`, (m) => save({ ringMinutes: m })),
      h(
        'button',
        {
          class: 'btn btn-wide',
          onclick: () => {
            void timers.startTimer(5000, 'Test').catch(fail);
            sheet.close();
          },
        },
        '▶ Test: ring in 5 seconds',
      ),
    );
  };
  const off = timers.subscribe(render);
  render();
}
