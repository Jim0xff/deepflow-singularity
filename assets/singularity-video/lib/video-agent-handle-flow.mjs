import fs from 'node:fs/promises';

import { createGenerateVideoDraft } from './video-agent-client.mjs';
import {
  buildDraftCreatedMessage,
  buildDraftCreateFailedMessage,
  buildHandleCommandInvalidMessage,
  buildManualWebsiteEntryMessage,
} from './video-agent-message-templates.mjs';
import { getVideoAgentPaths } from './video-agent-paths.mjs';
import { loadScriptSource as defaultLoadScriptSource } from './video-agent-script-source.mjs';
import { saveDraftContext as defaultSaveDraftContext } from './video-agent-draft-store.mjs';

async function readRuntimeConfig(configFile) {
  const content = await fs.readFile(configFile, 'utf8');
  return JSON.parse(content);
}

function shouldReply(event) {
  if (event?.chat?.type === 'group' || event?.chat?.type === 'supergroup') {
    return Boolean(event?.mention);
  }
  return true;
}

function resolvePublicCallbackUrl(config) {
  return config?.generateVideo?.publicCallbackUrl
    || config?.generateVideo?.callbackUrl
    || '';
}

function parseHandleCommand(text) {
  const match = String(text || '').trim().match(/^\/handle(?:@\S+)?\s+(.+)$/);
  if (!match) {
    return null;
  }

  const payload = match[1].trim();
  const handoff = payload.match(/^tg:(\S+)\s+path:(.+)$/)
    || payload.match(/^(\S+)\s+(.+)$/);
  if (!handoff) {
    return {
      malformed: true,
    };
  }

  const targetChatId = handoff[1].trim();
  const source = handoff[2].trim();
  if (!targetChatId || !source) {
    return {
      malformed: true,
    };
  }

  return {
    malformed: false,
    targetChatId,
    source,
  };
}

function resolveWebsiteUrl(config) {
  return config?.generateVideo?.websiteUrl || 'https://generate-video-gamma.vercel.app/';
}

function normalizeTelegramId(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return String(value);
}

export async function handleVideoAgentFlow({
  event,
  runtimeConfig = null,
  loadScriptSource = defaultLoadScriptSource,
  createDraft = createGenerateVideoDraft,
  saveDraftContext = defaultSaveDraftContext,
} = {}) {
  if (!shouldReply(event)) {
    return {
      action: 'no_reply',
    };
  }

  const paths = getVideoAgentPaths();
  const config = runtimeConfig || await readRuntimeConfig(paths.configFile);
  const handleCommand = parseHandleCommand(event?.message?.text);

  if (!handleCommand) {
    return {
      action: 'reply',
      message: buildManualWebsiteEntryMessage({
        websiteUrl: resolveWebsiteUrl(config),
      }),
    };
  }

  if (handleCommand.malformed) {
    return {
      action: 'reply',
      message: buildHandleCommandInvalidMessage(),
    };
  }

  const scriptSource = await loadScriptSource({
    scriptSource: {
      type: '',
      value: handleCommand.source,
    },
  });
  const senderId = normalizeTelegramId(event?.sender?.id);
  const messageId = normalizeTelegramId(event?.message?.id);
  const replyToMessageId = normalizeTelegramId(event?.message?.reply_to_message_id);

  const draft = await createDraft({
    script: scriptSource.loaded ? scriptSource.script : undefined,
    source: {
      platform: 'telegram',
      chat_id: handleCommand.targetChatId,
      user_id: senderId,
      message_id: messageId,
      reply_to_message_id: replyToMessageId,
    },
    callback: {
      url: resolvePublicCallbackUrl(config),
      token: config?.generateVideo?.callbackToken || '',
    },
    baseUrl: config?.generateVideo?.baseUrl || '',
    agentApiToken: config?.generateVideo?.agentApiToken || '',
  });

  if (!draft.ok || !draft.draftToken || !draft.openUrl) {
    return {
      action: 'reply',
      message: buildDraftCreateFailedMessage(),
    };
  }

  await saveDraftContext({
    draftsFile: paths.draftsFile,
    record: {
      draft_token: draft.draftToken,
      chat_id: handleCommand.targetChatId,
      user_id: senderId,
      message_id: messageId,
      reply_to_message_id: replyToMessageId,
      open_url: draft.openUrl,
      requested_at: new Date().toISOString(),
      chat_type: event?.chat?.type || null,
      account_id: config?.telegram?.accountId || 'singularity-video',
      script_source: scriptSource.sourceValue,
      script_source_type: scriptSource.sourceType,
      script_loaded: scriptSource.loaded,
      expires_at: draft.expiresAt,
    },
  });

  return {
    action: 'reply',
    target: {
      account_id: config?.telegram?.accountId || 'singularity-video',
      chat_id: handleCommand.targetChatId,
      reply_to_message_id: replyToMessageId || messageId,
    },
    message: buildDraftCreatedMessage({
      openUrl: draft.openUrl,
      scriptLoaded: scriptSource.loaded,
    }),
  };
}
