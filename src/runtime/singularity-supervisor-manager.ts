import fsSync from "node:fs";
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
  docsManagerPath?: string;
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
  const docsManagerPath = resolve(
    options.docsManagerPath
      ?? join(process.cwd(), "assets", "root", "skills", "docs-manager", "docs-manager-executor.mjs"),
  );
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
      if (shouldPublishToDocs(status)) {
        if (!inFlight.has(`${projectDir}:publish`)) {
          inFlight.add(`${projectDir}:publish`);
          try {
            await publishFinalArticleToDocs({
              docsManagerPath,
              projectDir,
              projectId: String(status.project_id || entry).trim() || entry,
              logger,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`[singularity-publish] failed ${entry}: ${message}`);
          } finally {
            inFlight.delete(`${projectDir}:publish`);
          }
        }
      }

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

function shouldPublishToDocs(status: Record<string, string>): boolean {
  return (
    String(status.docs_publish_requested || "").trim().toLowerCase() === "yes"
    && String(status.docs_publish_state || "").trim().toLowerCase() !== "done"
  );
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

async function publishFinalArticleToDocs({
  docsManagerPath,
  projectDir,
  projectId,
  logger,
}: {
  docsManagerPath: string;
  projectDir: string;
  projectId: string;
  logger: Logger;
}): Promise<void> {
  const statusPath = join(projectDir, "status.md");
  const outputPath = join(projectDir, "output.md");
  const article = await fs.readFile(outputPath, "utf8").catch(() => "");
  if (!article.trim()) {
    updateStatusMdAtomic(statusPath, {
      docs_publish_state: "failed",
      docs_publish_error: "output_md_empty",
      updated_at: new Date().toISOString(),
    });
    throw new Error("output.md is empty");
  }

  const bindingId = `http:singularity-${projectId}`;
  const targetPath = "05_delivery/final_article.md";

  updateStatusMdAtomic(statusPath, {
    docs_publish_state: "syncing",
    docs_publish_error: "",
    docs_publish_binding_id: bindingId,
    docs_publish_path: targetPath,
    updated_at: new Date().toISOString(),
  });

  await runDocsManager(docsManagerPath, ["--action", "bind", "--binding-id", bindingId, "--project-code", projectId]);
  await runDocsManager(docsManagerPath, ["--action", "ensure", "--binding-id", bindingId, "--profile", "canonical-v1"]);
  await runDocsManager(docsManagerPath, ["--action", "write", "--binding-id", bindingId, "--path", targetPath, "--content", article]);

  updateStatusMdAtomic(statusPath, {
    docs_publish_state: "done",
    docs_publish_requested: "no",
    docs_publish_error: "",
    docs_publish_at: new Date().toISOString(),
    docs_publish_binding_id: bindingId,
    docs_publish_path: targetPath,
    updated_at: new Date().toISOString(),
  });
  logger.info(`[singularity-publish] synced ${projectId} -> ${targetPath}`);
}

function runDocsManager(scriptPath: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: "ignore" });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`docs-manager failed code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  });
}

function updateStatusMdAtomic(statusPath: string, patch: Record<string, string>): void {
  const text = readStatusSync(statusPath);
  const lines = text.split("\n");
  const order: string[] = [];
  const map = new Map<string, string>();

  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) continue;
    if (!map.has(match[1])) order.push(match[1]);
    map.set(match[1], match[2]);
  }

  for (const [key, value] of Object.entries(patch)) {
    if (!map.has(key)) order.push(key);
    map.set(key, value);
  }

  const next = `${order.map((key) => `${key}: ${map.get(key) ?? ""}`).join("\n")}\n`;
  const tempPath = `${statusPath}.tmp`;
  fsSync.writeFileSync(tempPath, next, "utf8");
  fsSync.renameSync(tempPath, statusPath);
}

function readStatusSync(statusPath: string): string {
  try {
    return fsSync.readFileSync(statusPath, "utf8");
  } catch {
    return "";
  }
}
