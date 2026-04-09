import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type SingularitySupervisorManagerOptions = {
  projectsRoot: string;
  intervalMs: number;
  scriptPath?: string;
  logger?: Logger;
  readFile?: (filePath: string) => Promise<string | null>;
};

export type SingularitySupervisorManager = {
  start: () => void;
  stop: () => void;
  runNow: () => Promise<void>;
};

const defaultLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export function createSingularitySupervisorManager(
  options: SingularitySupervisorManagerOptions,
): SingularitySupervisorManager {
  const logger = options.logger ?? defaultLogger;
  const scriptPath = resolve(options.scriptPath ?? join(process.cwd(), "scripts", "singularity-supervisor.mjs"));
  let timer: NodeJS.Timeout | null = null;
  const inFlight = new Set<string>();

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      void runNow();
    }, options.intervalMs);
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  async function runNow(): Promise<void> {
    let entries: Array<string> = [];
    try {
      entries = await fs.readdir(options.projectsRoot);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry === "active" || entry === "CURRENT_PROJECT") continue;
      const projectDir = join(options.projectsRoot, entry);
      const statusPath = join(projectDir, "status.md");
      const content = await readText(statusPath);
      if (!content) continue;

      const status = parseStatusMd(content);
      if (!shouldAutoSupervise(status)) continue;
      if (inFlight.has(projectDir)) continue;

      inFlight.add(projectDir);
      try {
        await runSupervisorStart(scriptPath, projectDir);
        logger.info(`[singularity-supervisor] ensured ${entry}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[singularity-supervisor] failed ${entry}: ${message}`);
      } finally {
        inFlight.delete(projectDir);
      }
    }
  }

  async function readText(filePath: string): Promise<string | null> {
    if (options.readFile) return options.readFile(filePath);
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      return null;
    }
  }

  return { start, stop, runNow };
}

function parseStatusMd(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of String(text || "").split("\n")) {
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = match[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return result;
}

function shouldAutoSupervise(status: Record<string, string>): boolean {
  const workflowMode = String(status.workflow_mode || "").trim();
  const currentStep = String(status.current_step || "").trim();
  const projectStatus = String(status.status || "").trim();
  if (workflowMode !== "auto") return false;
  if (!["step_5_debate", "step_7_drafting"].includes(currentStep)) return false;
  if (["completed", "exited", "archived"].includes(projectStatus)) return false;
  return true;
}

function runSupervisorStart(scriptPath: string, projectDir: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [scriptPath, "start", "--project-dir", projectDir], {
      stdio: "ignore",
      detached: false,
    });

    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`start failed code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  });
}

