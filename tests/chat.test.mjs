import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}
const { buildRequest, askVideo, readAnswer, MODEL } = await load('../src/ai.ts');
const { captureMoment, readMoment, formatTime } = await load('../src/moment.ts');
const id = '8aGhZQkoFbQ';
const image = 'data:image/jpeg;base64,YWJj';
const moment = { videoId: id, time: 262, image };
const video = { id, title: 'Test lecture', duration: 1800 };
const captions = [
  { start: 0, duration: 3, text: 'earlier context' },
  { start: 261, duration: 4, text: 'current sentence' },
  { start: 300, duration: 3, text: 'future context' },
];
const completed = (text) => ({
  status: 'completed',
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  ],
});

function capture({
  locationId = id,
  playerId = id,
  ads = false,
  media = {},
  tainted = false,
} = {}) {
  let drawn = false;
  const canvas = {
    getContext: () => ({
      drawImage: () => {
        drawn = true;
      },
    }),
    toDataURL: () => {
      if (tainted) throw new Error('tainted');
      return image;
    },
  };
  const result = runInNewContext(`(${captureMoment.toString()})(${JSON.stringify(id)})`, {
    URL,
    Error,
    location: new URL(`https://www.youtube.com/watch?v=${locationId}`),
    document: {
      querySelector: () => ({
        classList: { contains: () => ads },
        getPlayerResponse: () => ({ videoDetails: { videoId: playerId } }),
        querySelector: () => ({
          readyState: 4,
          seeking: false,
          videoWidth: 3840,
          videoHeight: 2160,
          currentTime: 262,
          duration: 1800,
          ...media,
        }),
      }),
      createElement: () => canvas,
    },
  });
  return { result, drawn, canvas };
}

test('captures one current frame and time without seeking or external dependencies', () => {
  const { result, drawn, canvas } = capture();
  assert.equal(result.time, 262);
  assert.equal(result.image, image);
  assert.equal(drawn, true);
  assert.equal(canvas.width, 1920);
  assert.equal(canvas.height, 1080);
  assert.equal(formatTime(result.time), '4:22');
});

test('does not capture stale videos, ads, loading media or seek transitions', () => {
  for (const options of [
    { locationId: '9vJRopau0g0' },
    { playerId: '9vJRopau0g0' },
    { ads: true },
    { media: { readyState: 1 } },
    { media: { seeking: true } },
    { media: { currentTime: NaN } },
    { media: { duration: Infinity } },
  ]) {
    const { result, drawn } = capture(options);
    assert.equal(typeof result.error, 'string');
    assert.equal(drawn, false);
  }
  assert.match(capture({ tainted: true }).result.error, /프레임을 읽지/);
});

test('validates injected frame output instead of accepting a page-supplied external image URL', async (t) => {
  const original = globalThis.chrome;
  t.after(() => {
    if (original === undefined) delete globalThis.chrome;
    else globalThis.chrome = original;
  });
  let result = moment;
  globalThis.chrome = {
    scripting: {
      executeScript: async (options) => {
        assert.deepEqual(options.args, [id]);
        return [{ result }];
      },
    },
  };
  assert.equal((await readMoment(1, id)).time, 262);
  for (const invalid of [
    { ...moment, image: 'https://external.example/image.jpg' },
    { ...moment, time: -1 },
    { ...moment, videoId: 'different' },
    { error: '프레임 수집 실패' },
    undefined,
  ]) {
    result = invalid;
    await assert.rejects(readMoment(1, id));
  }
});

test('uses captions from start through question time, current image and successful previous turns', () => {
  const request = buildRequest(video, captions, moment, 'Explain?', [
    { question: 'Earlier?', answer: 'Earlier answer', time: 20 },
  ]);
  assert.equal(request.model, MODEL);
  assert.equal(request.store, false);
  assert.equal(request.reasoning.effort, 'none');
  assert.match(request.input[0].content, /earlier context/);
  assert.match(request.input[0].content, /current sentence/);
  assert.doesNotMatch(request.input[0].content, /future context/);
  assert.equal(request.input[1].role, 'user');
  assert.equal(request.input[2].content, 'Earlier answer');
  assert.equal(request.input.at(-1).content[1].image_url, image);
  assert.equal(JSON.stringify(request).match(/input_image/g).length, 1);
  assert.throws(
    () => buildRequest(video, captions, { ...moment, videoId: 'different' }, 'Q', []),
    /맞지/,
  );
  assert.throws(() => buildRequest(video, captions, moment, '', []), /질문/);
  assert.throws(
    () => buildRequest(video, [{ ...captions[0], text: 'x'.repeat(100001) }], moment, 'Q', []),
    /한도/,
  );
});

test('reads only completed assistant text and reports incomplete, refusal or empty output', () => {
  assert.equal(readAnswer(completed('Answer')), 'Answer');
  for (const response of [
    null,
    { status: 'failed' },
    completed(''),
    { ...completed('Partial'), status: 'incomplete' },
    {
      status: 'completed',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] },
      ],
    },
  ]) {
    assert.throws(() => readAnswer(response));
  }
});

test('API sends credentials only in authorization to a fixed endpoint and never auto retries', async (t) => {
  let calls = 0;
  const request = buildRequest(video, captions, moment, 'Question', []);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.doesNotMatch(options.body, /test-key/);
    return new Response(JSON.stringify(completed('Answer')), { status: 200 });
  });
  assert.equal(await askVideo('test-key', request, new AbortController().signal), 'Answer');
  assert.equal(calls, 1);
});

test('API errors are actionable and never echo server details or keys', async (t) => {
  let status = 401;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('secret-server-detail', { status });
  });
  for (const [code, pattern] of [
    [401, /키가 유효/],
    [403, /권한/],
    [404, /권한/],
    [429, /한도/],
    [500, /서버 오류/],
    [400, /HTTP 400/],
  ]) {
    status = code;
    await assert.rejects(askVideo('test-key', {}, new AbortController().signal), (error) => {
      assert.match(error.message, pattern);
      assert.doesNotMatch(error.message, /secret-server-detail|test-key/);
      return true;
    });
  }
  assert.equal(calls, 6);
});

test('network failure, timeout and cancellation do not start a second request', async (t) => {
  let name = 'TypeError';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    const error = new Error('private failure');
    error.name = name;
    throw error;
  });
  await assert.rejects(askVideo('test-key', {}, new AbortController().signal), /연결하지/);
  name = 'TimeoutError';
  await assert.rejects(askVideo('test-key', {}, new AbortController().signal), /시간이 초과/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(askVideo('test-key', {}, controller.signal), /중단/);
  assert.equal(calls, 2);
});
