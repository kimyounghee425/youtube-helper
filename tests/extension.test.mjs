import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const dist = new URL('../dist/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', dist), 'utf8'));
const worker = await readFile(new URL(manifest.background.service_worker, dist), 'utf8');

test('built extension includes its panel and referenced scripts/styles', async () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['sidePanel']);
  const html = await readFile(new URL(manifest.side_panel.default_path, dist), 'utf8');
  const resources = [...html.matchAll(/(?:src|href)="([^"\s]+\.(?:js|css))"/g)];
  assert.ok(resources.some(([, path]) => path.endsWith('.js')));
  for (const [, path] of resources) {
    await readFile(new URL(path.replace(/^\//, ''), dist));
  }
});

test('toolbar action is configured to open the panel', async () => {
  let opensOnClick = false;
  runInNewContext(worker, {
    chrome: {
      sidePanel: {
        setPanelBehavior: async (options) => {
          opensOnClick = options.openPanelOnActionClick;
        },
      },
    },
    console,
  });
  await setImmediate();
  assert.equal(opensOnClick, true);
});

test('panel configuration failures are reported', async () => {
  const failure = new Error('Side panel unavailable');
  let reported;
  runInNewContext(worker, {
    chrome: {
      sidePanel: {
        setPanelBehavior: async () => {
          throw failure;
        },
      },
    },
    console: {
      error: (_message, error) => {
        reported = error;
      },
    },
  });
  await setImmediate();
  assert.equal(reported, failure);
});
