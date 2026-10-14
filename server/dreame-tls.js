// A small TLS client and HTTP/1.1 request helper for Dreame's cloud.
//
// Dreame's servers drop connections whose TLS handshake doesn't look like the
// Dreamehome phone app's (Node's built-in TLS is refused), so this sends the
// same ClientHello the community Home Assistant integration does
// (github.com/Tasshack/dreame-vacuum, MIT) and runs the handshake itself with
// node:crypto. Unlike that integration it checks the server certificate chain
// against the system's trusted roots, the host name, the server's handshake
// signature and its Finished message, so the account password only ever goes
// to the real Dreame server.
//
// Supports TLS 1.3 (AES-GCM, ChaCha20-Poly1305) and TLS 1.2 ECDHE with AEAD
// ciphers, which is all the ClientHello offers that a modern server picks.

import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
// SHA-256 of "HelloRetryRequest", sent as ServerHello.random to ask for another key share.
const HRR_RANDOM = Buffer.from('cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c', 'hex');
const CIPHERS = [
  0x1303, 0x1301, 0x1302, 0xcca9, 0xcca8, 0xc02b, 0xc02f, 0xc02c, 0xc030, 0xc009, 0xc013, 0xc00a, 0xc014, 0x009c,
  0x009d, 0x002f, 0x0035,
];
const SIG_ALGS = [0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601, 0x0201];
const TLS12_SUITES = {
  0xcca9: { aead: 'chacha20-poly1305', keyLen: 32, ivLen: 12, hash: 'sha256' },
  0xcca8: { aead: 'chacha20-poly1305', keyLen: 32, ivLen: 12, hash: 'sha256' },
  0xc02b: { aead: 'aes-128-gcm', keyLen: 16, ivLen: 4, hash: 'sha256' },
  0xc02f: { aead: 'aes-128-gcm', keyLen: 16, ivLen: 4, hash: 'sha256' },
  0xc02c: { aead: 'aes-256-gcm', keyLen: 32, ivLen: 4, hash: 'sha384' },
  0xc030: { aead: 'aes-256-gcm', keyLen: 32, ivLen: 4, hash: 'sha384' },
};
const TLS13_SUITES = {
  0x1301: { aead: 'aes-128-gcm', keyLen: 16, hash: 'sha256', hashLen: 32 },
  0x1302: { aead: 'aes-256-gcm', keyLen: 32, hash: 'sha384', hashLen: 48 },
  0x1303: { aead: 'chacha20-poly1305', keyLen: 32, hash: 'sha256', hashLen: 32 },
};
const CURVES = { 0x0017: 'prime256v1', 0x0018: 'secp384r1' };

export class TlsError extends Error {}

const u16 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u24 = (n) => Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
const ext = (type, body) => Buffer.concat([u16(type), u16(body.length), body]);
const hmac = (hash, key, data) => crypto.createHmac(hash, key).update(data).digest();
const digest = (hash, data) => crypto.createHash(hash).update(data).digest();

function hkdfExpandLabel(hash, secret, label, context, length) {
  const full = Buffer.from(`tls13 ${label}`);
  const info = Buffer.concat([u16(length), Buffer.from([full.length]), full, Buffer.from([context.length]), context]);
  let out = Buffer.alloc(0);
  let t = Buffer.alloc(0);
  for (let i = 1; out.length < length; i++) {
    t = hmac(hash, secret, Buffer.concat([t, info, Buffer.from([i])]));
    out = Buffer.concat([out, t]);
  }
  return out.subarray(0, length);
}

/** TLS 1.2 PRF (P_hash). */
function prf(hash, secret, label, seed, length) {
  const s = Buffer.concat([Buffer.from(label), seed]);
  let a = s;
  let out = Buffer.alloc(0);
  while (out.length < length) {
    a = hmac(hash, secret, a);
    out = Buffer.concat([out, hmac(hash, secret, Buffer.concat([a, s]))]);
  }
  return out.subarray(0, length);
}

function seal(aead, key, nonce, aad, plaintext) {
  const c = crypto.createCipheriv(aead, key, nonce, { authTagLength: 16 });
  c.setAAD(aad, { plaintextLength: plaintext.length });
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
}

function open(aead, key, nonce, aad, sealed) {
  if (sealed.length < 16) throw new TlsError('short TLS record');
  const d = crypto.createDecipheriv(aead, key, nonce, { authTagLength: 16 });
  d.setAAD(aad, { plaintextLength: sealed.length - 16 });
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  try {
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  } catch {
    throw new TlsError('TLS record failed to decrypt');
  }
}

function seqNonce(iv, seq) {
  const n = Buffer.from(iv);
  const s = Buffer.alloc(8);
  s.writeBigUInt64BE(BigInt(seq));
  for (let i = 0; i < 8; i++) n[n.length - 8 + i] ^= s[i];
  return n;
}

function x25519Pair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    pub: raw,
    shared: (peer) =>
      crypto.diffieHellman({
        privateKey,
        publicKey: crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI, peer]), format: 'der', type: 'spki' }),
      }),
  };
}

/** The ClientHello Dreame's servers accept (same bytes as the Home Assistant integration's). */
export function buildClientHello(servername, keyShare, random = crypto.randomBytes(32), sessionId = crypto.randomBytes(32)) {
  const sni = Buffer.from(servername ?? '', 'ascii');
  const sniList = Buffer.concat([Buffer.from([0]), u16(sni.length), sni]);
  const groups = Buffer.concat([0x001d, 0x0017, 0x0018].map(u16));
  const sigs = Buffer.concat(SIG_ALGS.map(u16));
  const ks = Buffer.concat([u16(0x001d), u16(keyShare.length), keyShare]);
  let exts = Buffer.concat([
    ext(0, Buffer.concat([u16(sniList.length), sniList])),
    ext(23, Buffer.alloc(0)),
    ext(65281, Buffer.from([0])),
    ext(10, Buffer.concat([u16(groups.length), groups])),
    ext(11, Buffer.from([1, 0])),
    ext(35, Buffer.alloc(0)),
    ext(13, Buffer.concat([u16(sigs.length), sigs])),
    ext(51, Buffer.concat([u16(ks.length), ks])),
    ext(45, Buffer.from([1, 1])),
    ext(43, Buffer.from([4, 3, 4, 3, 3])),
  ]);
  const suites = Buffer.concat(CIPHERS.map(u16));
  let body = Buffer.concat([Buffer.from([3, 3]), random, Buffer.from([32]), sessionId, u16(suites.length), suites, Buffer.from([1, 0])]);
  // Pad hellos between 256 and 511 bytes up to 512, as BoringSSL/OkHttp do.
  const msgLen = 4 + body.length + 2 + exts.length;
  if (msgLen >= 256 && msgLen < 512) {
    const need = Math.max(0, 512 - msgLen - 4);
    exts = Buffer.concat([exts, ext(21, Buffer.alloc(need))]);
  }
  body = Buffer.concat([body, u16(exts.length), exts]);
  return Buffer.concat([Buffer.from([1]), u24(body.length), body]);
}

// ---- Certificate checks -------------------------------------------------

let roots = null;
function trustedRoots() {
  roots ??= tls.rootCertificates.map((pem) => {
    try {
      return new crypto.X509Certificate(pem);
    } catch {
      return null;
    }
  }).filter(Boolean);
  return roots;
}

/** Checks a DER chain (leaf first) against the trusted roots and the host name. Returns the leaf. */
export function verifyChain(ders, host, { now = Date.now(), ca = null } = {}) {
  if (!ders.length) throw new TlsError('server sent no certificate');
  const chain = ders.map((d) => new crypto.X509Certificate(d));
  const anchors = ca ? ca.map((c) => (c instanceof crypto.X509Certificate ? c : new crypto.X509Certificate(c))) : trustedRoots();
  const inDate = (c) => Date.parse(c.validFrom) <= now && now <= Date.parse(c.validTo);
  if (!chain[0].checkHost(host)) throw new TlsError(`certificate is not for ${host}`);
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i];
    if (!inDate(cert)) throw new TlsError('server certificate has expired or is not valid yet');
    const anchor = anchors.find((r) => cert.checkIssued(r) && cert.verify(r.publicKey));
    if (anchor) {
      if (!inDate(anchor)) throw new TlsError('root certificate has expired');
      return chain[0];
    }
    if (anchors.some((r) => r.fingerprint256 === cert.fingerprint256)) return chain[0];
    const next = chain[i + 1];
    if (!next || !cert.checkIssued(next) || !cert.verify(next.publicKey) || !next.ca) break;
  }
  throw new TlsError('server certificate is not trusted');
}

function verifySignature(scheme, publicKey, data, sig) {
  const rsaPss = { 0x0804: ['sha256', 32], 0x0805: ['sha384', 48], 0x0806: ['sha512', 64] }[scheme];
  if (rsaPss) {
    return crypto.verify(rsaPss[0], data, { key: publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: rsaPss[1] }, sig);
  }
  const hash = { 0x0403: 'sha256', 0x0503: 'sha384', 0x0603: 'sha512', 0x0401: 'sha256', 0x0501: 'sha384', 0x0601: 'sha512' }[scheme];
  if (!hash) throw new TlsError(`unsupported signature scheme ${scheme.toString(16)}`);
  return crypto.verify(hash, data, publicKey, sig);
}

// ---- Connection ---------------------------------------------------------

/**
 * One TLS connection. `connect()` runs the handshake; then `write(buf)` sends
 * application data and `read()` resolves with the next chunk (null at EOF).
 */
export class TlsConnection {
  constructor({ host, port = 443, servername = host, timeout = 15_000, ca = null, socketFactory = null } = {}) {
    this.host = host;
    this.port = port;
    this.servername = servername;
    this.timeout = timeout;
    this.ca = ca;
    this.socketFactory = socketFactory ?? (() => net.connect({ host, port }));
    this.rbuf = Buffer.alloc(0);
    this.app = [];
    this.waiter = null;
    this.ended = false;
    this.error = null;
    this.closed = false;
  }

  // -- raw socket plumbing --

  _wake() {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  _wait() {
    if (this.error) return Promise.reject(this.error);
    if (this.ended) return Promise.reject(new TlsError('connection closed'));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiter = null;
        reject(new TlsError('timed out'));
      }, this.timeout);
      this.waiter = () => {
        clearTimeout(t);
        if (this.error) reject(this.error);
        else resolve();
      };
    });
  }

  async _record() {
    for (;;) {
      if (this.rbuf.length >= 5) {
        const len = this.rbuf.readUInt16BE(3);
        if (this.rbuf.length >= 5 + len) {
          const type = this.rbuf[0];
          const body = this.rbuf.subarray(5, 5 + len);
          this.rbuf = this.rbuf.subarray(5 + len);
          return { type, body };
        }
      }
      if (this.ended && this.rbuf.length === 0) return null;
      await this._wait();
    }
  }

  _send(type, body) {
    this.sock.write(Buffer.concat([Buffer.from([type, 3, type === 22 && !this.hsDone && !this.sentFirst ? 1 : 3]), u16(body.length), body]));
    this.sentFirst = true;
  }

  async connect() {
    this.sock = this.socketFactory();
    this.sock.setNoDelay?.(true);
    this.sock.setKeepAlive?.(true, 60_000);
    this.sock.on('data', (d) => {
      this.rbuf = this.rbuf.length ? Buffer.concat([this.rbuf, d]) : d;
      this._wake();
    });
    this.sock.on('end', () => {
      this.ended = true;
      this._wake();
    });
    this.sock.on('close', () => {
      this.ended = true;
      this.closed = true;
      this._wake();
    });
    this.sock.on('error', (err) => {
      this.error = new TlsError(err.message);
      this._wake();
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new TlsError('connect timed out')), this.timeout);
      const done = (err) => {
        clearTimeout(t);
        if (err) reject(new TlsError(err.message));
        else resolve();
      };
      if (this.sock.readyState === 'open') done();
      else {
        this.sock.once('connect', () => done());
        this.sock.once('error', done);
      }
    }).catch((err) => {
      this.sock.destroy();
      throw err;
    });
    try {
      await this._handshake();
    } catch (err) {
      this.close();
      throw err instanceof TlsError ? err : new TlsError(err.message);
    }
    return this;
  }

  // -- handshake --

  async _plainHandshakeMessages() {
    // Yields plaintext handshake messages (header included), skipping CCS.
    const rec = await this._record();
    if (!rec) throw new TlsError('connection closed during handshake');
    if (rec.type === 21) throw new TlsError(`server refused the handshake (alert ${rec.body[1]})`);
    if (rec.type === 20) return this._plainHandshakeMessages();
    if (rec.type !== 22) throw new TlsError('unexpected record during handshake');
    return rec.body;
  }

  async _handshake() {
    const kx = x25519Pair();
    this.clientRandom = crypto.randomBytes(32);
    const ch = buildClientHello(this.servername, kx.pub, this.clientRandom);
    this._send(22, ch);
    const msgs = new HandshakeReader(() => this._plainHandshakeMessages());
    const sh = await msgs.next();
    if (sh[0] !== 2) throw new TlsError('expected ServerHello');
    const p = parseServerHello(sh);
    if (p.random.equals(HRR_RANDOM)) throw new TlsError('server asked for a different key exchange');
    this.cipher = p.cipher;
    if (p.version === 0x0304) {
      if (!TLS13_SUITES[p.cipher] || !p.keyShare) throw new TlsError('unsupported TLS 1.3 parameters');
      await this._handshake13(Buffer.concat([ch, sh]), kx.shared(p.keyShare));
    } else {
      if (!TLS12_SUITES[p.cipher]) throw new TlsError(`unsupported TLS 1.2 cipher ${p.cipher.toString(16)}`);
      this.ems = p.ems;
      await this._handshake12(Buffer.concat([ch, sh]), p.random, msgs);
    }
    this.hsDone = true;
  }

  async _handshake13(transcript, shared) {
    const s = TLS13_SUITES[this.cipher];
    this.s13 = s;
    const H = (d) => digest(s.hash, d);
    const zero = Buffer.alloc(s.hashLen);
    const early = hmac(s.hash, zero, zero);
    const hsSecret = hmac(s.hash, hkdfExpandLabel(s.hash, early, 'derived', H(Buffer.alloc(0)), s.hashLen), shared);
    const cHs = hkdfExpandLabel(s.hash, hsSecret, 'c hs traffic', H(transcript), s.hashLen);
    const sHs = hkdfExpandLabel(s.hash, hsSecret, 's hs traffic', H(transcript), s.hashLen);
    const sKey = hkdfExpandLabel(s.hash, sHs, 'key', Buffer.alloc(0), s.keyLen);
    const sIv = hkdfExpandLabel(s.hash, sHs, 'iv', Buffer.alloc(0), 12);
    let sseq = 0;
    const encrypted = async () => {
      for (;;) {
        const rec = await this._record();
        if (!rec) throw new TlsError('connection closed during handshake');
        if (rec.type === 20) continue;
        if (rec.type === 21) throw new TlsError(`server refused the handshake (alert ${rec.body[1]})`);
        const aad = Buffer.concat([Buffer.from([rec.type, 3, 3]), u16(rec.body.length)]);
        const pt = stripPadding(open(s.aead, sKey, seqNonce(sIv, sseq++), aad, rec.body));
        if (pt.type === 22) return pt.data;
        if (pt.type === 21) throw new TlsError('alert during handshake');
      }
    };
    const msgs = new HandshakeReader(encrypted);
    let leaf = null;
    for (;;) {
      const m = await msgs.next();
      const type = m[0];
      if (type === 11) {
        leaf = verifyChain(parseCertificates13(m.subarray(4)), this.servername, { ca: this.ca });
      } else if (type === 15) {
        if (!leaf) throw new TlsError('server skipped its certificate');
        const scheme = m.readUInt16BE(4);
        const sig = m.subarray(8, 8 + m.readUInt16BE(6));
        const signed = Buffer.concat([Buffer.alloc(64, 0x20), Buffer.from('TLS 1.3, server CertificateVerify\0'), H(transcript)]);
        if (!verifySignature(scheme, leaf.publicKey, signed, sig)) throw new TlsError('server handshake signature is wrong');
      } else if (type === 20) {
        if (!leaf) throw new TlsError('server skipped its certificate');
        const expected = hmac(s.hash, hkdfExpandLabel(s.hash, sHs, 'finished', Buffer.alloc(0), s.hashLen), H(transcript));
        if (!crypto.timingSafeEqual(expected, m.subarray(4))) throw new TlsError('server Finished does not match');
        transcript = Buffer.concat([transcript, m]);
        break;
      }
      transcript = Buffer.concat([transcript, m]);
    }
    const vd = hmac(s.hash, hkdfExpandLabel(s.hash, cHs, 'finished', Buffer.alloc(0), s.hashLen), H(transcript));
    const fin = Buffer.concat([Buffer.from([20]), u24(vd.length), vd]);
    this.sock.write(Buffer.from([0x14, 3, 3, 0, 1, 1]));
    const cKey = hkdfExpandLabel(s.hash, cHs, 'key', Buffer.alloc(0), s.keyLen);
    const cIv = hkdfExpandLabel(s.hash, cHs, 'iv', Buffer.alloc(0), 12);
    const inner = Buffer.concat([fin, Buffer.from([22])]);
    const aad = Buffer.concat([Buffer.from([23, 3, 3]), u16(inner.length + 16)]);
    const ct = seal(s.aead, cKey, seqNonce(cIv, 0), aad, inner);
    this.sock.write(Buffer.concat([Buffer.from([23, 3, 3]), u16(ct.length), ct]));
    const master = hmac(s.hash, hkdfExpandLabel(s.hash, hsSecret, 'derived', H(Buffer.alloc(0)), s.hashLen), zero);
    this.cAp = hkdfExpandLabel(s.hash, master, 'c ap traffic', H(transcript), s.hashLen);
    this.sAp = hkdfExpandLabel(s.hash, master, 's ap traffic', H(transcript), s.hashLen);
    this._keys13();
  }

  _keys13(which = 'both') {
    const s = this.s13;
    if (which !== 's') {
      this.cKey = hkdfExpandLabel(s.hash, this.cAp, 'key', Buffer.alloc(0), s.keyLen);
      this.cIv = hkdfExpandLabel(s.hash, this.cAp, 'iv', Buffer.alloc(0), 12);
      this.cseq = 0;
    }
    if (which !== 'c') {
      this.sKey = hkdfExpandLabel(s.hash, this.sAp, 'key', Buffer.alloc(0), s.keyLen);
      this.sIv = hkdfExpandLabel(s.hash, this.sAp, 'iv', Buffer.alloc(0), 12);
      this.sseq = 0;
    }
  }

  async _handshake12(transcript, serverRandom, msgs) {
    const s = TLS12_SUITES[this.cipher];
    this.s12 = s;
    let leaf = null;
    let ske = null;
    for (;;) {
      const m = await msgs.next();
      transcript = Buffer.concat([transcript, m]);
      if (m[0] === 11) leaf = verifyChain(parseCertificates12(m.subarray(4)), this.servername, { ca: this.ca });
      else if (m[0] === 12) ske = m.subarray(4);
      else if (m[0] === 13) throw new TlsError('server asked for a client certificate');
      else if (m[0] === 14) break;
    }
    if (!leaf) throw new TlsError('server skipped its certificate');
    if (!ske || ske[0] !== 3) throw new TlsError('server sent no key exchange');
    const curve = ske.readUInt16BE(1);
    const serverPub = ske.subarray(4, 4 + ske[3]);
    const params = ske.subarray(0, 4 + ske[3]);
    const scheme = ske.readUInt16BE(params.length);
    const sig = ske.subarray(params.length + 4, params.length + 4 + ske.readUInt16BE(params.length + 2));
    if (!verifySignature(scheme, leaf.publicKey, Buffer.concat([this.clientRandom, serverRandom, params]), sig)) {
      throw new TlsError('server key exchange signature is wrong');
    }
    let myPub;
    let shared;
    if (curve === 0x001d) {
      const kx = x25519Pair();
      myPub = kx.pub;
      shared = kx.shared(serverPub);
    } else if (CURVES[curve]) {
      const ecdh = crypto.createECDH(CURVES[curve]);
      myPub = ecdh.generateKeys();
      shared = ecdh.computeSecret(serverPub);
    } else throw new TlsError('unsupported key exchange curve');
    const ckeBody = Buffer.concat([Buffer.from([myPub.length]), myPub]);
    const cke = Buffer.concat([Buffer.from([16]), u24(ckeBody.length), ckeBody]);
    transcript = Buffer.concat([transcript, cke]);
    const master = this.ems
      ? prf(s.hash, shared, 'extended master secret', digest(s.hash, transcript), 48)
      : prf(s.hash, shared, 'master secret', Buffer.concat([this.clientRandom, serverRandom]), 48);
    const kb = prf(s.hash, master, 'key expansion', Buffer.concat([serverRandom, this.clientRandom]), 2 * s.keyLen + 2 * s.ivLen);
    this.cKey = kb.subarray(0, s.keyLen);
    this.sKey = kb.subarray(s.keyLen, 2 * s.keyLen);
    this.cIv = kb.subarray(2 * s.keyLen, 2 * s.keyLen + s.ivLen);
    this.sIv = kb.subarray(2 * s.keyLen + s.ivLen, 2 * s.keyLen + 2 * s.ivLen);
    this.cseq = 0;
    this.sseq = 0;
    this.tls12 = true;
    this._send(22, cke);
    this.sock.write(Buffer.from([0x14, 3, 3, 0, 1, 1]));
    const vd = prf(s.hash, master, 'client finished', digest(s.hash, transcript), 12);
    const fin = Buffer.concat([Buffer.from([20]), u24(12), vd]);
    transcript = Buffer.concat([transcript, fin]);
    this._send(22, this._encrypt12(22, fin));
    // Server: optional NewSessionTicket, ChangeCipherSpec, then its encrypted Finished.
    let ccs = false;
    for (;;) {
      const rec = await this._record();
      if (!rec) throw new TlsError('connection closed during handshake');
      if (rec.type === 21) throw new TlsError(`server refused the handshake (alert ${rec.body[1]})`);
      if (rec.type === 20) {
        ccs = true;
        continue;
      }
      if (rec.type !== 22) throw new TlsError('unexpected record during handshake');
      if (!ccs) {
        transcript = Buffer.concat([transcript, rec.body]);
        continue;
      }
      const m = this._decrypt12(22, rec.body);
      const expected = prf(s.hash, master, 'server finished', digest(s.hash, transcript), 12);
      if (m[0] !== 20 || !crypto.timingSafeEqual(expected, m.subarray(4, 16))) throw new TlsError('server Finished does not match');
      break;
    }
  }

  _encrypt12(type, plaintext) {
    const s = this.s12;
    const seq = Buffer.alloc(8);
    seq.writeBigUInt64BE(BigInt(this.cseq));
    const aad = Buffer.concat([seq, Buffer.from([type, 3, 3]), u16(plaintext.length)]);
    if (s.ivLen === 12) return seal(s.aead, this.cKey, seqNonce(this.cIv, this.cseq++), aad, plaintext);
    this.cseq++;
    return Buffer.concat([seq, seal(s.aead, this.cKey, Buffer.concat([this.cIv, seq]), aad, plaintext)]);
  }

  _decrypt12(type, body) {
    const s = this.s12;
    const seq = Buffer.alloc(8);
    seq.writeBigUInt64BE(BigInt(this.sseq));
    if (s.ivLen === 12) {
      const aad = Buffer.concat([seq, Buffer.from([type, 3, 3]), u16(body.length - 16)]);
      return open(s.aead, this.sKey, seqNonce(this.sIv, this.sseq++), aad, body);
    }
    const ct = body.subarray(8);
    const aad = Buffer.concat([seq, Buffer.from([type, 3, 3]), u16(ct.length - 16)]);
    this.sseq++;
    return open(s.aead, this.sKey, Buffer.concat([this.sIv, body.subarray(0, 8)]), aad, ct);
  }

  // -- application data --

  write(data) {
    if (this.closed || this.ended) throw new TlsError('connection closed');
    for (let i = 0; i < data.length; i += 16384) {
      const chunk = data.subarray(i, i + 16384);
      let enc;
      if (this.tls12) enc = this._encrypt12(23, chunk);
      else {
        const inner = Buffer.concat([chunk, Buffer.from([23])]);
        const aad = Buffer.concat([Buffer.from([23, 3, 3]), u16(inner.length + 16)]);
        enc = seal(this.s13.aead, this.cKey, seqNonce(this.cIv, this.cseq++), aad, inner);
      }
      this.sock.write(Buffer.concat([Buffer.from([23, 3, 3]), u16(enc.length), enc]));
    }
  }

  /** Next chunk of application data, or null when the server closed the connection. */
  async read() {
    while (!this.app.length) {
      const rec = await this._record();
      if (!rec) return null;
      if (rec.type === 20) continue;
      if (rec.type === 21) {
        if (this.tls12 || rec.body[1] === 0) return null;
        throw new TlsError('server closed the connection');
      }
      if (this.tls12) {
        const pt = this._decrypt12(rec.type, rec.body);
        if (rec.type === 23) this.app.push(pt);
        else if (rec.type === 21) return null;
        continue;
      }
      const s = this.s13;
      const aad = Buffer.concat([Buffer.from([rec.type, 3, 3]), u16(rec.body.length)]);
      const pt = stripPadding(open(s.aead, this.sKey, seqNonce(this.sIv, this.sseq++), aad, rec.body));
      if (pt.type === 23) this.app.push(pt.data);
      else if (pt.type === 21) return null;
      else if (pt.type === 22) this._postHandshake(pt.data);
    }
    return this.app.shift();
  }

  _postHandshake(data) {
    // NewSessionTicket is ignored; KeyUpdate rolls the keys.
    for (let i = 0; i + 4 <= data.length; ) {
      const type = data[i];
      const len = data.readUIntBE(i + 1, 3);
      const body = data.subarray(i + 4, i + 4 + len);
      i += 4 + len;
      if (type !== 24) continue;
      const s = this.s13;
      this.sAp = hkdfExpandLabel(s.hash, this.sAp, 'traffic upd', Buffer.alloc(0), s.hashLen);
      this._keys13('s');
      if (body[0] === 1) {
        const inner = Buffer.from([24, 0, 0, 1, 0, 22]);
        const aad = Buffer.concat([Buffer.from([23, 3, 3]), u16(inner.length + 16)]);
        const ct = seal(s.aead, this.cKey, seqNonce(this.cIv, this.cseq++), aad, inner);
        this.sock.write(Buffer.concat([Buffer.from([23, 3, 3]), u16(ct.length), ct]));
        this.cAp = hkdfExpandLabel(s.hash, this.cAp, 'traffic upd', Buffer.alloc(0), s.hashLen);
        this._keys13('c');
      }
    }
  }

  get usable() {
    return this.hsDone && !this.closed && !this.ended && !this.error;
  }

  close() {
    this.closed = true;
    this.sock?.destroy();
  }
}

/** Splits a stream of handshake record bodies into whole handshake messages. */
class HandshakeReader {
  constructor(more) {
    this.more = more;
    this.buf = Buffer.alloc(0);
  }

  async next() {
    for (;;) {
      if (this.buf.length >= 4) {
        const len = this.buf.readUIntBE(1, 3);
        if (this.buf.length >= 4 + len) {
          const msg = this.buf.subarray(0, 4 + len);
          this.buf = this.buf.subarray(4 + len);
          return msg;
        }
      }
      this.buf = Buffer.concat([this.buf, await this.more()]);
    }
  }
}

function stripPadding(pt) {
  let end = pt.length;
  while (end > 0 && pt[end - 1] === 0) end--;
  if (!end) return { type: 0, data: Buffer.alloc(0) };
  return { type: pt[end - 1], data: pt.subarray(0, end - 1) };
}

function parseServerHello(m) {
  let i = 4;
  i += 2; // legacy version
  const random = m.subarray(i, i + 32);
  i += 32;
  i += 1 + m[i];
  const cipher = m.readUInt16BE(i);
  i += 3;
  const out = { random, cipher, version: 0x0303, keyShare: null, ems: false };
  if (i + 2 > m.length) return out;
  const end = i + 2 + m.readUInt16BE(i);
  i += 2;
  while (i + 4 <= end) {
    const type = m.readUInt16BE(i);
    const len = m.readUInt16BE(i + 2);
    const data = m.subarray(i + 4, i + 4 + len);
    i += 4 + len;
    if (type === 43 && len === 2) out.version = data.readUInt16BE(0);
    else if (type === 51 && len >= 4) out.keyShare = data.subarray(4, 4 + data.readUInt16BE(2));
    else if (type === 23) out.ems = true;
  }
  return out;
}

function parseCertificates13(body) {
  let i = 1 + body[0];
  const end = i + 3 + body.readUIntBE(i, 3);
  i += 3;
  const out = [];
  while (i + 3 <= end) {
    const len = body.readUIntBE(i, 3);
    out.push(body.subarray(i + 3, i + 3 + len));
    i += 3 + len;
    i += 2 + body.readUInt16BE(i);
  }
  return out;
}

function parseCertificates12(body) {
  const end = 3 + body.readUIntBE(0, 3);
  const out = [];
  for (let i = 3; i + 3 <= end; ) {
    const len = body.readUIntBE(i, 3);
    out.push(body.subarray(i + 3, i + 3 + len));
    i += 3 + len;
  }
  return out;
}

// ---- HTTP/1.1 over a TlsConnection --------------------------------------

/** Reads one HTTP response from `conn`. */
async function readResponse(conn) {
  let buf = Buffer.alloc(0);
  const fill = async () => {
    const d = await conn.read();
    if (!d) throw new TlsError('connection closed mid-response');
    buf = Buffer.concat([buf, d]);
  };
  const line = async () => {
    let at;
    while ((at = buf.indexOf('\r\n')) < 0) await fill();
    const l = buf.subarray(0, at).toString('latin1');
    buf = buf.subarray(at + 2);
    return l;
  };
  const take = async (n) => {
    while (buf.length < n) await fill();
    const r = buf.subarray(0, n);
    buf = buf.subarray(n);
    return r;
  };
  const statusLine = await line();
  const status = Number(statusLine.split(' ')[1]);
  if (!Number.isInteger(status)) throw new TlsError('bad HTTP response');
  const headers = {};
  for (let l = await line(); l !== ''; l = await line()) {
    const at = l.indexOf(':');
    if (at > 0) headers[l.slice(0, at).trim().toLowerCase()] = l.slice(at + 1).trim();
  }
  let body;
  let reusable = (headers.connection ?? '').toLowerCase() !== 'close';
  if ((headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
    const parts = [];
    for (;;) {
      const size = parseInt((await line()).split(';')[0], 16);
      if (!Number.isFinite(size)) throw new TlsError('bad chunked response');
      if (size === 0) {
        while ((await line()) !== '');
        break;
      }
      parts.push(await take(size));
      await take(2);
    }
    body = Buffer.concat(parts);
  } else if (headers['content-length'] !== undefined) {
    body = await take(Number(headers['content-length']));
  } else {
    const parts = [buf];
    for (let d = await conn.read(); d; d = await conn.read()) parts.push(d);
    body = Buffer.concat(parts);
    reusable = false;
  }
  const enc = (headers['content-encoding'] ?? '').toLowerCase();
  if (enc.includes('gzip')) body = zlib.gunzipSync(body);
  else if (enc.includes('deflate')) body = zlib.inflateSync(body);
  return { status, headers, body, reusable };
}

/**
 * Keeps one connection per host:port and sends requests over it, retrying once
 * on a fresh connection when a reused one turns out to be dead.
 */
export function createHttpClient({ connect = (opts) => new TlsConnection(opts).connect(), ca = null } = {}) {
  const conns = new Map();
  let chain = Promise.resolve();

  const drop = (key) => {
    conns.get(key)?.close();
    conns.delete(key);
  };

  async function once(method, url, headers, body, timeout) {
    const u = new URL(url);
    const port = Number(u.port) || 443;
    const key = `${u.hostname}:${port}`;
    const hostHeader = port === 443 ? u.hostname : key;
    const data = body === null || body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const lines = [`${method} ${u.pathname || '/'}${u.search} HTTP/1.1`];
    let hostDone = false;
    let lenDone = false;
    for (const [k, v] of headers) {
      if (v === null || v === undefined) continue;
      const lk = k.toLowerCase();
      if (lk === 'host') hostDone = true;
      else if (lk === 'content-length') lenDone = true;
      lines.push(`${k}: ${v}`);
      // Header order as the Home Assistant integration sends it.
      if (lk === 'accept-encoding' && data && !lenDone) {
        lines.push(`content-length: ${data.length}`);
        lenDone = true;
      } else if (lk === 'authorization' && !hostDone) {
        lines.push(`host: ${hostHeader}`);
        hostDone = true;
      }
    }
    if (data && !lenDone) lines.push(`content-length: ${data.length}`);
    if (!hostDone) lines.splice(1, 0, `host: ${hostHeader}`);
    const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8');

    for (let attempt = 0; attempt < 2; attempt++) {
      let conn = conns.get(key);
      const fresh = !conn || !conn.usable;
      if (fresh) {
        drop(key);
        conn = await connect({ host: u.hostname, port, servername: u.hostname, timeout, ca });
        conns.set(key, conn);
      }
      conn.timeout = timeout;
      try {
        conn.write(data ? Buffer.concat([head, data]) : head);
        const res = await readResponse(conn);
        if (!res.reusable) drop(key);
        return { status: res.status, headers: res.headers, body: res.body };
      } catch (err) {
        drop(key);
        if (fresh || /timed out/.test(err.message)) throw err;
      }
    }
    throw new TlsError('request failed');
  }

  return {
    /** headers: an array of [name, value] pairs, sent in order. Requests are serialized. */
    request(method, url, headers, body, timeout = 10_000) {
      const run = chain.then(() => once(method, url, headers, body, timeout));
      chain = run.catch(() => {});
      return run;
    },
    close() {
      for (const key of [...conns.keys()]) drop(key);
    },
  };
}
