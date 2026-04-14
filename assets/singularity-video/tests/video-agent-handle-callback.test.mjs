import test from 'node:test';
import assert from 'node:assert/strict';

import { handleGenerateVideoCallback } from '../lib/video-agent-handle-callback.mjs';

test('handleGenerateVideoCallback rejects invalid callback token', async () => {
  const result = await handleGenerateVideoCallback({
    headers: {},
    body: {
      token: 'bad-token',
      event: 'video.job.completed',
      draft_token: 'draft-1',
    },
    expectedToken: 'good-token',
  });

  assert.deepEqual(result, {
    ok: false,
    action: 'reject',
    status: 401,
  });
});

test('handleGenerateVideoCallback builds telegram success reply for completed event', async () => {
  const updates = [];
  const result = await handleGenerateVideoCallback({
    headers: {},
    body: {
      token: 'good-token',
      event: 'video.job.completed',
      draft_token: 'draft-2',
      job_id: 'job-2',
      video_url: 'https://example.com/video.mp4',
      job_page_url: 'https://example.com/job/2',
    },
    expectedToken: 'good-token',
    getDraftContext: async () => ({
      draft_token: 'draft-2',
      chat_id: '-1002',
      reply_to_message_id: '3002',
    }),
    updateDraftContext: async ({ patch }) => {
      updates.push(patch);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'reply');
  assert.equal(result.target.chat_id, '-1002');
  assert.match(result.message, /视频已生成完成/);
  assert.match(result.message, /https:\/\/example.com\/video\.mp4/);
  assert.match(result.message, /https:\/\/example.com\/job\/2/);
  assert.equal(updates[0]?.job_id, 'job-2');
});

test('handleGenerateVideoCallback builds telegram failure reply and includes callback error', async () => {
  const result = await handleGenerateVideoCallback({
    headers: {},
    body: {
      token: 'good-token',
      event: 'video.job.failed',
      draft_token: 'draft-3',
      job_id: 'job-3',
      job_page_url: 'https://example.com/job/3',
      error: '素材解析失败',
    },
    expectedToken: 'good-token',
    getDraftContext: async () => ({
      draft_token: 'draft-3',
      chat_id: '-1003',
      reply_to_message_id: '3003',
    }),
    updateDraftContext: async () => {},
  });

  assert.equal(result.ok, true);
  assert.match(result.message, /视频生成失败/);
  assert.match(result.message, /素材解析失败/);
});

test('handleGenerateVideoCallback logs unknown draft token and skips reply', async () => {
  const logs = [];
  const result = await handleGenerateVideoCallback({
    headers: {},
    body: {
      token: 'good-token',
      event: 'video.job.failed',
      draft_token: 'missing-draft',
      job_id: 'job-4',
      source: {
        platform: 'telegram',
      },
    },
    expectedToken: 'good-token',
    getDraftContext: async () => null,
    updateDraftContext: async () => {},
    appendCallbackLog: async ({ entry }) => {
      logs.push(entry);
    },
  });

  assert.deepEqual(result, {
    ok: true,
    action: 'logged_only',
  });
  assert.equal(logs[0]?.draft_token, 'missing-draft');
  assert.equal(logs[0]?.job_id, 'job-4');
});
