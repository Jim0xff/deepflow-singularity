import fsSync from "node:fs";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type SupervisorStartResult = {
  reused?: boolean;
  pid?: number | null;
  projectDir?: string;
  stalePid?: number | null;
  stdout?: string;
  stderr?: string;
};

type SingularitySupervisorManagerOptions = {
  projectsRoot: string;
  intervalMs: number;
  scriptPath?: string;
  docsManagerPath?: string;
  docsRoot?: string;
  docsPublishNotifyAgentId?: string;
  runAgentCommand?: (agentId: string, message: string, sessionId: string) => Promise<void>;
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
  const docsRoot = resolve(options.docsRoot ?? "/tmp/deepflow-assets/docs");
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
    await publishPendingProjectsToDocs({
      projectsRoot: options.projectsRoot,
      docsManagerPath,
      docsRoot,
      notifyAgentId: options.docsPublishNotifyAgentId,
      runAgentCommand: options.runAgentCommand,
      inFlight,
      logger,
    });

    await clearPointersForAgentUnboundExitedProjects({
      projectsRoot: options.projectsRoot,
      logger,
    });

    const current = await resolveCurrentProject(options.projectsRoot, readText);
    if (!current) return;

    const { projectId, projectDir } = current;
    const statusPath = join(projectDir, "status.md");
    const content = await readText(statusPath);
    if (!content) return;

    const status = parseStatusMd(content);
    if (shouldEnsureDocsBinding(status)) {
      if (!inFlight.has(`${projectDir}:bind`)) {
        inFlight.add(`${projectDir}:bind`);
        try {
          await ensureDocsBinding({
            docsManagerPath,
            projectDir,
            projectId: String(status.project_id || projectId).trim() || projectId,
            logger,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`[singularity-publish] bind failed ${projectId}: ${message}`);
        } finally {
          inFlight.delete(`${projectDir}:bind`);
        }
      }
    }

    if (!shouldAutoSupervise(status)) return;
    if (inFlight.has(projectDir)) return;

    inFlight.add(projectDir);
    try {
      const startResult = await runSupervisorStart(scriptPath, projectDir);
      logger.info(
        `[singularity-supervisor] ensured ${projectId} ${JSON.stringify({
          reused: startResult.reused ?? null,
          pid: startResult.pid ?? null,
          stale_pid: startResult.stalePid ?? null,
          current_step: String(status.current_step || "").trim(),
          next_actor: String(status.next_actor || "").trim(),
          awaiting_user_choice: String(status.awaiting_user_choice || "").trim(),
          workflow_mode: String(status.workflow_mode || "").trim(),
          runtime_stdout: clipText(startResult.stdout),
          runtime_stderr: clipText(startResult.stderr),
        })}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[singularity-supervisor] failed ${projectId}: ${message}`);
    } finally {
      inFlight.delete(projectDir);
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

async function publishPendingProjectsToDocs({
  projectsRoot,
  docsManagerPath,
  docsRoot,
  notifyAgentId,
  runAgentCommand,
  inFlight,
  logger,
}: {
  projectsRoot: string;
  docsManagerPath: string;
  docsRoot: string;
  notifyAgentId?: string;
  runAgentCommand?: (agentId: string, message: string, sessionId: string) => Promise<void>;
  inFlight: Set<string>;
  logger: Logger;
}): Promise<void> {
  const entries = await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const projectDir = join(projectsRoot, entry.name);
    const statusPath = join(projectDir, "status.md");
    const statusText = await fs.readFile(statusPath, "utf8").catch(() => "");
    if (!statusText) continue;

    const status = parseStatusMd(statusText);
    if (!shouldPublishToDocs(status)) continue;

    const projectId = String(status.project_id || entry.name).trim() || entry.name;
    const publishKey = `${projectDir}:publish`;
    if (inFlight.has(publishKey)) continue;
    inFlight.add(publishKey);
    try {
      await publishFinalArticleToDocs({
        docsManagerPath,
        docsRoot,
        projectsRoot,
        projectDir,
        projectId,
        notifyAgentId,
        runAgentCommand,
        logger,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[singularity-publish] failed ${projectId}: ${message}`);
    } finally {
      inFlight.delete(publishKey);
    }
  }
}

async function resolveCurrentProject(
  projectsRoot: string,
  readFile: (filePath: string) => Promise<string | null>,
): Promise<{ projectId: string; projectDir: string } | null> {
  const currentProjectPath = join(projectsRoot, "CURRENT_PROJECT");
  const projectId = String((await readFile(currentProjectPath)) || "").trim();
  if (!projectId) return null;
  return {
    projectId,
    projectDir: join(projectsRoot, projectId),
  };
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

function resolveCurrentStep(status: Record<string, string>): string {
  const currentStep = String(status.current_step || "").trim();
  if (currentStep) return currentStep;

  const workflowMode = String(status.workflow_mode || "").trim();
  const lastCompletedStep = String(status.last_completed_step || "").trim();
  const nextStep = String(status.next_step || "").trim();

  if (workflowMode !== "auto") return "";

  if (lastCompletedStep === "step_5_debate" && nextStep === "step_6_feedback") {
    return "step_5_debate";
  }

  return "";
}

function shouldAutoSupervise(status: Record<string, string>): boolean {
  const workflowMode = String(status.workflow_mode || "").trim();
  const currentStep = resolveCurrentStep(status);
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

function shouldEnsureDocsBinding(status: Record<string, string>): boolean {
  const projectStatus = String(status.status || "").trim();
  const currentStep = resolveCurrentStep(status);
  const bindingState = String(status.docs_binding_state || "").trim().toLowerCase();
  if (["completed", "exited", "archived"].includes(projectStatus)) return false;
  if (["completed", "exited"].includes(currentStep)) return false;
  return bindingState !== "bound";
}

function clipText(value: string | undefined, maxLength = 200): string {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}...`;
}

function parseSupervisorStartOutput(stdout: string, stderr: string): SupervisorStartResult {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return { stdout, stderr };
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      reused: typeof parsed.reused === "boolean" ? parsed.reused : undefined,
      pid: Number.isFinite(Number(parsed.pid)) ? Number(parsed.pid) : null,
      projectDir: typeof parsed.projectDir === "string" ? parsed.projectDir : undefined,
      stalePid: Number.isFinite(Number(parsed.stalePid)) ? Number(parsed.stalePid) : null,
      stdout,
      stderr,
    };
  } catch {
    const match = trimmed.match(/(\{[\s\S]*\})\s*$/);
    if (!match) return { stdout, stderr };
    try {
      const parsed = JSON.parse(match[1]) as Record<string, unknown>;
      return {
        reused: typeof parsed.reused === "boolean" ? parsed.reused : undefined,
        pid: Number.isFinite(Number(parsed.pid)) ? Number(parsed.pid) : null,
        projectDir: typeof parsed.projectDir === "string" ? parsed.projectDir : undefined,
        stalePid: Number.isFinite(Number(parsed.stalePid)) ? Number(parsed.stalePid) : null,
        stdout,
        stderr,
      };
    } catch {
      return { stdout, stderr };
    }
  }
}

function shouldClearProjectPointers(status: Record<string, string>): boolean {
  const projectStatus = String(status.status || "").trim();
  const currentStep = resolveCurrentStep(status);
  return ["exited", "archived"].includes(projectStatus) || currentStep === "exited";
}

function didAgentUnbindDocs(status: Record<string, string>): boolean {
  return String(status.docs_binding_state || "").trim().toLowerCase() === "unbound";
}

function runSupervisorStart(scriptPath: string, projectDir: string): Promise<SupervisorStartResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [scriptPath, "start", "--project-dir", projectDir], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise(parseSupervisorStartOutput(stdout, stderr));
        return;
      }
      rejectPromise(
        new Error(
          `start failed code=${code ?? "null"} signal=${signal ?? "null"} stdout=${clipText(stdout)} stderr=${clipText(stderr)}`,
        ),
      );
    });
  });
}

async function publishFinalArticleToDocs({
  docsManagerPath,
  docsRoot,
  projectsRoot,
  projectDir,
  projectId,
  notifyAgentId,
  runAgentCommand,
  logger,
}: {
  docsManagerPath: string;
  docsRoot: string;
  projectsRoot: string;
  projectDir: string;
  projectId: string;
  notifyAgentId?: string;
  runAgentCommand?: (agentId: string, message: string, sessionId: string) => Promise<void>;
  logger: Logger;
}): Promise<void> {
  const statusPath = join(projectDir, "status.md");
  const finalOutputPath = join(projectDir, "final-output.md");
  const outputPath = join(projectDir, "output.md");
  const status = parseStatusMd(readStatusSync(statusPath));
  const finalArticle = await fs.readFile(finalOutputPath, "utf8").catch(() => "");
  const draftArticle = await fs.readFile(outputPath, "utf8").catch(() => "");
  const finalPublishRequired =
    String(status.final_article_ready || "").trim().toLowerCase() === "yes" ||
    String(status.review_target || "").trim().toLowerCase() === "final" ||
    String(status.active_menu_scope || "").trim() === "final_delivery_menu";
  const article = finalArticle.trim() ? finalArticle : (finalPublishRequired ? "" : draftArticle);
  if (!article.trim()) {
    const errorCode = finalPublishRequired ? "final_output_empty" : "final_output_and_output_empty";
    updateStatusMdAtomic(statusPath, {
      docs_publish_state: "failed",
      docs_publish_error: errorCode,
      updated_at: new Date().toISOString(),
    });
    throw new Error(finalPublishRequired ? "final-output.md is empty" : "final-output.md and output.md are empty");
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

  if (String(status.docs_binding_state || "").trim().toLowerCase() !== "bound") {
    await bindAndEnsureDocsProject({ docsManagerPath, bindingId, projectId });
  }

  try {
    await runDocsManager(docsManagerPath, ["--action", "write", "--binding-id", bindingId, "--path", targetPath, "--content", article]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("project is not bound")) throw error;

    updateStatusMdAtomic(statusPath, {
      docs_binding_state: "binding_repair",
      docs_publish_error: "binding_missing_rebinding",
      updated_at: new Date().toISOString(),
    });
    await bindAndEnsureDocsProject({ docsManagerPath, bindingId, projectId });
    await runDocsManager(docsManagerPath, ["--action", "write", "--binding-id", bindingId, "--path", targetPath, "--content", article]);
  }

  updateStatusMdAtomic(statusPath, {
    docs_publish_state: "done",
    docs_publish_requested: "no",
    docs_publish_error: "",
    docs_publish_at: new Date().toISOString(),
    docs_publish_binding_id: bindingId,
    docs_publish_path: targetPath,
    docs_binding_state: "bound",
    docs_bound_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  logger.info(`[singularity-publish] synced ${projectId} -> ${targetPath}`);

  if (notifyAgentId) {
    const absolutePath = join(docsRoot, "projects", projectId, targetPath);
    const chatId = await resolveProjectChatId(projectsRoot, projectId);
    const notifyTarget = chatId ? `tg:${chatId} path:${absolutePath}` : `path:${absolutePath}`;
    try {
      await notifyDocsPublishAgent({
        agentId: notifyAgentId,
        projectId,
        absolutePath,
        chatId,
        runAgentCommand,
      });
      updateStatusMdAtomic(statusPath, {
        docs_publish_notify_state: "sent",
        docs_publish_notify_agent: notifyAgentId,
        docs_publish_notify_at: new Date().toISOString(),
        docs_publish_notify_error: "",
        updated_at: new Date().toISOString(),
      });
      logger.info(`[singularity-publish] notified ${notifyAgentId} /handle ${notifyTarget}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateStatusMdAtomic(statusPath, {
        docs_publish_notify_state: "failed",
        docs_publish_notify_agent: notifyAgentId,
        docs_publish_notify_error: message,
        updated_at: new Date().toISOString(),
      });
      logger.error(`[singularity-publish] notify failed ${notifyAgentId}: ${message}`);
    }
  }
}

async function ensureDocsBinding({
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
  const bindingId = `http:singularity-${projectId}`;

  await bindAndEnsureDocsProject({ docsManagerPath, bindingId, projectId });

  updateStatusMdAtomic(statusPath, {
    docs_binding_state: "bound",
    docs_publish_binding_id: bindingId,
    docs_bound_at: new Date().toISOString(),
    docs_publish_error: "",
    updated_at: new Date().toISOString(),
  });
  logger.info(`[singularity-publish] bound ${projectId}`);
}

async function bindAndEnsureDocsProject({
  docsManagerPath,
  bindingId,
  projectId,
}: {
  docsManagerPath: string;
  bindingId: string;
  projectId: string;
}): Promise<void> {
  await runDocsManager(docsManagerPath, ["--action", "bind", "--binding-id", bindingId, "--project-code", projectId]);
  await runDocsManager(docsManagerPath, ["--action", "ensure", "--binding-id", bindingId, "--profile", "canonical-v1"]);
}

async function clearPointersForAgentUnboundExitedProjects({
  projectsRoot,
  logger,
}: {
  projectsRoot: string;
  logger: Logger;
}): Promise<void> {
  const entries = await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const projectDir = join(projectsRoot, entry.name);
    const statusPath = join(projectDir, "status.md");
    const statusText = await fs.readFile(statusPath, "utf8").catch(() => "");
    if (!statusText) continue;

    const status = parseStatusMd(statusText);
    if (!shouldClearProjectPointers(status)) continue;
    if (!didAgentUnbindDocs(status)) {
      logger.warn(`[singularity-publish] exit pointer not cleared before agent unbinds docs: ${entry.name}`);
      continue;
    }
    await clearProjectPointers(projectsRoot, entry.name);
  }
}

async function clearProjectPointers(projectsRoot: string, projectId: string): Promise<void> {
  const currentProjectPath = join(projectsRoot, "CURRENT_PROJECT");
  const current = await fs.readFile(currentProjectPath, "utf8").catch(() => "");
  if (current.trim() === projectId) {
    await fs.writeFile(currentProjectPath, "", "utf8").catch(() => undefined);
  }

  const activeDir = join(projectsRoot, "active");
  const entries = await fs.readdir(activeDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".current"))
    .map(async (entry) => {
      const filePath = join(activeDir, entry.name);
      const value = await fs.readFile(filePath, "utf8").catch(() => "");
      if (value.trim() === projectId) {
        await fs.writeFile(filePath, "", "utf8");
      }
    }));
}

async function resolveProjectChatId(projectsRoot: string, projectId: string): Promise<string> {
  const activeDir = join(projectsRoot, "active");
  const entries = await fs.readdir(activeDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".current")) continue;
    const filePath = join(activeDir, entry.name);
    const value = await fs.readFile(filePath, "utf8").catch(() => "");
    if (value.trim() !== projectId) continue;
    const raw = entry.name.slice(0, -".current".length);
    const chatId = raw.startsWith("telegram:") ? raw.slice("telegram:".length) : raw;
    if (chatId) return chatId;
  }
  return "";
}

function runDocsManager(scriptPath: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const detail = stderr.trim();
      rejectPromise(
        new Error(`docs-manager failed code=${code ?? "null"} signal=${signal ?? "null"}${detail ? `: ${detail}` : ""}`),
      );
    });
  });
}

function notifyDocsPublishAgent({
  agentId,
  projectId,
  absolutePath,
  chatId,
  runAgentCommand,
}: {
  agentId: string;
  projectId: string;
  absolutePath: string;
  chatId?: string;
  runAgentCommand?: (agentId: string, message: string, sessionId: string) => Promise<void>;
}): Promise<void> {
  const sessionId = `docs-publish-${sanitizeSessionId(projectId)}-${sanitizeSessionId(agentId)}`;
  const message = chatId ? `/handle tg:${chatId} path:${absolutePath}` : `/handle path:${absolutePath}`;

  if (runAgentCommand) {
    return runAgentCommand(agentId, message, sessionId);
  }
  return runOpenClawAgent(agentId, message, sessionId);
}

function runOpenClawAgent(agentId: string, message: string, sessionId: string): Promise<void> {
  const openclawNode = resolveExistingPath([
    process.env.OPENCLAW_NODE,
    "/usr/local/bin/node",
    process.execPath,
    "/root/.nvm/versions/node/v24.14.0/bin/node",
  ]);
  const openclawCli = resolveExistingPath([
    process.env.OPENCLAW_CLI,
    "/usr/local/lib/node_modules/openclaw/openclaw.mjs",
    join(process.execPath ? resolve(process.execPath, "..") : "", "../lib/node_modules/openclaw/openclaw.mjs"),
    "/root/.nvm/versions/node/v24.14.0/lib/node_modules/openclaw/openclaw.mjs",
  ]);
  if (!openclawNode || !openclawCli) {
    return Promise.reject(new Error("openclaw_path_missing"));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const childEnv = { ...process.env };
    delete childEnv.OPENCLAW_GATEWAY_URL;
    delete childEnv.CLAWDBOT_GATEWAY_URL;

    const child = spawn(openclawNode, [
      openclawCli,
      "agent",
      "--agent",
      agentId,
      "--message",
      message,
      "--session-id",
      sessionId,
      "--json",
    ], { stdio: ["ignore", "pipe", "pipe"], env: childEnv });

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`openclaw agent failed code=${code ?? "null"} signal=${signal ?? "null"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

function resolveExistingPath(candidates: Array<string | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate && fsSync.existsSync(candidate)) return candidate;
  }
  return null;
}

function sanitizeSessionId(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "") || "unknown";
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
