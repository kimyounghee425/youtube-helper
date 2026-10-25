import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const dist = new URL('../dist/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', dist), 'utf8'));
const workerSource = await readFile(
  new URL('../src/background/service-worker.ts', import.meta.url),
  'utf8',
);
const worker = ts.transpileModule(workerSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const youtubeSource = await readFile(new URL('../src/youtube.ts', import.meta.url), 'utf8');
const youtubeCode = ts.transpileModule(youtubeSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const youtube = await import(
  `data:text/javascript;base64,${Buffer.from(youtubeCode).toString('base64')}`
);
const videoId = '8aGhZQkoFbQ';
const otherId = '9vJRopau0g0';
const watch = (id) => `https://www.youtube.com/watch?v=${id}`;
const key = youtube.transcriptKey(1);
const fixture = (id) => ({
  status: 'captured',
  video: { id, title: 'lecture', duration: 1800 },
  captions: {
    status: 'ok',
    language: 'ko',
    automatic: true,
    data: {
      events: [
        { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'start' }] },
        { tStartMs: 1700000, dDurationMs: 2000, segs: [{ utf8: 'end' }] },
      ],
    },
  },
});
function event() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    emit: (...args) => [...listeners].map((fn) => fn(...args)),
  };
}
function setup({ data = {}, inject = async (id) => fixture(id), panelFailure } = {}) {
  const tabs = new Map();
  const injections = [];
  const errors = [];
  let panelOptions;
  const chrome = {
    sidePanel: {
      setPanelBehavior: async (options) => {
        if (panelFailure) throw panelFailure;
        panelOptions = options;
      },
    },
    storage: {
      session: {
        get: async (name) => ({ [name]: data[name] }),
        set: async (values) => Object.assign(data, values),
        remove: async (name) => {
          delete data[name];
        },
      },
    },
    scripting: {
      executeScript: async (options) => {
        injections.push(options.args[0]);
        return [{ result: await inject(options.args[0]) }];
      },
    },
    tabs: {
      onUpdated: event(),
      onRemoved: event(),
      get: async (id) => {
        if (!tabs.has(id)) throw new Error('tab closed');
        return tabs.get(id);
      },
      query: async () =>
        [...tabs.values()].filter((tab) => tab.url.startsWith('https://www.youtube.com/')),
    },
    runtime: { id: 'test-extension', onInstalled: event(), onStartup: event(), onMessage: event() },
  };
  runInNewContext(worker, {
    chrome,
    exports: {},
    require: () => youtube,
    console: { error: (...args) => errors.push(args) },
    Error,
  });
  const navigate = (id, change = { url: watch(id) }) => {
    const tab = { id: 1, url: watch(id), status: 'complete' };
    tabs.set(1, tab);
    chrome.tabs.onUpdated.emit(1, change, tab);
  };
  const message = (retry = false) =>
    new Promise((resolve) =>
      chrome.runtime.onMessage.emit(
        { type: 'ensure-transcript', tabId: 1, retry },
        { id: chrome.runtime.id },
        resolve,
      ),
    );
  return {
    chrome,
    tabs,
    data,
    injections,
    errors,
    navigate,
    message,
    panelOptions: () => panelOptions,
  };
}

test('built extension includes panel, worker dependencies and narrowly scoped permissions', async () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['sidePanel', 'scripting', 'storage']);
  assert.deepEqual(manifest.host_permissions, [
    'https://www.youtube.com/*',
    'https://api.openai.com/*',
  ]);
  const html = await readFile(new URL(manifest.side_panel.default_path, dist), 'utf8');
  const resources = [...html.matchAll(/(?:src|href)="([^"\s]+\.(?:js|css))"/g)];
  assert.ok(resources.some(([, path]) => path.endsWith('.js')));
  for (const [, path] of resources) await readFile(new URL(path.replace(/^\//, ''), dist));
  const builtWorker = await readFile(new URL(manifest.background.service_worker, dist), 'utf8');
  for (const [, path] of builtWorker.matchAll(/from\s*["']([^"']+)["']/g))
    await readFile(new URL(path, dist));
});

test('toolbar opens the panel and configuration failures are reported', async () => {
  const normal = setup();
  await setImmediate();
  assert.equal(normal.panelOptions().openPanelOnActionClick, true);
  const failure = new Error('Side panel unavailable');
  const failed = setup({ panelFailure: failure });
  await setImmediate();
  assert.equal(failed.errors[0][1], failure);
});

test('video entry collects the entire transcript without a panel message or click', async () => {
  const app = setup();
  app.navigate(videoId);
  await setImmediate();
  assert.equal(app.data[key].status, 'ready');
  assert.equal(app.data[key].captions.length, 2);
  assert.equal(app.data[key].captions[1].start, 1700);
  app.navigate(videoId, { status: 'complete' });
  await app.message();
  assert.equal(app.injections.length, 1);
});

test('same-tab navigation discards a late response from the previous video', async () => {
  let finishOld;
  const app = setup({
    inject: (id) =>
      id === videoId
        ? new Promise((resolve) => {
            finishOld = resolve;
          })
        : Promise.resolve(fixture(id)),
  });
  app.navigate(videoId);
  await setImmediate();
  app.navigate(otherId);
  await setImmediate();
  finishOld(fixture(videoId));
  await setImmediate();
  assert.equal(app.data[key].videoId, otherId);
  assert.equal(app.data[key].status, 'ready');
});

test('reload clears prior data and collects again after the document loads', async () => {
  const app = setup();
  app.navigate(videoId);
  await setImmediate();
  app.navigate(videoId, { status: 'loading' });
  await setImmediate();
  assert.equal(app.data[key], undefined);
  app.navigate(videoId, { status: 'complete' });
  await setImmediate();
  assert.equal(app.injections.length, 2);
  assert.equal(app.data[key].status, 'ready');
});

test('leaving a video or closing its tab clears data and invalidates in-flight work', async () => {
  let finish;
  const app = setup({
    inject: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  app.navigate(videoId);
  await setImmediate();
  const tab = { id: 1, url: 'https://www.youtube.com/', status: 'complete' };
  app.tabs.set(1, tab);
  app.chrome.tabs.onUpdated.emit(1, { url: tab.url }, tab);
  finish(fixture(videoId));
  await setImmediate();
  assert.equal(app.data[key], undefined);
  app.data[key] = { status: 'ready' };
  app.tabs.delete(1);
  app.chrome.tabs.onRemoved.emit(1);
  await setImmediate();
  assert.equal(app.data[key], undefined);
});

test('session cache survives worker restarts and existing tabs are collected on install', async () => {
  const first = setup();
  first.navigate(videoId);
  await setImmediate();
  const second = setup({ data: first.data });
  second.tabs.set(1, first.tabs.get(1));
  await second.message();
  assert.equal(second.injections.length, 0);
  const installed = setup();
  installed.tabs.set(1, first.tabs.get(1));
  installed.chrome.runtime.onInstalled.emit();
  await setImmediate();
  assert.equal(installed.data[key].status, 'ready');
});

test('errors are retained without automatic retries and explicit retry can recover', async () => {
  let fail = true;
  const app = setup({
    inject: async (id) => (fail ? { status: 'error', message: 'empty response' } : fixture(id)),
  });
  app.navigate(videoId);
  await setImmediate();
  assert.equal(app.data[key].status, 'error');
  await app.message();
  assert.equal(app.injections.length, 1);
  fail = false;
  await app.message(true);
  assert.equal(app.data[key].status, 'ready');
  assert.equal(app.injections.length, 2);
});
