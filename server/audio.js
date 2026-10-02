// Speaker outputs on the Pi (PipeWire, through its PulseAudio interface `pactl`).
// Lists the places sound can go (display speakers over HDMI, the headphone jack,
// connected Bluetooth speakers), switches the default output and sets its volume.
// The server runs as dan outside the desktop session, so commands are pointed at
// dan's PipeWire with XDG_RUNTIME_DIR.
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';

export class AudioError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function defaultRun(cmd, args, { timeout = 8000 } = {}) {
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`;
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, env: { ...process.env, LC_ALL: 'C', XDG_RUNTIME_DIR: runtimeDir } }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(new Error(String(stderr || err.message).trim()), { code: err.code }));
      resolve(String(stdout));
    });
  });
}

/** Which HDMI connectors have a screen plugged in, e.g. { 1: false, 2: true }. */
async function readHdmiPorts(drmDir) {
  const ports = {};
  const entries = await fs.readdir(drmDir).catch(() => []);
  for (const name of entries) {
    const m = /^card\d+-HDMI-A-(\d+)$/.exec(name);
    if (!m) continue;
    const status = await fs.readFile(`${drmDir}/${name}/status`, 'utf8').catch(() => '');
    ports[Number(m[1])] = status.trim() === 'connected';
  }
  return ports;
}

function percent(volume) {
  const values = Object.values(volume ?? {})
    .map((ch) => parseInt(ch?.value_percent, 10))
    .filter((n) => Number.isFinite(n));
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
}

/**
 * The kernel's HDMI-A-n connector number for a Pi 4 HDMI sink. The board's
 * "HDMI 0" socket is card vc4-hdmi-0 at fef00700 and connector HDMI-A-1.
 */
export function hdmiPort(sinkName, cardName = '') {
  const card = /hdmi-?(\d)$/i.exec(cardName);
  if (card) return Number(card[1]) + 1;
  if (sinkName.includes('fef00700')) return 1;
  if (sinkName.includes('fef05700')) return 2;
  return null;
}

/** Turns one `pactl -f json list sinks` entry into something a person recognizes. */
export function describeSink(sink, hdmiPorts = {}) {
  const props = sink.properties ?? {};
  const text = `${sink.name} ${sink.description ?? ''} ${props['alsa.card_name'] ?? ''}`;
  let kind = 'other';
  let label = sink.description || sink.name;
  if (props['device.bus'] === 'bluetooth' || sink.name.startsWith('bluez_output')) {
    kind = 'bluetooth';
    label = props['device.description'] || props['device.alias'] || sink.description || 'Bluetooth speaker';
  } else if (/hdmi/i.test(text)) {
    kind = 'hdmi';
    const port = hdmiPort(sink.name, props['alsa.card_name']);
    const screen = port !== null && hdmiPorts[port];
    label = screen ? 'Display speakers' : port ? `HDMI ${port} (no screen)` : 'HDMI';
    if (screen && Object.values(hdmiPorts).filter(Boolean).length > 1) label += ` (HDMI ${port})`;
  } else if (/headphones|bcm2835|analog/i.test(text)) {
    kind = 'analog';
    label = 'Headphone jack';
  }
  return {
    name: sink.name,
    label,
    kind,
    volume: percent(sink.volume),
    muted: Boolean(sink.mute),
  };
}

export function createAudio({ run = defaultRun, platform = process.platform, drmDir = '/sys/class/drm' } = {}) {
  const supported = platform === 'linux';
  const pactl = (args) => run('pactl', args);

  function wrap(err) {
    if (err instanceof AudioError) return err;
    if (err.code === 'ENOENT') return new AudioError(501, 'pactl is not installed on the Pi. Redeploy to install it.');
    if (/connection refused|connection failure|no such file/i.test(err.message)) {
      return new AudioError(503, "Can't reach the Pi's sound system (PipeWire). Is the desktop session running?");
    }
    return new AudioError(502, err.message || 'Sound command failed');
  }

  async function sinks() {
    return JSON.parse((await pactl(['-f', 'json', 'list', 'sinks'])) || '[]');
  }

  async function status() {
    if (!supported) return { available: false, outputs: [] };
    try {
      const [list, current, ports] = await Promise.all([
        sinks(),
        pactl(['get-default-sink']).then((s) => s.trim()).catch(() => ''),
        readHdmiPorts(drmDir),
      ]);
      let outputs = list.map((s) => ({ ...describeSink(s, ports), active: s.name === current }));
      // Hide the spare HDMI socket when we can tell which one the screen is on.
      if (Object.values(ports).some(Boolean)) outputs = outputs.filter((o) => o.kind !== 'hdmi' || o.active || !o.label.includes('no screen'));
      // Most useful first: Bluetooth (just connected on purpose), the display, then the rest.
      const order = { bluetooth: 0, hdmi: 1, analog: 2, other: 3 };
      outputs.sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));
      return { available: true, outputs };
    } catch (err) {
      throw wrap(err);
    }
  }

  async function findSink(name) {
    if (typeof name !== 'string' || !name) throw new AudioError(400, 'Pick an output');
    const list = await sinks();
    if (!list.some((s) => s.name === name)) throw new AudioError(404, 'That speaker is not connected anymore.');
  }

  /** Makes name the default output and moves anything already playing (Spotify, alarms) to it. */
  async function select(name) {
    if (!supported) throw new AudioError(501, 'Speaker switching only works on the Pi');
    try {
      await findSink(name);
      await pactl(['set-default-sink', name]);
      const streams = JSON.parse((await pactl(['-f', 'json', 'list', 'sink-inputs'])) || '[]');
      for (const s of streams) await pactl(['move-sink-input', String(s.index), name]).catch(() => {});
      return status();
    } catch (err) {
      throw wrap(err);
    }
  }

  async function setVolume(name, volume) {
    if (!supported) throw new AudioError(501, 'Speaker volume only works on the Pi');
    const v = Math.round(Number(volume));
    if (!Number.isFinite(v) || v < 0 || v > 100) throw new AudioError(400, 'Volume must be 0 to 100');
    try {
      await findSink(name);
      await pactl(['set-sink-volume', name, `${v}%`]);
      if (v > 0) await pactl(['set-sink-mute', name, '0']);
      return status();
    } catch (err) {
      throw wrap(err);
    }
  }

  return { supported, status, select, setVolume };
}
