import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDreameCloud, sign, spliced } from './dreame-cloud.js';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

/** A fake HTTP client: `routes(method, url, headers, body)` returns { status, body }. */
function fakeHttp(routes) {
  const calls = [];
  return {
    calls,
    async request(method, url, headers, body) {
      calls.push({ method, url, headers: Object.fromEntries(headers), body });
      const r = await routes(method, url, Object.fromEntries(headers), body, calls.length);
      return { status: r.status ?? 200, headers: {}, body: Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
    },
    close() {},
  };
}

const token = (n = 1) => ({ access_token: `tok${n}`, refresh_token: `ref${n}`, expires_in: 3600, uid: 'U1', region: 'us', lang: 'en', country: 'US', tenant_id: '000002' });
const device = { did: '123456', model: 'dreame.vacuum.r2492', bindDomain: '10000.mt.us.iot.dreame.tech:19974' };

test('signing matches the integration (checked against its Python output)', () => {
  const p = { did: '123456', id: 7, data: { did: '123456', id: 7, method: 'action', params: { did: '123456', siid: 4, aiid: 1, in: [{ piid: 1, value: 18 }] } } };
  assert.equal(spliced(p), 'data=[did="123456"&id=7&method="action"&params=[aiid=1&did="123456"&siid=4]]&did=123456&id=7');
  assert.equal(sign(p, 1700000000000).sign, '30f6b2af75192ec03599d973245f8758');
  assert.equal(sign({ did: '1', keys: [{ b: 2, a: 'x' }], ok: true, none: null, region: 'us' }, 1700000000000).sign, '4a54f0e707a6342c3cbdf6f9730c0457');
});

test('signs in with the hashed password, then sends commands through the device relay', async () => {
  const http = fakeHttp((method, url, headers, body) => {
    if (url.endsWith('/dreame-auth/oauth/token')) return { body: token() };
    if (url.includes('/device/sendCommand')) return { body: { code: 0, success: true, data: { result: [{ siid: 3, piid: 1, code: 0, value: 87 }] } } };
    return { status: 404, body: {} };
  });
  const cloud = createDreameCloud({ username: 'dan+test@example.com', password: 'pw!', region: 'us', http });
  const props = await cloud.getProperties(device, [[3, 1]]);
  assert.deepEqual(props, { '3.1': 87 });

  const [login, cmd] = http.calls;
  assert.equal(login.url, 'https://us.iot.dreame.tech:13267/dreame-auth/oauth/token');
  assert.equal(login.body, `grant_type=password&scope=all&platform=ANDROID&type=account&username=dan%2Btest%40example.com&password=${md5('pw!RAylYC%fmSKp7%Tq')}`);
  assert.equal(login.headers.authorization, 'Basic ZHJlYW1lX2FwcHYxOkFQXmR2QHpAU1FZVnhOODg=');
  assert.equal(login.headers['tenant-id'], '000000');
  assert.equal(login.headers['dreame-auth'], undefined);

  // The command goes to the robot's own relay host and carries the session.
  assert.equal(cmd.url, 'https://us.iot.dreame.tech:13267/dreame-iot-com-10000/device/sendCommand');
  assert.equal(cmd.headers['dreame-auth'], 'tok1');
  assert.equal(cmd.headers['tenant-id'], '000002');
  assert.ok(cmd.headers['dreame-rlc']);
  const body = JSON.parse(cmd.body);
  assert.equal(body.data.method, 'get_properties');
  assert.deepEqual(body.data.params, [{ did: '3.1', siid: 3, piid: 1 }]);
  assert.equal(body.sign, sign({ did: body.did, id: body.id, data: body.data }, body.timestamp).sign);
});

test('a wrong password is reported once and not retried', async () => {
  const http = fakeHttp(() => ({ status: 401, body: { error: 'invalid_grant', error_description: 'Bad credentials' } }));
  const cloud = createDreameCloud({ username: 'a@b.c', password: 'nope', http });
  await assert.rejects(cloud.devices(), (err) => err.auth && /Bad credentials/.test(err.message));
  await assert.rejects(cloud.devices(), (err) => err.auth);
  assert.equal(http.calls.length, 1);
});

test('an expired session signs in again with the refresh token', async () => {
  let n = 0;
  const http = fakeHttp((method, url, headers, body) => {
    if (url.endsWith('/oauth/token')) return { body: token(++n) };
    if (headers['dreame-auth'] === 'tok1') return { status: 401, body: { code: 401, msg: 'expired' } };
    return { body: { code: 0, data: { page: { records: [device] } } } };
  });
  const cloud = createDreameCloud({ username: 'a@b.c', password: 'pw', http });
  const list = await cloud.devices();
  assert.equal(list[0].did, '123456');
  const logins = http.calls.filter((c) => c.url.endsWith('/oauth/token'));
  assert.equal(logins.length, 2);
  assert.match(logins[1].body, /grant_type=refresh_token&.*refresh_token=ref1/);
});

test('a session ended by Dreame (non-401 code) asks for a new sign-in', async () => {
  const http = fakeHttp((method, url) => (url.endsWith('/oauth/token') ? { body: token() } : { status: 401, body: { code: 10001, msg: 'logged in elsewhere' } }));
  const cloud = createDreameCloud({ username: 'a@b.c', password: 'pw', http });
  await assert.rejects(cloud.devices(), (err) => err.auth);
});

test('an offline robot gives a clear error', async () => {
  const http = fakeHttp((method, url) => (url.endsWith('/oauth/token') ? { body: token() } : { body: { code: 0, success: true, data: {} } }));
  const cloud = createDreameCloud({ username: 'a@b.c', password: 'pw', http });
  await assert.rejects(cloud.action(device, 2, 1), /did not answer/);
});
