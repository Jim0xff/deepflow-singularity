import chokidar, { type FSWatcher } from "chokidar";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { buildHandoffSessionId, parseHandoffFile, parseOwnerNotifyFile, selectBindingIdForProject } from "./core.js";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type HandoffNotifierOptions = {
  docsRoot: string;
  debounceMs?: number;
  runAgentCommand: (agentId: string, message: string, sessionId: string) => Promise<void>;
  runOwnerNotify?: (params: {
    actionType: "status_updated" | "demo_updated";
    projectId: string;
    bindingId: string;
    relativePath: string;
    filePath: string;
    beforeContent: string;
  }) => Promise<void>;
  logger?: Logger;
};

export type HandoffNotifier = {
  start: () => void;
  stop: () => Promise<void>;
};

const defaultLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export function createHandoffNotifier(options: HandoffNotifierOptions): HandoffNotifier {
  const debounceMs = options.debounceMs ?? 800;
  const logger = options.logger ?? defaultLogger;
  let watcher: FSWatcher | null = null;
  const timers = new Map<string, { timer: NodeJS.Timeout; eventType: "add" | "change" }>();
  const fileSnapshots = new Map<string, string>();

  function start(): void {
    if (watcher) {
      return;
    }

    const watchRoot = join(options.docsRoot, "projects");

    watcher = chokidar.watch(watchRoot, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50,
      },
    });

    watcher.on("add", (filePath) => {
      schedule(filePath, "add");
    });

    watcher.on("change", (filePath) => {
      schedule(filePath, "change");
    });

    logger.info(`[handoff-notify] watching ${watchRoot}`);
    void preloadOwnerNotifySnapshots(watchRoot);
  }

  async function stop(): Promise<void> {
    for (const pending of timers.values()) {
      clearTimeout(pending.timer);
    }
    timers.clear();

    if (!watcher) {
      return;
    }

    await watcher.close();
    watcher = null;
  }

  function schedule(changedPath: string, eventType: "add" | "change"): void {
    const pending = timers.get(changedPath);
    if (pending) {
      clearTimeout(pending.timer);
    }

    const nextTimer = setTimeout(() => {
      const nextPending = timers.get(changedPath);
      timers.delete(changedPath);
      void handleChangedPath(changedPath, nextPending?.eventType ?? eventType);
    }, debounceMs);

    timers.set(changedPath, { timer: nextTimer, eventType });
  }

  async function handleChangedPath(changedPath: string, eventType: "add" | "change"): Promise<void> {
    const handoffParsed = parseHandoffFile(changedPath, options.docsRoot);
    const ownerNotifyParsed = parseOwnerNotifyFile(changedPath, options.docsRoot);
    if (!handoffParsed && !ownerNotifyParsed) {
      return;
    }

    const content = await readFileContent(changedPath);
    if (!content || content.trim().length === 0) {
      const parsed = handoffParsed ?? ownerNotifyParsed;
      if (ownerNotifyParsed) {
        fileSnapshots.set(changedPath, content ?? "");
      }
      logger.info(`[handoff-notify] skip empty handoff/receipt: ${parsed?.projectId}/${parsed?.relativePath}`);
      return;
    }

    const parsed = handoffParsed ?? ownerNotifyParsed;
    if (!parsed) {
      return;
    }
    const bindingId = await resolveBindingIdForProject(parsed.projectId);
    if (!bindingId) {
      if (ownerNotifyParsed) {
        fileSnapshots.set(changedPath, content);
      }
      logger.warn(`[handoff-notify] no binding found for project ${parsed.projectId}, skip ${parsed.relativePath}`);
      return;
    }

    if (handoffParsed) {
      const sessionId = buildHandoffSessionId(handoffParsed.projectId, handoffParsed.agentId);
      const message = `/handle ${handoffParsed.projectId} ${bindingId} ${handoffParsed.relativePath}`;

      try {
        await options.runAgentCommand(handoffParsed.agentId, message, sessionId);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[handoff-notify] failed to notify ${handoffParsed.agentId}: ${errorMessage}`);
      }
      return;
    }

    if (!ownerNotifyParsed || !options.runOwnerNotify) {
      if (ownerNotifyParsed) {
        fileSnapshots.set(changedPath, content);
      }
      return;
    }

    const beforeContent = fileSnapshots.get(changedPath) ?? "";
    fileSnapshots.set(changedPath, content);

    if (beforeContent === content) {
      return;
    }
    if (eventType === "change" && beforeContent.length === 0) {
      logger.info(`[handoff-notify] skip owner-notify without prior snapshot: ${ownerNotifyParsed.projectId}/${ownerNotifyParsed.relativePath}`);
      return;
    }

    try {
      await options.runOwnerNotify({
        actionType: ownerNotifyParsed.actionType,
        projectId: ownerNotifyParsed.projectId,
        bindingId,
        relativePath: ownerNotifyParsed.relativePath,
        filePath: changedPath,
        beforeContent,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[handoff-notify] failed to run owner-notify for ${ownerNotifyParsed.relativePath}: ${errorMessage}`);
    }
  }

  async function readFileContent(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      return null;
    }
  }

  async function resolveBindingIdForProject(projectId: string): Promise<string | null> {
    const bindingsPath = join(options.docsRoot, "projects.json");
    let raw: string;

    try {
      raw = (await fs.readFile(bindingsPath, "utf8")).trim();
    } catch {
      return null;
    }

    if (!raw) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn("[handoff-notify] invalid projects.json, skip");
      return null;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return selectBindingIdForProject(parsed as Record<string, unknown>, projectId);
  }

  async function preloadOwnerNotifySnapshots(root: string): Promise<void> {
    const ownerRelativePaths = new Set(["00_meta/project_status.md", "05_delivery/current_demo.md"]);
    const stack = [root];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }

      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }

        const parsed = parseOwnerNotifyFile(fullPath, options.docsRoot);
        if (!parsed || !ownerRelativePaths.has(parsed.relativePath)) {
          continue;
        }

        const content = await readFileContent(fullPath);
        if (content !== null) {
          fileSnapshots.set(fullPath, content);
        }
      }
    }
  }

  return {
    start,
    stop,
  };
}
