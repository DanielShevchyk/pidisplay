// Dreame cloud client: signs in with a Dreamehome account the way the phone
// app does and talks to the robot through Dreame's servers.
//
// Unofficial. The endpoints, headers and request signing come from the
// community Home Assistant integration github.com/Tasshack/dreame-vacuum (MIT,
// protocol.py, class DreameVacuumDreameHomeCloudProtocol, v2.0.2). If Dreame
// changes its cloud, compare against a newer release of that file.

import crypto from 'node:crypto';
import { createHttpClient } from './dreame-tls.js';

const API_HOST = '.iot.dreame.tech';
const API_PORT = 13267;
const PASSWORD_SALT = 'RAylYC%fmSKp7%Tq';
const CLIENT_ID = 'EETjszu*XI5znHsI'; // signing and header key of the Dreamehome app
const APP_VERSION = '102060300';
const USER_AGENT = 'Dart/3.9 (dart:io)';
const BASIC_AUTH = 'ZHJlYW1lX2FwcHYxOkFQXmR2QHpAU1FZVnhOODg=';
const DEFAULT_TENANT = '000000';
const FILE_USER_AGENT = 'okhttp/4.12.0';
/** Dreamehome app regions (the server the account lives on). */
export const REGIONS = { us: 'United States', eu: 'Europe', cn: 'China', ru: 'Russia', sg: 'Singapore' };

export class DreameCloudError extends Error {
  constructor(message, { auth = false, status = null } = {}) {
    super(message);
    this.auth = auth; // true: the account or password is wrong; don't retry by itself
    this.status = status;
  }
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

/** Python's urllib.parse.quote(s, safe=''). */
const quote = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Python json.dumps(v, ensure_ascii=False) for the scalar and object values the signer sees. */
const pyJson = (v) => JSON.stringify(v);

/** The string Dreame signs: sorted key=value pairs, nested objects in brackets (see `_spliced`). */
export function spliced(obj, top = true) {
  const parts = [];
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const inner = spliced(v, false);
      parts.push(inner ? `${k}=[${inner}]` : `${k}=]`);
    } else if (Array.isArray(v)) {
      if (top) parts.push(`${k}=${sortedJson(v)}`);
    } else if (typeof v === 'boolean') parts.push(`${k}=${v ? 'true' : 'false'}`);
    else if (v === null || v === undefined) parts.push(`${k}=null`);
    else if (top) parts.push(`${k}=${v}`);
    else parts.push(`${k}=${pyJson(v)}`);
  }
  return parts.join('&');
}

/** json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False). */
function sortedJson(v) {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function sign(params, ms = Date.now()) {
  return { ...params, sign: md5(`${spliced(params)}${ms}${CLIENT_ID}`), timestamp: ms };
}

/**
 * @param {object} o
 * @param {string} o.username Dreamehome account email (or phone)
 * @param {string} o.password
 * @param {string} o.region us | eu | cn | ru | sg
 */
export function createDreameCloud({ username, password, region = 'us', http = createHttpClient(), now = () => Date.now() } = {}) {
  if (!REGIONS[region]) throw new DreameCloudError(`Unknown Dreame region "${region}"`);
  const base = `https://${region}${API_HOST}:${API_PORT}`;
  const visitorHash = md5(crypto.randomBytes(16));
  const session = { token: null, refresh: null, expires: 0, tenant: null, region: null, lang: null, country: null, uid: null };
  let requestId = Math.floor(Math.random() * 100) + 1;
  let loginPromise = null;
  let authFailed = null;

  function baseHeaders(contentType) {
    const meta = `cv=a_${APP_VERSION};canvasHash=${md5(`${username}c`).slice(0, 8)};webglHash=${md5(`${username}w`).slice(0, 8)};visitorIdHash=${visitorHash}`;
    const h = [
      ['user-agent', USER_AGENT],
      ['dreame-meta', meta],
      ['accept-encoding', 'gzip'],
    ];
    if (session.region && session.lang && session.country) {
      const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(CLIENT_ID), null);
      const rlc = Buffer.concat([c.update(`${session.region}|${session.lang}|${session.country}`), c.final()]).toString('base64');
      h.push(['dreame-rlc', rlc]);
    }
    h.push(['tenant-id', session.tenant ?? DEFAULT_TENANT]);
    h.push(['authorization', `Basic ${BASIC_AUTH}`]);
    h.push(['content-type', contentType]);
    return h;
  }

  async function doLogin() {
    let body;
    const usedRefresh = Boolean(session.refresh);
    if (session.refresh) {
      body = `grant_type=refresh_token&scope=all&platform=ANDROID&type=account&refresh_token=${session.refresh}`;
    } else {
      body = `grant_type=password&scope=all&platform=ANDROID&type=account&username=${quote(username)}&password=${md5(password + PASSWORD_SALT)}`;
      if (session.country && session.lang) body += `&country=${session.country}&lang=${session.lang}`;
    }
    let res;
    try {
      res = await http.request('POST', `${base}/dreame-auth/oauth/token`, baseHeaders('application/x-www-form-urlencoded'), body, 10_000);
    } catch (err) {
      throw new DreameCloudError(`Can't reach Dreame's servers: ${err.message}`);
    }
    const text = res.body.toString('utf8');
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // handled below
    }
    if (res.status === 200 && data?.access_token) {
      session.token = data.access_token;
      session.refresh = data.refresh_token ?? null;
      session.expires = now() + (Number(data.expires_in) || 3600) * 1000;
      session.uid = data.uid ?? session.uid;
      session.region = data.region ?? session.region;
      session.lang = data.lang ?? session.lang;
      session.country = data.country ?? session.country;
      session.tenant = data.tenant_id ?? session.tenant;
      authFailed = null;
      return;
    }
    if ([400, 401, 403].includes(res.status)) {
      if (usedRefresh) {
        // Expired refresh token: fall back to the password once.
        session.refresh = null;
        return doLogin();
      }
      const reason = data?.error_description || data?.msg || text.slice(0, 200);
      authFailed = new DreameCloudError(`Dreame refused the sign-in: ${reason}`, { auth: true, status: res.status });
      throw authFailed;
    }
    throw new DreameCloudError(`Dreame sign-in failed (HTTP ${res.status})`, { status: res.status });
  }

  function login() {
    loginPromise ??= doLogin().finally(() => {
      loginPromise = null;
    });
    return loginPromise;
  }

  async function ensureLogin() {
    if (authFailed) throw authFailed;
    if (!session.token || now() > session.expires - 10 * 60_000) await login();
  }

  /** POST a signed JSON request to an API path; returns the parsed reply. */
  async function api(path, params, { timeout = 10_000, retried = false } = {}) {
    await ensureLogin();
    const headers = [...baseHeaders('application/json'), ['dreame-auth', session.token]];
    const body = params ? JSON.stringify(sign(params, now())) : null;
    let res;
    try {
      res = await http.request('POST', `${base}/${path}`, headers, body, timeout);
    } catch (err) {
      throw new DreameCloudError(`Can't reach Dreame's servers: ${err.message}`);
    }
    const text = res.body.toString('utf8');
    if (res.status === 401 && !retried) {
      let code = null;
      try {
        code = JSON.parse(text).code;
      } catch {
        // not JSON
      }
      if (code !== null && code !== undefined && code !== 401) {
        throw new DreameCloudError('Dreame ended the session; sign in again', { auth: true, status: 401 });
      }
      session.token = null;
      return api(path, params, { timeout, retried: true });
    }
    if (res.status !== 200) throw new DreameCloudError(`Dreame answered HTTP ${res.status}: ${text.slice(0, 160)}`, { status: res.status });
    try {
      return JSON.parse(text);
    } catch {
      throw new DreameCloudError('Dreame sent a reply that is not JSON');
    }
  }

  const ok = (r, what) => {
    if (!r || r.code !== 0 || r.data === undefined) throw new DreameCloudError(`${what} failed: ${r?.msg ?? JSON.stringify(r).slice(0, 160)}`);
    return r.data;
  };

  return {
    region,
    get uid() {
      return session.uid;
    },
    get signedIn() {
      return Boolean(session.token);
    },
    get authError() {
      return authFailed;
    },
    login,

    /** Every device on the account (vacuums and anything else Dreame makes). */
    async devices() {
      const data = ok(await api('dreame-user-iot/iotuserbind/device/listV2', null), 'Listing devices');
      return data?.page?.records ?? [];
    },

    /**
     * Runs a MIoT method on a device (get_properties, set_properties, action)
     * through Dreame's command relay; `device` is a record from devices().
     */
    async send(device, method, params, { timeout, retried = false } = {}) {
      const host = device.bindDomain ? `-${String(device.bindDomain).split('.')[0]}` : '';
      requestId += 1;
      const did = String(device.did);
      const r = await api(`dreame-iot-com${host}/device/sendCommand`, { did, id: requestId, data: { did, id: requestId, method, params } }, { timeout });
      if (r?.data?.result === undefined) {
        // Accepted but no answer from the robot yet: the integration retries once.
        if (r?.success === true && !retried) return this.send(device, method, params, { timeout, retried: true });
        throw new DreameCloudError(r?.code === 0 || r?.success ? 'The robot did not answer (is it online?)' : `Command failed: ${r?.msg ?? 'no result'}`);
      }
      return r.data.result;
    },

    /** Values of [siid, piid] pairs, as { "siid.piid": value }. Missing ones are left out. */
    async getProperties(device, pairs) {
      const out = {};
      for (let i = 0; i < pairs.length; i += 15) {
        const batch = pairs.slice(i, i + 15).map(([siid, piid]) => ({ did: `${siid}.${piid}`, siid, piid }));
        const result = await this.send(device, 'get_properties', batch);
        for (const p of Array.isArray(result) ? result : []) {
          if (p && p.code === 0 && p.value !== undefined) out[`${p.siid}.${p.piid}`] = p.value;
        }
      }
      return out;
    },

    async setProperty(device, siid, piid, value) {
      const result = await this.send(device, 'set_properties', [{ did: String(device.did), siid, piid, value }]);
      const r = Array.isArray(result) ? result[0] : result;
      if (r && r.code !== undefined && r.code !== 0) throw new DreameCloudError(`The robot refused that setting (code ${r.code})`);
      return r;
    },

    async action(device, siid, aiid, input = []) {
      const r = await this.send(device, 'action', { did: String(device.did), siid, aiid, in: input });
      if (r && r.code !== undefined && r.code !== 0) throw new DreameCloudError(`The robot refused that command (code ${r.code})`);
      return r;
    },

    /** A short-lived download link for a file the robot uploaded (maps). */
    async fileUrl(device, objectName) {
      const r = await api('dreame-user-iot/iotfile/getDownloadUrl', {
        did: String(device.did),
        model: device.model,
        filename: objectName,
        region,
      });
      return ok(r, 'Getting a map link');
    },

    async download(url) {
      let res;
      try {
        res = await http.request('GET', url, [['Connection', 'Keep-Alive'], ['Accept-Encoding', 'gzip'], ['User-Agent', FILE_USER_AGENT]], null, 15_000);
      } catch (err) {
        throw new DreameCloudError(`Map download failed: ${err.message}`);
      }
      if (res.status !== 200) throw new DreameCloudError(`Map download failed (HTTP ${res.status})`);
      return res.body;
    },

    close() {
      http.close();
    },
  };
}
