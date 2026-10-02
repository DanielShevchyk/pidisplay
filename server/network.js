// Wi-Fi (NetworkManager via nmcli) and Bluetooth (BlueZ via bluetoothctl) for
// the gear menu. The server runs as dan outside a desktop session, so
// deploy/pidisplay-network.rules grants dan the NetworkManager actions used here
// and deploy/pidisplay-sudoers allows only `rfkill unblock bluetooth`.
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';

export class NetworkError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]|\x01|\x02/g;

function defaultRun(cmd, args, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
      const out = String(stdout).replace(ANSI, '');
      if (err) {
        const message = (String(stderr) || out || err.message).replace(ANSI, '').trim();
        return reject(Object.assign(new Error(message), { stdout: out }));
      }
      resolve(out);
    });
  });
}

/** Splits one line of `nmcli -t` output, which escapes ':' and '\' with a backslash. */
export function splitTerse(line) {
  const fields = [''];
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) fields[fields.length - 1] += line[++i];
    else if (c === ':') fields.push('');
    else fields[fields.length - 1] += c;
  }
  return fields;
}

const lines = (text) => text.split('\n').filter((l) => l.trim());

/** Turns nmcli's error text into something a person can act on. */
function wifiError(err) {
  const msg = String(err.message || err);
  if (/secrets were required|psk|802-1x|no secrets|password/i.test(msg)) {
    return new NetworkError(400, 'Wrong password, or this network needs one.');
  }
  if (/no network with ssid/i.test(msg)) return new NetworkError(404, "That network isn't in range anymore.");
  if (/not authorized|insufficient privileges/i.test(msg)) {
    return new NetworkError(403, 'PiDisplay is missing permission to change Wi-Fi. Redeploy to install it.');
  }
  return new NetworkError(502, msg.replace(/^Error:\s*/, '') || 'Wi-Fi command failed');
}

export function createNetwork({ run = defaultRun, platform = process.platform, rfkillDir = '/sys/class/rfkill' } = {}) {
  const supported = platform === 'linux';
  const nm = (args, opts) => run('nmcli', args, opts);
  const bt = (args, opts) => run('bluetoothctl', args, opts);

  async function wifiDevice() {
    const out = await nm(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device']);
    const dev = lines(out)
      .map(splitTerse)
      .find(([, type]) => type === 'wifi');
    return dev ? { name: dev[0], state: dev[2], connection: dev[3] || null } : null;
  }

  async function savedWifi() {
    const out = await nm(['-t', '-f', 'NAME,UUID,TYPE', 'connection', 'show']);
    const list = lines(out)
      .map(splitTerse)
      .filter(([, , type]) => type === '802-11-wireless');
    return Promise.all(
      list.map(async ([name, uuid]) => {
        const ssid = (await nm(['-t', '-g', '802-11-wireless.ssid', 'connection', 'show', 'uuid', uuid]).catch(() => '')).trim();
        return { name, uuid, ssid: ssid || name };
      }),
    );
  }

  async function activeWifi(device) {
    if (!device?.connection || !device.state.startsWith('connected')) return null;
    const out = await nm(['-t', '-f', 'NAME,UUID,DEVICE', 'connection', 'show', '--active']);
    const row = lines(out)
      .map(splitTerse)
      .find(([, , dev]) => dev === device.name);
    return row ? { name: row[0], uuid: row[1] } : null;
  }

  const wifi = {
    async status({ rescan = false } = {}) {
      if (!supported) return { available: false };
      const device = await wifiDevice().catch(() => null);
      if (!device) return { available: false };
      const enabled = (await nm(['radio', 'wifi'])).trim() === 'enabled';
      const saved = await savedWifi();
      const active = await activeWifi(device);
      let networks = [];
      if (enabled) {
        const out = await nm(
          ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', 'ifname', device.name, '--rescan', rescan ? 'yes' : 'auto'],
          { timeout: 30000 },
        ).catch((err) => {
          throw wifiError(err);
        });
        const bySsid = new Map();
        for (const [inUse, ssid, signal, security] of lines(out).map(splitTerse)) {
          if (!ssid) continue; // hidden networks
          const n = { ssid, signal: Number(signal) || 0, secure: Boolean(security && security !== '--'), enterprise: /802\.1X/i.test(security), security, inUse: inUse === '*' };
          const prev = bySsid.get(ssid);
          if (!prev || n.inUse || (!prev.inUse && n.signal > prev.signal)) bySsid.set(ssid, n);
        }
        const savedSsids = new Set(saved.map((s) => s.ssid));
        networks = [...bySsid.values()]
          .map((n) => ({ ...n, saved: savedSsids.has(n.ssid) }))
          .sort((a, b) => Number(b.inUse) - Number(a.inUse) || Number(b.saved) - Number(a.saved) || b.signal - a.signal);
      }
      let current = null;
      if (active) {
        const ip = (await nm(['-t', '-g', 'IP4.ADDRESS', 'device', 'show', device.name]).catch(() => '')).split('|')[0].trim();
        const ssid = saved.find((s) => s.uuid === active.uuid)?.ssid ?? active.name;
        current = { ssid, uuid: active.uuid, ip: ip.replace(/\/\d+$/, '') || null, signal: networks.find((n) => n.inUse)?.signal ?? null };
      }
      return { available: true, enabled, device: device.name, current, networks, saved };
    },

    async connect(ssid, password) {
      if (!supported) throw new NetworkError(501, 'Wi-Fi settings only work on the Pi');
      if (typeof ssid !== 'string' || !ssid || ssid.length > 32) throw new NetworkError(400, 'Pick a network');
      if (password !== undefined && (typeof password !== 'string' || password.length > 63)) {
        throw new NetworkError(400, 'Wi-Fi passwords are 8 to 63 characters');
      }
      const device = await wifiDevice();
      if (!device) throw new NetworkError(404, 'No Wi-Fi adapter found');
      const before = await activeWifi(device);
      const savedBefore = await savedWifi();
      const existing = savedBefore.find((s) => s.ssid === ssid);
      try {
        if (existing) {
          if (password) await nm(['connection', 'modify', 'uuid', existing.uuid, 'wifi-sec.psk', password]);
          await nm(['--wait', '45', 'connection', 'up', 'uuid', existing.uuid, 'ifname', device.name], { timeout: 50000 });
        } else {
          const args = ['--wait', '45', 'device', 'wifi', 'connect', ssid, 'ifname', device.name];
          if (password) args.push('password', password);
          await nm(args, { timeout: 50000 });
        }
      } catch (err) {
        // Don't leave a broken profile behind, and get back on the old network.
        if (!existing) {
          const known = new Set(savedBefore.map((s) => s.uuid));
          for (const s of await savedWifi().catch(() => [])) {
            if (s.ssid === ssid && !known.has(s.uuid)) await nm(['connection', 'delete', 'uuid', s.uuid]).catch(() => {});
          }
        }
        if (before && before.uuid !== existing?.uuid) {
          const now = await activeWifi(await wifiDevice().catch(() => null)).catch(() => null);
          if (now?.uuid !== before.uuid) {
            await nm(['--wait', '45', 'connection', 'up', 'uuid', before.uuid], { timeout: 50000 }).catch(() => {});
          }
        }
        throw wifiError(err);
      }
    },

    async disconnect() {
      if (!supported) throw new NetworkError(501, 'Wi-Fi settings only work on the Pi');
      const active = await activeWifi(await wifiDevice());
      if (!active) return;
      await nm(['connection', 'down', 'uuid', active.uuid]).catch((err) => {
        throw wifiError(err);
      });
    },

    async forget(uuid) {
      if (!supported) throw new NetworkError(501, 'Wi-Fi settings only work on the Pi');
      const saved = await savedWifi();
      if (!saved.some((s) => s.uuid === uuid)) throw new NetworkError(404, 'That network is not saved');
      await nm(['connection', 'delete', 'uuid', uuid]).catch((err) => {
        throw wifiError(err);
      });
    },

    async setEnabled(on) {
      if (!supported) throw new NetworkError(501, 'Wi-Fi settings only work on the Pi');
      await nm(['radio', 'wifi', on ? 'on' : 'off']).catch((err) => {
        throw wifiError(err);
      });
    },
  };

  async function bluetoothBlocked() {
    try {
      for (const entry of await fs.readdir(rfkillDir)) {
        const type = (await fs.readFile(`${rfkillDir}/${entry}/type`, 'utf8')).trim();
        if (type !== 'bluetooth') continue;
        return (await fs.readFile(`${rfkillDir}/${entry}/soft`, 'utf8')).trim() === '1';
      }
    } catch {}
    return false;
  }

  function parseInfo(mac, text) {
    const get = (key) => text.match(new RegExp(`^\\s*${key}: (.*)$`, 'm'))?.[1]?.trim();
    return {
      mac,
      name: get('Name') ?? null,
      icon: get('Icon') ?? null,
      paired: get('Paired') === 'yes',
      connected: get('Connected') === 'yes',
      trusted: get('Trusted') === 'yes',
    };
  }

  async function deviceInfo(mac) {
    return parseInfo(mac, await bt(['info', mac]).catch(() => ''));
  }

  const checkMac = (mac) => {
    if (typeof mac !== 'string' || !MAC.test(mac)) throw new NetworkError(400, 'Invalid device address');
    return mac.toUpperCase();
  };

  function btError(err, fallback) {
    const msg = String(err?.message || err || '');
    if (/not available|no default controller/i.test(msg)) return new NetworkError(404, 'No Bluetooth adapter found');
    if (/authentication|auth/i.test(msg)) return new NetworkError(400, 'The device rejected pairing. Put it in pairing mode and try again.');
    return new NetworkError(502, fallback);
  }

  const bluetooth = {
    async status() {
      if (!supported) return { available: false };
      const show = await bt(['show']).catch(() => '');
      if (!/Controller /.test(show)) return { available: false };
      const powered = /Powered: yes/.test(show);
      const devices = [];
      if (powered) {
        const out = await bt(['devices']).catch(() => '');
        const macs = [...out.matchAll(/^Device ([0-9A-F:]{17})/gim)].map((m) => m[1].toUpperCase()).slice(0, 60);
        for (const info of await Promise.all(macs.map(deviceInfo))) {
          // Skip nameless beacons unless already paired.
          if (info.name || info.paired) devices.push(info);
        }
        devices.sort((a, b) => Number(b.paired) - Number(a.paired) || Number(b.connected) - Number(a.connected) || String(a.name).localeCompare(String(b.name)));
      }
      return { available: true, powered, devices };
    },

    async setPowered(on) {
      if (!supported) throw new NetworkError(501, 'Bluetooth settings only work on the Pi');
      if (on && (await bluetoothBlocked())) {
        await run('sudo', ['-n', '/usr/sbin/rfkill', 'unblock', 'bluetooth']).catch(() => {
          throw new NetworkError(403, 'Bluetooth is blocked and PiDisplay may not unblock it. Redeploy to install the permission.');
        });
        await new Promise((r) => setTimeout(r, 1000));
      }
      const out = await bt(['power', on ? 'on' : 'off']).catch((err) => err.stdout || err.message);
      if (!/succeeded/i.test(out)) throw btError(out, `Couldn't turn Bluetooth ${on ? 'on' : 'off'}`);
    },

    async scan(seconds = 8) {
      if (!supported) throw new NetworkError(501, 'Bluetooth settings only work on the Pi');
      // Discovery only lasts while bluetoothctl runs, so keep it running for the timeout.
      await bt(['--timeout', String(seconds), 'scan', 'on'], { timeout: (seconds + 5) * 1000 }).catch(() => {});
      return bluetooth.status();
    },

    async pair(mac) {
      mac = checkMac(mac);
      const out = await bt(['--agent', 'NoInputNoOutput', '--timeout', '30', 'pair', mac], { timeout: 40000 }).catch(
        (err) => err.stdout || err.message,
      );
      let info = await deviceInfo(mac);
      if (!info.paired) throw btError(out, "Couldn't pair. Make sure the device is in pairing mode.");
      await bt(['trust', mac]).catch(() => {});
      await bt(['--timeout', '20', 'connect', mac], { timeout: 25000 }).catch(() => {});
      info = await deviceInfo(mac);
      return info;
    },

    async connect(mac) {
      mac = checkMac(mac);
      const out = await bt(['--timeout', '20', 'connect', mac], { timeout: 25000 }).catch((err) => err.stdout || err.message);
      if (!(await deviceInfo(mac)).connected) throw btError(out, "Couldn't connect. Is the device on and nearby?");
    },

    async disconnect(mac) {
      mac = checkMac(mac);
      await bt(['disconnect', mac]).catch(() => {});
    },

    async remove(mac) {
      mac = checkMac(mac);
      const out = await bt(['remove', mac]).catch((err) => err.stdout || err.message);
      if (!/removed|not available/i.test(out)) throw btError(out, "Couldn't forget that device");
    },
  };

  return { wifi, bluetooth };
}
