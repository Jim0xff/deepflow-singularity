import {
  applyNonRecoverableDispatchFailure,
  applyRecoverableDispatchFailure,
  canPromoteChangedFileDispatch,
  chunkMessageText,
  clearDispatchFailure,
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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
    expect(probePatch.retry_backoff_ms).toBe(900_000);
    expect(probePatch.next_retry_at).toBe("2026-04-23T00:18:00.000Z");
    expect(probePatch.last_dispatch_key).toBe(dispatchKey);
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
    expect(runtimePatch.next_retry_at).toBe("2026-04-23T00:15:00.000Z");
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
});
