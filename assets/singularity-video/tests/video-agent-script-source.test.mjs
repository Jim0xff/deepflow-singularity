import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadScriptSource } from '../lib/video-agent-script-source.mjs';

test('loadScriptSource returns unloaded result when source is empty', async () => {
  const result = await loadScriptSource({
    scriptSource: {
      type: '',
      value: '',
    },
  });

  assert.deepEqual(result, {
    loaded: false,
    sourceType: null,
    sourceValue: null,
    script: null,
    error: null,
  });
});

test('loadScriptSource reads text from local file source', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-agent-source-'));
  const filePath = path.join(tempDir, 'script.txt');
  await fs.writeFile(filePath, 'hello from file', 'utf8');

  const result = await loadScriptSource({
    scriptSource: {
      type: 'file',
      value: filePath,
    },
  });

  assert.equal(result.loaded, true);
  assert.equal(result.sourceType, 'file');
  assert.equal(result.sourceValue, filePath);
  assert.equal(result.script, 'hello from file');
  assert.equal(result.error, null);
});

test('loadScriptSource reads text from remote url source', async () => {
  const calls = [];
  const result = await loadScriptSource({
    scriptSource: {
      type: 'url',
      value: 'https://example.com/script.txt',
    },
    fetchImpl: async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        async text() {
          return 'hello from url';
        },
      };
    },
  });

  assert.deepEqual(calls, ['https://example.com/script.txt']);
  assert.equal(result.loaded, true);
  assert.equal(result.sourceType, 'url');
  assert.equal(result.script, 'hello from url');
});

test('loadScriptSource falls back cleanly when local file cannot be read', async () => {
  const result = await loadScriptSource({
    scriptSource: {
      type: 'file',
      value: '/tmp/does-not-exist-video-agent-script.txt',
    },
  });

  assert.equal(result.loaded, false);
  assert.equal(result.sourceType, 'file');
  assert.equal(result.script, null);
  assert.match(result.error || '', /ENOENT|no such file/i);
});

test('loadScriptSource falls back cleanly when remote url fetch fails', async () => {
  const result = await loadScriptSource({
    scriptSource: {
      type: 'url',
      value: 'https://example.com/fail.txt',
    },
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      async text() {
        return 'server error';
      },
    }),
  });

  assert.equal(result.loaded, false);
  assert.equal(result.sourceType, 'url');
  assert.equal(result.script, null);
  assert.match(result.error || '', /500/);
});
