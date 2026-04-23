import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const DEFAULT_MAX_RECOVERY_SESSION_ATTEMPTS = 1;
export const DEFAULT_RETRY_DELAYS_MS = [15_000, 60_000];
export const DEFAULT_PROBE_RETRY_DELAY_MS = 15 * 60_000;

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

export function relativeFileSignature(projectDir, relativePath) {
  const filePath = path.join(projectDir, relativePath);
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return "";
    const content = fs.readFileSync(filePath);
    return `${stat.mtimeMs}:${stat.size}:${createHash("sha1").update(content).digest("hex")}`;
  } catch {
    return "";
  }
}

export function snapshotRelativeFileSignatures(projectDir, relativePaths = []) {
  const snapshot = {};
  for (const relativePath of relativePaths) {
    snapshot[relativePath] = relativeFileSignature(projectDir, relativePath);
  }
  return snapshot;
}

export function hasChangedRelativeFile(projectDir, before = {}) {
  return Object.entries(before).some(([relativePath, previousSignature]) => {
    return relativeFileSignature(projectDir, relativePath) !== String(previousSignature || "");
  });
}

export function dispatchResumeSignalPaths(dispatch = {}) {
  const paths = new Set();
  for (const relativePath of dispatch.afterSuccessWhenFilesChanged || []) {
    const value = String(relativePath || "").trim();
    if (value) paths.add(value);
  }
  const deliverPath = String(dispatch.deliverFromChangedFile || "").trim();
  if (deliverPath) paths.add(deliverPath);
  return [...paths];
}

export function snapshotDispatchResumeSignals(projectDir, dispatch = {}) {
  const paths = dispatchResumeSignalPaths(dispatch);
  return {
    paths,
    snapshot: snapshotRelativeFileSignatures(projectDir, paths),
  };
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

export function hasNoReplySignal(run) {
  const text = `${String(run?.stdout || "")}\n${String(run?.stderr || "")}`;
  return /\bNO_REPLY\b/i.test(text);
}

export function hasTransientFailureText(text) {
  return (
    /\bNO_REPLY\b/i.test(text) ||
    /\bread failed:\s*Offset \d+ is beyond end of file\b/i.test(text) ||
    /\bembedded run agent end\b[\s\S]*\bisError=true\b[\s\S]*\berror=terminated\b/i.test(text) ||
    /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND)\b/i.test(text) ||
    /\btimeout\b|\btimed out\b/i.test(text) ||
    /\b(429|502|503|504)\b/i.test(text) ||
    /\btemporar(?:y|ily)\b[\s_-]*unavailable\b/i.test(text)
  );
}

export function hasTransientDispatchFailureSignal(run) {
  const text = `${String(run?.stdout || "")}\n${String(run?.stderr || "")}`;
  return hasTransientFailureText(text);
}

export function hasTransientDeliveryFailureSignal(deliveryErrorText) {
  return hasTransientFailureText(String(deliveryErrorText || ""));
}

export function canPromoteChangedFileDispatch({
  dispatch = {},
  successFilesChanged = false,
  transientDispatchFailure = false,
  parsedVerdict = "",
}) {
  const hasAdvancePatch = Boolean(dispatch.afterSuccessPatch || dispatch.afterStatusPatch);
  const hasVerdictDrivenAdvance = Boolean(dispatch.afterSuccessPatchFromLatestVerdict && parsedVerdict);
  return Boolean(
    dispatch.deliverRequiresChangedFile &&
      (hasAdvancePatch || hasVerdictDrivenAdvance) &&
      successFilesChanged &&
      transientDispatchFailure,
  );
}

export function hasDispatchResumeSignalChanged(projectDir, runtime = {}) {
  const snapshot =
    runtime.last_dispatch_resume_signals &&
    typeof runtime.last_dispatch_resume_signals === "object" &&
    !Array.isArray(runtime.last_dispatch_resume_signals)
      ? runtime.last_dispatch_resume_signals
      : {};
  return hasChangedRelativeFile(projectDir, snapshot);
}

export function shouldDispatchRepeated({ runtime = {}, projectDir, nowMs = Date.now() }) {
  if (hasDispatchResumeSignalChanged(projectDir, runtime)) {
    return { shouldDispatch: true, reason: "resume_signal_changed" };
  }

  const hasFailureState = Boolean(runtime.last_failure_class || runtime.next_retry_at);
  if (!hasFailureState) {
    return { shouldDispatch: false, reason: "already_dispatched_for_status" };
  }

  const nextRetryAtMs = Date.parse(String(runtime.next_retry_at || ""));
  if (Number.isFinite(nextRetryAtMs) && nextRetryAtMs > nowMs) {
    return { shouldDispatch: false, reason: "waiting_for_retry_window" };
  }

  return {
    shouldDispatch: true,
    reason: String(runtime.retry_mode || "").trim().toLowerCase() === "probe" ? "probe_due" : "retry_due",
  };
}

export function dispatchFailureCounts(runtime = {}) {
  const value = runtime.dispatch_failure_counts;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const counts = {};
  for (const [key, count] of Object.entries(value)) {
    const numeric = Number(count);
    if (Number.isFinite(numeric) && numeric > 0) counts[key] = numeric;
  }
  return counts;
}

export function recoverySessionId({ projectDir, actor, dispatchKey, attempt }) {
  const projectId = path.basename(projectDir || "project");
  const hash = createHash("sha256").update(String(dispatchKey || "")).digest("hex").slice(0, 12);
  const attemptText = String(Math.max(1, Number(attempt) || 1));
  const suffix = `-${hash}-${attemptText}`;
  const prefixMaxLength = Math.max(1, 180 - suffix.length);
  const prefix = `supervisor-recovery-${projectId}-${actor}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, prefixMaxLength)
    .replace(/-+$/g, "");
  return `${prefix || "supervisor-recovery"}${suffix}`;
}

export function dispatchRecoveryPlan({
  runtime = {},
  projectDir,
  actor,
  dispatchKey,
  maxRecoverySessionAttempts = DEFAULT_MAX_RECOVERY_SESSION_ATTEMPTS,
}) {
  const failureCounts = dispatchFailureCounts(runtime);
  const previousFailureCount = Number(failureCounts[dispatchKey] || 0);
  const canUseRecoverySession =
    previousFailureCount > 0 && previousFailureCount <= Number(maxRecoverySessionAttempts || 0);
  return {
    failureCounts,
    previousFailureCount,
    recoverySession: canUseRecoverySession
      ? recoverySessionId({
          projectDir,
          actor,
          dispatchKey,
          attempt: previousFailureCount,
        })
      : "",
  };
}

export function applyRecoverableDispatchFailure({
  runtimePatch,
  failureCounts,
  dispatchKey,
  previousFailureCount,
  recoverySession,
  statusMtimeMs,
  maxRecoverySessionAttempts = DEFAULT_MAX_RECOVERY_SESSION_ATTEMPTS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  probeRetryDelayMs = DEFAULT_PROBE_RETRY_DELAY_MS,
  nowIso = new Date().toISOString(),
  reason = "",
  resumeSignals = {},
  resumeSignalPaths = [],
}) {
  const nextFailureCount = Number(previousFailureCount || 0) + 1;
  failureCounts[dispatchKey] = nextFailureCount;
  runtimePatch.dispatch_failure_counts = failureCounts;
  runtimePatch.last_recovery_session_id = recoverySession;
  runtimePatch.last_dispatch_key = dispatchKey;
  runtimePatch.last_dispatch_status_mtime_ms = statusMtimeMs;
  runtimePatch.last_failure_class = "retryable";
  runtimePatch.last_failure_reason = reason || String(runtimePatch.last_error || "retryable_dispatch_failure");
  runtimePatch.retry_attempt = nextFailureCount;
  runtimePatch.last_dispatch_resume_signals = resumeSignals;
  runtimePatch.last_resume_signal_paths = resumeSignalPaths;
  runtimePatch.blocked_since = "";
  runtimePatch.probe_every_ms = Number(probeRetryDelayMs || 0) || DEFAULT_PROBE_RETRY_DELAY_MS;

  const delayMs = Number(retryDelaysMs[nextFailureCount - 1]);
  if (Number.isFinite(delayMs) && delayMs > 0) {
    runtimePatch.retry_mode = "retry";
    runtimePatch.retry_backoff_ms = delayMs;
    runtimePatch.next_retry_at = new Date(Date.parse(nowIso) + delayMs).toISOString();
    runtimePatch.last_recovery_action = recoverySession ? "retry_scheduled_after_rotated_session" : "retry_scheduled";
    return { exhausted: false, nextFailureCount, mode: "retry", delayMs };
  }

  runtimePatch.retry_mode = "probe";
  runtimePatch.retry_backoff_ms = runtimePatch.probe_every_ms;
  runtimePatch.next_retry_at = new Date(Date.parse(nowIso) + runtimePatch.probe_every_ms).toISOString();
  runtimePatch.last_recovery_action = "entered_probe_mode_after_retryable_failure";
  return { exhausted: true, nextFailureCount, mode: "probe", delayMs: runtimePatch.probe_every_ms };
}

export function applyNonRecoverableDispatchFailure({
  runtimePatch,
  dispatchKey,
  statusMtimeMs,
  reason,
  probeRetryDelayMs = DEFAULT_PROBE_RETRY_DELAY_MS,
  nowIso = new Date().toISOString(),
  resumeSignals = {},
  resumeSignalPaths = [],
}) {
  runtimePatch.last_recovery_session_id = "";
  runtimePatch.last_dispatch_key = dispatchKey;
  runtimePatch.last_dispatch_status_mtime_ms = statusMtimeMs;
  runtimePatch.last_failure_class = "blocked_repairable";
  runtimePatch.last_failure_reason = reason || String(runtimePatch.last_error || "blocked_dispatch_failure");
  runtimePatch.retry_mode = "probe";
  runtimePatch.retry_attempt = 0;
  runtimePatch.probe_every_ms = Number(probeRetryDelayMs || 0) || DEFAULT_PROBE_RETRY_DELAY_MS;
  runtimePatch.retry_backoff_ms = runtimePatch.probe_every_ms;
  runtimePatch.next_retry_at = new Date(Date.parse(nowIso) + runtimePatch.probe_every_ms).toISOString();
  runtimePatch.blocked_since = String(runtimePatch.blocked_since || nowIso);
  runtimePatch.last_dispatch_resume_signals = resumeSignals;
  runtimePatch.last_resume_signal_paths = resumeSignalPaths;
  runtimePatch.last_recovery_action = "blocked_repairable_waiting_for_probe_or_resume_signal";
}

export function clearDispatchFailure({ runtimePatch, failureCounts, dispatchKey, recoverySession }) {
  delete failureCounts[dispatchKey];
  runtimePatch.dispatch_failure_counts = failureCounts;
  delete runtimePatch.last_error;
  delete runtimePatch.last_dispatch_failed_at;
  delete runtimePatch.last_no_reply_signal;
  delete runtimePatch.last_transient_failure_signal;
  delete runtimePatch.last_failure_class;
  delete runtimePatch.last_failure_reason;
  delete runtimePatch.retry_mode;
  delete runtimePatch.retry_attempt;
  delete runtimePatch.retry_backoff_ms;
  delete runtimePatch.next_retry_at;
  delete runtimePatch.probe_every_ms;
  delete runtimePatch.blocked_since;
  delete runtimePatch.last_dispatch_resume_signals;
  delete runtimePatch.last_resume_signal_paths;
  runtimePatch.last_recovery_session_id = recoverySession;
  runtimePatch.last_recovery_action = recoverySession ? "rotated_session_after_failed_dispatch" : "";
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
