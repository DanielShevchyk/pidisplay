import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNews, localPlace, parseFeed } from './news.js';

const related = (pairs) =>
  `<ol>${pairs.map(([t, s]) => `<li><a href="https://news.google.com/x" target="_blank">${t}</a>&nbsp;&nbsp;<font color="#6f6f6f">${s}</font></li>`).join('')}</ol>`;

function item({ title, source, desc = '', date = 'Fri, 02 Oct 2026 21:10:00 GMT', guid = title }) {
  return `<item><title>${title} - ${source}</title><link>https://news.google.com/rss/articles/${encodeURIComponent(guid)}?oc=5</link>
<guid isPermaLink="false">${guid}</guid><pubDate>${date}</pubDate>
<description>${desc.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</description>
<source url="https://example.com">${source}</source></item>`;
}

const rss = (...items) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Feed</title>${items.join('')}</channel></rss>`;

test('parseFeed strips the outlet suffix, decodes entities and reads related coverage', () => {
  const xml = rss(
    item({
      title: 'Talks resume &amp; leaders meet',
      source: 'Reuters',
      desc: related([
        ['Talks resume &amp; leaders meet', 'Reuters'],
        ['Leaders meet for second day', 'AP News'],
        ['What to know about the talks', 'BBC'],
      ]),
    }),
    item({ title: 'Quake hits coast', source: 'CNN', date: 'garbage' }),
  );
  const items = parseFeed(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Talks resume & leaders meet');
  assert.equal(items[0].source, 'Reuters');
  assert.equal(items[0].time, Date.UTC(2026, 9, 2, 21, 10));
  assert.match(items[0].url, /^https:\/\/news\.google\.com\/rss\/articles\//);
  assert.deepEqual(items[0].related, [
    { title: 'Leaders meet for second day', source: 'AP News' },
    { title: 'What to know about the talks', source: 'BBC' },
  ]);
  assert.equal(items[1].time, null);
  assert.deepEqual(items[1].related, []);
});

test('localPlace expands US state codes for the geo feed', () => {
  assert.deepEqual(localPlace('Citrus Heights, CA'), { label: 'Citrus Heights', geo: 'Citrus Heights, California', city: 'Citrus Heights' });
  assert.equal(localPlace('Paris, France').geo, 'Paris, France');
  assert.equal(localPlace('  '), null);
  assert.throws(() => localPlace('38.7,-121.3'), /city name/);
});

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) return { ok: false, status: 404, text: async () => '' };
    const value = typeof hit[1] === 'function' ? hit[1]() : hit[1];
    return { ok: true, status: 200, text: async () => value };
  };
  return { fetchImpl, calls };
}

test('get returns world, U.S. and local sections, and caches feeds', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'topic/WORLD': rss(item({ title: 'World story', source: 'BBC' })),
    'topic/NATION': rss(item({ title: 'US story', source: 'NPR' })),
    'geo/Citrus%20Heights%2C%20California': rss(item({ title: 'Local story', source: 'Sacramento Bee' })),
  });
  let t = 0;
  const news = createNews({ fetchImpl, now: () => t });
  const out = await news.get({ location: 'Citrus Heights, CA' });
  assert.deepEqual(
    out.sections.map((s) => [s.id, s.label, s.items[0]?.title, s.error]),
    [
      ['world', 'World', 'World story', undefined],
      ['us', 'U.S.', 'US story', undefined],
      ['local', 'Citrus Heights', 'Local story', undefined],
    ],
  );
  await news.get({ location: 'Citrus Heights, CA' });
  assert.equal(calls.length, 3);
  t = 11 * 60 * 1000;
  await news.get({ sections: 'world' });
  assert.equal(calls.length, 4);
});

test('an empty geo feed falls back to a search, and failures stay per section', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'geo/': rss(),
    '/search?q=': rss(item({ title: 'Town council votes', source: 'Patch' })),
  });
  const news = createNews({ fetchImpl });
  const out = await news.get({ sections: 'world,local', location: 'Tinyville, OR' });
  assert.match(out.sections[0].error, /returned 404/);
  assert.equal(out.sections[1].label, 'Tinyville');
  assert.equal(out.sections[1].items[0].title, 'Town council votes');
  assert.ok(calls.some((u) => u.includes(encodeURIComponent('"Tinyville" when:3d'))));

  const noPlace = await news.get({ sections: 'local' });
  assert.match(noPlace.sections[0].error, /Set a location/);
});

test('a failed refresh keeps the last good copy, marked stale', async () => {
  let up = true;
  const { fetchImpl } = fakeFetch({
    'topic/WORLD': () => {
      if (!up) throw new Error('offline');
      return rss(item({ title: 'Cached story', source: 'AP' }));
    },
  });
  let t = 0;
  const news = createNews({
    fetchImpl: async (url, opts) => {
      if (!up) throw new Error('offline');
      return fetchImpl(url, opts);
    },
    now: () => t,
  });
  await news.get({ sections: 'world' });
  up = false;
  t = 60 * 60 * 1000;
  const [world] = (await news.get({ sections: 'world' })).sections;
  assert.equal(world.stale, true);
  assert.equal(world.items[0].title, 'Cached story');
});

test('rejects unknown sections', async () => {
  const news = createNews({ fetchImpl: async () => assert.fail('no fetch') });
  await assert.rejects(news.get({ sections: 'sports' }), /sections must be/);
});
