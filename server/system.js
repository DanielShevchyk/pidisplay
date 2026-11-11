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
  /** Background history sampling (see start()). */
  historyMs = 10_000,
  historyLen = 360,
  clockTicks = 100,
  pageSize = 4096,
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

  // ---- Rolling history + details -------------------------------------------
  // A light background sampler keeps the last hour so the detail sheet has a
  // graph the moment it opens. Each tick is four small /proc and /sys reads
  // (never vcgencmd), every 10 s: well under a millisecond of CPU on a Pi 4.
  const points = [];
  let histTimer = null;
  let histPrevStat = null;
  let histPrevIfaces = null;
  let lastIfaceRates = new Map();
  let lastSplit = null;
  let prevProcs = null;
  let prevDetailIfaces = null;
  let prevDetailStat = null;

  /** Aggregate CPU line of /proc/stat: user, nice, system, idle, iowait, irq, softirq, steal. */
  async function procStat() {
    const text = await tryRead('/proc/stat');
    const line = text?.split('\n').find((l) => l.startsWith('cpu '));
    if (!line) return null;
    const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = line.trim().split(/\s+/).slice(1).map(Number);
    return { user: user + nice, system: system + irq + softirq, iowait, idle, total: user + nice + system + idle + iowait + irq + softirq + steal };
  }

  function cpuSplit(cur, prev) {
    if (!cur || !prev) return null;
    const total = cur.total - prev.total;
    if (total <= 0) return null;
    const pct = (k) => Math.round(((cur[k] - prev[k]) / total) * 1000) / 10;
    const busy = Math.round(((total - (cur.idle - prev.idle) - (cur.iowait - prev.iowait)) / total) * 1000) / 10;
    return { usage: busy, user: pct('user'), system: pct('system'), iowait: pct('iowait') };
  }

  /** Per-interface byte, packet, error and drop counters from /proc/net/dev (no loopback). */
  async function interfaces() {
    const text = await tryRead('/proc/net/dev');
    if (!text) return null;
    const list = [];
    for (const line of text.split('\n').slice(2)) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const name = line.slice(0, i).trim();
      if (name === 'lo') continue;
      const f = line.slice(i + 1).trim().split(/\s+/).map(Number);
      list.push({ name, rx: f[0] || 0, rxPackets: f[1] || 0, rxErrors: f[2] || 0, rxDrops: f[3] || 0, tx: f[8] || 0, txPackets: f[9] || 0, txErrors: f[10] || 0, txDrops: f[11] || 0 });
    }
    return list;
  }

  function ifaceRates(cur, prev, t) {
    const out = new Map();
    if (!cur || !prev || t <= prev.t) return out;
    const secs = (t - prev.t) / 1000;
    for (const c of cur) {
      const p = prev.list.find((x) => x.name === c.name);
      if (!p || c.rx < p.rx || c.tx < p.tx) continue; // new interface or counter reset
      out.set(c.name, { rxRate: Math.round((c.rx - p.rx) / secs), txRate: Math.round((c.tx - p.tx) / secs) });
    }
    return out;
  }

  async function tick() {
    const t = now();
    const [stat, mem, temp, ifs, mhz] = await Promise.all([
      safe(procStat),
      safe(memory),
      safe(temperature),
      safe(interfaces),
      safe(() => tryRead('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq')),
    ]);
    const split = cpuSplit(stat, histPrevStat);
    histPrevStat = stat;
    if (split) lastSplit = split;
    const rates = ifaceRates(ifs, histPrevIfaces, t);
    histPrevIfaces = ifs ? { list: ifs, t } : null;
    if (rates.size) lastIfaceRates = rates;
    const sum = (k) => (rates.size ? [...rates.values()].reduce((s, r) => s + r[k], 0) : null);
    // The first tick only primes the counters.
    if (!split && !rates.size) return;
    points.push({
      t,
      cpu: split?.usage ?? null,
      iowait: split?.iowait ?? null,
      mem: mem?.used ?? null,
      temp,
      rx: sum('rxRate'),
      tx: sum('txRate'),
      mhz: mhz && Number.isFinite(Number(mhz)) ? Math.round(Number(mhz) / 1000) : null,
    });
    if (points.length > historyLen) points.splice(0, points.length - historyLen);
  }

  /** Reads utime+stime and RSS of every process, from /proc/<pid>/stat. */
  async function processTimes() {
    const pids = (await readdir('/proc').catch(() => [])).filter((d) => /^\d+$/.test(d));
    const out = new Map();
    await Promise.all(
      pids.map(async (pid) => {
        const text = await tryRead(`/proc/${pid}/stat`);
        if (!text) return;
        const open = text.indexOf('(');
        const close = text.lastIndexOf(')');
        if (open < 0 || close < open) return;
        const f = text.slice(close + 2).split(' ');
        // f[0] is field 3 (state); utime/stime are fields 14/15, rss field 24.
        out.set(pid, { name: text.slice(open + 1, close), ticks: Number(f[11]) + Number(f[12]), rss: Number(f[21]) * pageSize });
      }),
    );
    return out;
  }

  /** Top process groups by CPU (share of the whole machine) with memory, grouped by name. */
  async function topProcesses(limit = 8) {
    let cur = await processTimes();
    let t = now();
    let prev = prevProcs;
    // Without a recent previous reading, take a short second one to diff against.
    if (!prev || t - prev.t > 30_000 || t <= prev.t) {
      prevProcs = { map: cur, t };
      await new Promise((r) => setTimeout(r, 500));
      prev = prevProcs;
      cur = await processTimes();
      t = Math.max(now(), prev.t + 500);
    }
    prevProcs = { map: cur, t };
    if (!cur.size) return { count: 0, top: [] };
    const cores = Math.max(1, cpus().length);
    const scale = 100 / (((t - prev.t) / 1000) * clockTicks * cores);
    const groups = new Map();
    for (const [pid, p] of cur) {
      const before = prev.map.get(pid);
      const delta = before && before.name === p.name ? Math.max(0, p.ticks - before.ticks) : 0;
      const g = groups.get(p.name) ?? { name: p.name, count: 0, cpu: 0, mem: 0 };
      g.count++;
      g.cpu += delta * scale;
      g.mem += p.rss || 0;
      groups.set(p.name, g);
    }
    const top = [...groups.values()]
      .sort((a, b) => b.cpu - a.cpu || b.mem - a.mem)
      .slice(0, limit)
      .map((g) => ({ ...g, cpu: Math.round(g.cpu * 10) / 10 }));
    return { count: cur.size, top };
  }

  async function details() {
    const t = now();
    const [ifs, procs, stat] = await Promise.all([safe(interfaces), safe(() => topProcesses()), safe(procStat)]);
    let rates = prevDetailIfaces && t - prevDetailIfaces.t < 30_000 ? ifaceRates(ifs, prevDetailIfaces, t) : new Map();
    if (!rates.size) rates = lastIfaceRates;
    prevDetailIfaces = ifs ? { list: ifs, t } : null;
    // CPU split since the sheet's last refresh (falls back to the last history tick's).
    const split = (prevDetailStat && t - prevDetailStat.t < 30_000 ? cpuSplit(stat, prevDetailStat.stat) : null) ?? lastSplit;
    prevDetailStat = stat ? { stat, t } : null;
    return {
      time: t,
      intervalMs: historyMs,
      history: points,
      cpuSplit: split,
      processes: procs,
      interfaces: (ifs ?? []).map((i) => ({ ...i, rxRate: rates.get(i.name)?.rxRate ?? null, txRate: rates.get(i.name)?.txRate ?? null })),
    };
  }

  return {
    async get() {
      if (cache && now() - cache.time < CACHE_MS) return cache;
      pending ??= sample().finally(() => (pending = null));
      cache = await pending;
      return cache;
    },
    details,
    /** Starts the background history sampler (the server calls this; tests call tick). */
    start() {
      if (histTimer) return;
      tick().catch(() => {});
      histTimer = setInterval(() => tick().catch(() => {}), historyMs);
      histTimer.unref?.();
    },
    stop() {
      clearInterval(histTimer);
      histTimer = null;
    },
    tick,
  };
}
