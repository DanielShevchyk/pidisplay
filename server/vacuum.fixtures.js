// Test and demo data for the vacuum widget: a small made-up floor plan encoded
// the way a Dreame robot uploads its saved maps (see dreame-map.js).

import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const DEMO_IV = 'NRwnBj5FsNPgBNbT';

/** Rooms as [id, x0, y0, x1, y1] in map pixels (y up, as the robot stores it). */
const PLAN = [
  [1, 2, 2, 41, 21], // living room
  [2, 43, 2, 69, 21], // kitchen
  [3, 2, 23, 25, 41], // office
  [4, 27, 23, 52, 41], // bedroom
  [5, 54, 23, 69, 41], // bathroom
];

export const DEMO_ROOMS = {
  1: { type: 1, index: 0 },
  2: { type: 4, index: 0 },
  3: { type: 0, index: 0, name: Buffer.from("Dan's Office").toString('base64') },
  4: { type: 2, index: 0 },
  5: { type: 6, index: 0 },
};

/** Raw (decrypted, inflated) saved-map bytes. */
export function demoMapBytes({ mapId = 7, width = 72, height = 44, segInf = DEMO_ROOMS } = {}) {
  const header = Buffer.alloc(27);
  header.writeUInt16LE(mapId, 0);
  header.writeUInt16LE(0, 2);
  header[4] = 73; // 'I' frame
  header.writeUInt16LE(50, 17);
  header.writeUInt16LE(width, 19);
  header.writeUInt16LE(height, 21);
  const px = Buffer.alloc(width * height);
  for (const [id, x0, y0, x1, y1] of PLAN) {
    for (let y = y0 - 1; y <= y1 + 1; y++) {
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const edge = x < x0 || x > x1 || y < y0 || y > y1;
        const i = y * width + x;
        if (edge) {
          if (!px[i]) px[i] = 0x80; // wall
        } else px[i] = id;
      }
    }
  }
  // Doorways between rooms.
  for (const [x, y] of [[42, 10], [42, 11], [10, 22], [11, 22], [35, 22], [36, 22], [60, 22], [61, 22]]) px[y * width + x] = 1;
  const json = Buffer.from(JSON.stringify({ seg_inf: segInf, timestamp_ms: 1760400000000 }));
  return Buffer.concat([header, px, json]);
}

/** Encodes raw map bytes like the robot: zlib, AES-256-CBC, URL-safe base64, ",key". */
export function encodeMap(bytes, { key = 'k3yFromObjectName', iv = DEMO_IV } = {}) {
  const aesKey = Buffer.from(crypto.createHash('sha256').update(key).digest('hex').slice(0, 32), 'utf8');
  const c = crypto.createCipheriv('aes-256-cbc', aesKey, Buffer.from(iv, 'utf8'));
  const enc = Buffer.concat([c.update(zlib.deflateSync(bytes)), c.final()]);
  return `${enc.toString('base64').replace(/\//g, '_').replace(/\+/g, '-')},${key}`;
}

/** The saved-map list file the robot points to from property 6.8. */
export function demoMapList({ mapId = 7, angle = 0 } = {}) {
  return JSON.stringify({ curr_id: mapId, mapstr: [{ map: encodeMap(demoMapBytes({ mapId })), angle, name: 'Home', mapobj: 'x' }] });
}

/** Property values for a robot in a given situation. */
export function demoProps(kind = 'docked') {
  const base = {
    '2.2': 0, '3.1': 92, '3.2': 1, '4.4': 1, '4.5': 2, '4.23': (20 << 16) | (10 << 8) | 0, '4.25': 0, '27.1': 0, '27.2': 0,
    '27.3': 0, '9.2': 64, '10.2': 41, '11.1': 77, '16.1': 8, '18.1': 55,
    '6.8': JSON.stringify({ object_name: 'ali_dreame/123/map/list.json', md5: 'abc' }),
  };
  const kinds = {
    docked: { '2.1': 6, '4.1': 6, '4.7': 0, '4.2': 0, '4.3': 0, '4.63': 0 },
    cleaning: { '2.1': 12, '3.2': 2, '3.1': 64, '4.1': 18, '4.7': 3, '4.2': 23, '4.3': 31, '4.63': 46 },
    paused: { '2.1': 3, '3.2': 2, '3.1': 60, '4.1': 1, '4.7': 8, '4.2': 25, '4.3': 33, '4.63': 50 },
    error: { '2.1': 4, '2.2': 106, '3.2': 2, '3.1': 51, '4.1': 12, '4.7': 0, '27.2': 1 },
  };
  return { ...base, ...kinds[kind] };
}
