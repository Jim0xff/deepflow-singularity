# Deepflow Singularity

`deepflow-singularity` is a stripped-down OpenClaw deployment scaffold for a three-agent writing workflow:

- `singularity-main`
- `singularity-reviewer`
- `singularity-writer`

It keeps the useful parts of the original Deepflow project:

- `recipe.yaml` based OpenClaw provisioning
- local dev reload via `scripts/dev.mjs`
- Docker Compose deployment
- self-hosted GitHub Actions deployment
- nginx config generation
- optional credentials sync and Spaces sync

It intentionally removes the original product/frontend/backend/QA orchestration from the active configuration.

For the imported singularity agents, the shared project state directory is mounted into the container at both `/tmp/openclaw-dev-shared` and `/.openclaw/shared` so the original SOP paths continue to work.

## Agent Asset Sources

The current assets were seeded from local OpenClaw workspaces:

- `workspace-adversary` -> `assets/singularity-main`
- `workspace-adversary2` -> `assets/singularity-reviewer`
- `workspace-editor` -> `assets/singularity-writer`

## Local Development

Install dependencies:

```bash
npm install
```

Prepare `.env` from `.env.example`, then run:

```bash
npm run dev
```

This will:

- run `clawchef cook`
- overlay `assets/singularity-*` into `~/.openclaw/workspace-singularity-*`
- start `openclaw gateway`

In Docker deployments, the container start script is responsible for OpenClaw runtime setup: it runs `clawchef cook`, overlays workspace assets into `/root/.openclaw/workspace-*`, starts `openclaw gateway`, and only then hands off long-running `server.js` supervision to `supervisord`. `server.ts` itself does not cook or launch gateway. Only shared project data is bind-mounted; `/root/.openclaw` itself is left unmanaged so `clawchef cook` can rebuild it safely.

## Environment Variables

Primary variables:

- `CLAWCHEF_VAR_OPENAI_API_KEY`
- `CLAWCHEF_VAR_AGENT_MODEL`
- `CLAWCHEF_VAR_FINAL_WRITER_MODEL`
- `GEMINI_API_KEY`
- `CLAWCHEF_VAR_SINGULARITY_MAIN_TELEGRAM_BOT_KEY`
- `CLAWCHEF_VAR_SINGULARITY_REVIEWER_TELEGRAM_BOT_KEY`
- `CLAWCHEF_VAR_SINGULARITY_WRITER_TELEGRAM_BOT_KEY`

Optional deployment/runtime variables:

- `TELEGRAM_NOTIFY_BOT_TOKEN`
- `TELEGRAM_NOTIFY_CHAT_ID`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `HOST_DEEPFLOW_ASSETS_DIR`
- `HOST_OPENCLAW_DEV_SHARED_DIR`
- `HOST_CODEX_DIR`

## Deployment

The deployment workflow lives at [deploy.yml](./.github/workflows/deploy.yml).

It expects a self-hosted GitHub Actions runner on the target host and uses:

- repo checkout path: `/opt/deepflow-singularity/<branch>`
- deployment config: `/opt/deepflow-singularity-config/config.yaml`
- nginx conf dir: `/etc/nginx/conf.d/deepflow-singularity`

Each branch can map to its own domain/port/env block inside that YAML config.
The `main` branch currently auto-deploys to `188.166.52.45`.

For current OpenClaw builds, plan for at least `8 GB RAM` on production hosts. `4 GB` instances can start, but factory reset, workspace rebuild, plugin enablement, and gateway recovery are much more likely to hit memory pressure during deployment.

## Supervisor

A generic supervisor core now lives under:

- `scripts/supervisor/core.mjs`
- `scripts/supervisor/adapters/singularity-flow.mjs`

The design is:

- `core.mjs`: reusable start/watch runtime, PID handling, polling, dispatch dedupe
- adapter: flow-specific state machine

Start the singularity flow supervisor with:

```bash
npm run supervisor:singularity -- start --project-dir /.openclaw/shared/projects/<project_id>
```

The first adapter only automates:

- `step_5_debate` handoff between `reviewer` and `main`
- `step_7_drafting` loop between `writer`, `reviewer`, and `main`

The server also runs a lightweight manager that scans the shared projects root and ensures a supervisor is started for any project whose `status.md` is in `workflow_mode=auto` and currently at `step_5_debate` or `step_7_drafting`.
The same manager also publishes `output.md` to docs-manager after `main` marks a human-approved article with `docs_publish_requested=yes`.

## Test

Run the current smoke test with:

```bash
npm test
```
