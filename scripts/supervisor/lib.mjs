import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export function ensureProjectDir(projectDir) {
  if (!projectDir || projectDir.startsWith("-")) {
    throw new Error("project_dir is required");
  }
  const stat = fs.statSync(projectDir, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) {
    throw new Error(`project_dir is not a directory: ${projectDir}`);
  }
  const statusPath = path.join(projectDir, "status.md");
  if (!fs.existsSync(statusPath)) {
    throw new Error(`missing status.md under project_dir: ${projectDir}`);
  }
}

export function readText(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function readJson(filePath, fallback = {}) {
  try {
    const text = readText(filePath);
    return text.trim() ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function parseStatusMd(text) {
  const fields = {};
  for (const line of String(text || "").split("\n")) {
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) continue;
    fields[match[1]] = match[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return fields;
}

export function updateStatusMdAtomic(statusPath, patch) {
  const existing = readText(statusPath);
  const lines = existing.split("\n");
  const kv = new Map();
  const order = [];

  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (!kv.has(key)) order.push(key);
    kv.set(key, match[2]);
  }

  for (const [key, value] of Object.entries(patch)) {
    if (!kv.has(key)) order.push(key);
    kv.set(key, String(value ?? ""));
  }

  const nextText = `${order.map((key) => `${key}: ${kv.get(key) ?? ""}`).join("\n")}\n`;
  const tmpPath = `${statusPath}.tmp`;
  fs.writeFileSync(tmpPath, nextText, "utf8");
  fs.renameSync(tmpPath, statusPath);
}

export function fileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export function pidAlive(pid) {
  const numericPid = Number(pid);
  if (!numericPid) return false;
  try {
    process.kill(numericPid, 0);
    const stat = spawnSync("ps", ["-p", String(numericPid), "-o", "stat="], { encoding: "utf8" });
    if (stat.status !== 0) return false;
    const state = String(stat.stdout || "").trim();
    return Boolean(state) && !state.includes("Z");
  } catch {
    return false;
  }
}

export function resolveExistingPath(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function runOpenClawAgent({
  agentId,
  message,
  sessionId = "",
  delivery = null,
  env = process.env,
  openclawNode,
  openclawCli,
  spawnSyncImpl = spawnSync,
}) {
  if (!openclawNode || !openclawCli) {
    return { status: 1, stdout: "", stderr: "openclaw_path_missing" };
  }

  const args = [openclawCli, "agent", "--agent", agentId, "--message", message, "--json"];
  if (sessionId) {
    args.push("--session-id", sessionId);
  }
  if (delivery?.enabled) {
    args.push("--deliver");
    if (delivery.channel) args.push("--reply-channel", delivery.channel);
    if (delivery.account) args.push("--reply-account", delivery.account);
    if (delivery.to) args.push("--reply-to", delivery.to);
  }

  const childEnv = { ...env };
  delete childEnv.OPENCLAW_GATEWAY_URL;
  delete childEnv.CLAWDBOT_GATEWAY_URL;

  return spawnSyncImpl(openclawNode, args, { encoding: "utf8", env: childEnv });
}

export function daemonizeWatch(commandArgs, { logPath, cwd = process.cwd() }) {
  const out = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, commandArgs, {
    cwd,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  fs.closeSync(out);
  return child;
}
