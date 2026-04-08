import { promises as fs } from "node:fs";
import { join } from "node:path";
import { selectBindingIdForProject } from "../handoff-notify/core.js";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type ProjectBinding = {
  projectId: string;
  bindingId: string;
};

type FollowupState = {
  lastVisibleAt: number;
  lastVisibilityGapFollowupForVisibleAt: number;
  lastReceiptTimeoutFollowupForVisibleAt: number;
};

type PmFollowupSchedulerOptions = {
  docsRoot: string;
  intervalMs: number;
  staleMs: number;
  receiptTimeoutMs?: number;
  runFollowup: (params: {
    projectId: string;
    bindingId: string;
    projectStatusPath: string;
    reason: "visibility_gap" | "receipt_timeout";
    waitingRoles: Array<"frontend" | "backend">;
  }) => Promise<void>;
  logger?: Logger;
  now?: () => number;
  readProjectBindings?: () => Promise<ProjectBinding[]>;
  readFile?: (filePath: string) => Promise<string | null>;
};

export type PmFollowupScheduler = {
  start: () => void;
  stop: () => void;
  noteVisibleEvent: (projectId: string) => void;
  runNow: () => Promise<void>;
};

const defaultLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export function createPmFollowupScheduler(options: PmFollowupSchedulerOptions): PmFollowupScheduler {
  const logger = options.logger ?? defaultLogger;
  const now = options.now ?? (() => Date.now());
  const states = new Map<string, FollowupState>();
  let timer: NodeJS.Timeout | null = null;

  function start(): void {
    if (timer) {
      return;
    }
    timer = setInterval(() => {
      void runNow();
    }, options.intervalMs);
  }

  function stop(): void {
    if (!timer) {
      return;
    }
    clearInterval(timer);
    timer = null;
  }

  function noteVisibleEvent(projectId: string): void {
    states.set(projectId, {
      lastVisibleAt: now(),
      lastVisibilityGapFollowupForVisibleAt: 0,
      lastReceiptTimeoutFollowupForVisibleAt: 0,
    });
  }

  async function runNow(): Promise<void> {
    const bindings = await loadProjectBindings();
    const currentNow = now();

    for (const { projectId, bindingId } of bindings) {
      const projectStatusPath = join(options.docsRoot, "projects", projectId, "00_meta", "project_status.md");
      const content = await readText(projectStatusPath);
      if (!content) {
        continue;
      }

      const meta = parseFrontmatter(content);
      if (!isEligibleStage(String(meta.stage || ""))) {
        continue;
      }

      const state = states.get(projectId);
      if (!state) {
        states.set(projectId, {
          lastVisibleAt: currentNow,
          lastVisibilityGapFollowupForVisibleAt: 0,
          lastReceiptTimeoutFollowupForVisibleAt: 0,
        });
        continue;
      }

      const waitingRoles = getWaitingRoles(meta);
      const receiptTimeoutMs = options.receiptTimeoutMs ?? options.staleMs;

      try {
        if (
          waitingRoles.length > 0 &&
          currentNow - state.lastVisibleAt >= receiptTimeoutMs &&
          state.lastReceiptTimeoutFollowupForVisibleAt < state.lastVisibleAt
        ) {
          await options.runFollowup({
            projectId,
            bindingId,
            projectStatusPath,
            reason: "receipt_timeout",
            waitingRoles,
          });
          states.set(projectId, {
            lastVisibleAt: currentNow,
            lastVisibilityGapFollowupForVisibleAt: state.lastVisibilityGapFollowupForVisibleAt,
            lastReceiptTimeoutFollowupForVisibleAt: currentNow,
          });
          continue;
        }

        if (
          currentNow - state.lastVisibleAt >= options.staleMs &&
          state.lastVisibilityGapFollowupForVisibleAt < state.lastVisibleAt
        ) {
          await options.runFollowup({
            projectId,
            bindingId,
            projectStatusPath,
            reason: "visibility_gap",
            waitingRoles,
          });
          states.set(projectId, {
            lastVisibleAt: currentNow,
            lastVisibilityGapFollowupForVisibleAt: currentNow,
            lastReceiptTimeoutFollowupForVisibleAt: state.lastReceiptTimeoutFollowupForVisibleAt,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[pm-followup] failed for ${projectId}: ${message}`);
      }
    }
  }

  async function loadProjectBindings(): Promise<ProjectBinding[]> {
    if (options.readProjectBindings) {
      return options.readProjectBindings();
    }

    const bindingsPath = join(options.docsRoot, "projects.json");
    const raw = await readText(bindingsPath);
    if (!raw) {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn("[pm-followup] invalid projects.json, skip");
      return [];
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }

    const projectIds = [...new Set(Object.values(parsed as Record<string, unknown>).filter((value) => typeof value === "string"))] as string[];
    return projectIds
      .map((projectId) => {
        const bindingId = selectBindingIdForProject(parsed as Record<string, unknown>, projectId);
        return bindingId ? { projectId, bindingId } : null;
      })
      .filter((item): item is ProjectBinding => item !== null);
  }

  async function readText(filePath: string): Promise<string | null> {
    if (options.readFile) {
      return options.readFile(filePath);
    }
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      return null;
    }
  }

  return {
    start,
    stop,
    noteVisibleEvent,
    runNow,
  };
}

function parseFrontmatter(markdown: string): Record<string, string> {
  const text = String(markdown || "");
  if (!text.startsWith("---\n")) {
    return {};
  }
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) {
    return {};
  }

  const result: Record<string, string> = {};
  const block = text.slice(4, end).trim();
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const idx = line.indexOf(":");
    if (idx === -1) {
      continue;
    }
    result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

function isEligibleStage(stage: string): boolean {
  return [
    "clarification_pending",
    "ready_for_handoff",
    "frontend_in_progress",
    "backend_in_progress",
    "blocked",
    "ready_for_demo",
    "iterating",
  ].includes(stage);
}

function getWaitingRoles(meta: Record<string, string>): Array<"frontend" | "backend"> {
  const roles: Array<"frontend" | "backend"> = [];
  if (String(meta.frontend_status || "") === "waiting_receipt") {
    roles.push("frontend");
  }
  if (String(meta.backend_status || "") === "waiting_receipt") {
    roles.push("backend");
  }
  return roles;
}
