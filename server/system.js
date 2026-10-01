// System stats for the "system" widget: CPU, memory, disk, temperature, clock
// speed, power/throttle flags, network and uptime. Reads /proc, /sys and
// vcgencmd on the Pi; every reading degrades to null when it isn't available
// (e.g. on a dev laptop), so the endpoint never fails because one source did.
import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';

/** Bits of `vcgencmd get_throttled` (Raspberry Pi firmware docs). */
const THROTTLE_BITS = {
  underVoltage: 0,
  freqCapped: 1,
  throttled: 2,
  softTempLimit: 3,
  underVoltageOccurred: 16,
  freqCappedOccurred: 17,
  throttledOccurred: 18,
  softTempLimitOccurred: 19,
};

// Several tiles (and screens) poll at once; one sample a second is plenty.
const CACHE_MS = 900;

function defaultExec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 2000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

export function decodeThrottled(raw) {
  const flags = {};
  for (const [name, bit] of Object.entries(THROTTLE_BITS)) flags[name] = Boolean((raw >>> bit) & 1);
  return flags;
}

export function createSystem({
  readFile = (file) => fs.readFile(file, 'utf8'),
  readdir = (dir) => fs.readdir(dir),
  statfs = (p) => fs.statfs(p),
  exec = defaultExec,
  cpus = () => os.cpus(),
  now = () => Date.now(),
  diskPath = '/',
} = {}) {
  let prevCpu = null;
  let prevNet = null;
  let cache = null;
  let pending = null;
  // Stop shelling out to vcgencmd once it's known to be missing.
  let hasVcgencmd = true;

  const tryRead = (file) => readFile(file).then((s) => s.trim(), () => null);

  async function vcgencmd(...args) {
    if (!hasVcgencmd) return null;
    try {
      return (await exec('vcgencmd', args)).trim();
    } catch (err) {
      if (err?.code === 'ENOENT') hasVcgencmd = false;
      return null;
    }
  }

  function cpuTimes() {
    return cpus().map(({ times: t }) => {
      const total = t.user + t.nice + t.sys + t.idle + t.irq;
      return { busy: total - t.idle, total };
    });
  }

  function cpuUsage() {
    const cur = cpuTimes();
    const prev = prevCpu;
    prevCpu = cur;
    if (!prev || prev.length !== cur.length) return null;
    const pct = (b, t) => (t > 0 ? Math.round((b / t) * 1000) / 10 : 0);
    const cores = cur.map((c, i) => pct(c.busy - prev[i].busy, c.total - prev[i].total));
    const busy = cur.reduce((s, c, i) => s + c.busy - prev[i].busy, 0);
    const total = cur.reduce((s, c, i) => s + c.total - prev[i].total, 0);
    return { usage: pct(busy, total), cores };
  }

  async function memory() {
    const text = await tryRead('/proc/meminfo');
    if (text) {
      const kb = (name) => {
        const m = text.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'));
        return m ? Number(m[1]) * 1024 : null;
      };
      const total = kb('MemTotal');
      const available = kb('MemAvailable') ?? kb('MemFree');
      const swapTotal = kb('SwapTotal');
      const swapFree = kb('SwapFree');
      if (total && available !== null) {
        return {
          total,
          used: total - available,
          swapTotal: swapTotal ?? 0,
          swapUsed: swapTotal && swapFree !== null ? swapTotal - swapFree : 0,
        };
      }
    }
    return { total: os.totalmem(), used: os.totalmem() - os.freemem(), swapTotal: 0, swapUsed: 0 };
  }

  async function disk() {
    try {
      const s = await statfs(diskPath);
      const total = s.blocks * s.bsize;
      // Same maths as df: blocks reserved for root count as neither used nor free.
      const used = (s.blocks - s.bfree) * s.bsize;
      const free = s.bavail * s.bsize;
      return { path: diskPath, total, used, free };
    } catch {
      return null;
    }
  }

  async function temperature() {
    const sys = await tryRead('/sys/class/thermal/thermal_zone0/temp');
    if (sys && Number.isFinite(Number(sys))) return Math.round(Number(sys) / 100) / 10;
    const vc = (await vcgencmd('measure_temp'))?.match(/temp=([\d.]+)/);
    return vc ? Number(vc[1]) : null;
  }

  async function clock() {
    const cur = await tryRead('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq');
    const max = await tryRead('/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq');
    const mhz = (khz) => (khz && Number.isFinite(Number(khz)) ? Math.round(Number(khz) / 1000) : null);
    const speeds = cpus().map((c) => c.speed).filter((s) => s > 0);
    return { mhz: mhz(cur) ?? (speeds[0] || null), maxMhz: mhz(max) };
  }

  async function power() {
    let raw = null;
    const vc = (await vcgencmd('get_throttled'))?.match(/throttled=(0x[0-9a-f]+)/i);
    if (vc) raw = parseInt(vc[1], 16);
    else {
      // Exposed by the firmware driver on recent Pi kernels, no vcgencmd needed.
      const sys = await tryRead('/sys/devices/platform/soc/soc:firmware/get_throttled');
      if (sys && /^[0-9a-f]+$/i.test(sys)) raw = parseInt(sys, 16);
    }
    if (raw === null) {
      // Last resort: the rpi_volt hwmon only reports undervoltage.
      const uv = await undervoltageHwmon();
      if (uv === null) return null;
      raw = uv ? 1 : 0;
    }
    const volts = (await vcgencmd('measure_volts', 'core'))?.match(/volt=([\d.]+)/);
    return { raw, ...decodeThrottled(raw), coreVolts: volts ? Number(volts[1]) : null };
  }

  async function undervoltageHwmon() {
    const dirs = await readdir('/sys/class/hwmon').catch(() => []);
    for (const d of dirs) {
      if ((await tryRead(`/sys/class/hwmon/${d}/name`)) !== 'rpi_volt') continue;
      const v = await tryRead(`/sys/class/hwmon/${d}/in0_lcrit_alarm`);
      if (v !== null) return v === '1';
    }
    return null;
  }

  async function network(t) {
    const text = await tryRead('/proc/net/dev');
    if (!text) return null;
    let rx = 0;
    let tx = 0;
    for (const line of text.split('\n').slice(2)) {
      const [name, rest] = line.split(':');
      if (!rest || name.trim() === 'lo') continue;
      const f = rest.trim().split(/\s+/).map(Number);
      rx += f[0] || 0;
      tx += f[8] || 0;
    }
    const prev = prevNet;
    prevNet = { rx, tx, t };
    const secs = prev ? (t - prev.t) / 1000 : 0;
    const rate = (a, b) => (secs > 0 && a >= b ? Math.round((a - b) / secs) : null);
    return { rxRate: prev ? rate(rx, prev.rx) : null, txRate: prev ? rate(tx, prev.tx) : null };
  }

  function ipAddress() {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
    }
    return null;
  }

  // A value from a failed reading becomes null rather than failing the response.
  const safe = (p) => Promise.resolve().then(p).catch(() => null);

  async function sample() {
    const t = now();
    let cpu = cpuUsage();
    if (!cpu) {
      // First call has nothing to diff against; take a short second sample.
      await new Promise((r) => setTimeout(r, 250));
      cpu = cpuUsage();
    }
    const [mem, dsk, temp, clk, pwr, net] = await Promise.all([
      safe(memory),
      safe(disk),
      safe(temperature),
      safe(clock),
      safe(power),
      safe(() => network(t)),
    ]);
    return {
      time: t,
      hostname: os.hostname(),
      ip: ipAddress(),
      uptime: Math.round(os.uptime()),
      load: os.loadavg().map((n) => Math.round(n * 100) / 100),
      cpu: { usage: cpu?.usage ?? null, cores: cpu?.cores ?? [], mhz: clk?.mhz ?? null, maxMhz: clk?.maxMhz ?? null },
      temperature: temp,
      memory: mem,
      disk: dsk,
      power: pwr,
      network: net,
    };
  }

  return {
    async get() {
      if (cache && now() - cache.time < CACHE_MS) return cache;
      pending ??= sample().finally(() => (pending = null));
      cache = await pending;
      return cache;
    },
  };
}
