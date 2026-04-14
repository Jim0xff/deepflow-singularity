#!/usr/bin/env node

import fs from 'node:fs/promises';

import { handleGenerateVideoCallback } from '../lib/video-agent-handle-callback.mjs';
import { getVideoAgentPaths } from '../lib/video-agent-paths.mjs';

async function main() {
  const bodyFile = process.argv[2];
  if (!bodyFile) {
    throw new Error('Usage: video-agent-handle-callback.mjs <json-body-file>');
  }
  const content = await fs.readFile(bodyFile, 'utf8');
  const body = JSON.parse(content);
  const paths = getVideoAgentPaths();
  const config = JSON.parse(await fs.readFile(paths.configFile, 'utf8'));
  const result = await handleGenerateVideoCallback({
    body,
    expectedToken: config?.generateVideo?.callbackToken || '',
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`[video-agent-handle-callback] ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
