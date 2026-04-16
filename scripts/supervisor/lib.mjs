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

export function pidAlive(pid, match = "") {
  const numericPid = Number(pid);
  if (!numericPid) return false;
  try {
    process.kill(numericPid, 0);
    const stat = spawnSync("ps", ["-p", String(numericPid), "-o", "stat=", "-o", "args="], { encoding: "utf8" });
    if (stat.status !== 0) return false;
    const out = String(stat.stdout || "").trim();
    if (!out || out.includes("Z")) return false;
    return !match || out.includes(match);
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

export function parseAgentPayloadTexts(stdout) {
  const value = String(stdout || "");
  const candidates = [value, ...findJsonObjectCandidates(value).reverse()];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const payloads = parsed?.result?.payloads ?? parsed?.payloads;
      if (Array.isArray(payloads)) {
        return payloads.map((payload) => String(payload?.text || "").trim()).filter(Boolean);
      }
    } catch {
      // Try the next candidate; stdout may contain non-JSON diagnostic lines.
    }
  }
  return [];
}

function findJsonObjectCandidates(value) {
  const candidates = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(value.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

export function stripLegacyActionMenu(text) {
  return String(text || "")
    .replace(
      /\n+\s*1[).、]\s*你直接提修改意见[\s\S]*?4[).、]\s*你直接\s*@ORCHESTRATOR_BOT\s*结束项目\s*$/u,
      "",
    )
    .trim();
}

export function chunkMessageText(text, maxChars = 3500) {
  const value = String(text || "").trim();
  if (!value) return [];
  if (value.length <= maxChars) return [value];

  const chunks = [];
  let remaining = value;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf("\n\n", maxChars);
    if (cut < maxChars * 0.5) cut = remaining.lastIndexOf("\n", maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function latestMarkdownBlock(text) {
  const value = String(text || "").trim();
  const index = value.lastIndexOf("\n## ");
  return (index >= 0 ? value.slice(index + 1) : value).trim();
}

export function parseLatestVerdict(text) {
  const block = latestMarkdownBlock(text);
  const explicit = block.match(/\bverdict\s*[:=_-]\s*(approved|changes_requested)\b/i);
  if (explicit) return explicit[1].toLowerCase();
  if (/(需要修改|需修改|要求修改|未通过|不通过|不能通过|不可通过|changes requested)/iu.test(block)) {
    return "changes_requested";
  }
  if (/(审核|审稿|本轮)?\s*(已通过|审核通过|审稿通过|批准|可批准)/u.test(block)) return "approved";
  return "";
}

export function sendOpenClawMessage({
  account,
  channel,
  target,
  message,
  env = process.env,
  openclawNode,
  openclawCli,
  spawnSyncImpl = spawnSync,
}) {
  if (!openclawNode || !openclawCli) {
    return { status: 1, stdout: "", stderr: "openclaw_path_missing" };
  }

  const args = [
    openclawCli,
    "message",
    "send",
    "--channel",
    channel,
    "--account",
    account,
    "--target",
    target,
    "--message",
    message,
    "--json",
  ];

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
