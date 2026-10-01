import { h } from '../../core/dom';
import { defineWidget } from '../../core/types';
import './clock.css';

interface ClockConfig {
  style: 'digital' | 'analog';
  hourCycle: 'auto' | '12' | '24';
  showSeconds: boolean;
  showDate: boolean;
  /** IANA zone like "Europe/London"; empty means the Pi's local time. */
  timeZone: string;
  label: string;
  [key: string]: unknown;
}

const SVG = 'http://www.w3.org/2000/svg';

export default defineWidget<ClockConfig>({
  type: 'clock',
  name: 'Clock',
  description: 'Digital or analog clock, any time zone',
  icon: '🕒',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'medium',
  supportsBar: true,
  defaultConfig: {
    style: 'digital',
    hourCycle: 'auto',
    showSeconds: false,
    showDate: true,
    timeZone: '',
    label: '',
  },
  settings: [
    {
      key: 'style',
      label: 'Style',
      type: 'select',
      options: [
        { value: 'digital', label: 'Digital' },
        { value: 'analog', label: 'Analog' },
      ],
    },
    {
      key: 'hourCycle',
      label: 'Hours',
      type: 'select',
      options: [
        { value: 'auto', label: 'System default' },
        { value: '12', label: '12-hour' },
        { value: '24', label: '24-hour' },
      ],
    },
    { key: 'showSeconds', label: 'Show seconds', type: 'boolean' },
    { key: 'showDate', label: 'Show date', type: 'boolean' },
    { key: 'timeZone', label: 'Time zone (blank = local)', type: 'text', placeholder: 'e.g. Europe/London' },
    { key: 'label', label: 'Label', type: 'text', placeholder: 'e.g. Tokyo' },
  ],

  mount(el, { config, placement }) {
    const timeZone = validZone(config.timeZone);
    const hour12 = config.hourCycle === 'auto' ? undefined : config.hourCycle === '12';
    const timeFmt = new Intl.DateTimeFormat([], {
      hour: 'numeric',
      minute: '2-digit',
      second: config.showSeconds ? '2-digit' : undefined,
      hour12,
      timeZone,
    });
    const dateFmt = new Intl.DateTimeFormat([], {
      weekday: placement === 'bar' || placement === 'small' ? 'short' : 'long',
      month: placement === 'bar' || placement === 'small' ? 'short' : 'long',
      day: 'numeric',
      timeZone,
    });
    // 24h numeric parts for positioning analog hands in the chosen zone.
    const partsFmt = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
      timeZone,
    });

    const label = config.label ? h('div', { class: 'clock-label' }, config.label) : null;
    const date = h('div', { class: 'clock-date' });
    const showDate = config.showDate && placement !== 'small';
    let render: (now: Date) => void;

    if (placement === 'bar') {
      const time = h('span', { class: 'clock-bar-time' });
      el.append(h('div', { class: 'clock clock-bar' }, time, config.showDate && date));
      render = (now) => {
        time.textContent = timeFmt.format(now);
        date.textContent = dateFmt.format(now);
      };
    } else if (config.style === 'analog') {
      const hands = analogFace(config.showSeconds);
      el.append(
        h('div', { class: `clock clock-analog size-${placement}` }, label, hands.svg, showDate && date),
      );
      render = (now) => {
        const p = numericParts(partsFmt, now);
        hands.set(p.hour, p.minute, p.second);
        date.textContent = dateFmt.format(now);
      };
    } else {
      const main = h('span', { class: 'clock-main' });
      const secs = h('span', { class: 'clock-secs' });
      const period = h('span', { class: 'clock-period' });
      el.append(
        h(
          'div',
          { class: `clock clock-digital size-${placement}` },
          label,
          h('div', { class: 'clock-time' }, main, secs, period),
          showDate && date,
        ),
      );
      render = (now) => {
        const parts = timeFmt.formatToParts(now);
        const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
        main.textContent = `${get('hour')}:${get('minute')}`;
        secs.textContent = config.showSeconds ? `:${get('second')}` : '';
        period.textContent = get('dayPeriod');
        date.textContent = dateFmt.format(now);
      };
    }

    // Tick on the second boundary so the display never lags the real time.
    let timer = 0;
    const tick = () => {
      const now = new Date();
      render(now);
      timer = window.setTimeout(tick, 1000 - now.getMilliseconds() + 5);
    };
    tick();
    return { destroy: () => clearTimeout(timer) };
  },
});

function validZone(zone: string): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat([], { timeZone: zone });
    return zone;
  } catch {
    console.warn(`Clock: unknown time zone "${zone}", using local time`);
    return undefined;
  }
}

function numericParts(fmt: Intl.DateTimeFormat, now: Date) {
  const n = (type: string) => Number(fmt.formatToParts(now).find((p) => p.type === type)?.value ?? 0);
  return { hour: n('hour'), minute: n('minute'), second: n('second') };
}

function analogFace(showSeconds: boolean) {
  const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) => {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };
  const svg = el('svg', { viewBox: '-100 -100 200 200', class: 'clock-face' });
  svg.append(el('circle', { r: 96, class: 'clock-dial' }));
  for (let i = 0; i < 60; i++) {
    const major = i % 5 === 0;
    svg.append(
      el('line', {
        y1: -88,
        y2: major ? -76 : -83,
        transform: `rotate(${i * 6})`,
        class: major ? 'clock-tick major' : 'clock-tick',
      }),
    );
  }
  const hour = el('line', { y1: 10, y2: -48, class: 'clock-hand hour' });
  const minute = el('line', { y1: 12, y2: -72, class: 'clock-hand minute' });
  const second = el('line', { y1: 18, y2: -80, class: 'clock-hand second' });
  svg.append(hour, minute, ...(showSeconds ? [second] : []), el('circle', { r: 4, class: 'clock-pin' }));
  return {
    svg,
    set(h: number, m: number, s: number) {
      hour.setAttribute('transform', `rotate(${(h % 12) * 30 + m * 0.5})`);
      minute.setAttribute('transform', `rotate(${m * 6 + s * 0.1})`);
      second.setAttribute('transform', `rotate(${s * 6})`);
    },
  };
}
