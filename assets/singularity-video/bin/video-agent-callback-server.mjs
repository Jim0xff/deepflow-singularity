#!/usr/bin/env node

import fs from 'node:fs/promises';
import http from 'node:http';

import { handleGenerateVideoCallback } from '../lib/video-agent-handle-callback.mjs';
import { getVideoAgentPaths } from '../lib/video-agent-paths.mjs';
import { sendTelegramMessage } from '../lib/video-agent-send-telegram.mjs';

async function loadConfig() {
  const paths = getVideoAgentPaths();
  const content = await fs.readFile(paths.configFile, 'utf8');
  return JSON.parse(content);
}

function parseCallbackPath(callbackUrl) {
  if (typeof callbackUrl === 'string' && callbackUrl.trim()) {
    return callbackUrl.trim();
  }
  return '/video-agent/callback';
}

async function main() {
  const config = await loadConfig();
  const host = process.env.VIDEO_AGENT_CALLBACK_HOST || config?.callbackServer?.host || '127.0.0.1';
  const port = Number(process.env.VIDEO_AGENT_CALLBACK_PORT || config?.callbackServer?.port || 31991);
  const callbackPath = parseCallbackPath(process.env.VIDEO_AGENT_CALLBACK_PATH || config?.callbackServer?.path || '');

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== callbackPath) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    try {
      const body = await readJsonBody(req);
      const result = await handleGenerateVideoCallback({
        headers: req.headers,
        body,
        expectedToken: config?.generateVideo?.callbackToken || '',
      });

      if (result.action === 'reject') {
        res.statusCode = result.status || 401;
        res.end('unauthorized');
        return;
      }

      if (result.action === 'reply') {
        await sendTelegramMessage({
          accountId: config?.telegram?.accountId || 'singularity-video',
          chatId: result.target.chat_id,
          message: result.message,
          replyToMessageId: result.target.reply_to_message_id,
        });
      }

      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        ok: true,
        action: result.action,
      }));
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        ok: false,
        error: error?.message || String(error),
      }));
    }
  });

  server.listen(port, host, () => {
    process.stdout.write(`video-agent callback server listening on http://${host}:${port}${callbackPath}\n`);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

main().catch((error) => {
  process.stderr.write(`[video-agent-callback-server] ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
