#!/usr/bin/env node

import { handleVideoAgentFlow } from '../lib/video-agent-handle-flow.mjs';

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    throw new Error('Usage: video-agent-handle-flow.mjs \'<json-event>\'');
  }
  const event = JSON.parse(raw);
  const result = await handleVideoAgentFlow({ event });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`[video-agent-handle-flow] ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
