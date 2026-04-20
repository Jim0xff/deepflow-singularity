#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { handleVideoAgentFlow } from '../lib/video-agent-handle-flow.mjs';
import { sendTelegramMessage } from '../lib/video-agent-send-telegram.mjs';

export async function runVideoAgentHandleFlow({
  event,
  handleFlow = handleVideoAgentFlow,
  sendTelegram = sendTelegramMessage,
}) {
  const result = await handleFlow({ event });
  if (shouldSendHandleResult(result)) {
    result.delivery = await sendTelegram({
      accountId: result.target.account_id || 'singularity-video',
      chatId: result.target.chat_id,
      message: result.message,
      replyToMessageId: null,
    });
    result.action = 'handled';
    result.message = '视频入口已发送到目标群。';
  }
  return result;
}

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    throw new Error('Usage: video-agent-handle-flow.mjs \'<json-event>\'');
  }
  const event = JSON.parse(raw);
  const result = await runVideoAgentHandleFlow({ event });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function shouldSendHandleResult(result) {
  if (result?.action !== 'reply' || !result?.target?.chat_id || !result?.message) {
    return false;
  }

  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[video-agent-handle-flow] ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
