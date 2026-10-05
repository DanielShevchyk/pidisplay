import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from './server.js';

let server, base, dataDir;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pidisplay-'));
  server = createServer({
    dataDir,
    distDir: path.join(dataDir, 'dist'),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }),
    faresConfigFile: path.join(dataDir, 'farewatcher-config.json'),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await fs.rm(dataDir, { recursive: true, force: true });
});

const json = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('serves the default layout until one is saved', async () => {
  const layout = await (await fetch(`${base}/api/layout`)).json();
  assert.equal(layout.version, 1);
  assert.ok(layout.pages.length > 0);

  layout.pages[0].name = 'Changed';
  assert.equal((await fetch(`${base}/api/layout`, json('PUT', layout))).status, 204);
  const saved = await (await fetch(`${base}/api/layout`)).json();
  assert.equal(saved.pages[0].name, 'Changed');
});

test('rejects malformed layouts', async () => {
  const res = await fetch(`${base}/api/layout`, json('PUT', { pages: [] }));
  assert.equal(res.status, 400);
});

test('stores widget data by key and rejects path tricks', async () => {
  assert.equal((await fetch(`${base}/api/store/todo.main`)).status, 404);
  await fetch(`${base}/api/store/todo.main`, json('PUT', { items: ['milk'] }));
  assert.deepEqual(await (await fetch(`${base}/api/store/todo.main`)).json(), { items: ['milk'] });
  assert.equal((await fetch(`${base}/api/store/..%2Fsecrets`)).status, 400);
});

test('posts, lists and clears notifications', async () => {
  const res = await fetch(`${base}/api/notifications`, json('POST', { title: 'Hi', level: 'alert' }));
  assert.equal(res.status, 201);
  const n = await res.json();
  assert.equal(n.level, 'alert');
  assert.equal((await (await fetch(`${base}/api/notifications`)).json())[0].id, n.id);
  await fetch(`${base}/api/notifications/${n.id}`, { method: 'DELETE' });
  assert.deepEqual(await (await fetch(`${base}/api/notifications`)).json(), []);
  assert.equal((await fetch(`${base}/api/notifications`, json('POST', {}))).status, 400);
});

test('weather route validates input and reports unknown places', async () => {
  assert.equal((await fetch(`${base}/api/weather`)).status, 400);
  const res = await fetch(`${base}/api/weather?location=Nowhere`);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /Nowhere/);
});

test('serves the Farewatcher summary once it has been written', async () => {
  assert.deepEqual(await (await fetch(`${base}/api/fares`)).json(), { available: false });
  await fs.writeFile(path.join(dataDir, 'farewatcher.json'), JSON.stringify({ currency: 'USD', deals: [] }));
  const body = await (await fetch(`${base}/api/fares`)).json();
  assert.equal(body.available, true);
  assert.equal(body.currency, 'USD');
});

test('sends Farewatcher ticket links to the phone only for flight sites, once ntfy is set up', async () => {
  const url = 'https://www.google.com/travel/flights?q=Flights%20from%20SFO%20to%20TYO';
  let res = await fetch(`${base}/api/fares/send`, json('POST', { url }));
  assert.equal(res.status, 503); // no Farewatcher config yet
  await fs.writeFile(
    path.join(dataDir, 'farewatcher-config.json'),
    JSON.stringify({ notify: { ntfy_server: 'https://ntfy.example', ntfy_topic: 'test-topic' } }),
  );
  assert.equal((await fetch(`${base}/api/fares/send`, json('POST', { url: 'https://evil.example/x' }))).status, 400);
  assert.equal((await fetch(`${base}/api/fares/send`, json('POST', { url: 'not a url' }))).status, 400);
  res = await fetch(`${base}/api/fares/send`, json('POST', { url, title: 'Tokyo $589' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sent: true });
});

test('timers and alarms are served under /api/timers and /api/alarms', async () => {
  let res = await fetch(`${base}/api/timers`, json('POST', { durationMs: 60000, label: 'Tea' }));
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(s.timers[0].label, 'Tea');
  assert.equal(typeof s.now, 'number');
  res = await fetch(`${base}/api/alarms`, json('POST', { hour: 7, minute: 0, days: [1] }));
  assert.equal((await res.json()).alarms.length, 1);
  assert.equal((await fetch(`${base}/api/timers/${s.timers[0].id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/timers`, json('POST', { durationMs: 'soon' }))).status, 400);
  await new Promise((r) => setTimeout(r, 50)); // saves are queued behind the response
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'timers.json'), 'utf8'));
  assert.equal(saved.alarms.length, 1);
});
