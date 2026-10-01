import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystem, decodeThrottled } from './system.js';

const MEMINFO = `MemTotal:        3884136 kB
MemFree:          812344 kB
MemAvailable:    2942136 kB
SwapTotal:        204796 kB
SwapFree:         102396 kB
`;

const NETDEV = (rx, tx) => `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 999999 10 0 0 0 0 0 0 999999 10 0 0 0 0 0 0
  eth0: ${rx} 100 0 0 0 0 0 0 ${tx} 80 0 0 0 0 0 0
`;

/** A fake Pi: files, commands and CPU counters advance on every call. */
function fakePi({ files = {}, commands = {}, vcgencmdMissing = false } = {}) {
  let tick = 0;
  let clock = 1_000_000;
  const net = { rx: 1000, tx: 500 };
  return {
    advance(ms) {
      clock += ms;
      net.rx += 2000;
      net.tx += 1000;
    },
    opts: {
      now: () => clock,
      readFile: async (f) => {
        if (f === '/proc/net/dev') return NETDEV(net.rx, net.tx);
        if (f in files) return files[f];
        throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      },
      readdir: async () => [],
      statfs: async () => ({ bsize: 4096, blocks: 1000, bfree: 400, bavail: 350 }),
      exec: async (cmd, args) => {
        if (vcgencmdMissing) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        const key = args.join(' ');
        if (key in commands) return commands[key];
        throw new Error('unknown');
      },
      // Each core: +60 busy, +40 idle per sample, so 60% usage.
      cpus: () => {
        tick++;
        return [0, 1].map(() => ({ speed: 1500, times: { user: 60 * tick, nice: 0, sys: 0, idle: 40 * tick, irq: 0 } }));
      },
    },
  };
}

test('decodes throttle flags', () => {
  const f = decodeThrottled(0x50005);
  assert.equal(f.underVoltage, true);
  assert.equal(f.freqCapped, false);
  assert.equal(f.throttled, true);
  assert.equal(f.underVoltageOccurred, true);
  assert.equal(f.throttledOccurred, true);
  assert.equal(f.softTempLimitOccurred, false);
});

test('reads Pi metrics from /proc, /sys and vcgencmd', async () => {
  const pi = fakePi({
    files: {
      '/proc/meminfo': MEMINFO,
      '/sys/class/thermal/thermal_zone0/temp': '48312\n',
      '/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq': '1800000\n',
      '/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq': '1800000\n',
    },
    commands: { get_throttled: 'throttled=0x50000\n', 'measure_volts core': 'volt=0.8500V\n' },
  });
  const sys = createSystem(pi.opts);
  const s = await sys.get();

  assert.equal(s.cpu.usage, 60);
  assert.deepEqual(s.cpu.cores, [60, 60]);
  assert.equal(s.cpu.mhz, 1800);
  assert.equal(s.temperature, 48.3);
  assert.equal(s.memory.total, 3884136 * 1024);
  assert.equal(s.memory.used, (3884136 - 2942136) * 1024);
  assert.equal(s.memory.swapUsed, (204796 - 102396) * 1024);
  assert.deepEqual(s.disk, { path: '/', total: 4096000, used: 2457600, free: 1433600 });
  assert.equal(s.power.underVoltage, false);
  assert.equal(s.power.underVoltageOccurred, true);
  assert.equal(s.power.coreVolts, 0.85);
  assert.equal(s.power.raw, 0x50000);
  assert.equal(s.network.rxRate, null); // nothing to compare against yet

  pi.advance(2000);
  const s2 = await sys.get();
  assert.equal(s2.network.rxRate, 1000);
  assert.equal(s2.network.txRate, 500);
});

test('returns nulls instead of failing when nothing Pi-specific exists', async () => {
  const pi = fakePi({ vcgencmdMissing: true });
  const sys = createSystem({ ...pi.opts, statfs: async () => { throw new Error('no statfs'); } });
  const s = await sys.get();
  assert.equal(s.temperature, null);
  assert.equal(s.power, null);
  assert.equal(s.disk, null);
  assert.ok(s.memory.total > 0); // falls back to os.totalmem()
  assert.equal(s.cpu.mhz, 1500);
});

test('caches a sample for concurrent and rapid requests', async () => {
  const pi = fakePi();
  let calls = 0;
  const cpus = pi.opts.cpus;
  const sys = createSystem({ ...pi.opts, cpus: () => (calls++, cpus()) });
  const [a, b] = await Promise.all([sys.get(), sys.get()]);
  assert.equal(a, b);
  const before = calls;
  await sys.get();
  assert.equal(calls, before);
});
