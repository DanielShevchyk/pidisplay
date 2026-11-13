// Measures one page swipe on the kiosk. Run on the Pi (Node 22):
//   node scripts/trace-swipe.mjs [left|right] [out.json]
// Needs the kiosk's debugging port (deploy/kiosk.sh: 127.0.0.1:9222). It drags the
// pages with a synthetic finger, records a Chromium trace and the GPU's busy time,
// and prints frame timing plus where the work went. The raw trace is saved for a
// closer look (load it in https://ui.perfetto.dev).
import { readFileSync, writeFileSync } from 'node:fs';

const dir = process.argv[2] === 'right' ? 1 : -1;
const out = process.argv[3] || '/tmp/swipe-trace.json';
const GPU_STATS = '/sys/devices/platform/v3dbus/fec00000.v3d/gpu_stats';

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:8080'));
if (!page) throw new Error('Kiosk page not found on port 9222');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
let nextId = 1;
const pending = new Map();
const events = [];
let traceDone;
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { ok, fail } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
  } else if (msg.method === 'Tracing.dataCollected') events.push(...msg.params.value);
  else if (msg.method === 'Tracing.tracingComplete') traceDone?.();
};
const send = (method, params = {}) =>
  new Promise((ok, fail) => {
    const id = nextId++;
    pending.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gpu = () => {
  const row = readFileSync(GPU_STATS, 'utf8').split('\n').find((l) => l.startsWith('render'));
  const [, ts, jobs, runtime] = row.split(/\s+/).map(Number);
  return { ts, jobs, runtime };
};

// Optional experiments: PAGE=<index> taps that page's dot first, CSS=<rules> adds a
// style sheet (e.g. CSS='.tile{background:none!important}'), both before tracing.
if (process.env.PAGE || process.env.CSS) {
  await send('Runtime.evaluate', {
    expression: `(() => {
      const css = ${JSON.stringify(process.env.CSS || '')};
      let s = document.getElementById('trace-css');
      if (!s) { s = document.createElement('style'); s.id = 'trace-css'; document.head.append(s); }
      s.textContent = css;
      const i = ${JSON.stringify(process.env.PAGE ?? '')};
      if (i !== '') document.querySelectorAll('.dot')[Number(i)]?.click();
    })()`,
  });
  await sleep(4000);
}

const before = await send('Runtime.evaluate', {
  expression: `document.querySelector('.page-title')?.textContent`,
  returnByValue: true,
});

await send('Tracing.start', {
  traceConfig: {
    recordMode: 'recordAsMuchAsPossible',
    includedCategories: [
      'devtools.timeline',
      'disabled-by-default-devtools.timeline',
      'disabled-by-default-devtools.timeline.frame',
      'blink',
      'cc',
      'gpu',
      'viz',
      'benchmark',
      'toplevel',
    ],
  },
});
await sleep(300);

// A finger drag across 60% of the screen in ~240 ms, then the release slide.
const y = 1040;
const x0 = dir < 0 ? 1500 : 420;
const x1 = x0 + dir * 1150;
const g0 = gpu();
const t0 = Date.now();
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y, button: 'left', clickCount: 1 });
for (let i = 1; i <= 15; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / 15, y, button: 'left', buttons: 1 });
  await sleep(16);
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y, button: 'left', clickCount: 1 });
await sleep(1100);
const g1 = gpu();
const tEnd = Date.now();

const done = new Promise((r) => (traceDone = r));
await send('Tracing.end');
await done;
const after = await send('Runtime.evaluate', {
  expression: `document.querySelector('.page-title')?.textContent`,
  returnByValue: true,
});
ws.close();
writeFileSync(out, JSON.stringify({ traceEvents: events }));

// ---- Summary -----------------------------------------------------------
const threads = new Map();
for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') threads.set(`${e.pid}:${e.tid}`, e.args.name);
const tname = (e) => threads.get(`${e.pid}:${e.tid}`) || `tid ${e.tid}`;

const pressTs = events.find((e) => e.name === 'EventDispatch' && e.args?.data?.type === 'pointerdown')?.ts;
const startTs = pressTs ?? Math.min(...events.filter((e) => e.ts).map((e) => e.ts));
const windowEnd = startTs + (tEnd - t0) * 1000;
const inWindow = (e) => e.ts >= startTs && e.ts <= windowEnd;

// Frames the display compositor actually drew.
const swapNames = ['Display::DrawAndSwap', 'DisplayScheduler::DrawAndSwap', 'Graphics.Pipeline.DrawAndSwap'];
const swapName = swapNames.find((n) => events.some((e) => e.name === n));
const swaps = swapName ? events.filter((e) => e.name === swapName && e.ph !== 'e' && inWindow(e)).map((e) => e.ts).sort((a, b) => a - b) : [];
const gaps = swaps.slice(1).map((t, i) => (t - swaps[i]) / 1000);
const slow = gaps.filter((g) => g > 25);

// Where the time went, by thread and event (complete events only, top level-ish).
const busy = new Map();
for (const e of events) {
  if (e.ph !== 'X' || !e.dur || !inWindow(e)) continue;
  const key = `${tname(e)} | ${e.name}`;
  busy.set(key, (busy.get(key) || 0) + e.dur / 1000);
}
const top = [...busy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 28);

// The same frames split by phase: finger down, the release slide, and after it settles
// (when the page beyond the new one is woken).
const upTs = events.find((e) => e.name === 'EventDispatch' && e.args?.data?.type === 'pointerup')?.ts;
const phases = upTs
  ? [
      ['drag', startTs, upTs],
      ['slide', upTs, upTs + 400_000],
      ['settle', upTs + 400_000, windowEnd],
    ]
  : [];
const phaseLines = phases.map(([name, a, b]) => {
  const s = swaps.filter((t) => t >= a && t <= b);
  const g = s.slice(1).map((t, i) => (t - s[i]) / 1000);
  const longest = events
    .filter((e) => e.name === 'ProxyMain::BeginMainFrame' && e.ts >= a && e.ts <= b && e.dur)
    .reduce((m, e) => Math.max(m, e.dur / 1000), 0);
  return `  ${name.padEnd(6)} ${((b - a) / 1000).toFixed(0).padStart(4)} ms: ${s.length} frames, worst gap ${Math.max(0, ...g).toFixed(0)} ms, longest main-thread frame ${longest.toFixed(0)} ms`;
});

const gpuBusy = ((g1.runtime - g0.runtime) / (g1.ts - g0.ts)) * 100;
console.log(`Swipe ${dir < 0 ? 'left' : 'right'}: "${before.result?.value}" -> "${after.result?.value}"`);
console.log(`Window ${((windowEnd - startTs) / 1000).toFixed(0)} ms; ${events.length} trace events saved to ${out}`);
console.log(`GPU: ${gpuBusy.toFixed(0)}% busy, ${g1.jobs - g0.jobs} render jobs`);
if (swapName) {
  const avg = gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1);
  console.log(`Frames drawn (${swapName}): ${swaps.length}, mean gap ${avg.toFixed(1)} ms, worst ${Math.max(0, ...gaps).toFixed(1)} ms, gaps >25 ms: ${slow.length} [${slow.map((g) => g.toFixed(0)).join(', ')}]`);
} else console.log('No display swap events in the trace');
for (const line of phaseLines) console.log(line);
const rasterMs = events
  .filter((e) => e.name === 'RasterTask' && e.ph === 'X' && inWindow(e))
  .reduce((s, e) => s + e.dur / 1000, 0);
const gpuRasterMs = events
  .filter((e) => e.name === 'RasterDecoderImpl::DoEndRasterCHROMIUM' && e.ph === 'X' && inWindow(e))
  .reduce((s, e) => s + e.dur / 1000, 0);
console.log(`Raster: ${rasterMs.toFixed(0)} ms in raster tasks, ${gpuRasterMs.toFixed(0)} ms of GPU raster flushes`);
console.log('Busiest (thread | event: ms, events overlap):');
for (const [k, ms] of top) console.log(`  ${ms.toFixed(1).padStart(7)}  ${k}`);
