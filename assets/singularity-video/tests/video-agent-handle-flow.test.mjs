import test from 'node:test';
import assert from 'node:assert/strict';

import { handleVideoAgentFlow } from '../lib/video-agent-handle-flow.mjs';

test('handleVideoAgentFlow ignores group message without mention', async () => {
  const result = await handleVideoAgentFlow({
    event: {
      chat: {
        id: '-1001',
        type: 'group',
      },
      sender: {
        id: '2001',
      },
      message: {
        id: '3001',
        text: '随便说一句',
      },
      mention: false,
    },
  });

  assert.deepEqual(result, {
    action: 'no_reply',
  });
});

test('handleVideoAgentFlow returns website url for normal group mention without creating draft', async () => {
  let createDraftCalled = false;
  const result = await handleVideoAgentFlow({
    event: {
      chat: {
        id: '-1002',
        type: 'group',
      },
      sender: {
        id: '2002',
      },
      message: {
        id: '3002',
        text: '@video-agent 生成视频',
        reply_to_message_id: '3999',
      },
      mention: true,
    },
    runtimeConfig: {
      generateVideo: {
        publicCallbackUrl: 'http://host.docker.internal:9000/hooks/video-job',
        callbackToken: 'token-1',
        websiteUrl: 'https://generate-video-gamma.vercel.app/',
      },
      telegram: {
        accountId: 'video-agent',
      },
    },
    createDraft: async () => {
      createDraftCalled = true;
      throw new Error('should not create draft for normal mention');
    },
    saveDraftContext: async () => {},
  });

  assert.equal(result.action, 'reply');
  assert.match(result.message, /https:\/\/generate-video-gamma\.vercel\.app\//);
  assert.equal(createDraftCalled, false);
});

test('handleVideoAgentFlow creates draft from /handle source override', async () => {
  const sourceCalls = [];
  const draftCalls = [];
  const result = await handleVideoAgentFlow({
    event: {
      chat: {
        id: '1005',
        type: 'direct',
      },
      sender: {
        id: '2005',
      },
      message: {
        id: '3005',
        text: '/handle https://example.com/final-script.txt',
      },
      mention: false,
    },
    runtimeConfig: {
      generateVideo: {
        publicCallbackUrl: 'http://host.docker.internal:9000/hooks/video-job',
        callbackToken: 'token-1',
        websiteUrl: 'https://generate-video-gamma.vercel.app/',
      },
      telegram: {
        accountId: 'video-agent',
      },
    },
    loadScriptSource: async ({ scriptSource }) => {
      sourceCalls.push(scriptSource);
      return {
        loaded: true,
        sourceType: 'url',
        sourceValue: scriptSource.value,
        script: '上游最终文案',
        error: null,
      };
    },
    createDraft: async (payload) => {
      draftCalls.push(payload);
      return {
        ok: true,
        status: 200,
        draftToken: 'draft-handle',
        openUrl: 'https://example.com/open/handle',
        expiresAt: '2026-04-13T00:00:00.000Z',
        error: null,
      };
    },
    saveDraftContext: async () => {},
  });

  assert.deepEqual(sourceCalls[0], {
    type: '',
    value: 'https://example.com/final-script.txt',
  });
  assert.equal(draftCalls[0]?.script, '上游最终文案');
  assert.equal(result.action, 'reply');
  assert.match(result.message, /文案已自动填好/);
  assert.match(result.message, /https:\/\/example.com\/open\/handle/);
});

test('handleVideoAgentFlow returns website url without creating draft for normal direct chat', async () => {
  let createDraftCalled = false;
  const result = await handleVideoAgentFlow({
    event: {
      chat: {
        id: '1003',
        type: 'direct',
      },
      sender: {
        id: '2003',
      },
      message: {
        id: '3003',
        text: '帮我生成视频',
      },
      mention: false,
    },
    loadScriptSource: async () => ({
      loaded: true,
      sourceType: 'file',
      sourceValue: '/tmp/ignored.txt',
      script: '不应该用于普通对话',
      error: null,
    }),
    runtimeConfig: {
      generateVideo: {
        websiteUrl: 'https://generate-video-gamma.vercel.app/',
      },
    },
    createDraft: async () => {
      createDraftCalled = true;
      throw new Error('should not create draft for normal chat');
    },
    saveDraftContext: async () => {},
  });

  assert.equal(result.action, 'reply');
  assert.match(result.message, /打开链接后请填写文案/);
  assert.match(result.message, /https:\/\/generate-video-gamma\.vercel\.app\//);
  assert.equal(createDraftCalled, false);
});

test('handleVideoAgentFlow responds to direct hi with website url', async () => {
  const result = await handleVideoAgentFlow({
    event: {
      chat: {
        id: '1006',
        type: 'direct',
      },
      sender: {
        id: '2006',
      },
      message: {
        id: '3006',
        text: 'hi',
      },
      mention: false,
    },
    runtimeConfig: {
      generateVideo: {
        websiteUrl: 'https://generate-video-gamma.vercel.app/',
      },
    },
  });

  assert.equal(result.action, 'reply');
  assert.match(result.message, /https:\/\/generate-video-gamma\.vercel\.app\//);
});

test('handleVideoAgentFlow returns failure message when draft creation fails', async () => {
  const result = await handleVideoAgentFlow({
    event: {
      chat: {
        id: '1004',
        type: 'direct',
      },
      sender: {
        id: '2004',
      },
      message: {
        id: '3004',
        text: '/handle /tmp/final-script.txt',
      },
      mention: false,
    },
    loadScriptSource: async () => ({
      loaded: false,
      sourceType: null,
      sourceValue: null,
      script: null,
      error: null,
    }),
    runtimeConfig: {
      generateVideo: {
        publicCallbackUrl: 'http://host.docker.internal:9000/hooks/video-job',
        callbackToken: 'token-1',
      },
      telegram: {
        accountId: 'singularity-video',
      },
    },
    createDraft: async () => ({
      ok: false,
      status: 500,
      draftToken: null,
      openUrl: null,
      expiresAt: null,
      error: 'boom',
    }),
    saveDraftContext: async () => {
      throw new Error('should not save on failure');
    },
  });

  assert.deepEqual(result, {
    action: 'reply',
    message: '生成入口创建失败，请稍后重试',
  });
});
