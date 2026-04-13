import dotenv from "dotenv";
dotenv.config();

import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { createApp } from "./app/create-app.js";
import { createCommandRunner } from "./runtime/command-runner.js";
import { createCredentialsSyncService } from "./runtime/credentials-sync.js";
import { runDeploymentNotify } from "./runtime/deployment-notify.js";
import { createSingularitySupervisorManager } from "./runtime/singularity-supervisor-manager.js";
import { createSpacesSyncService } from "./runtime/spaces-sync.js";

const docsRoot = resolve(process.env.DOCS_ROOT ?? "/tmp/deepflow-assets/docs");
const watchDir = resolve(process.env.WATCH_DIR ?? "/tmp/deepflow-assets");
const syncedOpenclawAssetsDir = resolve(process.env.SYNCED_OPENCLAW_ASSETS_DIR ?? "/tmp/deepflow-assets/openclaw");
const spacesBucket = process.env.SPACES_BUCKET ?? "deepflow-test";
const spacesPrefix = trimSlashes(process.env.SPACES_PREFIX ?? "deepflow-assets");
const spacesEndpoint = process.env.SPACES_ENDPOINT ?? "https://ams3.digitaloceanspaces.com";
const awsRegion = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID ?? "";
const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? "";
const s3SyncEnabled = awsAccessKeyId.length > 0 && awsSecretAccessKey.length > 0;
const s3SyncPartiallyConfigured = (awsAccessKeyId.length > 0) !== (awsSecretAccessKey.length > 0);
const credentialsSource = resolve(process.env.CREDENTIALS_SOURCE ?? `${process.env.HOME ?? "/root"}/.openclaw/credentials`);
const credentialsTargetDir = resolve(process.env.CREDENTIALS_TARGET_DIR ?? "/tmp/deepflow-assets/openclaw/credentials");
const credentialsRestoreSource = resolve(process.env.CREDENTIALS_RESTORE_SOURCE ?? `${syncedOpenclawAssetsDir}/credentials`);
const copyIntervalMs = Number.parseInt(process.env.COPY_INTERVAL_SECONDS ?? "60", 10) * 1000;
const syncDebounceMs = Number.parseInt(process.env.SYNC_DEBOUNCE_SECONDS ?? "2", 10) * 1000;
const webPort = Number.parseInt(process.env.WEB_PORT ?? "3000", 10);
const openclawGatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789";
const supervisorProjectsRoot = resolve(process.env.SINGULARITY_PROJECTS_ROOT ?? "/tmp/openclaw-dev-shared/projects");
const supervisorIntervalMs = Number.parseInt(process.env.SINGULARITY_SUPERVISOR_INTERVAL_SECONDS ?? "15", 10) * 1000;
const singularitySupervisorEnabled = process.env.SINGULARITY_SUPERVISOR_ENABLED !== "false";
const docsPublishNotifyAgentId = process.env.SINGULARITY_DOCS_PUBLISH_NOTIFY_AGENT_ID ?? "singularity-video";
const docsAuthToken = process.env.DOCS_AUTH_TOKEN ?? "";
const docsProjectAuthFileName = ".docs-auth.json";

let shuttingDown = false;

const spacesSync = createSpacesSyncService({
  watchDir,
  spacesEndpoint,
  s3Uri: `s3://${spacesBucket}/${spacesPrefix}/`,
  syncDebounceMs,
  runCommand: createCommandRunner(awsRegion),
});

const credentialsSync = createCredentialsSyncService({
  credentialsSource,
  credentialsTargetDir,
  credentialsRestoreSource,
  copyIntervalMs,
});

const singularitySupervisorManager = createSingularitySupervisorManager({
  projectsRoot: supervisorProjectsRoot,
  intervalMs: supervisorIntervalMs,
  docsRoot,
  docsPublishNotifyAgentId,
});

const app = createApp({
  docsRoot,
  openclawGatewayUrl,
  docsAuthToken,
  docsProjectAuthFileName,
});

async function main(): Promise<void> {
  await fs.mkdir(docsRoot, { recursive: true });
  await fs.mkdir(watchDir, { recursive: true });
  await fs.mkdir(syncedOpenclawAssetsDir, { recursive: true });

  if (!s3SyncEnabled) {
    if (s3SyncPartiallyConfigured) {
      console.warn("[spaces-sync] disabled: both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required to enable S3 sync");
    } else {
      console.log("[spaces-sync] disabled: AWS credentials not configured");
    }
  }

  const server = app.listen(webPort, () => {
    console.log(`[server] listening on ${webPort}`);
  });

  process.on("SIGINT", () => {
    void shutdown(server);
  });
  process.on("SIGTERM", () => {
    void shutdown(server);
  });

  if (s3SyncEnabled) {
    await spacesSync.bootstrapFromS3();
    await credentialsSync.restoreFromSyncedAssets();
  }

  credentialsSync.start();
  if (s3SyncEnabled) {
    spacesSync.startWatcher();
  }
  if (singularitySupervisorEnabled) {
    singularitySupervisorManager.start();
    void singularitySupervisorManager.runNow();
  }

  void runNotifyIfConfigured();
}

async function shutdown(server: ReturnType<typeof app.listen>): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log("[server] shutting down");

  credentialsSync.stop();
  await spacesSync.stopWatcher();
  singularitySupervisorManager.stop();

  server.close(() => {
    process.exit(0);
  });
}

async function runNotifyIfConfigured(): Promise<void> {
  const token = process.env.TELEGRAM_NOTIFY_BOT_TOKEN;
  if (!token) {
    console.log("[deployment-notify] TELEGRAM_NOTIFY_BOT_TOKEN not set, skip");
    return;
  }

  const chatId = process.env.TELEGRAM_NOTIFY_CHAT_ID;
  if (!chatId) {
    console.log("[deployment-notify] TELEGRAM_NOTIFY_CHAT_ID not set, skip");
    return;
  }

  await runDeploymentNotify({
    token,
    chatId,
    healthUrl: process.env.DEPLOYMENT_HEALTH_URL ?? "http://127.0.0.1:18789/health",
    intervalMs: Number.parseInt(process.env.DEPLOYMENT_NOTIFY_INTERVAL_SECONDS ?? "5", 10) * 1000,
    maxAttempts: Number.parseInt(process.env.DEPLOYMENT_NOTIFY_MAX_ATTEMPTS ?? "120", 10),
    text: process.env.DEPLOYMENT_NOTIFY_TEXT ?? `OpenClaw gateway is healthy on ${process.env.HOSTNAME ?? "unknown-host"}`,
  });
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+/, "").replace(/\/+$/, "");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
