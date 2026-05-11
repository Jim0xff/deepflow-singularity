import { spawn } from "node:child_process";
import {
  applyNonRecoverableDispatchFailure,
  applyRecoverableDispatchFailure,
  canPromoteChangedFileDispatch,
  chunkMessageText,
  clearDispatchFailure,
  compactProjectHistoriesBeforeDispatch,
  dispatchResumeSignalPaths,
  dispatchFailureCounts,
  dispatchRecoveryPlan,
  hasNoReplySignal,
  hasTransientDeliveryFailureSignal,
  hasTransientDispatchFailureSignal,
  hasChangedRelativeFile,
  parseAgentPayloadTexts,
  parseLatestVerdict,
  relativeFileSignature,
  recoverySessionId,
  runOpenClawAgent,
  sendOpenClawMessage,
  shouldDispatchRepeated,
  snapshotDispatchResumeSignals,
  snapshotRelativeFileSignatures,
  stripLegacyActionMenu,
} from "../scripts/supervisor/lib.mjs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SUPERVISOR_CORE_PATH = join(__dirname, "..", "scripts", "supervisor", "core.mjs");
const SINGULARITY_ADAPTER_PATH = join(__dirname, "..", "scripts", "supervisor", "adapters", "singularity-flow.mjs");

async function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 50 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor timeout");
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 500)),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

async function createFakeOpenClawCli(rootDir) {
  const cliPath = join(rootDir, "fake-openclaw.mjs");
  await writeFile(
    cliPath,
    `
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

function projectDirFromMessage(message) {
  const match = String(message || "").match(/Project root:\\s*(.+)/);
  return match ? match[1].trim() : "";
}

function log(entry) {
  const logPath = process.env.FAKE_OPENCLAW_LOG;
  if (!logPath) return;
  appendFileSync(logPath, JSON.stringify(entry) + "\\n");
}

const command = process.argv[2] || "";

if (command === "message" && process.argv[3] === "send") {
  if (process.env.FAKE_MESSAGE_SEND_FAIL === "1") {
    log({
      kind: "message_failed",
      account: argValue("--account"),
      target: argValue("--target"),
      message: argValue("--message"),
    });
    process.stderr.write("telegram send failed");
    process.exit(1);
  }
  log({
    kind: "message",
    account: argValue("--account"),
    target: argValue("--target"),
    message: argValue("--message"),
  });
  process.stdout.write("{}");
  process.exit(0);
}

if (command === "agent") {
  const agentId = argValue("--agent");
  const message = argValue("--message");
  const projectDir = projectDirFromMessage(message);
  log({ kind: "agent", agentId, projectDir, message });
  const writerDraftText =
    process.env.FAKE_WRITER_MULTI_SECTION === "1"
      ? "# Recovered Draft\\n\\nintro\\n\\n## Section One\\n\\npart one\\n\\n## Section Two\\n\\npart two\\n\\n## Appendix\\n\\nappendix body"
      : "# Recovered Draft\\n\\nbody from fake writer";

  if (agentId === "singularity-writer") {
    if (process.env.FAKE_WRITER_KEEP_OUTPUT === "1") {
      process.stdout.write(JSON.stringify({ result: { payloads: [{ text: "# unchanged draft" }] } }));
      process.exit(0);
    }
      writeFileSync(path.join(projectDir, "output.md"), writerDraftText, "utf8");
      if (process.env.FAKE_WRITER_APPEND_HISTORY === "1") {
        writeFileSync(
          path.join(projectDir, "draft_review_history.md"),
          "## 2026-04-23T10:25:00Z | role: writer | type: draft_round\\nsummary\\n",
          "utf8",
        );
      }
      if (process.env.FAKE_WRITER_EXIT_CODE === "0") {
        process.stdout.write(JSON.stringify({ result: { payloads: [{ text: writerDraftText }] } }));
        process.exit(0);
      }
    } else if (agentId === "singularity-reviewer") {
      writeFileSync(
        path.join(projectDir, "draft_review_history.md"),
        [
          "## 2026-04-23T10:25:00Z | role: reviewer | type: editorial_review | target: output.md | review_target: draft | verdict: approved",
          "EDITORIAL_REVIEW",
        "稿件可通过。",
        "SHOULD_FIX",
        "- 节奏可继续微调。",
      ].join("\\n"),
      "utf8",
    );
  } else if (agentId === "singularity-main") {
    process.stdout.write(JSON.stringify({ result: { payloads: [{ text: "main menu" }] } }));
    process.exit(0);
  }

  process.stderr.write("read failed: Offset 350 is beyond end of file (235 lines total)");
  process.exit(1);
}

process.stderr.write("unsupported fake openclaw command");
process.exit(1);
`.trimStart(),
    "utf8",
  );
  return cliPath;
}

function parseJsonLines(text) {
  return String(text || "")
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function createSupervisorRecoveryFixture({ nextActor }) {
  const rootDir = await mkdtemp(join(tmpdir(), "supervisor-core-recovery-"));
  const projectDir = join(rootDir, "demo-project");
  const activeDir = join(rootDir, "active");
  const logPath = join(rootDir, "fake-openclaw.log");
  const cliPath = await createFakeOpenClawCli(rootDir);

  await mkdir(projectDir, { recursive: true });
  await mkdir(activeDir, { recursive: true });
  await writeFile(join(activeDir, "telegram:-10001.current"), "demo-project\n", "utf8");
  await writeFile(
    join(projectDir, "status.md"),
    [
      "project_id: demo-project",
      "status: active",
      "workflow_mode: auto",
      "current_step: step_7_drafting",
      `next_actor: ${nextActor}`,
      "awaiting_user_choice: no",
      "final_article_ready: no",
      "review_target: draft",
    ].join("\n") + "\n",
    "utf8",
  );
  await writeFile(join(projectDir, "project.md"), "title: demo\n", "utf8");
  await writeFile(join(projectDir, "handoff.md"), "## handoff\n", "utf8");
  await writeFile(join(projectDir, "interaction_log.md"), "## interaction\n", "utf8");
  await writeFile(join(projectDir, "materials.md"), "## materials\n", "utf8");
  await writeFile(join(projectDir, "output.md"), "# Old Draft\n\nold body", "utf8");
  await writeFile(join(projectDir, "draft_review_history.md"), "## old review\nverdict: changes_requested\n", "utf8");

  return { rootDir, projectDir, logPath, cliPath };
}

describe("supervisor dispatch dedupe", () => {
  test("failed dispatch must not advance dedupe cursor", () => {
    const runtime = {};
    const dispatchKey = "step7:100:writer";
    const statusMtimeMs = 100;
    const run = { status: 1, stdout: "", stderr: "boom" };

    const dispatched = run.status === 0;

    if (dispatched) {
      runtime.last_dispatch_key = dispatchKey;
      runtime.last_dispatch_status_mtime_ms = statusMtimeMs;
    } else {
      runtime.last_dispatch_failed_at = "now";
    }
    runtime.last_dispatch_exit_code = run.status;

    expect(runtime.last_dispatch_key).toBeUndefined();
    expect(runtime.last_dispatch_status_mtime_ms).toBeUndefined();
    expect(runtime.last_dispatch_failed_at).toBeDefined();
    expect(runtime.last_dispatch_exit_code).toBe(1);
  });

  test("agent dispatch can deliver to telegram and strips gateway url override", () => {
    let call;
    const run = runOpenClawAgent({
      agentId: "singularity-reviewer",
      message: "hello",
      openclawNode: "/node",
      openclawCli: "/openclaw.mjs",
      env: {
        OPENCLAW_GATEWAY_URL: "http://127.0.0.1:18789",
        CLAWDBOT_GATEWAY_URL: "http://127.0.0.1:18789",
        KEEP_ME: "yes",
      },
      delivery: {
        enabled: true,
        channel: "telegram",
        account: "singularity-reviewer",
        to: "-1003539190038",
      },
      spawnSyncImpl: (command, args, options) => {
        call = { command, args, options };
        return { status: 0, stdout: "{}", stderr: "" };
      },
    });

    expect(run.status).toBe(0);
    expect(call.command).toBe("/node");
    expect(call.args).toEqual([
      "/openclaw.mjs",
      "agent",
      "--agent",
      "singularity-reviewer",
      "--message",
      "hello",
      "--json",
      "--deliver",
      "--reply-channel",
      "telegram",
      "--reply-account",
      "singularity-reviewer",
      "--reply-to",
      "-1003539190038",
    ]);
    expect(call.options.env.OPENCLAW_GATEWAY_URL).toBeUndefined();
    expect(call.options.env.CLAWDBOT_GATEWAY_URL).toBeUndefined();
    expect(call.options.env.KEEP_ME).toBe("yes");
  });

  test("extracts and cleans agent payloads for explicit delivery", () => {
    const stdout = JSON.stringify({
      result: {
        payloads: [
          {
            text: [
              "正文",
              "",
              "1) 你直接提修改意见，我继续改稿",
              "2) 你直接 @REVIEWER_BOT 进行编审/反方审稿",
              "3) 你直接 @ORCHESTRATOR_BOT 保存成果",
              "4) 你直接 @ORCHESTRATOR_BOT 结束项目",
            ].join("\n"),
          },
        ],
      },
    });

    expect(parseAgentPayloadTexts(stdout)).toHaveLength(1);
    expect(stripLegacyActionMenu(parseAgentPayloadTexts(stdout)[0])).toBe("正文");
    expect(chunkMessageText("a".repeat(7200))).toHaveLength(3);
  });

  test("extracts agent payloads when stdout has diagnostic log lines", () => {
    const stdout = [
      "[agents/auth-profiles] inherited auth-profiles from main agent",
      JSON.stringify({
        payloads: [{ text: "本轮对垒已完成。" }],
      }),
    ].join("\n");

    expect(parseAgentPayloadTexts(stdout)).toEqual(["本轮对垒已完成。"]);
  });

  test("extracts payloads when diagnostic lines contain JSON", () => {
    const stdout = [
      JSON.stringify({ level: "info", msg: "startup" }),
      `[auth] config ${JSON.stringify({ profile: "main" })}`,
      JSON.stringify({
        result: {
          payloads: [{ text: "正文" }],
        },
      }),
    ].join("\n");

    expect(parseAgentPayloadTexts(stdout)).toEqual(["正文"]);
  });

  test("extracts pretty printed payload after diagnostic JSON", () => {
    const stdout = [
      JSON.stringify({ level: "info", msg: "startup" }),
      "[auth] config {\"profile\":\"main\"}",
      JSON.stringify(
        {
          result: {
            payloads: [{ text: "pretty 正文 {不是日志}" }],
          },
        },
        null,
        2,
      ),
    ].join("\n");

    expect(parseAgentPayloadTexts(stdout)).toEqual(["pretty 正文 {不是日志}"]);
  });

  test("explicit message delivery uses openclaw message send", () => {
    let call;
    const run = sendOpenClawMessage({
      account: "singularity-writer",
      channel: "telegram",
      target: "-1003539190038",
      message: "draft",
      openclawNode: "/node",
      openclawCli: "/openclaw.mjs",
      env: {
        OPENCLAW_GATEWAY_URL: "http://127.0.0.1:18789",
        KEEP_ME: "yes",
      },
      spawnSyncImpl: (command, args, options) => {
        call = { command, args, options };
        return { status: 0, stdout: "{}", stderr: "" };
      },
    });

    expect(run.status).toBe(0);
    expect(call.args).toEqual([
      "/openclaw.mjs",
      "message",
      "send",
      "--channel",
      "telegram",
      "--account",
      "singularity-writer",
      "--target",
      "-1003539190038",
      "--message",
      "draft",
      "--json",
    ]);
    expect(call.options.env.OPENCLAW_GATEWAY_URL).toBeUndefined();
    expect(call.options.env.KEEP_ME).toBe("yes");
  });

  test("parses latest reviewer verdict variants", () => {
    expect(parseLatestVerdict("## review\nVerdict: approved")).toBe("approved");
    expect(parseLatestVerdict("## review\nVERDICT_approved")).toBe("approved");
    expect(parseLatestVerdict("## review\nverdict=changes_requested")).toBe("changes_requested");
    expect(parseLatestVerdict("## review\n本轮审核通过")).toBe("approved");
    expect(parseLatestVerdict("## review\n需要修改：结构问题")).toBe("changes_requested");
    expect(parseLatestVerdict("## review\n未通过，需要修改")).toBe("changes_requested");
    expect(parseLatestVerdict("## review\n不能通过，继续修改")).toBe("changes_requested");
    expect(parseLatestVerdict("## review\n不可通过")).toBe("changes_requested");
  });

  test("detects no-reply dispatch output", () => {
    expect(hasNoReplySignal({ stdout: "NO_REPLY", stderr: "" })).toBe(true);
    expect(hasNoReplySignal({ stdout: "", stderr: "agent returned no_reply" })).toBe(true);
    expect(hasNoReplySignal({ stdout: "normal payload", stderr: "" })).toBe(false);
  });

  test("detects transient dispatch failures from embedded runtime errors", () => {
    expect(hasTransientDispatchFailureSignal({ stdout: "NO_REPLY", stderr: "" })).toBe(true);
    expect(
      hasTransientDispatchFailureSignal({
        stdout: "",
        stderr: "read failed: Offset 350 is beyond end of file (235 lines total)",
      }),
    ).toBe(true);
    expect(
      hasTransientDispatchFailureSignal({
        stdout: "",
        stderr: "[agent/embedded] embedded run agent end: id=1 isError=true error=terminated",
      }),
    ).toBe(true);
    expect(hasTransientDispatchFailureSignal({ stdout: "{}", stderr: "" })).toBe(false);
    expect(hasTransientDeliveryFailureSignal("telegram timeout 503")).toBe(true);
  });

  test("detects changed files by signature instead of mtime only", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "supervisor-signature-"));
    const target = join(projectDir, "output.md");
    await writeFile(target, "draft v1", "utf8");

    const snapshot = snapshotRelativeFileSignatures(projectDir, ["output.md"]);
    expect(relativeFileSignature(projectDir, "output.md")).toBe(snapshot["output.md"]);

    await writeFile(target, "draft v2", "utf8");
    expect(hasChangedRelativeFile(projectDir, snapshot)).toBe(true);

    await rm(projectDir, { recursive: true, force: true });
  });

  test("promotes changed-file dispatches after transient writer failures", () => {
    expect(
      canPromoteChangedFileDispatch({
        dispatch: {
          suppressDelivery: true,
          deliverRequiresChangedFile: true,
          afterSuccessPatch: { next_actor: "reviewer" },
        },
        successFilesChanged: true,
        transientDispatchFailure: true,
      }),
    ).toBe(true);

    expect(
      canPromoteChangedFileDispatch({
        dispatch: {
          deliverRequiresChangedFile: true,
          afterSuccessPatchFromLatestVerdict: true,
        },
        successFilesChanged: true,
        transientDispatchFailure: true,
        parsedVerdict: "",
      }),
    ).toBe(false);

    expect(
      canPromoteChangedFileDispatch({
        dispatch: {
          deliverRequiresChangedFile: true,
          afterSuccessPatchFromLatestVerdict: true,
        },
        successFilesChanged: true,
        transientDispatchFailure: true,
        parsedVerdict: "approved",
      }),
    ).toBe(true);
  });

  test("normalizes dispatch failure counts", () => {
    expect(
      dispatchFailureCounts({
        dispatch_failure_counts: {
          "step7:100:writer": 2,
          "step7:101:writer": "3",
          stale: 0,
          bad: "nan",
        },
      }),
    ).toEqual({
      "step7:100:writer": 2,
      "step7:101:writer": 3,
    });
    expect(dispatchFailureCounts({ dispatch_failure_counts: [] })).toEqual({});
  });

  test("compacts draft_review_history markdown-field and timestamp-style blocks", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "supervisor-compact-draft-history-"));
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      Array.from({ length: 72 }, (_, index) =>
        index % 2 === 0
          ? [
              `### Round: 2026-04-${String((index % 28) + 1).padStart(2, "0")} Draft Re-review Feedback`,
              "",
              `- **timestamp**: 2026-04-27 14:${String(index).padStart(2, "0")}:57 UTC`,
              "- **role**: editor",
              "- **type**: step_7_feedback",
              `- **instruction**: ${"x".repeat(2600)}`,
              "",
            ].join("\n")
          : [
              "---",
              `[2026-04-27T14:${String(index).padStart(2, "0")}:57Z]`,
              "actor: editor",
              "type: step_7_feedback",
              `instruction: ${"y".repeat(2600)}`,
              "",
            ].join("\n"),
      ).join("\n"),
      "utf8",
    );
    await writeFile(join(projectDir, "interaction_log.md"), "## interaction\n", "utf8");

    const result = compactProjectHistoriesBeforeDispatch(projectDir, "writer");
    expect(result?.files.some((file) => file.file === "draft_review_history.md")).toBe(true);

    const compacted = await readFile(join(projectDir, "draft_review_history.md"), "utf8");
    expect(compacted.startsWith("<!-- history_compacted")).toBe(true);
    expect(Buffer.byteLength(compacted, "utf8")).toBeLessThanOrEqual(80 * 1024);

    await rm(projectDir, { recursive: true, force: true });
  });

  test("keeps the latest full draft_review_history block when it alone exceeds target", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "supervisor-compact-draft-latest-full-"));
    const latestBlock = [
      "## 2026-05-06T09:00:00Z | role: writer | type: draft_round",
      "EDITORIAL_REVIEW:",
      `latest huge block ${"k".repeat(110 * 1024)}`,
    ].join("\n");
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "## 2026-05-06T08:00:00Z | role: reviewer | type: editorial_review",
        "older block",
        "",
        latestBlock,
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(projectDir, "interaction_log.md"), "## interaction\n", "utf8");

    const result = compactProjectHistoriesBeforeDispatch(projectDir, "writer");
    expect(result?.files.some((file) => file.file === "draft_review_history.md")).toBe(true);

    const compacted = await readFile(join(projectDir, "draft_review_history.md"), "utf8");
    expect(compacted.startsWith("<!-- history_compacted")).toBe(true);
    expect(compacted).toContain("## 2026-05-06T09:00:00Z | role: writer | type: draft_round");
    expect(compacted).toContain(`latest huge block ${"k".repeat(1024)}`);

    await rm(projectDir, { recursive: true, force: true });
  });

  test("builds sanitized recovery session ids", () => {
    const sessionId = recoverySessionId({
      projectDir: `/tmp/projects/${"very-long-project-".repeat(20)}`,
      actor: "writer",
      dispatchKey: "step7:1776701039723.5732:writer:with/symbols",
      attempt: 2,
    });

    expect(sessionId).toMatch(/^[a-z0-9_-]+$/);
    expect(sessionId.length).toBeLessThanOrEqual(180);
    expect(sessionId).toMatch(/-[a-f0-9]{12}-2$/);
  });

  test("recoverable no-reply failures schedule retries and then enter probe mode", () => {
    const dispatchKey = "step7:100:writer";
    const statusMtimeMs = 100;
    const runtime = {};
    const firstPlan = dispatchRecoveryPlan({
      runtime,
      projectDir: "/tmp/projects/demo",
      actor: "writer",
      dispatchKey,
    });

    expect(firstPlan.recoverySession).toBe("");

    const firstPatch = {};
    applyRecoverableDispatchFailure({
      runtimePatch: firstPatch,
      failureCounts: firstPlan.failureCounts,
      dispatchKey,
      previousFailureCount: firstPlan.previousFailureCount,
      recoverySession: firstPlan.recoverySession,
      statusMtimeMs,
      nowIso: "2026-04-23T00:00:00.000Z",
      reason: "no_reply",
    });

    expect(firstPatch.dispatch_failure_counts).toEqual({ [dispatchKey]: 1 });
    expect(firstPatch.last_recovery_action).toBe("retry_scheduled");
    expect(firstPatch.last_dispatch_key).toBe(dispatchKey);
    expect(firstPatch.last_dispatch_status_mtime_ms).toBe(statusMtimeMs);
    expect(firstPatch.retry_mode).toBe("retry");
    expect(firstPatch.retry_backoff_ms).toBe(15_000);
    expect(firstPatch.next_retry_at).toBe("2026-04-23T00:00:15.000Z");

    const retryPlan = dispatchRecoveryPlan({
      runtime: firstPatch,
      projectDir: "/tmp/projects/demo",
      actor: "writer",
      dispatchKey,
    });

    expect(retryPlan.recoverySession).toMatch(/^supervisor-recovery-demo-writer-[a-f0-9]{12}-1$/);

    const secondPatch = {};
    applyRecoverableDispatchFailure({
      runtimePatch: secondPatch,
      failureCounts: retryPlan.failureCounts,
      dispatchKey,
      previousFailureCount: retryPlan.previousFailureCount,
      recoverySession: retryPlan.recoverySession,
      statusMtimeMs,
      nowIso: "2026-04-23T00:01:00.000Z",
      reason: "no_reply",
    });

    expect(secondPatch.dispatch_failure_counts).toEqual({ [dispatchKey]: 2 });
    expect(secondPatch.last_recovery_action).toBe("retry_scheduled_after_rotated_session");
    expect(secondPatch.last_dispatch_key).toBe(dispatchKey);
    expect(secondPatch.last_dispatch_status_mtime_ms).toBe(statusMtimeMs);
    expect(secondPatch.retry_mode).toBe("retry");
    expect(secondPatch.retry_backoff_ms).toBe(60_000);
    expect(secondPatch.next_retry_at).toBe("2026-04-23T00:02:00.000Z");

    const probePatch = {};
    applyRecoverableDispatchFailure({
      runtimePatch: probePatch,
      failureCounts: { ...secondPatch.dispatch_failure_counts },
      dispatchKey,
      previousFailureCount: 2,
      recoverySession: "",
      statusMtimeMs,
      nowIso: "2026-04-23T00:03:00.000Z",
      reason: "no_reply",
    });

    expect(probePatch.dispatch_failure_counts).toEqual({ [dispatchKey]: 3 });
    expect(probePatch.last_recovery_action).toBe("entered_probe_mode_after_retryable_failure");
    expect(probePatch.retry_mode).toBe("probe");
    expect(probePatch.retry_backoff_ms).toBe(0);
    expect(probePatch.probe_attempt).toBe(1);
    expect(probePatch.next_retry_at).toBe("2026-04-23T00:03:00.000Z");
    expect(probePatch.last_dispatch_key).toBe(dispatchKey);
  });

  test("recoverable probe retries run on the next tick for the first three probe attempts, then switch to 15 minutes", () => {
    const dispatchKey = "step7:100:writer";
    const statusMtimeMs = 100;

    const firstProbePatch = {};
    applyRecoverableDispatchFailure({
      runtimePatch: firstProbePatch,
      failureCounts: {},
      dispatchKey,
      previousFailureCount: 2,
      recoverySession: "",
      statusMtimeMs,
      nowIso: "2026-04-23T00:03:00.000Z",
      reason: "no_reply",
    });
    expect(firstProbePatch.retry_mode).toBe("probe");
    expect(firstProbePatch.probe_attempt).toBe(1);
    expect(firstProbePatch.retry_backoff_ms).toBe(0);
    expect(firstProbePatch.next_retry_at).toBe("2026-04-23T00:03:00.000Z");

    const thirdProbePatch = {};
    applyRecoverableDispatchFailure({
      runtimePatch: thirdProbePatch,
      failureCounts: {},
      dispatchKey,
      previousFailureCount: 4,
      recoverySession: "",
      statusMtimeMs,
      nowIso: "2026-04-23T00:09:00.000Z",
      reason: "no_reply",
    });
    expect(thirdProbePatch.retry_mode).toBe("probe");
    expect(thirdProbePatch.probe_attempt).toBe(3);
    expect(thirdProbePatch.retry_backoff_ms).toBe(0);
    expect(thirdProbePatch.next_retry_at).toBe("2026-04-23T00:09:00.000Z");

    const fourthProbePatch = {};
    applyRecoverableDispatchFailure({
      runtimePatch: fourthProbePatch,
      failureCounts: {},
      dispatchKey,
      previousFailureCount: 5,
      recoverySession: "",
      statusMtimeMs,
      nowIso: "2026-04-23T00:12:00.000Z",
      reason: "no_reply",
    });
    expect(fourthProbePatch.retry_mode).toBe("probe");
    expect(fourthProbePatch.probe_attempt).toBe(4);
    expect(fourthProbePatch.retry_backoff_ms).toBe(900_000);
    expect(fourthProbePatch.next_retry_at).toBe("2026-04-23T00:27:00.000Z");
  });

  test("successful recovery clears failure counters", () => {
    const dispatchKey = "step7:100:writer";
    const runtimePatch = {
      last_error: "expected_file_not_changed",
      last_dispatch_failed_at: "now",
      last_no_reply_signal: "yes",
      last_transient_failure_signal: "yes",
      last_failure_class: "retryable",
      last_failure_reason: "no_reply",
      retry_mode: "probe",
      retry_attempt: 3,
      retry_backoff_ms: 900000,
      next_retry_at: "later",
      probe_every_ms: 900000,
      blocked_since: "before",
      last_dispatch_resume_signals: { "output.md": "sig" },
      last_resume_signal_paths: ["output.md"],
    };
    const failureCounts = { [dispatchKey]: 1, other: 2 };

    clearDispatchFailure({
      runtimePatch,
      failureCounts,
      dispatchKey,
      recoverySession: "supervisor-recovery-demo-writer-hash-1",
    });

    expect(runtimePatch.dispatch_failure_counts).toEqual({ other: 2 });
    expect(runtimePatch.last_error).toBeUndefined();
    expect(runtimePatch.last_dispatch_failed_at).toBeUndefined();
    expect(runtimePatch.last_no_reply_signal).toBeUndefined();
    expect(runtimePatch.last_transient_failure_signal).toBeUndefined();
    expect(runtimePatch.last_failure_class).toBeUndefined();
    expect(runtimePatch.last_failure_reason).toBeUndefined();
    expect(runtimePatch.retry_mode).toBeUndefined();
    expect(runtimePatch.next_retry_at).toBeUndefined();
    expect(runtimePatch.last_dispatch_resume_signals).toBeUndefined();
    expect(runtimePatch.last_recovery_action).toBe("rotated_session_after_failed_dispatch");
  });

  test("blocked repairable failures enter probe mode without rotating session", () => {
    const runtimePatch = {};
    applyNonRecoverableDispatchFailure({
      runtimePatch,
      dispatchKey: "step7:100:writer",
      statusMtimeMs: 100,
      reason: "expected_file_not_changed",
      nowIso: "2026-04-23T00:00:00.000Z",
    });

    expect(runtimePatch.last_recovery_session_id).toBe("");
    expect(runtimePatch.last_recovery_action).toBe("blocked_repairable_waiting_for_probe_or_resume_signal");
    expect(runtimePatch.last_dispatch_key).toBe("step7:100:writer");
    expect(runtimePatch.last_dispatch_status_mtime_ms).toBe(100);
    expect(runtimePatch.last_failure_class).toBe("blocked_repairable");
    expect(runtimePatch.last_failure_reason).toBe("expected_file_not_changed");
    expect(runtimePatch.retry_mode).toBe("probe");
    expect(runtimePatch.retry_attempt).toBe(1);
    expect(runtimePatch.probe_attempt).toBe(1);
    expect(runtimePatch.retry_backoff_ms).toBe(0);
    expect(runtimePatch.next_retry_at).toBe("2026-04-23T00:00:00.000Z");
  });

  test("blocked repairable probe retries run on the next tick for the first three attempts, then 15 minutes", () => {
    const secondPatch = {};
    applyNonRecoverableDispatchFailure({
      runtimePatch: secondPatch,
      dispatchKey: "step7:100:writer",
      statusMtimeMs: 100,
      reason: "expected_file_not_changed",
      previousProbeAttempt: 1,
      nowIso: "2026-04-23T00:03:00.000Z",
    });
    expect(secondPatch.probe_attempt).toBe(2);
    expect(secondPatch.retry_backoff_ms).toBe(0);
    expect(secondPatch.next_retry_at).toBe("2026-04-23T00:03:00.000Z");

    const thirdPatch = {};
    applyNonRecoverableDispatchFailure({
      runtimePatch: thirdPatch,
      dispatchKey: "step7:100:writer",
      statusMtimeMs: 100,
      reason: "expected_file_not_changed",
      previousProbeAttempt: 2,
      nowIso: "2026-04-23T00:06:00.000Z",
    });
    expect(thirdPatch.probe_attempt).toBe(3);
    expect(thirdPatch.retry_backoff_ms).toBe(0);
    expect(thirdPatch.next_retry_at).toBe("2026-04-23T00:06:00.000Z");

    const fourthPatch = {};
    applyNonRecoverableDispatchFailure({
      runtimePatch: fourthPatch,
      dispatchKey: "step7:100:writer",
      statusMtimeMs: 100,
      reason: "expected_file_not_changed",
      previousProbeAttempt: 3,
      nowIso: "2026-04-23T00:09:00.000Z",
    });
    expect(fourthPatch.probe_attempt).toBe(4);
    expect(fourthPatch.retry_backoff_ms).toBe(900_000);
    expect(fourthPatch.next_retry_at).toBe("2026-04-23T00:24:00.000Z");
  });

  test("repeated dispatch waits for retry window unless resume signals change", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "supervisor-repeated-"));
    const outputPath = join(projectDir, "output.md");
    await writeFile(outputPath, "draft v1", "utf8");

    expect(dispatchResumeSignalPaths({ afterSuccessWhenFilesChanged: ["output.md"], deliverFromChangedFile: "output.md" })).toEqual([
      "output.md",
    ]);

    const resumeSignals = snapshotDispatchResumeSignals(projectDir, {
      afterSuccessWhenFilesChanged: ["output.md"],
      deliverFromChangedFile: "output.md",
    });

    const waitingRuntime = {
      last_failure_class: "retryable",
      retry_mode: "probe",
      next_retry_at: "2099-01-01T00:00:00.000Z",
      last_dispatch_resume_signals: resumeSignals.snapshot,
    };

    expect(shouldDispatchRepeated({ runtime: waitingRuntime, projectDir })).toEqual({
      shouldDispatch: false,
      reason: "waiting_for_retry_window",
    });

    await writeFile(outputPath, "draft v2", "utf8");
    expect(shouldDispatchRepeated({ runtime: waitingRuntime, projectDir }).reason).toBe("resume_signal_changed");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("core watch promotes writer changed-file recovery after transient failure", async () => {
    const { rootDir, projectDir, logPath, cliPath } = await createSupervisorRecoveryFixture({ nextActor: "writer" });
    const child = spawn(
      process.execPath,
      [
        SUPERVISOR_CORE_PATH,
        "watch",
        "--project-dir",
        projectDir,
        "--adapter",
        SINGULARITY_ADAPTER_PATH,
        "--poll-ms",
        "50",
      ],
      {
        cwd: join(__dirname, ".."),
        env: {
          ...process.env,
          OPENCLAW_NODE: process.execPath,
          OPENCLAW_CLI: cliPath,
          FAKE_OPENCLAW_LOG: logPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      await waitFor(async () => {
        const statusText = await readFile(join(projectDir, "status.md"), "utf8");
        return statusText.includes("next_actor: reviewer") ? statusText : "";
      });

      const runtime = JSON.parse(await readFile(join(projectDir, "runtime", "supervisor.json"), "utf8"));
      expect(runtime.last_dispatch_actor).toBe("writer");
      expect(runtime.last_recovery_action).toBe("accepted_changed_files_after_transient_failure_and_delivered_from_file");
      expect(runtime.last_failure_class).toBeUndefined();

      const logEntries = parseJsonLines(await readFile(logPath, "utf8"));
      expect(logEntries.some((entry) => entry.kind === "message" && entry.account === "singularity-main")).toBe(true);
      expect(logEntries.some((entry) => entry.kind === "message" && /Recovered Draft/.test(entry.message))).toBe(true);
    } finally {
      await stopChild(child);
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 10_000);

  test("core watch compacts oversized history files before writer dispatch", async () => {
    const { rootDir, projectDir, cliPath } = await createSupervisorRecoveryFixture({ nextActor: "writer" });
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      Array.from(
        { length: 140 },
        (_, index) =>
          [
            `## 2026-04-23T10:${String(index).padStart(2, "0")}:00Z | role: reviewer | type: editorial_review`,
            "EDITORIAL_REVIEW:",
            `legacy review detail ${String(index).padStart(3, "0")} ${"x".repeat(900)}`,
            "MUST_FIX:",
            `- fix ${"y".repeat(400)}`,
          ].join("\n"),
      ).join("\n\n"),
      "utf8",
    );
    await writeFile(
      join(projectDir, "interaction_log.md"),
      Array.from(
        { length: 2200 },
        (_, index) => `2026-04-23T10:${String(index % 60).padStart(2, "0")}:00Z | step7 | legacy log ${index} ${"z".repeat(40)}`,
      ).join("\n"),
      "utf8",
    );

    const child = spawn(
      process.execPath,
      [
        SUPERVISOR_CORE_PATH,
        "watch",
        "--project-dir",
        projectDir,
        "--adapter",
        SINGULARITY_ADAPTER_PATH,
        "--poll-ms",
        "50",
      ],
      {
        cwd: join(__dirname, ".."),
        env: {
          ...process.env,
          OPENCLAW_NODE: process.execPath,
          OPENCLAW_CLI: cliPath,
          FAKE_WRITER_EXIT_CODE: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      await waitFor(async () => {
        const outputText = await readFile(join(projectDir, "output.md"), "utf8");
        return outputText.includes("Recovered Draft") ? outputText : "";
      });

      const archives = await readdir(join(projectDir, "archives"));
      expect(archives.some((name) => name.startsWith("draft_review_history."))).toBe(true);

      const draftReviewHistoryText = await readFile(join(projectDir, "draft_review_history.md"), "utf8");
      const interactionLogText = await readFile(join(projectDir, "interaction_log.md"), "utf8");
      expect(draftReviewHistoryText.startsWith("<!-- history_compacted")).toBe(true);
      expect(interactionLogText.startsWith("<!-- history_compacted")).toBe(false);
      expect(Buffer.byteLength(draftReviewHistoryText, "utf8")).toBeLessThanOrEqual(80 * 1024);

      const dispatchHistory = parseJsonLines(await readFile(join(projectDir, "runtime", "dispatch-history.jsonl"), "utf8"));
      const compactionEvent = dispatchHistory.find((entry) => entry.event === "history_compacted");
      expect(compactionEvent?.actor).toBe("writer");
      expect(compactionEvent?.files?.map((file) => file.file)).toEqual(expect.arrayContaining(["draft_review_history.md"]));
    } finally {
      await stopChild(child);
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 10_000);

  test("core watch delivers full writer draft from output.md instead of only the last markdown block", async () => {
    const { rootDir, projectDir, logPath, cliPath } = await createSupervisorRecoveryFixture({ nextActor: "writer" });
    const child = spawn(
      process.execPath,
      [
        SUPERVISOR_CORE_PATH,
        "watch",
        "--project-dir",
        projectDir,
        "--adapter",
        SINGULARITY_ADAPTER_PATH,
        "--poll-ms",
        "50",
      ],
      {
        cwd: join(__dirname, ".."),
        env: {
          ...process.env,
          OPENCLAW_NODE: process.execPath,
          OPENCLAW_CLI: cliPath,
          FAKE_OPENCLAW_LOG: logPath,
          FAKE_WRITER_MULTI_SECTION: "1",
          FAKE_WRITER_EXIT_CODE: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      await waitFor(async () => {
        let text = "";
        try {
          text = await readFile(logPath, "utf8");
        } catch {
          return null;
        }
        const logEntries = parseJsonLines(text);
        return logEntries.find((entry) => entry.kind === "message" && entry.account === "singularity-main") || null;
      });

      const logEntries = parseJsonLines(await readFile(logPath, "utf8"));
      const delivery = logEntries.find((entry) => entry.kind === "message" && entry.account === "singularity-main");
      expect(delivery.message).toContain("# Recovered Draft");
      expect(delivery.message).toContain("## Section One");
      expect(delivery.message).toContain("## Section Two");
      expect(delivery.message).toContain("## Appendix");
      expect(delivery.message.startsWith("## Appendix")).toBe(false);
    } finally {
      await stopChild(child);
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 10_000);

  test("core watch delivers final-output.md and appends the fixed final article menu", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "supervisor-core-final-main-"));
    const projectDir = join(rootDir, "demo-project");
    const activeDir = join(rootDir, "active");
    const logPath = join(rootDir, "fake-openclaw.log");
    const cliPath = await createFakeOpenClawCli(rootDir);

    await mkdir(projectDir, { recursive: true });
    await mkdir(activeDir, { recursive: true });
    await writeFile(join(activeDir, "telegram:-10001.current"), "demo-project\n", "utf8");
    await writeFile(
      join(projectDir, "status.md"),
      [
        "project_id: demo-project",
        "status: active",
        "workflow_mode: auto",
        "current_step: step_8_final_article",
        "next_actor: main",
        "awaiting_user_choice: no",
        "final_article_ready: yes",
        "review_target: final",
      ].join("\n") + "\n",
      "utf8"
    );
    await writeFile(join(projectDir, "project.md"), "title: demo\n", "utf8");
    await writeFile(join(projectDir, "final-output.md"), "# Final Title\n\nfinal body", "utf8");
    await writeFile(join(projectDir, "draft_review_history.md"), "## old review\nverdict: approved\n", "utf8");

    const child = spawn(
      process.execPath,
      [
        SUPERVISOR_CORE_PATH,
        "watch",
        "--project-dir",
        projectDir,
        "--adapter",
        SINGULARITY_ADAPTER_PATH,
        "--poll-ms",
        "50",
      ],
      {
        cwd: join(__dirname, ".."),
        env: {
          ...process.env,
          OPENCLAW_NODE: process.execPath,
          OPENCLAW_CLI: cliPath,
          FAKE_OPENCLAW_LOG: logPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    try {
      await waitFor(async () => {
        let text = "";
        try {
          text = await readFile(logPath, "utf8");
        } catch {
          return null;
        }
        const logEntries = parseJsonLines(text);
        return logEntries.find((entry) => entry.kind === "message" && entry.account === "singularity-main") || null;
      });

      const logEntries = parseJsonLines(await readFile(logPath, "utf8"));
      const delivery = logEntries.find((entry) => entry.kind === "message" && entry.account === "singularity-main");
      expect(delivery.message).toContain("# Final Title");
      expect(delivery.message).toContain("final body");
      expect(delivery.message).toContain("正式稿已生成，当前仍在正式稿阶段，请确认下一步。");
      expect(delivery.message).toContain("1. 确认文章 OK");
      expect(delivery.message).toContain("附加命令：素材包（当前未绑定）");
      expect(delivery.message).not.toContain("main menu");
    } finally {
      await stopChild(child);
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 10_000);

  test("core watch advances writer after file success even when delivery fails", async () => {
    const { rootDir, projectDir, logPath, cliPath } = await createSupervisorRecoveryFixture({ nextActor: "writer" });
    const child = spawn(
      process.execPath,
      [
        SUPERVISOR_CORE_PATH,
        "watch",
        "--project-dir",
        projectDir,
        "--adapter",
        SINGULARITY_ADAPTER_PATH,
        "--poll-ms",
        "50",
      ],
      {
        cwd: join(__dirname, ".."),
        env: {
          ...process.env,
          OPENCLAW_NODE: process.execPath,
          OPENCLAW_CLI: cliPath,
          FAKE_OPENCLAW_LOG: logPath,
          FAKE_MESSAGE_SEND_FAIL: "1",
          FAKE_WRITER_EXIT_CODE: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      await waitFor(async () => {
        const statusText = await readFile(join(projectDir, "status.md"), "utf8");
        return statusText.includes("next_actor: reviewer") ? statusText : "";
      });

      const runtime = JSON.parse(await readFile(join(projectDir, "runtime", "supervisor.json"), "utf8"));
      expect(runtime.last_dispatch_actor).toBe("writer");
      expect(runtime.last_error).toBeUndefined();
      expect(runtime.last_failure_class).toBeUndefined();
      expect(runtime.last_recovery_action).toBe("delivery_failed_but_advanced_after_success");
      expect(runtime.last_delivery_error).toBe("telegram send failed");

      const statusText = await readFile(join(projectDir, "status.md"), "utf8");
      expect(statusText).toContain("next_actor: reviewer");

      const logEntries = parseJsonLines(await readFile(logPath, "utf8"));
      expect(logEntries.some((entry) => entry.kind === "message_failed" && entry.account === "singularity-main")).toBe(
        true,
      );
    } finally {
      await stopChild(child);
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 10_000);

  test("core watch self-heals to main menu when writer succeeds without changing output", async () => {
    const { rootDir, projectDir, logPath, cliPath } = await createSupervisorRecoveryFixture({ nextActor: "writer" });
    const child = spawn(
      process.execPath,
      [
        SUPERVISOR_CORE_PATH,
        "watch",
        "--project-dir",
        projectDir,
        "--adapter",
        SINGULARITY_ADAPTER_PATH,
        "--poll-ms",
        "50",
      ],
      {
        cwd: join(__dirname, ".."),
        env: {
          ...process.env,
          OPENCLAW_NODE: process.execPath,
          OPENCLAW_CLI: cliPath,
          FAKE_OPENCLAW_LOG: logPath,
          FAKE_WRITER_KEEP_OUTPUT: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      await waitFor(async () => {
        try {
          const runtime = JSON.parse(await readFile(join(projectDir, "runtime", "supervisor.json"), "utf8"));
          return runtime.last_dispatch_actor === "main"
            && runtime.last_recovery_action === "step7_writer_no_change_returned_to_menu"
            ? runtime
            : null;
        } catch {
          return null;
        }
      });

      const runtime = JSON.parse(await readFile(join(projectDir, "runtime", "supervisor.json"), "utf8"));
      expect(runtime.last_dispatch_actor).toBe("main");
      expect(runtime.last_recovery_action).toBe("step7_writer_no_change_returned_to_menu");
      expect(runtime.last_failure_class).toBeUndefined();
      expect(runtime.last_dispatch_message).toContain("本轮改稿未产生新的正文版本");
      expect(runtime.last_dispatch_stdout).toContain("main menu");
      expect(runtime.last_dispatch_stdout).not.toContain("unchanged draft");
      expect(runtime.last_dispatch_stderr).toBe("");
      expect(runtime.last_dispatch_exit_code).toBe(0);

      const statusText = await readFile(join(projectDir, "status.md"), "utf8");
      expect(statusText).toContain("workflow_mode: manual");
      expect(statusText).toContain("active_menu_scope: step_7_menu");

      const logEntries = parseJsonLines(await readFile(logPath, "utf8"));
      expect(logEntries.some((entry) => entry.kind === "agent" && entry.agentId === "singularity-main")).toBe(true);
      expect(logEntries.some((entry) => entry.kind === "message" && entry.account === "singularity-main")).toBe(true);
      expect(logEntries.some((entry) => entry.kind === "message" && /main menu/.test(entry.message))).toBe(true);
    } finally {
      await stopChild(child);
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 10_000);

  test("core watch does not advance to manual step7 when self-heal menu delivery fails", async () => {
    const { rootDir, projectDir, logPath, cliPath } = await createSupervisorRecoveryFixture({ nextActor: "writer" });
    const child = spawn(
      process.execPath,
      [
        SUPERVISOR_CORE_PATH,
        "watch",
        "--project-dir",
        projectDir,
        "--adapter",
        SINGULARITY_ADAPTER_PATH,
        "--poll-ms",
        "50",
      ],
      {
        cwd: join(__dirname, ".."),
        env: {
          ...process.env,
          OPENCLAW_NODE: process.execPath,
          OPENCLAW_CLI: cliPath,
          FAKE_OPENCLAW_LOG: logPath,
          FAKE_WRITER_KEEP_OUTPUT: "1",
          FAKE_MESSAGE_SEND_FAIL: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      await waitFor(async () => {
        try {
          const runtime = JSON.parse(await readFile(join(projectDir, "runtime", "supervisor.json"), "utf8"));
          return runtime.last_failure_reason === "delivery_failed" ? runtime : null;
        } catch {
          return null;
        }
      });

      const runtime = JSON.parse(await readFile(join(projectDir, "runtime", "supervisor.json"), "utf8"));
      expect(runtime.last_failure_class).toBe("blocked_repairable");
      expect(runtime.last_failure_reason).toBe("delivery_failed");
      expect(runtime.last_recovery_action).toBe("blocked_repairable_waiting_for_probe_or_resume_signal");
      expect(runtime.last_recovery_action).not.toBe("step7_writer_no_change_returned_to_menu");
      expect(runtime.last_dispatch_actor).not.toBe("main");

      const statusText = await readFile(join(projectDir, "status.md"), "utf8");
      expect(statusText).toContain("workflow_mode: auto");
      expect(statusText).toContain("next_actor: writer");
      expect(statusText).not.toContain("active_menu_scope: step_7_menu");

      const logEntries = parseJsonLines(await readFile(logPath, "utf8"));
      expect(logEntries.some((entry) => entry.kind === "agent" && entry.agentId === "singularity-main")).toBe(true);
      expect(logEntries.filter((entry) => entry.kind === "message_failed" && entry.account === "singularity-main").length)
        .toBeGreaterThanOrEqual(2);
    } finally {
      await stopChild(child);
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 10_000);

  test("core watch promotes reviewer changed-file recovery by verdict after transient failure", async () => {
    const { rootDir, projectDir, logPath, cliPath } = await createSupervisorRecoveryFixture({ nextActor: "reviewer" });
    const child = spawn(
      process.execPath,
      [
        SUPERVISOR_CORE_PATH,
        "watch",
        "--project-dir",
        projectDir,
        "--adapter",
        SINGULARITY_ADAPTER_PATH,
        "--poll-ms",
        "50",
      ],
      {
        cwd: join(__dirname, ".."),
        env: {
          ...process.env,
          OPENCLAW_NODE: process.execPath,
          OPENCLAW_CLI: cliPath,
          FAKE_OPENCLAW_LOG: logPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      await waitFor(async () => {
        const statusText = await readFile(join(projectDir, "status.md"), "utf8");
        return statusText.includes("next_actor: main") ? statusText : "";
      });

      const statusText = await readFile(join(projectDir, "status.md"), "utf8");
      expect(statusText).toContain("workflow_mode: auto");
      expect(statusText).toContain("next_actor: main");

      const runtime = JSON.parse(await readFile(join(projectDir, "runtime", "supervisor.json"), "utf8"));
      expect(runtime.last_dispatch_actor).toBe("reviewer");
      expect(runtime.last_recovery_action).toBe("accepted_changed_files_after_transient_failure_and_delivered_from_file");
      expect(runtime.last_failure_class).toBeUndefined();
      const reviewerFeedback = JSON.parse(await readFile(join(projectDir, "runtime", "reviewer-feedback.json"), "utf8"));
      expect(Array.isArray(reviewerFeedback.items)).toBe(true);
      expect(reviewerFeedback.items.at(-1).review_target).toBe("draft");
      expect(reviewerFeedback.items.at(-1).verdict).toBe("approved");
      expect(reviewerFeedback.items.at(-1).block).toMatch(/verdict: approved|verdict=approved/i);

      const logEntries = parseJsonLines(await readFile(logPath, "utf8"));
      expect(logEntries.some((entry) => entry.kind === "message" && entry.account === "singularity-main")).toBe(true);
      expect(logEntries.some((entry) => entry.kind === "message" && /verdict: approved/.test(entry.message))).toBe(true);
    } finally {
      await stopChild(child);
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 10_000);
});
