import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodeMapBytes, parseMap, parseMapList, WALL } from './dreame-map.js';
import { demoMapBytes, demoMapList, encodeMap, DEMO_IV } from './vacuum.fixtures.js';

test('decrypts a map by trying the model keys', () => {
  const raw = demoMapBytes();
  const { bytes, iv } = decodeMapBytes(encodeMap(raw));
  assert.equal(iv, DEMO_IV);
  assert.ok(bytes.equals(raw));
});

test('reads unencrypted maps too', () => {
  const raw = demoMapBytes();
  const text = zlib.deflateSync(raw).toString('base64').replace(/\//g, '_').replace(/\+/g, '-');
  assert.ok(decodeMapBytes(text).bytes.equals(raw));
});

test('names rooms from custom names, room types, or numbers', () => {
  const { mapId, rooms } = parseMap(demoMapBytes());
  assert.equal(mapId, 7);
  assert.deepEqual(rooms, [
    { id: 1, name: 'Living Room' },
    { id: 2, name: 'Kitchen' },
    { id: 3, name: "Dan's Office" },
    { id: 4, name: 'Primary Bedroom' },
    { id: 5, name: 'Bathroom' },
  ]);
  const second = parseMap(demoMapBytes({ segInf: { 1: { type: 6, index: 1 }, 2: {} } })).rooms;
  assert.deepEqual(second, [{ id: 1, name: 'Bathroom 2' }, { id: 2, name: 'Room 2' }]);
});

test('builds a cropped picture with rows flipped top to bottom', () => {
  const { picture } = parseMap(demoMapBytes(), 90);
  assert.equal(picture.rotation, 90);
  // Cropped to the outer walls: x 1..70, y 1..42 of a 72x44 map.
  assert.equal(picture.width, 70);
  assert.equal(picture.height, 42);
  const px = Buffer.from(picture.pixels, 'base64');
  const at = (x, y) => px[(44 - 1 - y - 1) * 70 + (x - 1)];
  // The living room is stored at the bottom (low y), so it is drawn at the bottom.
  assert.equal(at(10, 5), 1);
  assert.equal(at(10, 30), 3);
  assert.equal(px[0], WALL);
});

test('no picture when the pixels do not match the rooms', () => {
  const raw = demoMapBytes({ segInf: { 40: { type: 1 } } });
  const { rooms, picture } = parseMap(raw);
  assert.deepEqual(rooms, [{ id: 40, name: 'Living Room' }]);
  assert.equal(picture, null);
});

test('reads the saved-map list and picks the current map', async () => {
  const list = await parseMapList(demoMapList());
  assert.equal(list.currentId, 7);
  assert.equal(list.maps.length, 1);
  assert.equal(list.maps[0].rooms.length, 5);
  assert.equal(list.maps[0].name, 'Home');
  assert.equal(list.iv, DEMO_IV);
});

test('fetches maps stored as separate objects', async () => {
  const text = JSON.stringify({ curr_id: 3, server: 1, mapstr: [{ rismobj: 'obj/3', angle: 180 }] });
  const fetched = [];
  const list = await parseMapList(text, {
    fetchObject: async (name) => {
      fetched.push(name);
      return Buffer.from(encodeMap(demoMapBytes({ mapId: 3 })));
    },
  });
  assert.deepEqual(fetched, ['obj/3']);
  assert.equal(list.maps[0].mapId, 3);
  assert.equal(list.maps[0].picture.rotation, 180);
});
