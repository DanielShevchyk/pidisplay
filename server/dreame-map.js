// Reads the rooms (and a simple room map) out of a Dreame saved-map file.
//
// Format, from the community Home Assistant integration (Tasshack/dreame-vacuum,
// map.py DreameVacuumMapDecoder): URL-safe base64, optionally ",<key>" on the
// end; with a key the bytes are AES-256-CBC encrypted with
// sha256(key).hex[0:32] as the key and a per-model IV; then zlib. Inside: a
// 27-byte header, width*height pixel bytes, then JSON with "seg_inf" (rooms).

import crypto from 'node:crypto';
import zlib from 'node:zlib';

const HEADER_SIZE = 27;
// Per-model IVs from the integration's device table; the right one is found by trying each.
const MODEL_IVS = [
  '3F0ji4ufBMaH1ThM', '4sCv3Q2BtbWVBIB2', '6PFiLPYMHLylp7RR', '8qnS9dqgT3CppGe1', 'FmnfaI2pbem0k75t',
  'NRwnBj5FsNPgBNbT', 'OFULk9To37qRdXY3', 'RNO4p35b2QKaovHC', 'dndRQ3z8ACjDdDMo', 'nf3Zi2Mq8jD5AAOm',
  'ojxGnogHfVuefVfx', 'qFKhvoAqRFTPfKN6', 'wRy05fYLQJMRH6Mj',
];
const ROOM_TYPES = {
  1: 'Living Room', 2: 'Primary Bedroom', 3: 'Study', 4: 'Kitchen', 5: 'Dining Hall', 6: 'Bathroom', 7: 'Balcony',
  8: 'Corridor', 9: 'Utility Room', 10: 'Closet', 11: 'Meeting Room', 12: 'Office', 13: 'Fitness Area',
  14: 'Recreation Area', 15: 'Secondary Bedroom',
};
/** Pixel value for walls in the compact map sent to the screen. */
export const WALL = 255;

export class MapError extends Error {}

function tryInflate(buf) {
  try {
    const out = zlib.inflateSync(buf);
    return out.length >= HEADER_SIZE ? out : null;
  } catch {
    return null;
  }
}

/** Decodes one map payload to its raw bytes. `ivHint` is tried first. */
export function decodeMapBytes(raw, ivHint = null) {
  let text = String(raw).trim().replace(/_/g, '/').replace(/-/g, '+');
  let key = null;
  if (text.includes(',')) [text, key] = text.split(',');
  const bytes = Buffer.from(text, 'base64');
  if (!key) {
    const out = tryInflate(bytes);
    if (!out) throw new MapError('map data is not readable');
    return { bytes: out, iv: null };
  }
  const aesKey = Buffer.from(crypto.createHash('sha256').update(key).digest('hex').slice(0, 32), 'utf8');
  for (const iv of [ivHint, ...MODEL_IVS].filter((v, i, a) => v && a.indexOf(v) === i)) {
    if (bytes.length % 16) break;
    const d = crypto.createDecipheriv('aes-256-cbc', aesKey, Buffer.from(iv, 'utf8'));
    d.setAutoPadding(false);
    const out = tryInflate(Buffer.concat([d.update(bytes), d.final()]));
    if (out) return { bytes: out, iv };
  }
  throw new MapError('map data could not be decrypted (unknown robot model key)');
}

function roomName(id, info) {
  if (info?.name) {
    try {
      const name = Buffer.from(info.name, 'base64').toString('utf8').trim();
      if (name) return name;
    } catch {
      // fall through
    }
  }
  const type = Number(info?.type);
  if (type && ROOM_TYPES[type]) {
    const index = Number(info?.index) || 0;
    return index > 0 ? `${ROOM_TYPES[type]} ${index + 1}` : ROOM_TYPES[type];
  }
  return `Room ${id}`;
}

/**
 * Parses a decoded map: its id, rooms from seg_inf, and a compact picture of
 * the rooms (cropped, one byte per pixel: 0 outside, room id, or WALL), rows
 * top to bottom as the app draws it.
 */
export function parseMap(bytes, rotation = 0) {
  const mapId = bytes.readUInt16LE(0);
  const width = bytes.readUInt16LE(19);
  const height = bytes.readUInt16LE(21);
  const imageEnd = HEADER_SIZE + width * height;
  if (bytes.length < imageEnd) throw new MapError('map data is truncated');
  let json = {};
  try {
    json = JSON.parse(bytes.subarray(imageEnd).toString('utf8') || '{}');
  } catch {
    json = {};
  }
  const segInf = json.seg_inf && typeof json.seg_inf === 'object' ? json.seg_inf : {};
  const rooms = Object.entries(segInf)
    .map(([k, v]) => ({ id: Number(k), name: roomName(Number(k), v) }))
    .filter((r) => Number.isInteger(r.id) && r.id > 0 && r.id < 64)
    .sort((a, b) => a.id - b.id);

  // Saved maps: low 6 bits are the room id, the top bit marks walls.
  const ids = new Set(rooms.map((r) => r.id));
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  const px = new Uint8Array(width * height);
  let roomPixels = 0;
  for (let y = 0; y < height; y++) {
    // Map rows run bottom to top.
    const row = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const p = bytes[HEADER_SIZE + width * y + x];
      if (!p) continue;
      const seg = p & 0x3f;
      let v = 0;
      if (p >> 7) v = WALL;
      else if (seg > 0) v = seg;
      if (!v) continue;
      if (v !== WALL && ids.has(v)) roomPixels++;
      px[row * width + x] = v;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (row < minY) minY = row;
      if (row > maxY) maxY = row;
    }
  }
  let picture = null;
  // Only trust the picture when most of it lines up with the room list.
  if (rooms.length && maxX >= 0 && roomPixels > 50) {
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const out = Buffer.alloc(w * h);
    for (let y = 0; y < h; y++) out.set(px.subarray((minY + y) * width + minX, (minY + y) * width + minX + w), y * w);
    picture = { width: w, height: h, rotation: [0, 90, 180, 270].includes(Number(rotation)) ? Number(rotation) : 0, pixels: out.toString('base64') };
  }
  return { mapId, rooms, picture };
}

/**
 * Turns the saved-map list file (JSON with "mapstr") into maps with rooms.
 * `fetchObject(name)` downloads a map stored as a separate object (server == 1).
 */
export async function parseMapList(listText, { fetchObject = null, ivHint = null } = {}) {
  let info;
  try {
    info = JSON.parse(String(listText));
  } catch {
    throw new MapError('map list is not JSON');
  }
  const maps = [];
  let iv = ivHint;
  for (const entry of Array.isArray(info.mapstr) ? info.mapstr : []) {
    let raw = entry.map ?? null;
    if (!raw && info.server === 1 && entry.rismobj && fetchObject) raw = (await fetchObject(entry.rismobj)).toString('utf8');
    if (!raw) continue;
    try {
      const decoded = decodeMapBytes(raw, iv);
      iv = decoded.iv ?? iv;
      const parsed = parseMap(decoded.bytes, entry.angle ? Number(entry.angle) : 0);
      maps.push({ ...parsed, name: entry.name ? String(entry.name) : null });
    } catch (err) {
      if (!(err instanceof MapError)) throw err;
    }
  }
  return { currentId: info.curr_id ?? null, maps, iv };
}
