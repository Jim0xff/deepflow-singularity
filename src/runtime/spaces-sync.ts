import chokidar, { type FSWatcher } from "chokidar";
import type { CommandRunner } from "./command-runner.js";

type SpacesSyncOptions = {
  watchDir: string;
  spacesEndpoint: string;
  s3Uri: string;
  syncDebounceMs: number;
  runCommand: CommandRunner;
};

export type SpacesSyncService = {
  bootstrapFromS3: () => Promise<void>;
  startWatcher: () => void;
  stopWatcher: () => Promise<void>;
};

export function createSpacesSyncService(options: SpacesSyncOptions): SpacesSyncService {
  let syncWatcher: FSWatcher | null = null;
  let pendingSyncTimer: NodeJS.Timeout | null = null;
  let isSyncing = false;
  let syncRequestedWhileRunning = false;

  async function bootstrapFromS3(): Promise<void> {
    await options.runCommand(
      "aws",
      [
        "s3",
        "sync",
        options.s3Uri,
        options.watchDir,
        "--endpoint-url",
        options.spacesEndpoint,
        "--delete",
        "--only-show-errors",
      ],
      "[spaces-sync] bootstrap sync from S3",
    );
  }

  function startWatcher(): void {
    if (syncWatcher) {
      return;
    }

    syncWatcher = chokidar.watch(options.watchDir, { ignoreInitial: true, persistent: true });
    syncWatcher.on("all", () => {
      scheduleSyncToS3();
    });
    console.log(`[spaces-sync] watching ${options.watchDir}`);
  }

  async function stopWatcher(): Promise<void> {
    if (pendingSyncTimer) {
      clearTimeout(pendingSyncTimer);
      pendingSyncTimer = null;
    }

    if (!syncWatcher) {
      return;
    }

    await syncWatcher.close();
    syncWatcher = null;
  }

  function scheduleSyncToS3(): void {
    if (pendingSyncTimer) {
      clearTimeout(pendingSyncTimer);
    }
    pendingSyncTimer = setTimeout(() => {
      void syncToS3();
    }, options.syncDebounceMs);
  }

  async function syncToS3(): Promise<void> {
    if (isSyncing) {
      syncRequestedWhileRunning = true;
      return;
    }
    isSyncing = true;

    try {
      await options.runCommand(
        "aws",
        [
          "s3",
          "sync",
          options.watchDir,
          options.s3Uri,
          "--endpoint-url",
          options.spacesEndpoint,
          "--delete",
          "--only-show-errors",
        ],
        "[spaces-sync] sync to S3",
      );
    } finally {
      isSyncing = false;
      if (syncRequestedWhileRunning) {
        syncRequestedWhileRunning = false;
        scheduleSyncToS3();
      }
    }
  }

  return {
    bootstrapFromS3,
    startWatcher,
    stopWatcher,
  };
}
