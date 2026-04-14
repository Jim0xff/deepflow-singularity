#!/usr/bin/env node

import { handleVideoAgentFlow } from '../lib/video-agent-handle-flow.mjs';
import { sendTelegramMessage } from '../lib/video-agent-send-telegram.mjs';

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    throw new Error('Usage: video-agent-handle-flow.mjs \'<json-event>\'');
  }
  const event = JSON.parse(raw);
  const result = await handleVideoAgentFlow({ event });
  if (shouldSendToTarget({ event, result })) {
    result.delivery = await sendTelegramMessage({
      accountId: result.target.account_id || 'singularity-video',
      chatId: result.target.chat_id,
      message: result.message,
      replyToMessageId: result.target.reply_to_message_id,
    });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function shouldSendToTarget({ event, result }) {
  if (result?.action !== 'reply' || !result?.target?.chat_id || !result?.message) {
    return false;
  }

  return String(event?.chat?.id || '') !== String(result.target.chat_id);
}

main().catch((error) => {
  process.stderr.write(`[video-agent-handle-flow] ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
