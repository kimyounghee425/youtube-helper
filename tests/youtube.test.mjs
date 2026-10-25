import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/youtube.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { getVideoId, captureVideo, parseCaptions } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);
const videoId = '8aGhZQkoFbQ';
const url = `https://www.youtube.com/watch?v=${videoId}`;
const track = {
  baseUrl: 'https://www.youtube.com/api/timedtext?v=8aGhZQkoFbQ&lang=ko',
  languageCode: 'ko',
};
const details = { videoId, title: 'Example lecture', lengthSeconds: '300' };
const response = {
  videoDetails: details,
  captions: { playerCaptionsTracklistRenderer: { captionTracks: [track] } },
};
const captionData = {
  events: [{ tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: 'hello ' }, { utf8: 'world' }] }],
};

function capture({ playerResponse = response, fetcher, locationUrl = url } = {}) {
  const location = new URL(locationUrl);
  return runInNewContext(`(${captureVideo.toString()})(${JSON.stringify(videoId)})`, {
    URL,
    AbortSignal,
    Error,
    setTimeout: (callback) => {
      callback();
    },
    location,
    document: {
      querySelector: () => ({
        getPlayerResponse: () =>
          typeof playerResponse === 'function' ? playerResponse() : playerResponse,
      }),
    },
    fetch: fetcher ?? (async () => ({ ok: true, text: async () => JSON.stringify(captionData) })),
  });
}

test('only normal YouTube watch URLs are accepted', () => {
  assert.equal(getVideoId(`${url}&t=120&list=playlist`), videoId);
  for (const value of [
    undefined,
    '',
    'invalid',
    url.replace('https:', 'http:'),
    'https://www.youtube.com/shorts/8aGhZQkoFbQ',
    url.replace('www.youtube.com', 'www.youtube.com.evil.test'),
    url.replace(videoId, 'bad'),
  ]) {
    assert.equal(getVideoId(value), null);
  }
});

test('caption text and millisecond timestamps are preserved; control events are ignored', () => {
  const data = { events: [{ tStartMs: 0, wWinId: 1 }, ...captionData.events] };
  assert.deepEqual(parseCaptions(data), [{ start: 1, duration: 3, text: 'hello world' }]);
  assert.throws(() => parseCaptions({ events: [] }), /문장이 없어요/);
  assert.throws(
    () =>
      parseCaptions({ events: [{ tStartMs: '1000', dDurationMs: 3, segs: [{ utf8: 'text' }] }] }),
    /시간 정보/,
  );
  assert.throws(
    () => parseCaptions({ events: [{ tStartMs: 0, dDurationMs: 3, segs: [{ utf8: 7 }] }] }),
    /텍스트 형식/,
  );
  assert.throws(() => parseCaptions({ error: 'unavailable' }), /응답 형식/);
});

test('injected function works without module scope and requests only YouTube captions', async () => {
  let requested;
  const result = await capture({
    fetcher: async (address, options) => {
      requested = new URL(address);
      assert.equal(options.redirect, 'error');
      return { ok: true, text: async () => JSON.stringify(captionData) };
    },
  });
  assert.equal(requested.origin, 'https://www.youtube.com');
  assert.equal(requested.searchParams.get('fmt'), 'json3');
  assert.equal(result.video.duration, 300);
  assert.equal(result.captions.status, 'ok');
  assert.equal(result.captions.language, 'ko');
});

test('missing captions are distinct from an empty 200 response and HTTP failure', async () => {
  const missing = await capture({
    playerResponse: { videoDetails: details },
    fetcher: () => assert.fail('must not fetch'),
  });
  assert.equal(missing.captions.status, 'unavailable');
  const empty = await capture({ fetcher: async () => ({ ok: true, text: async () => '' }) });
  assert.equal(empty.captions.status, 'error');
  assert.match(empty.captions.message, /본문 응답이 비어/);
  const failed = await capture({ fetcher: async () => ({ ok: false, status: 429 }) });
  assert.match(failed.captions.message, /HTTP 429/);
  assert.equal(failed.video.id, videoId);
});

test('stale player data, live streams and unsupported pages never fetch captions', async () => {
  for (const overrides of [
    { playerResponse: { ...response, videoDetails: { ...details, videoId: '9vJRopau0g0' } } },
    { playerResponse: { ...response, videoDetails: { ...details, isLive: true } } },
    { locationUrl: 'https://www.youtube.com/shorts/8aGhZQkoFbQ' },
  ]) {
    const result = await capture({ ...overrides, fetcher: () => assert.fail('must not fetch') });
    assert.equal(result.status, 'error');
  }
});

test('untrusted caption URLs are rejected before a network request', async () => {
  const result = await capture({
    playerResponse: {
      ...response,
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ ...track, baseUrl: 'https://example.com/collect' }],
        },
      },
    },
    fetcher: () => assert.fail('must not fetch'),
  });
  assert.equal(result.captions.status, 'error');
  assert.match(result.captions.message, /지원하지 않는 자막 주소/);
});

test('network and timeout failures keep video metadata with actionable errors', async () => {
  for (const name of ['TimeoutError', 'TypeError']) {
    const result = await capture({
      fetcher: async () => {
        const error = new Error('request failed');
        error.name = name;
        throw error;
      },
    });
    assert.equal(result.video.id, videoId);
    assert.equal(result.captions.status, 'error');
    assert.match(result.captions.message, /다시/);
  }
});

test('waits for the new video metadata before collecting the full transcript', async () => {
  let attempts = 0;
  const result = await capture({
    playerResponse: () =>
      ++attempts < 3 ? { videoDetails: { ...details, videoId: '9vJRopau0g0' } } : response,
  });
  assert.equal(attempts, 3);
  assert.equal(result.captions.status, 'ok');
});

test('all captions remain available including segments far beyond the current playback position', () => {
  const result = parseCaptions({
    events: [
      ...captionData.events,
      { tStartMs: 1700000, dDurationMs: 5000, segs: [{ utf8: 'last slide' }] },
    ],
  });
  assert.equal(result.length, 2);
  assert.equal(result[1].start, 1700);
  assert.equal(result[1].text, 'last slide');
});
