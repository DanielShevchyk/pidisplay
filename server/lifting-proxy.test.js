import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer } from './server.js';

let upstream, server, down, base, downBase, dataDir;
const seen = [];

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const make = (liftingUrl) =>
  createServer({
    dataDir,
    distDir: path.join(dataDir, 'dist'),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    faresConfigFile: path.join(dataDir, 'fw.json'),
    stocksAutoStart: false,
    stravaAutoStart: false,
    liftingUrl,
  });

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pidisplay-lifting-'));
  upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url, body });
    res.writeHead(201, { 'Content-Type': 'application/json', 'X-Upstream': 'yes' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upBase = await listen(upstream);
  server = make(upBase);
  base = await listen(server);
  down = make('http://127.0.0.1:9'); // nothing listens there
  downBase = await listen(down);
});

after(async () => {
  for (const s of [upstream, server, down]) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('proxies /lifting/ to the lifting service with the prefix stripped', async () => {
  const res = await fetch(`${base}/lifting/import?x=1`, { method: 'POST', body: '{"sessions":[]}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('x-upstream'), 'yes');
  assert.deepEqual(seen.at(-1), { method: 'POST', url: '/import?x=1', body: '{"sessions":[]}' });
  await fetch(`${base}/lifting/`);
  assert.equal(seen.at(-1).url, '/');
});

test('redirects /lifting to /lifting/ so relative links resolve', async () => {
  const res = await fetch(`${base}/lifting?theme=dark`, { redirect: 'manual' });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/lifting/?theme=dark');
});

test('explains when the lifting service is down', async () => {
  const page = await fetch(`${downBase}/lifting/`);
  assert.equal(page.status, 502);
  assert.match(await page.text(), /isn't running/);
  const api = await fetch(`${downBase}/lifting/api/summary`);
  assert.equal(api.status, 502);
  assert.equal((await api.json()).error, 'The lifting service is not running');
});
