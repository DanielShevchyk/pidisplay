import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from './server.js';
import { createKiosk } from './kiosk.js';

async function withServer(kiosk, fn) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pidisplay-kiosk-'));
  const server = createServer({ dataDir, distDir: path.join(dataDir, 'dist'), kiosk });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, dataDir);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

test('exit drops the flag kiosk.sh waits on, then closes the browser', async () => {
  const flagDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pidisplay-flag-'));
  const flagFile = path.join(flagDir, 'pidisplay-desktop');
  let closed;
  const browserClosed = new Promise((r) => (closed = r));
  const kiosk = createKiosk({ flagFile, supported: true, closeBrowser: async () => closed() });

  await withServer(kiosk, async (base) => {
    const res = await fetch(`${base}/api/kiosk/exit`, { method: 'POST' });
    assert.equal(res.status, 204);
    await fs.access(flagFile);
    await browserClosed;
  });
  await fs.rm(flagDir, { recursive: true, force: true });
});

test('exit is refused where there is no kiosk', async () => {
  const kiosk = createKiosk({ supported: false, closeBrowser: async () => assert.fail('should not close') });
  await withServer(kiosk, async (base) => {
    assert.equal((await fetch(`${base}/api/kiosk/exit`, { method: 'POST' })).status, 501);
    assert.equal((await fetch(`${base}/api/kiosk/exit`)).status, 404);
  });
});
