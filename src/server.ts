import dotenv from "dotenv";
dotenv.config();

import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { createApp } from "./app/create-app.js";
import { createCommandRunner } from "./runtime/command-runner.js";
import { createCredentialsSyncService } from "./runtime/credentials-sync.js";
import { runDeploymentNotify } from "./runtime/deployment-notify.js";
import { createOpenclawGatewayService } from "./runtime/openclaw-gateway.js";
import { createSpacesSyncService } from "./runtime/spaces-sync.js";

const docsRoot = resolve(process.env.DOCS_ROOT ?? "/tmp/deepflow-assets/docs");
const watchDir = resolve(process.env.WATCH_DIR ?? "/tmp/deepflow-assets");
const syncedOpenclawAssetsDir = resolve(process.env.SYNCED_OPENCLAW_ASSETS_DIR ?? "/tmp/deepflow-assets/openclaw");
const openclawHome = resolve(process.env.OPENCLAW_HOME ?? `${process.env.HOME ?? "/root"}/.openclaw`);
const appAssetsRoot = resolve(process.cwd(), "assets");
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
const docsAuthToken = process.env.DOCS_AUTH_TOKEN ?? "";
const docsProjectAuthFileName = ".docs-auth.json";
const workspaceNames = [
  "singularity-main",
  "singularity-reviewer",
  "singularity-writer",
] as const;

let shuttingDown = false;

const runCommand = createCommandRunner(awsRegion);

const gateway = createOpenclawGatewayService({
  openclawGatewayUrl,
  onUnexpectedExit: (code) => {
    if (!shuttingDown) {
      process.exit(code ?? 1);
    }
  },
});

const spacesSync = createSpacesSyncService({
  watchDir,
  spacesEndpoint,
  s3Uri: `s3://${spacesBucket}/${spacesPrefix}/`,
  syncDebounceMs,
  runCommand,
});

const credentialsSync = createCredentialsSyncService({
  credentialsSource,
  credentialsTargetDir,
  credentialsRestoreSource,
  copyIntervalMs,
});

const app = createApp({
  docsRoot,
  openclawGatewayUrl,
  docsAuthToken,
  docsProjectAuthFileName,
  isGatewayReady: () => gateway.isReady(),
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

  await runCommand("clawchef", ["cook", ".", "-s", "--gateway-mode", "none"], "[openclaw] running clawchef cook");
  await overlayWorkspaceAssets();

  credentialsSync.start();
  if (s3SyncEnabled) {
    spacesSync.startWatcher();
  }

  gateway.start();
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
  await gateway.stop();

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

async function overlayWorkspaceAssets(): Promise<void> {
  for (const workspaceName of workspaceNames) {
    const assetDir = resolve(appAssetsRoot, workspaceName);
    const workspaceDir = resolve(openclawHome, `workspace-${workspaceName}`);

    try {
      await fs.access(assetDir);
      await fs.mkdir(workspaceDir, { recursive: true });
      const entries = await fs.readdir(assetDir);

      for (const entry of entries) {
        await fs.cp(resolve(assetDir, entry), resolve(workspaceDir, entry), {
          recursive: true,
          force: true,
          errorOnExist: false,
        });
      }

      console.log(`[openclaw] workspace asset overlay applied: ${workspaceName}`);
    } catch (error) {
      console.warn(`[openclaw] workspace asset overlay skipped: ${workspaceName} (${String(error)})`);
    }
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
