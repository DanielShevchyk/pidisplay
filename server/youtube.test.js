import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createYouTube, parseChunks, parseDialApp, parseSearch, videoIdFrom } from './youtube.js';

const chunk = (events) => {
  const body = JSON.stringify(events);
  return `${body.length}\n${body}\n`;
};

test('parseChunks splits lounge output and keeps an incomplete tail', () => {
  const a = chunk([[0, ['c', 'SID1', '', 8]], [1, ['S', 'GS1']]]);
  const b = chunk([[2, ['nowPlaying', { videoId: 'dQw4w9WgXcQ', state: '1', currentTime: '3', duration: '212' }]]]);
  const { batches, rest } = parseChunks(a + b.slice(0, 20));
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0][0], [0, ['c', 'SID1', '', 8]]);
  const more = parseChunks(rest + b.slice(20));
  assert.equal(more.batches.length, 1);
  assert.equal(more.batches[0][0][1][1].videoId, 'dQw4w9WgXcQ');
  assert.equal(more.rest, '\n');
  // Brackets inside strings don't confuse it.
  assert.equal(parseChunks(chunk([[3, ['x', { t: 'a]b[{' }]]])).batches[0][0][1][1].t, 'a]b[{');
});

test('parseSearch reads video renderers and lockups, skipping other items', () => {
  const data = {
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [
              {
                itemSectionRenderer: {
                  contents: [
                    { channelRenderer: { channelId: 'UC1', title: { simpleText: 'A channel' } } },
                    {
                      videoRenderer: {
                        videoId: 'dQw4w9WgXcQ',
                        title: { runs: [{ text: 'Never Gonna ' }, { text: 'Give You Up' }] },
                        ownerText: { runs: [{ text: 'Rick Astley' }] },
                        lengthText: { simpleText: '3:33' },
                        shortViewCountText: { simpleText: '1.6B views' },
                        publishedTimeText: { simpleText: '15 years ago' },
                      },
                    },
                    {
                      videoRenderer: {
                        videoId: 'live1234567',
                        title: { runs: [{ text: 'Lofi radio' }] },
                        ownerText: { runs: [{ text: 'Lofi Girl' }] },
                        badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW', label: 'LIVE' } }],
                      },
                    },
                    { videoRenderer: { videoId: 'dQw4w9WgXcQ', title: { runs: [{ text: 'Duplicate' }] } } },
                    {
                      lockupViewModel: {
                        contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
                        contentId: 'abcdefghijk',
                        contentImage: { thumbnailViewModel: { overlays: [{ thumbnailBadgeViewModel: { text: '12:04' } }] } },
                        metadata: {
                          lockupMetadataViewModel: {
                            title: { content: 'A lockup video' },
                            metadata: {
                              contentMetadataViewModel: {
                                metadataRows: [
                                  { metadataParts: [{ text: { content: 'Some Channel' } }] },
                                  { metadataParts: [{ text: { content: '10K views' } }, { text: { content: '2 days ago' } }] },
                                ],
                              },
                            },
                          },
                        },
                      },
                    },
                    { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST', contentId: 'PL123' } },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  };
  const results = parseSearch(data);
  assert.deepEqual(
    results.map((r) => [r.id, r.title, r.channel, r.duration, r.live]),
    [
      ['dQw4w9WgXcQ', 'Never Gonna Give You Up', 'Rick Astley', '3:33', false],
      ['live1234567', 'Lofi radio', 'Lofi Girl', '', true],
      ['abcdefghijk', 'A lockup video', 'Some Channel', '12:04', false],
    ],
  );
  assert.equal(results[2].views, '10K views');
  assert.equal(results[2].published, '2 days ago');
  assert.equal(results[0].thumb, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
  assert.deepEqual(parseSearch(null), []);
});

test('videoIdFrom accepts ids and the usual link shapes', () => {
  assert.equal(videoIdFrom('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFrom('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFrom('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFrom('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFrom('cats'), null);
});

test('parseDialApp reads the YouTube app state and screen id', () => {
  const xml = `<?xml version="1.0"?><service xmlns="urn:dial-multiscreen-org:schemas:dial" dialVer="2.1">
<name>YouTube</name><options allowStop="true"/><state>running</state><link rel="run" href="run"/>
<additionalData><screenId>screen-abc</screenId></additionalData></service>`;
  assert.deepEqual(parseDialApp(xml), { state: 'running', screenId: 'screen-abc' });
  assert.deepEqual(parseDialApp('<service><state>stopped</state></service>'), { state: 'stopped', screenId: null });
});

/** A fake YouTube: records lounge calls and answers like the real service. */
function fakeLounge({ tokenExpired = false } = {}) {
  const calls = [];
  let expired = tokenExpired;
  const reply = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    body: null,
  });
  const fetchImpl = async (url, init = {}) => {
    const form = init.body && typeof init.body === 'string' && !init.body.startsWith('{') ? Object.fromEntries(new URLSearchParams(init.body)) : null;
    const u = new URL(url);
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method ?? 'GET', form });
    if (u.pathname.endsWith('/pairing/get_screen')) {
      if (form.pairing_code !== '123456789012') return reply(404, 'Not Found');
      return reply(200, { screen: { screenId: 'scr1', loungeToken: 'tok1', name: 'YouTube on TV', expiration: Date.now() + 86400000 } });
    }
    if (u.pathname.endsWith('/pairing/get_lounge_token_batch')) {
      expired = false;
      return reply(200, { screens: [{ screenId: form.screen_ids, loungeToken: 'tok2', expiration: Date.now() + 86400000 }] });
    }
    if (u.pathname.endsWith('/pairing/get_screen_availability')) return reply(200, { screens: [{ loungeToken: form.lounge_token, status: 'online' }] });
    if (u.pathname.endsWith('/bc/bind')) {
      if (u.searchParams.get('RID') === 'rpc') {
        // Like the real channel: stays open until the session is closed.
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      if (u.searchParams.get('RID') === '1') {
        if (expired) return reply(401, 'Expired');
        return reply(200, chunk([[0, ['c', 'SID1', '', 8]], [1, ['S', 'GS1']], [2, ['nowPlaying', {}]]]));
      }
      return reply(200, '');
    }
    if (u.pathname === '/oembed') return reply(200, { title: 'Looked up', author_name: 'Someone' });
    return reply(404, 'Not Found');
  };
  return { calls, fetchImpl };
}

function service(lounge, saved = null) {
  const saves = [];
  const yt = createYouTube({
    load: async () => saved,
    save: async (v) => saves.push(v),
    fetchImpl: lounge.fetchImpl,
    wait: async () => {},
  });
  return { yt, saves };
}

test('pairing with a TV code links the TV and play sends setPlaylist on the session', async () => {
  const lounge = fakeLounge();
  const { yt, saves } = service(lounge);
  await assert.rejects(yt.handle('POST', ['youtube', 'pair'], { code: '111 222 333 444' }), /didn't work/);
  const linked = await yt.handle('POST', ['youtube', 'pair'], { code: '123 456 789 012' });
  assert.deepEqual(linked.screens, [{ id: 'scr1', name: 'YouTube on TV', dial: false }]);
  assert.equal(linked.current, 'scr1');
  assert.equal(JSON.stringify(linked).includes('tok1'), false, 'the token never leaves the server');
  assert.equal(saves.at(-1).screens[0].token, 'tok1');

  const played = await yt.handle('POST', ['youtube', 'play'], { videoId: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', channel: 'Rick Astley' });
  assert.equal(played.tv.videoId, 'dQw4w9WgXcQ');
  assert.equal(played.tv.title, 'Never Gonna Give You Up');
  assert.equal(played.history[0].id, 'dQw4w9WgXcQ');
  const bind = lounge.calls.find((c) => c.path.endsWith('/bc/bind') && c.query.RID === '1');
  assert.equal(bind.form.loungeIdToken, 'tok1');
  assert.equal(bind.form.name, 'PiDisplay');
  const cmd = lounge.calls.find((c) => c.form?.req0__sc === 'setPlaylist');
  assert.equal(cmd.form.req0_videoId, 'dQw4w9WgXcQ');
  assert.equal(cmd.query.SID, 'SID1');
  assert.equal(cmd.query.gsessionid, 'GS1');
  assert.equal(cmd.query.loungeIdToken, 'tok1');

  await yt.handle('POST', ['youtube', 'control'], { action: 'pause' });
  const pause = lounge.calls.filter((c) => c.form?.req0__sc).map((c) => [c.form.req0__sc, c.form.ofs, c.query.RID]);
  assert.deepEqual(pause, [
    ['setPlaylist', '1', '2'],
    ['pause', '2', '3'],
  ]);
  await yt.handle('POST', ['youtube', 'control'], { action: 'volume', value: 140 });
  assert.equal(lounge.calls.at(-1).form.req0_volume, '100');
  await assert.rejects(yt.handle('POST', ['youtube', 'control'], { action: 'explode' }), /action must be/);
  await assert.rejects(yt.handle('POST', ['youtube', 'play'], { videoId: 'nope' }), /videoId/);
  yt.stop();
});

test('an expired lounge token is renewed from the screen id', async () => {
  const lounge = fakeLounge({ tokenExpired: true });
  const saved = { screens: [{ id: 'scr1', name: 'Living room', token: 'old', expires: null }], current: 'scr1', history: [] };
  const { yt, saves } = service(lounge, saved);
  await yt.handle('POST', ['youtube', 'play'], { videoId: 'dQw4w9WgXcQ' });
  assert.ok(lounge.calls.some((c) => c.path.endsWith('/get_lounge_token_batch') && c.form.screen_ids === 'scr1'));
  assert.equal(saves.at(-1).screens[0].token, 'tok2');
  assert.equal(lounge.calls.find((c) => c.form?.req0__sc === 'setPlaylist').query.loungeIdToken, 'tok2');
  // The title came from oEmbed since the screen didn't send one.
  assert.equal((await yt.status()).tv.title, 'Looked up');
  yt.stop();
});

test('play without a linked TV says so', async () => {
  const { yt } = service(fakeLounge());
  await assert.rejects(yt.handle('POST', ['youtube', 'play'], { videoId: 'dQw4w9WgXcQ' }), /No TV is linked/);
  assert.deepEqual((await yt.handle('GET', ['youtube'], null)).screens, []);
});

test('forgetting the current TV falls back to another one', async () => {
  const saved = {
    screens: [
      { id: 'a', name: 'Bedroom', token: 't', expires: null },
      { id: 'b', name: 'Living room', token: 't', expires: null },
    ],
    current: 'a',
    history: [],
  };
  const { yt } = service(fakeLounge(), saved);
  const s = await yt.handle('DELETE', ['youtube', 'screens', 'a'], null);
  assert.deepEqual(s.screens.map((x) => x.id), ['b']);
  assert.equal(s.current, 'b');
  yt.stop();
});

test('search posts to youtubei and caches the results', async () => {
  let posts = 0;
  const fetchImpl = async (url, init) => {
    posts++;
    assert.match(url, /youtubei\/v1\/search/);
    const body = JSON.parse(init.body);
    assert.equal(body.query, 'cats');
    assert.equal(body.context.client.clientName, 'WEB');
    return {
      ok: true,
      status: 200,
      json: async () => ({ contents: [{ videoRenderer: { videoId: 'abcdefghijk', title: { runs: [{ text: 'Cats' }] } } }] }),
    };
  };
  const yt = createYouTube({ fetchImpl });
  const a = await yt.handle('GET', ['youtube', 'search'], null, new URLSearchParams('q=cats'));
  const b = await yt.handle('GET', ['youtube', 'search'], null, new URLSearchParams('q=Cats'));
  assert.equal(a.results[0].title, 'Cats');
  assert.deepEqual(a, b);
  assert.equal(posts, 1);
  await assert.rejects(yt.handle('GET', ['youtube', 'search'], null, new URLSearchParams('q=')), /q is required/);
});
