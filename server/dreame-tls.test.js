import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TlsConnection, createHttpClient, buildClientHello, verifyChain } from './dreame-tls.js';

// Test certificates come from the openssl command line (installed on the Pi and
// most Linux boxes); the tests are skipped where it's missing.
let certs = null;
const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

before(() => {
  if (!hasOpenssl) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dreame-tls-'));
  const ossl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'ext.cnf'), 'basicConstraints=CA:FALSE\nsubjectAltName=DNS:us.iot.dreame.test,DNS:localhost\n');
  fs.writeFileSync(path.join(dir, 'ca.cnf'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  const ca = (name) => {
    ossl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${name}.key`);
    ossl('req', '-x509', '-new', '-key', `${name}.key`, '-days', '3650', '-subj', `/CN=${name}`, '-out', `${name}.pem`,
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  };
  ca('root');
  ca('other');
  // Intermediate signed by root.
  ossl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'int.key');
  ossl('req', '-new', '-key', 'int.key', '-subj', '/CN=int', '-out', 'int.csr');
  ossl('x509', '-req', '-in', 'int.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-days', '3650', '-extfile', 'ca.cnf', '-out', 'int.pem');
  const leaf = (name, makeKey) => {
    makeKey(`${name}.key`);
    ossl('req', '-new', '-key', `${name}.key`, '-subj', '/CN=us.iot.dreame.test', '-out', `${name}.csr`);
    ossl('x509', '-req', '-in', `${name}.csr`, '-CA', 'int.pem', '-CAkey', 'int.key', '-CAcreateserial', '-days', '3650', '-extfile', 'ext.cnf', '-out', `${name}.pem`);
  };
  leaf('ec', (out) => ossl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', out));
  leaf('rsa', (out) => ossl('genrsa', '-out', out, '2048'));
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  certs = {
    root: read('root.pem'),
    other: read('other.pem'),
    int: read('int.pem'),
    ec: { key: read('ec.key'), cert: read('ec.pem') + read('int.pem') },
    rsa: { key: read('rsa.key'), cert: read('rsa.pem') + read('int.pem') },
  };
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A Node TLS server answering each HTTP request with a JSON echo; returns its port. */
async function server(opts, handler = defaultHandler) {
  const srv = tls.createServer({ ...opts }, (sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString();
        const len = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0);
        if (buf.length < end + 4 + len) return;
        const body = buf.subarray(end + 4, end + 4 + len).toString();
        buf = buf.subarray(end + 4 + len);
        handler(sock, head, body);
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)), srv };
}

function defaultHandler(sock, head, body) {
  const out = JSON.stringify({ head, body, version: sock.getProtocol(), cipher: sock.getCipher().name });
  sock.write(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(out)}\r\n\r\n${out}`);
}

const connect = (port, extra = {}) =>
  new TlsConnection({ host: '127.0.0.1', port, servername: 'us.iot.dreame.test', ca: [certs.root], timeout: 5000, ...extra }).connect();

const skip = !hasOpenssl && 'openssl is not installed';

test('ClientHello is byte-identical to the Home Assistant integration\'s', async () => {
  const { createHash } = await import('node:crypto');
  // Expected hash computed from the integration's own construction with the same fixed inputs.
  const ch = buildClientHello('us.iot.dreame.tech', Buffer.alloc(32, 7), Buffer.alloc(32, 1), Buffer.alloc(32, 2));
  assert.equal(ch.length, 250);
  assert.equal(createHash('sha256').update(ch).digest('hex'), '848bf24a8ba44363a103a57e7044f6cc3393103c3a5f20b0d01dbac55e579aaa');
});

for (const [name, opts] of [
  ['TLS 1.3 AES-128-GCM', { minVersion: 'TLSv1.3', ciphers: 'TLS_AES_128_GCM_SHA256' }],
  ['TLS 1.3 AES-256-GCM', { minVersion: 'TLSv1.3', ciphers: 'TLS_AES_256_GCM_SHA384' }],
  ['TLS 1.3 ChaCha20', { minVersion: 'TLSv1.3', ciphers: 'TLS_CHACHA20_POLY1305_SHA256' }],
  ['TLS 1.3 RSA-PSS certificate', { minVersion: 'TLSv1.3', rsa: true }],
  ['TLS 1.2 ECDHE-ECDSA-AES128-GCM', { maxVersion: 'TLSv1.2', ciphers: 'ECDHE-ECDSA-AES128-GCM-SHA256' }],
  ['TLS 1.2 ECDHE-ECDSA-AES256-GCM', { maxVersion: 'TLSv1.2', ciphers: 'ECDHE-ECDSA-AES256-GCM-SHA384' }],
  ['TLS 1.2 ECDHE-ECDSA-CHACHA20', { maxVersion: 'TLSv1.2', ciphers: 'ECDHE-ECDSA-CHACHA20-POLY1305' }],
  ['TLS 1.2 ECDHE-RSA-AES128-GCM', { maxVersion: 'TLSv1.2', ciphers: 'ECDHE-RSA-AES128-GCM-SHA256', rsa: true }],
  ['TLS 1.2 ECDHE-RSA-AES256-GCM over P-256', { maxVersion: 'TLSv1.2', ciphers: 'ECDHE-RSA-AES256-GCM-SHA384', rsa: true, ecdhCurve: 'P-256' }],
]) {
  test(`handshake and HTTP round trip: ${name}`, { skip }, async () => {
    const { rsa, ...tlsOpts } = opts;
    const s = await server({ ...(rsa ? certs.rsa : certs.ec), ...tlsOpts });
    const http = createHttpClient({ ca: [certs.root], connect: ({ port, timeout }) => connect(port, { timeout }) });
    try {
      const url = `https://us.iot.dreame.test:${s.port}/dreame-auth/oauth/token`;
      const headers = [['user-agent', 'test'], ['accept-encoding', 'gzip'], ['authorization', 'Basic x'], ['content-type', 'application/json']];
      const a = await http.request('POST', url, headers, '{"a":1}');
      const b = await http.request('POST', url, headers, '{"b":2}'); // same connection, reused
      assert.equal(a.status, 200);
      const ja = JSON.parse(a.body);
      const jb = JSON.parse(b.body);
      assert.equal(ja.body, '{"a":1}');
      assert.equal(jb.body, '{"b":2}');
      assert.equal(ja.version, opts.maxVersion === 'TLSv1.2' ? 'TLSv1.2' : 'TLSv1.3');
      // Header order: content-length right after accept-encoding, host right after authorization.
      assert.match(ja.head, /accept-encoding: gzip\r\ncontent-length: 7\r\nauthorization: Basic x\r\nhost: us\.iot\.dreame\.test:\d+\r\n/);
    } finally {
      http.close();
      await s.close();
    }
  });
}

test('large and chunked gzip responses come through', { skip }, async () => {
  const zlib = await import('node:zlib');
  const big = JSON.stringify({ data: 'x'.repeat(70_000) });
  const s = await server({ ...certs.ec, minVersion: 'TLSv1.3' }, (sock) => {
    const gz = zlib.gzipSync(big);
    sock.write(`HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\ncontent-encoding: gzip\r\n\r\n`);
    sock.write(`${(gz.length - 10).toString(16)}\r\n`);
    sock.write(gz.subarray(0, gz.length - 10));
    sock.write(`\r\n${(10).toString(16)}\r\n`);
    sock.write(gz.subarray(gz.length - 10));
    sock.write('\r\n0\r\n\r\n');
  });
  const http = createHttpClient({ connect: ({ port }) => connect(port) });
  try {
    const r = await http.request('GET', `https://us.iot.dreame.test:${s.port}/x`, [], null);
    assert.equal(r.body.toString(), big);
  } finally {
    http.close();
    await s.close();
  }
});

test('a connection the server closed is replaced on the next request', { skip }, async () => {
  let n = 0;
  const s = await server({ ...certs.ec }, (sock, head, body) => {
    n++;
    defaultHandler(sock, head, body);
    if (n === 1) setTimeout(() => sock.end(), 20);
  });
  const http = createHttpClient({ connect: ({ port }) => connect(port) });
  try {
    const url = `https://us.iot.dreame.test:${s.port}/x`;
    await http.request('GET', url, [], null);
    await new Promise((r) => setTimeout(r, 100));
    const r = await http.request('GET', url, [], null);
    assert.equal(r.status, 200);
    assert.equal(n, 2);
  } finally {
    http.close();
    await s.close();
  }
});

test('refuses a certificate from an untrusted root', { skip }, async () => {
  for (const extra of [{ minVersion: 'TLSv1.3' }, { maxVersion: 'TLSv1.2' }]) {
    const s = await server({ ...certs.ec, ...extra });
    try {
      await assert.rejects(connect(s.port, { ca: [certs.other] }), /not trusted/);
    } finally {
      await s.close();
    }
  }
});

test('refuses a certificate for another host name', { skip }, async () => {
  const s = await server({ ...certs.ec });
  try {
    await assert.rejects(connect(s.port, { servername: 'evil.example' }), /not for evil\.example/);
  } finally {
    await s.close();
  }
});

test('verifyChain accepts root-signed chains and rejects broken ones', { skip }, () => {
  const der = (pem) => Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  const [leaf] = certs.ec.cert.split(/(?<=-----END CERTIFICATE-----)\n?/);
  assert.ok(verifyChain([der(leaf), der(certs.int)], 'us.iot.dreame.test', { ca: [certs.root] }));
  // Missing intermediate.
  assert.throws(() => verifyChain([der(leaf)], 'us.iot.dreame.test', { ca: [certs.root] }), /not trusted/);
  // Expired at a date far in the future.
  assert.throws(
    () => verifyChain([der(leaf), der(certs.int)], 'us.iot.dreame.test', { ca: [certs.root], now: Date.UTC(2100, 0, 1) }),
    /expired/,
  );
});
