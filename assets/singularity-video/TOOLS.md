# TOOLS.md - Video Agent Tools

## Runtime Paths

- Config: `config/video-agent-config.json`
- Draft store: `drafts.json`
- Callback log: `runtime/callback-log.jsonl`
- Flow handler: `bin/video-agent-handle-flow.mjs`
- Callback handler: `bin/video-agent-handle-callback.mjs`
- Callback server: `bin/video-agent-callback-server.mjs`

## Required Runtime Config

The operator must provide:

- generate-video base URL
- generate-video agent API token
- public callback URL reachable from generate-video
- callback verification token
- optional script source
- optional callback server host/port/path override

## Script Source

`/handle <chat_id> <source>` provides the Telegram reply target and script source.

Example:

```text
/handle -1001234567890 https://example.com/final-script.txt
```

Supported source values:

- local file path
- HTTP/HTTPS URL returning script text

Normal user conversation does not use `scriptSource` and does not create a draft. It returns `generateVideo.websiteUrl` for manual entry.

The `<chat_id>` value must be saved in the draft context. Callback notifications use that saved chat ID, not the OpenClaw message context that delivered `/handle`.

## Callback Server

- The local callback server listens on `callbackServer.host` + `callbackServer.port`.
- The request path is `callbackServer.path`.
- `generateVideo.publicCallbackUrl` is the URL sent to generate-video.
- In Docker-based local development, `publicCallbackUrl` can use `host.docker.internal` while the server still listens on `127.0.0.1`.
- After validating the token, it sends the result back to Telegram with `openclaw message send`.

## Telegram Behavior

- Groups require explicit mention.
- DMs respond directly.
- Successful draft creation returns `open_url`.
- Final video success or failure is delivered only via callback-driven notification.
