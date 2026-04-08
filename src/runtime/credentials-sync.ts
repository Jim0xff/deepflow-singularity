import { promises as fs } from "node:fs";
import { directoryFingerprint, mapsEqual, statOrNull } from "./fs-fingerprint.js";

type CredentialsSyncOptions = {
  credentialsSource: string;
  credentialsTargetDir: string;
  credentialsRestoreSource: string;
  copyIntervalMs: number;
};

export type CredentialsSyncService = {
  restoreFromSyncedAssets: () => Promise<void>;
  start: () => void;
  stop: () => void;
};

export function createCredentialsSyncService(options: CredentialsSyncOptions): CredentialsSyncService {
  let credentialsTimer: NodeJS.Timeout | null = null;

  async function restoreFromSyncedAssets(): Promise<void> {
    const sourceStat = await statOrNull(options.credentialsRestoreSource);
    if (!sourceStat?.isDirectory()) {
      console.log(`[credentials-restore] source not found, skip: ${options.credentialsRestoreSource}`);
      return;
    }

    const sourceMap = await directoryFingerprint(options.credentialsRestoreSource);
    const targetMap = await directoryFingerprint(options.credentialsSource);
    if (mapsEqual(sourceMap, targetMap)) {
      console.log("[credentials-restore] no changes, skip restore");
      return;
    }

    await fs.rm(options.credentialsSource, { recursive: true, force: true });
    await fs.mkdir(options.credentialsSource, { recursive: true });
    await fs.cp(options.credentialsRestoreSource, options.credentialsSource, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });
    console.log("[credentials-restore] restored credentials from synced assets");
  }

  function start(): void {
    if (credentialsTimer) {
      return;
    }

    void syncCredentialsOnce();
    credentialsTimer = setInterval(() => {
      void syncCredentialsOnce();
    }, options.copyIntervalMs);
  }

  function stop(): void {
    if (!credentialsTimer) {
      return;
    }
    clearInterval(credentialsTimer);
    credentialsTimer = null;
  }

  async function syncCredentialsOnce(): Promise<void> {
    const sourceStat = await statOrNull(options.credentialsSource);
    if (!sourceStat?.isDirectory()) {
      return;
    }

    const sourceMap = await directoryFingerprint(options.credentialsSource);
    const targetMap = await directoryFingerprint(options.credentialsTargetDir);
    if (mapsEqual(sourceMap, targetMap)) {
      console.log("[credentials-sync] no changes, skip copy");
      return;
    }

    await fs.rm(options.credentialsTargetDir, { recursive: true, force: true });
    await fs.mkdir(options.credentialsTargetDir, { recursive: true });
    await fs.cp(options.credentialsSource, options.credentialsTargetDir, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });
    console.log("[credentials-sync] copied credentials to asset directory");
  }

  return {
    restoreFromSyncedAssets,
    start,
    stop,
  };
}
