// Built-in alarm sounds, synthesized with Web Audio so there are no sound files
// to ship. In the kiosk, deploy/kiosk.sh passes --autoplay-policy so audio can
// start without a tap; elsewhere the first touch on the page unlocks it.
import type { ToneId } from './timers';

/** Schedules one cycle of the sound at time t and returns the cycle length in seconds (incl. the pause). */
type Pattern = (ctx: AudioContext, out: AudioNode, t: number) => number;

interface NoteOpts {
  freq: number;
  start: number;
  /** Seconds until the note has faded out. */
  decay: number;
  gain?: number;
  type?: OscillatorType;
  attack?: number;
  /** Hold at full level this long before decaying (for beeps). */
  hold?: number;
}

function note(ctx: AudioContext, out: AudioNode, o: NoteOpts) {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  const peak = o.gain ?? 0.5;
  const attack = o.attack ?? 0.005;
  const hold = o.hold ?? 0;
  osc.type = o.type ?? 'sine';
  osc.frequency.value = o.freq;
  env.gain.setValueAtTime(0.0001, o.start);
  env.gain.exponentialRampToValueAtTime(peak, o.start + attack);
  if (hold) env.gain.setValueAtTime(peak, o.start + attack + hold);
  env.gain.exponentialRampToValueAtTime(0.0001, o.start + attack + hold + o.decay);
  osc.connect(env).connect(out);
  osc.start(o.start);
  osc.stop(o.start + attack + hold + o.decay + 0.05);
}

/** A struck bell: a few inharmonic partials that die away at different speeds. */
function bell(ctx: AudioContext, out: AudioNode, freq: number, start: number, gain: number) {
  const partials: [number, number, number][] = [
    [1, 1, 2.6],
    [2, 0.6, 1.8],
    [2.76, 0.4, 1.3],
    [5.4, 0.25, 0.8],
    [8.93, 0.12, 0.5],
  ];
  for (const [ratio, level, decay] of partials) note(ctx, out, { freq: freq * ratio, start, decay, gain: gain * level, attack: 0.002 });
}

const PATTERNS: Record<ToneId, Pattern> = {
  // Three falling notes, like a doorbell.
  chime(ctx, out, t) {
    [1318.5, 1046.5, 784].forEach((freq, i) => {
      note(ctx, out, { freq, start: t + i * 0.38, decay: 1.4, gain: 0.45 });
      note(ctx, out, { freq: freq * 2, start: t + i * 0.38, decay: 0.6, gain: 0.08 });
    });
    return 2.8;
  },
  // Classic bedside alarm clock: four quick beeps, then a gap.
  beep(ctx, out, t) {
    for (let i = 0; i < 4; i++) note(ctx, out, { freq: 2048, start: t + i * 0.16, hold: 0.07, decay: 0.02, gain: 0.22, type: 'square' });
    return 1.2;
  },
  bells(ctx, out, t) {
    bell(ctx, out, 523.25, t, 0.4);
    bell(ctx, out, 392, t + 0.9, 0.35);
    return 3.6;
  },
  // Rising and falling arpeggio, soft and woody.
  marimba(ctx, out, t) {
    [523.25, 659.25, 783.99, 1046.5, 783.99, 659.25].forEach((freq, i) => {
      note(ctx, out, { freq, start: t + i * 0.16, decay: 0.45, gain: 0.5, type: 'triangle' });
      note(ctx, out, { freq: freq * 4, start: t + i * 0.16, decay: 0.08, gain: 0.05 });
    });
    return 1.9;
  },
  // Gentle swelling tone for waking up slowly.
  rise(ctx, out, t) {
    note(ctx, out, { freq: 587.33, start: t, attack: 0.5, hold: 0.3, decay: 0.9, gain: 0.35 });
    note(ctx, out, { freq: 880, start: t, attack: 0.5, hold: 0.3, decay: 0.9, gain: 0.15 });
    return 2.4;
  },
  // Fast and urgent.
  pulse(ctx, out, t) {
    for (let i = 0; i < 3; i++) note(ctx, out, { freq: 1000, start: t + i * 0.12, hold: 0.05, decay: 0.02, gain: 0.25, type: 'square' });
    return 0.7;
  },
};

export const TONES: { id: ToneId; name: string }[] = [
  { id: 'chime', name: 'Chime' },
  { id: 'bells', name: 'Bells' },
  { id: 'marimba', name: 'Marimba' },
  { id: 'rise', name: 'Gentle' },
  { id: 'beep', name: 'Beeper' },
  { id: 'pulse', name: 'Urgent' },
];

export const toneName = (id: ToneId) => TONES.find((t) => t.id === id)?.name ?? id;

let ctx: AudioContext | null = null;

function audio(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    // Browsers without the kiosk's autoplay flag only allow sound after a touch.
    const unlock = () => void ctx?.resume().catch(() => {});
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return ctx;
}

/** True when the browser is holding sound back until someone touches the screen. */
export function soundBlocked(): boolean {
  return ctx !== null && ctx.state !== 'running';
}

/** Perceived loudness is roughly logarithmic, so square the slider value. */
const gainFor = (volume: number) => Math.pow(Math.min(100, Math.max(0, volume)) / 100, 2);

interface PlayOpts {
  volume: number;
  fadeIn?: boolean;
  /** Play this many cycles then stop; default loops until stopped. */
  cycles?: number;
}

/** Starts a tone and returns a function that stops it. */
export function play(tone: ToneId, opts: PlayOpts): () => void {
  const ac = audio();
  const pattern = PATTERNS[tone] ?? PATTERNS.chime;
  const master = ac.createGain();
  // Several notes can overlap; keep the sum from clipping.
  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 0;
  limiter.ratio.value = 12;
  master.connect(limiter).connect(ac.destination);

  const level = gainFor(opts.volume);
  const t0 = ac.currentTime + 0.05;
  if (opts.fadeIn) {
    master.gain.setValueAtTime(level * 0.15, t0);
    master.gain.linearRampToValueAtTime(level, t0 + 30);
  } else master.gain.setValueAtTime(level, t0);

  let next = t0;
  let left = opts.cycles ?? Infinity;
  let timer = 0;
  let stopped = false;
  // Schedule a second ahead on the audio clock; while audio is still locked
  // the clock doesn't move, so this waits instead of piling up notes.
  const loop = () => {
    while (left > 0 && next < ac.currentTime + 1) {
      next += pattern(ac, master, next);
      left--;
    }
    if (left > 0) timer = window.setTimeout(loop, 250);
  };
  loop();

  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    const now = ac.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(0, now + 0.05);
    setTimeout(() => master.disconnect(), 200);
  };
}

let previewStop: (() => void) | null = null;

/** Plays a sample (two cycles) for the sound pickers, cutting off any earlier preview. */
export function preview(tone: ToneId, volume: number) {
  previewStop?.();
  previewStop = play(tone, { volume, cycles: 2 });
}

export function stopPreview() {
  previewStop?.();
  previewStop = null;
}

/** For tests: render one cycle offline and return its peak and RMS level. */
export async function measureTone(tone: ToneId): Promise<{ peak: number; rms: number; seconds: number }> {
  const rate = 22050;
  const probe = new OfflineAudioContext(1, rate * 6, rate);
  const seconds = PATTERNS[tone](probe as unknown as AudioContext, probe.destination, 0);
  const buf = await probe.startRendering();
  const data = buf.getChannelData(0);
  let peak = 0;
  let sum = 0;
  for (const v of data) {
    peak = Math.max(peak, Math.abs(v));
    sum += v * v;
  }
  return { peak, rms: Math.sqrt(sum / data.length), seconds };
}
