import {
  appendCallbackLog as defaultAppendCallbackLog,
  getDraftContext as defaultGetDraftContext,
  updateDraftContext as defaultUpdateDraftContext,
} from './video-agent-draft-store.mjs';
import {
  buildCallbackCompletedMessage,
  buildCallbackFailedMessage,
} from './video-agent-message-templates.mjs';
import { getVideoAgentPaths } from './video-agent-paths.mjs';

function extractCallbackToken({ headers = {}, body = {} }) {
  return headers['x-callback-token']
    || headers['x-video-agent-token']
    || body.token
    || null;
}

export async function handleGenerateVideoCallback({
  headers = {},
  body = {},
  expectedToken,
  getDraftContext = defaultGetDraftContext,
  updateDraftContext = defaultUpdateDraftContext,
  appendCallbackLog = defaultAppendCallbackLog,
} = {}) {
  const token = extractCallbackToken({ headers, body });
  if (!expectedToken || token !== expectedToken) {
    return {
      ok: false,
      action: 'reject',
      status: 401,
    };
  }

  const paths = getVideoAgentPaths();
  const draftToken = body.draft_token || null;
  const context = await getDraftContext({
    draftsFile: paths.draftsFile,
    draftToken,
  });

  if (!context) {
    await appendCallbackLog({
      callbackLogFile: paths.callbackLogFile,
      entry: {
        received_at: new Date().toISOString(),
        event: body.event || null,
        draft_token: draftToken,
        job_id: body.job_id || null,
        source: body.source || null,
      },
    });
    return {
      ok: true,
      action: 'logged_only',
    };
  }

  await updateDraftContext({
    draftsFile: paths.draftsFile,
    draftToken,
    patch: {
      last_event: body.event || null,
      last_event_at: new Date().toISOString(),
      last_error: body.error || null,
      job_id: body.job_id || null,
    },
  });

  if (body.event === 'video.job.completed') {
    return {
      ok: true,
      action: 'reply',
      target: {
        chat_id: context.chat_id,
        reply_to_message_id: context.reply_to_message_id || context.message_id || null,
      },
      message: buildCallbackCompletedMessage({
        videoUrl: body.video_url,
        jobPageUrl: body.job_page_url,
      }),
    };
  }

  return {
    ok: true,
    action: 'reply',
    target: {
      chat_id: context.chat_id,
      reply_to_message_id: context.reply_to_message_id || context.message_id || null,
    },
    message: buildCallbackFailedMessage({
      jobPageUrl: body.job_page_url,
      error: body.error || null,
    }),
  };
}
