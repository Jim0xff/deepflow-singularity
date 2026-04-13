#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  daemonizeWatch,
  ensureProjectDir,
  fileMtimeMs,
  parseStatusMd,
  parseAgentPayloadTexts,
  pidAlive,
  readJson,
  readText,
  resolveExistingPath,
  runOpenClawAgent,
  sendOpenClawMessage,
  stripLegacyActionMenu,
  chunkMessageText,
  updateStatusMdAtomic,
  writeJson,
} from "./lib.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || "/root/.openclaw";
const OPENCLAW_NODE = resolveExistingPath([
  process.env.OPENCLAW_NODE,
  "/usr/local/bin/node",
  process.execPath,
  "/root/.nvm/versions/node/v24.14.0/bin/node",
]);
const OPENCLAW_CLI = resolveExistingPath([
  process.env.OPENCLAW_CLI,
  "/usr/local/lib/node_modules/openclaw/openclaw.mjs",
  path.join(path.dirname(process.execPath), "../lib/node_modules/openclaw/openclaw.mjs"),
  "/root/.nvm/versions/node/v24.14.0/lib/node_modules/openclaw/openclaw.mjs",
]);

function usage() {
  console.error(
    "usage: supervisor-core.mjs <start|watch> --project-dir <dir> --adapter <file> [--poll-ms <ms>] [--main-agent-id <id>] [--reviewer-agent-id <id>] [--writer-agent-id <id>] [--main-session-id <id>] [--reviewer-session-id <id>] [--writer-session-id <id>]"
  );
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function shouldStop(status) {
  return (
    String(status.workflow_mode || "").trim() === "manual" ||
    ["completed", "exited", "archived"].includes(String(status.status || "").trim()) ||
    ["completed", "exited"].includes(String(status.current_step || "").trim())
  );
}

function stopReason(status) {
  if (String(status.workflow_mode || "").trim() === "manual") return "manual";
  if (["completed", "exited", "archived"].includes(String(status.status || "").trim())) return "project_closed";
  if (["completed", "exited"].includes(String(status.current_step || "").trim())) return "step_closed";
  return "";
}

function buildAgentRuntime(args) {
  return {
    main: {
      agentId: args["main-agent-id"] || "singularity-main",
      sessionId: args["main-session-id"] || "",
    },
    reviewer: {
      agentId: args["reviewer-agent-id"] || "singularity-reviewer",
      sessionId: args["reviewer-session-id"] || "",
    },
    writer: {
      agentId: args["writer-agent-id"] || "singularity-writer",
      sessionId: args["writer-session-id"] || "",
    },
  };
}

function resolveTelegramDelivery(projectDir) {
  const projectId = path.basename(projectDir);
  const activeDir = path.join(path.dirname(projectDir), "active");
  let entries = [];
  try {
    entries = fs.readdirSync(activeDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".current")) continue;
    const pointerPath = path.join(activeDir, entry.name);
    if (readText(pointerPath).trim() !== projectId) continue;

    const rawTarget = entry.name.slice(0, -".current".length);
    const target = rawTarget.startsWith("telegram:") ? rawTarget.slice("telegram:".length) : rawTarget;
    if (!target) continue;
    return { enabled: true, channel: "telegram", to: target };
  }

  return null;
}

async function loadAdapter(adapterPath) {
  const resolved = path.isAbsolute(adapterPath) ? adapterPath : path.resolve(__dirname, adapterPath);
  const module = await import(pathToFileURL(resolved).href);
  if (typeof module.tick !== "function") {
    throw new Error(`adapter missing tick(): ${resolved}`);
  }
  return { resolved, tick: module.tick };
}

function deliverAgentPayloads({ delivery, actor, run, dispatch, nextRuntime }) {
  if (!delivery?.enabled) return { ok: true, sent: 0, failed: 0 };

  const texts = parseAgentPayloadTexts(run.stdout);
  const sent = [];
  const failed = [];

  for (const rawText of texts) {
    const cleaned = dispatch.stripLegacyActionMenu ? stripLegacyActionMenu(rawText) : rawText.trim();
    for (const chunk of chunkMessageText(cleaned)) {
      const result = sendOpenClawMessage({
        account: delivery.account || actor,
        channel: delivery.channel,
        target: delivery.to,
        message: chunk,
        openclawNode: OPENCLAW_NODE,
        openclawCli: OPENCLAW_CLI,
      });
      const entry = {
        status: result.status ?? 1,
        stdout: String(result.stdout || "").trim(),
        stderr: String(result.stderr || "").trim(),
      };
      if (entry.status === 0) {
        sent.push(entry);
      } else {
        failed.push(entry);
      }
    }
  }

  nextRuntime.last_delivery_count = sent.length;
  nextRuntime.last_delivery_failed_count = failed.length;
  nextRuntime.last_delivery_at = sent.length ? new Date().toISOString() : "";
  nextRuntime.last_delivery_error = failed.length ? failed.map((item) => item.stderr || item.stdout).join("\n") : "";
  return { ok: failed.length === 0, sent: sent.length, failed: failed.length };
}

function snapshotRelativeFileMtimes(projectDir, relativePaths = []) {
  const snapshot = {};
  for (const relativePath of relativePaths) {
    snapshot[relativePath] = fileMtimeMs(path.join(projectDir, relativePath));
  }
  return snapshot;
}

function hasChangedRelativeFile(projectDir, before = {}) {
  return Object.entries(before).some(([relativePath, previousMtime]) => {
    return fileMtimeMs(path.join(projectDir, relativePath)) > Number(previousMtime || 0);
  });
}

async function runWatch({ projectDir, adapterPath, pollMs, args }) {
  const runtimeDir = path.join(projectDir, "runtime");
  const logPath = path.join(runtimeDir, "supervisor.log");
  const pidPath = path.join(runtimeDir, "supervisor.pid");
  const runtimePath = path.join(runtimeDir, "supervisor.json");
  const adapter = await loadAdapter(adapterPath);

  fs.mkdirSync(runtimeDir, { recursive: true });
  writeJson(runtimePath, {
    ...(readJson(runtimePath, {})),
    state: "running",
    pid: process.pid,
    project_dir: projectDir,
    adapter: adapter.resolved,
    updated_at: new Date().toISOString(),
  });
  fs.writeFileSync(pidPath, `${process.pid}\n`, "utf8");

  try {
    while (true) {
      const statusPath = path.join(projectDir, "status.md");
      const statusText = readText(statusPath);
      const status = parseStatusMd(statusText);
      if (shouldStop(status)) break;

      const runtime = readJson(runtimePath, {});
      const statusMtimeMs = fileMtimeMs(statusPath);
      const agentRuntime = buildAgentRuntime(args);
      const result = await adapter.tick({
        projectDir,
        projectRoot: projectDir,
        runtimeDir,
        statusPath,
        statusText,
        status,
        statusMtimeMs,
        runtime,
        agents: agentRuntime,
        updateStatus: (patch) => updateStatusMdAtomic(statusPath, patch),
      });

      let dispatched = false;
      const nextRuntime = {
        ...runtime,
        state: "running",
        pid: process.pid,
        project_dir: projectDir,
        adapter: adapter.resolved,
        updated_at: new Date().toISOString(),
      };

      if (result?.runtimePatch && typeof result.runtimePatch === "object") {
        Object.assign(nextRuntime, result.runtimePatch);
      }

      if (result?.dispatch) {
        const dispatchKey = String(result.dispatch.key || "");
        const repeated =
          dispatchKey &&
          dispatchKey === String(runtime.last_dispatch_key || "") &&
          Number(runtime.last_dispatch_status_mtime_ms || 0) === statusMtimeMs;

        if (!repeated) {
          const actor = result.dispatch.actor;
          const agent = agentRuntime[actor];
          if (!agent?.agentId) {
            nextRuntime.last_error = `unknown_actor:${actor}`;
          } else {
            const delivery = {
              ...resolveTelegramDelivery(projectDir),
              account: agent.agentId,
            };
            const successFileSnapshot = snapshotRelativeFileMtimes(
              projectDir,
              result.dispatch.afterSuccessWhenFilesChanged,
            );
            const run = runOpenClawAgent({
              agentId: agent.agentId,
              message: result.dispatch.message,
              sessionId: result.dispatch.sessionId || agent.sessionId,
              openclawNode: OPENCLAW_NODE,
              openclawCli: OPENCLAW_CLI,
            });
            dispatched = run.status === 0;
            if (dispatched) {
              const deliveryResult = deliverAgentPayloads({
                delivery,
                actor,
                run,
                dispatch: result.dispatch,
                nextRuntime,
              });
              if (!deliveryResult.ok) {
                dispatched = false;
                nextRuntime.last_dispatch_failed_at = new Date().toISOString();
                nextRuntime.last_error = "delivery_failed";
              } else {
                nextRuntime.last_dispatch_key = dispatchKey;
                nextRuntime.last_dispatch_actor = actor;
                nextRuntime.last_dispatch_status_mtime_ms = statusMtimeMs;
                nextRuntime.last_dispatch_at = new Date().toISOString();
                if (
                  result.dispatch.afterSuccessPatch &&
                  hasChangedRelativeFile(projectDir, successFileSnapshot)
                ) {
                  updateStatusMdAtomic(statusPath, {
                    ...result.dispatch.afterSuccessPatch,
                    updated_at: new Date().toISOString(),
                  });
                  dispatched = false;
                }
                if (result.dispatch.afterStatusPatch) {
                  updateStatusMdAtomic(statusPath, {
                    ...result.dispatch.afterStatusPatch,
                    updated_at: new Date().toISOString(),
                  });
                  dispatched = false;
                }
              }
            } else {
              nextRuntime.last_dispatch_failed_at = new Date().toISOString();
            }
            nextRuntime.last_dispatch_message = result.dispatch.message;
            nextRuntime.last_dispatch_stdout = String(run.stdout || "").trim();
            nextRuntime.last_dispatch_stderr = String(run.stderr || "").trim();
            nextRuntime.last_dispatch_exit_code = run.status ?? 1;
          }
        }
      }

      writeJson(runtimePath, nextRuntime);

      const nextDelayMs = Number(result?.delayMs || pollMs || 15_000);
      await new Promise((resolve) => setTimeout(resolve, dispatched ? 2_000 : nextDelayMs));
    }
  } finally {
    const finalRuntime = readJson(runtimePath, {});
    const finalStatus = parseStatusMd(readText(path.join(projectDir, "status.md")));
    writeJson(runtimePath, {
      ...finalRuntime,
      state: "exited",
      pid: null,
      exit_reason: stopReason(finalStatus) || "watch_stopped",
      project_dir: projectDir,
      adapter: adapter.resolved,
      updated_at: new Date().toISOString(),
    });
    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
    fs.closeSync(fs.openSync(logPath, "a"));
  }
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || !["start", "watch"].includes(command)) usage();

  const args = parseArgs(argv);
  const projectDir = args["project-dir"];
  const adapterPath = args.adapter;
  const pollMs = Number(args["poll-ms"] || 15_000);
  if (!projectDir || !adapterPath) usage();
  ensureProjectDir(projectDir);

  const runtimeDir = path.join(projectDir, "runtime");
  const runtimePath = path.join(runtimeDir, "supervisor.json");
  const pidPath = path.join(runtimeDir, "supervisor.pid");
  const logPath = path.join(runtimeDir, "supervisor.log");
  fs.mkdirSync(runtimeDir, { recursive: true });

  if (command === "watch") {
    await runWatch({ projectDir, adapterPath, pollMs, args });
    return;
  }

  const existing = readJson(runtimePath, {});
  const pidMatch = `${__filename} watch --project-dir ${projectDir}`;
  if (pidAlive(existing.pid, pidMatch)) {
    writeJson(runtimePath, {
      ...existing,
      state: "running",
      pid: existing.pid,
      project_dir: projectDir,
      updated_at: new Date().toISOString(),
    });
    console.log(JSON.stringify({ ok: true, reused: true, pid: existing.pid, projectDir }, null, 2));
    return;
  }
  if (existing.pid) {
    writeJson(runtimePath, {
      ...existing,
      state: "stale",
      pid: null,
      project_dir: projectDir,
      stale_pid: existing.pid,
      updated_at: new Date().toISOString(),
    });
    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
  }

  const child = daemonizeWatch(
    [
      __filename,
      "watch",
      "--project-dir",
      projectDir,
      "--adapter",
      adapterPath,
      "--poll-ms",
      String(pollMs),
      ...Object.entries(args)
        .filter(([key]) => !["project-dir", "adapter", "poll-ms"].includes(key))
        .flatMap(([key, value]) => [`--${key}`, String(value)]),
    ],
    { logPath, cwd: process.cwd() }
  );

  writeJson(runtimePath, {
    state: "starting",
    pid: child.pid,
    project_dir: projectDir,
    adapter: path.resolve(__dirname, adapterPath),
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  fs.writeFileSync(pidPath, `${child.pid}\n`, "utf8");

  console.log(JSON.stringify({ ok: true, reused: false, pid: child.pid, projectDir }, null, 2));
}

main().catch((error) => {
  console.error(String(error?.stack || error || "supervisor_failed"));
  process.exit(1);
});
