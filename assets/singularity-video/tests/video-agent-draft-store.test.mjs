import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  appendCallbackLog,
  getDraftContext,
  saveDraftContext,
  updateDraftContext,
} from '../lib/video-agent-draft-store.mjs';

async function createPaths() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-agent-store-'));
  return {
    draftsFile: path.join(tempDir, 'drafts.json'),
    callbackLogFile: path.join(tempDir, 'callback-log.jsonl'),
  };
}

test('saveDraftContext persists a new mapping and getDraftContext reads it back', async () => {
  const paths = await createPaths();

  await saveDraftContext({
    draftsFile: paths.draftsFile,
    record: {
      draft_token: 'draft-1',
      chat_id: '1001',
      user_id: '2002',
      message_id: '3003',
      reply_to_message_id: '4004',
      open_url: 'https://example.com/open',
      requested_at: '2026-03-26T12:00:00.000Z',
    },
  });

  const record = await getDraftContext({
    draftsFile: paths.draftsFile,
    draftToken: 'draft-1',
  });

  assert.equal(record?.chat_id, '1001');
  assert.equal(record?.open_url, 'https://example.com/open');
});

test('updateDraftContext patches an existing record', async () => {
  const paths = await createPaths();

  await saveDraftContext({
    draftsFile: paths.draftsFile,
    record: {
      draft_token: 'draft-2',
      chat_id: '1001',
      user_id: '2002',
      message_id: '3003',
      reply_to_message_id: null,
      open_url: 'https://example.com/open',
      requested_at: '2026-03-26T12:00:00.000Z',
    },
  });

  await updateDraftContext({
    draftsFile: paths.draftsFile,
    draftToken: 'draft-2',
    patch: {
      last_event: 'video.job.completed',
      job_id: 'job-9',
    },
  });

  const record = await getDraftContext({
    draftsFile: paths.draftsFile,
    draftToken: 'draft-2',
  });

  assert.equal(record?.last_event, 'video.job.completed');
  assert.equal(record?.job_id, 'job-9');
});

test('saveDraftContext preserves existing records across multiple writes', async () => {
  const paths = await createPaths();

  await saveDraftContext({
    draftsFile: paths.draftsFile,
    record: {
      draft_token: 'draft-a',
      chat_id: '1',
      user_id: '2',
      message_id: '3',
      reply_to_message_id: null,
      open_url: 'https://example.com/a',
      requested_at: '2026-03-26T12:00:00.000Z',
    },
  });
  await saveDraftContext({
    draftsFile: paths.draftsFile,
    record: {
      draft_token: 'draft-b',
      chat_id: '4',
      user_id: '5',
      message_id: '6',
      reply_to_message_id: null,
      open_url: 'https://example.com/b',
      requested_at: '2026-03-26T12:01:00.000Z',
    },
  });

  const recordA = await getDraftContext({
    draftsFile: paths.draftsFile,
    draftToken: 'draft-a',
  });
  const recordB = await getDraftContext({
    draftsFile: paths.draftsFile,
    draftToken: 'draft-b',
  });

  assert.equal(recordA?.open_url, 'https://example.com/a');
  assert.equal(recordB?.open_url, 'https://example.com/b');
});

test('appendCallbackLog writes json lines for diagnostics', async () => {
  const paths = await createPaths();

  await appendCallbackLog({
    callbackLogFile: paths.callbackLogFile,
    entry: {
      event: 'video.job.failed',
      draft_token: 'draft-x',
    },
  });

  const content = await fs.readFile(paths.callbackLogFile, 'utf8');
  assert.match(content, /"event":"video.job.failed"/);
  assert.match(content, /"draft_token":"draft-x"/);
});
