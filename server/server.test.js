import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from './server.js';

let server, base, dataDir;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pidisplay-'));
  server = createServer({ dataDir, distDir: path.join(dataDir, 'dist') });
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
