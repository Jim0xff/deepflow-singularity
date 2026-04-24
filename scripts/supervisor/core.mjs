#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  daemonizeWatch,
  ensureProjectDir,
  fileMtimeMs,
  canPromoteChangedFileDispatch,
  hasChangedRelativeFile,
  hasTransientDeliveryFailureSignal,
  shouldDispatchRepeated,
  latestMarkdownBlock,
  parseStatusMd,
  parseAgentPayloadTexts,
  parseLatestVerdict,
  pidAlive,
  readJson,
  readText,
  resolveExistingPath,
  runOpenClawAgent,
  sendOpenClawMessage,
  snapshotDispatchResumeSignals,
  snapshotRelativeFileSignatures,
  stripLegacyActionMenu,
  chunkMessageText,
  applyNonRecoverableDispatchFailure,
  applyRecoverableDispatchFailure,
  clearDispatchFailure,
  dispatchRecoveryPlan,
  hasNoReplySignal,
  hasTransientDispatchFailureSignal,
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
    "usage: supervisor-core.mjs <start|watch> --project-dir <dir> --adapter <file> [--poll-ms <ms>] [--main-agent-id <id>] [--reviewer-agent-id <id>] [--writer-agent-id <id>] [--final-writer-agent-id <id>] [--main-session-id <id>] [--reviewer-session-id <id>] [--writer-session-id <id>] [--final-writer-session-id <id>]"
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
    final_writer: {
      agentId: args["final-writer-agent-id"] || "singularity-final-writer",
      sessionId: args["final-writer-session-id"] || "",
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

function previewText(value, maxLength = 240) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}...`;
}

function summarizeStatus(status = {}) {
  return {
    status: String(status.status || "").trim(),
    workflow_mode: String(status.workflow_mode || "").trim(),
    current_step: String(status.current_step || "").trim(),
    next_actor: String(status.next_actor || "").trim(),
    awaiting_user_choice: String(status.awaiting_user_choice || "").trim(),
    review_target: String(status.review_target || "").trim(),
    final_article_ready: String(status.final_article_ready || "").trim(),
    final_writer_mode: String(status.final_writer_mode || "").trim(),
    active_menu_scope: String(status.active_menu_scope || "").trim(),
  };
}

function summarizeRuntime(runtime = {}) {
  return {
    state: String(runtime.state || "").trim(),
    pid: runtime.pid ?? null,
    last_decision: String(runtime.last_decision || "").trim(),
    last_dispatch_key: String(runtime.last_dispatch_key || "").trim(),
    last_dispatch_actor: String(runtime.last_dispatch_actor || "").trim(),
    last_failure_class: String(runtime.last_failure_class || "").trim(),
    last_failure_reason: String(runtime.last_failure_reason || "").trim(),
    retry_mode: String(runtime.retry_mode || "").trim(),
    retry_attempt: Number(runtime.retry_attempt || 0) || 0,
    next_retry_at: String(runtime.next_retry_at || "").trim(),
    last_recovery_action: String(runtime.last_recovery_action || "").trim(),
  };
}

function summarizeDispatch(dispatch = {}) {
  return {
    key: String(dispatch.key || "").trim(),
    actor: String(dispatch.actor || "").trim(),
    session_id: String(dispatch.sessionId || "").trim(),
    message_chars: String(dispatch.message || "").length,
    suppress_delivery: Boolean(dispatch.suppressDelivery),
    deliver_requires_changed_file: Boolean(dispatch.deliverRequiresChangedFile),
    require_latest_verdict: Boolean(dispatch.requireLatestVerdict),
    success_files: [...(dispatch.afterSuccessWhenFilesChanged || [])],
    deliver_from_changed_file: String(dispatch.deliverFromChangedFile || "").trim(),
    recovery_deliver_from_changed_file: String(dispatch.recoveryDeliverFromChangedFile || "").trim(),
    delivery_actor: String(dispatch.deliveryActor || "").trim(),
    recovery_delivery_actor: String(dispatch.recoveryDeliveryActor || "").trim(),
    delivery_failure_does_not_block_success: Boolean(dispatch.deliveryFailureDoesNotBlockSuccess),
    has_after_success_patch: Boolean(dispatch.afterSuccessPatch),
    has_after_verdict_patch: Boolean(dispatch.afterSuccessPatchFromLatestVerdict),
    has_after_status_patch: Boolean(dispatch.afterStatusPatch),
  };
}

function logWatchEvent(projectDir, event, details = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      scope: "singularity_supervisor_watch",
      project_id: path.basename(projectDir),
      event,
      ...details,
    }),
  );
}

function applyStatusPatchWithLog({ projectDir, statusPath, source, patch, details = {} }) {
  const statusBefore = parseStatusMd(readText(statusPath));
  updateStatusMdAtomic(statusPath, patch);
  const statusAfter = parseStatusMd(readText(statusPath));
  logWatchEvent(projectDir, "status_patch_applied", {
    source,
    patch,
    status_before: summarizeStatus(statusBefore),
    status_after: summarizeStatus(statusAfter),
    ...details,
  });
}

function persistLatestReviewerFeedback({ projectDir, parsedVerdict, status, dispatchedAtIso }) {
  const block = latestMarkdownBlock(readText(path.join(projectDir, "draft_review_history.md")));
  if (!block || !/\brole\s*[:=]\s*reviewer\b/i.test(block)) return;

  const reviewTarget =
    String(status?.review_target || "").trim().toLowerCase() === "final" ||
    String(status?.final_article_ready || "").trim().toLowerCase() === "yes"
      ? "final"
      : "draft";
  const filePath = path.join(projectDir, "runtime", "reviewer-feedback.json");
  const existing = readJson(filePath, {});
  const items = Array.isArray(existing.items) ? existing.items : [];
  items.push({
    ts: String(dispatchedAtIso || new Date().toISOString()),
    review_target: reviewTarget,
    verdict: String(parsedVerdict || "").trim().toLowerCase(),
    block,
  });
  writeJson(filePath, { items: items.slice(-20) });
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

  let texts = parseAgentPayloadTexts(run.stdout);
  if (dispatch.deliverFromChangedFile) {
    const block = latestMarkdownBlock(readText(path.join(dispatch.projectDir, dispatch.deliverFromChangedFile)));
    if (block) texts = [block];
  }
  if (!texts.length) {
    nextRuntime.last_delivery_count = 0;
    nextRuntime.last_delivery_failed_count = 1;
    nextRuntime.last_delivery_at = "";
    nextRuntime.last_delivery_error = "no_payload_text";
    return { ok: false, sent: 0, failed: 1 };
  }
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

function verdictPatch(verdict, status = {}) {
  const reviewTarget = String(status.review_target || "").trim().toLowerCase();
  const finalArticleReady = String(status.final_article_ready || "").trim().toLowerCase() === "yes";
  const isFinalReview = reviewTarget === "final" || finalArticleReady;
  if (verdict === "approved") {
    return {
      workflow_mode: "auto",
      current_step: "step_7_drafting",
      next_actor: "main",
      awaiting_user_choice: "no",
      final_article_ready: isFinalReview ? "yes" : "no",
      final_writer_mode: "",
      after_final_writer: "",
    };
  }
  return {
    workflow_mode: "auto",
    current_step: "step_7_drafting",
    next_actor: isFinalReview ? "final_writer" : "writer",
    awaiting_user_choice: "no",
    final_article_ready: "no",
    review_target: isFinalReview ? "final" : "draft",
    final_writer_mode: isFinalReview ? "revise" : "",
    after_final_writer: isFinalReview ? "reviewer" : "",
  };
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
  logWatchEvent(projectDir, "watch_started", {
    pid: process.pid,
    adapter: adapter.resolved,
    poll_ms: pollMs,
    agents: Object.fromEntries(
      Object.entries(buildAgentRuntime(args)).map(([actor, runtime]) => [actor, runtime.agentId || ""])
    ),
  });

  try {
    while (true) {
      const statusPath = path.join(projectDir, "status.md");
      const statusText = readText(statusPath);
      const status = parseStatusMd(statusText);
      const runtime = readJson(runtimePath, {});
      if (shouldStop(status)) {
        logWatchEvent(projectDir, "watch_stop_requested", {
          reason: stopReason(status) || "watch_stopped",
          status: summarizeStatus(status),
          runtime: summarizeRuntime(runtime),
        });
        break;
      }
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

      logWatchEvent(projectDir, "tick_evaluated", {
        status: summarizeStatus(status),
        runtime: summarizeRuntime(runtime),
        status_mtime_ms: statusMtimeMs,
        delay_ms: Number(result?.delayMs || pollMs || 15_000),
        adapter_decision: String(result?.runtimePatch?.last_decision || "").trim(),
        dispatch: result?.dispatch ? summarizeDispatch(result.dispatch) : null,
      });

      if (result?.dispatch) {
        const dispatchKey = String(result.dispatch.key || "");
        const repeated =
          dispatchKey &&
          dispatchKey === String(runtime.last_dispatch_key || "") &&
          Number(runtime.last_dispatch_status_mtime_ms || 0) === statusMtimeMs;
        const repeatedDecision = repeated ? shouldDispatchRepeated({ runtime, projectDir }) : { shouldDispatch: true };

        if (!repeated || repeatedDecision.shouldDispatch) {
          const actor = result.dispatch.actor;
          const agent = agentRuntime[actor];
          const dispatchStartedAt = new Date();
          const dispatchStartedAtIso = dispatchStartedAt.toISOString();
          const { paths: resumeSignalPaths, snapshot: resumeSignals } = snapshotDispatchResumeSignals(
            projectDir,
            result.dispatch,
          );
          logWatchEvent(projectDir, "dispatch_attempt", {
            actor,
            dispatch_key: dispatchKey,
            repeated,
            repeated_reason: repeated ? String(repeatedDecision.reason || "") : "",
            status: summarizeStatus(status),
            runtime: summarizeRuntime(runtime),
            dispatch: summarizeDispatch(result.dispatch),
            resume_signal_paths: resumeSignalPaths,
            resume_signals: resumeSignals,
          });
          let run = { status: 1, stdout: "", stderr: "" };
          if (!agent?.agentId) {
            nextRuntime.last_dispatch_failed_at = dispatchStartedAtIso;
            nextRuntime.last_error = `unknown_actor:${actor}`;
            applyNonRecoverableDispatchFailure({
              runtimePatch: nextRuntime,
              dispatchKey,
              statusMtimeMs,
              reason: `unknown_actor:${actor}`,
              nowIso: dispatchStartedAtIso,
              resumeSignals,
              resumeSignalPaths,
            });
            logWatchEvent(projectDir, "dispatch_blocked", {
              actor,
              dispatch_key: dispatchKey,
              reason: `unknown_actor:${actor}`,
              status: summarizeStatus(status),
              runtime_after: summarizeRuntime(nextRuntime),
            });
          } else {
            const { failureCounts, previousFailureCount, recoverySession } = dispatchRecoveryPlan({
              runtime,
              projectDir,
              actor,
              dispatchKey,
            });
            const deliveryActorKey = result.dispatch.deliveryActor || actor;
            const deliveryAgent = agentRuntime[deliveryActorKey] || agent;
            const delivery = {
              ...resolveTelegramDelivery(projectDir),
              account: deliveryAgent?.agentId || agent.agentId,
            };
            const successFileSnapshot = snapshotRelativeFileSignatures(
              projectDir,
              result.dispatch.afterSuccessWhenFilesChanged,
            );
            const dispatchSessionId = result.dispatch.sessionId || recoverySession || agent.sessionId;
            logWatchEvent(projectDir, "dispatch_launching_agent", {
              actor,
              dispatch_key: dispatchKey,
              agent_id: agent.agentId,
              session_id: dispatchSessionId,
              recovery_session_id: recoverySession,
              previous_failure_count: previousFailureCount,
              success_file_snapshot: successFileSnapshot,
            });
            run = runOpenClawAgent({
              agentId: agent.agentId,
              message: result.dispatch.message,
              sessionId: dispatchSessionId,
              openclawNode: OPENCLAW_NODE,
              openclawCli: OPENCLAW_CLI,
            });
            dispatched = run.status === 0;
            const noReply = hasNoReplySignal(run);
            const transientDispatchFailure = hasTransientDispatchFailureSignal(run);
            const successFilesChanged = hasChangedRelativeFile(projectDir, successFileSnapshot);
            const parsedVerdict = result.dispatch.afterSuccessPatchFromLatestVerdict
              ? parseLatestVerdict(readText(path.join(projectDir, "draft_review_history.md")))
              : "";
            logWatchEvent(projectDir, "dispatch_agent_completed", {
              actor,
              dispatch_key: dispatchKey,
              exit_code: run.status ?? 1,
              no_reply: noReply,
              transient_failure: transientDispatchFailure,
              success_files_changed: successFilesChanged,
              parsed_verdict: parsedVerdict,
              stdout_preview: previewText(run.stdout),
              stderr_preview: previewText(run.stderr),
            });
            let recoverableDispatchFailed = false;
            let blockedDispatchFailureReason = "";
            if (dispatched) {
              if (result.dispatch.deliverRequiresChangedFile && !successFilesChanged) {
                dispatched = false;
                recoverableDispatchFailed = transientDispatchFailure;
                blockedDispatchFailureReason = transientDispatchFailure ? "" : "expected_file_not_changed";
                nextRuntime.last_dispatch_failed_at = dispatchStartedAtIso;
                nextRuntime.last_error = "expected_file_not_changed";
                nextRuntime.last_no_reply_signal = noReply ? "yes" : "no";
                nextRuntime.last_transient_failure_signal = transientDispatchFailure ? "yes" : "no";
              } else {
                if (result.dispatch.requireLatestVerdict && !parsedVerdict) {
                  dispatched = false;
                  recoverableDispatchFailed = transientDispatchFailure;
                  blockedDispatchFailureReason = transientDispatchFailure ? "" : "latest_verdict_missing";
                  nextRuntime.last_dispatch_failed_at = dispatchStartedAtIso;
                  nextRuntime.last_error = "latest_verdict_missing";
                  nextRuntime.last_no_reply_signal = noReply ? "yes" : "no";
                  nextRuntime.last_transient_failure_signal = transientDispatchFailure ? "yes" : "no";
                } else {
                  const deliveryResult = result.dispatch.suppressDelivery
                    ? { ok: true, sent: 0, failed: 0 }
                    : deliverAgentPayloads({
                        delivery,
                        actor,
                        run,
                        dispatch: { ...result.dispatch, projectDir },
                        nextRuntime,
                      });
                  logWatchEvent(projectDir, "dispatch_delivery_result", {
                    actor,
                    dispatch_key: dispatchKey,
                    suppressed: Boolean(result.dispatch.suppressDelivery),
                    ok: Boolean(deliveryResult.ok),
                    sent: Number(deliveryResult.sent || 0),
                    failed: Number(deliveryResult.failed || 0),
                    delivery_actor: deliveryActorKey,
                    delivery_error_preview: previewText(nextRuntime.last_delivery_error),
                  });
                  const deliveryFailureDoesNotBlockSuccess =
                    !deliveryResult.ok &&
                    successFilesChanged &&
                    Boolean(result.dispatch.deliveryFailureDoesNotBlockSuccess);
                  if (!deliveryResult.ok && !deliveryFailureDoesNotBlockSuccess) {
                    const transientDeliveryFailure = hasTransientDeliveryFailureSignal(nextRuntime.last_delivery_error);
                    dispatched = false;
                    recoverableDispatchFailed = transientDispatchFailure || transientDeliveryFailure;
                    blockedDispatchFailureReason = recoverableDispatchFailed ? "" : "delivery_failed";
                    nextRuntime.last_dispatch_failed_at = dispatchStartedAtIso;
                    nextRuntime.last_error = "delivery_failed";
                    nextRuntime.last_no_reply_signal = noReply ? "yes" : "no";
                    nextRuntime.last_transient_failure_signal =
                      transientDispatchFailure || transientDeliveryFailure ? "yes" : "no";
                  } else {
                    clearDispatchFailure({ runtimePatch: nextRuntime, failureCounts, dispatchKey, recoverySession });
                    if (deliveryFailureDoesNotBlockSuccess) {
                      nextRuntime.last_recovery_action = "delivery_failed_but_advanced_after_success";
                    }
                    nextRuntime.last_dispatch_key = dispatchKey;
                    nextRuntime.last_dispatch_actor = actor;
                    nextRuntime.last_dispatch_status_mtime_ms = statusMtimeMs;
                    nextRuntime.last_dispatch_at = dispatchStartedAtIso;
                    if (actor === "reviewer" && successFilesChanged) {
                      persistLatestReviewerFeedback({
                        projectDir,
                        parsedVerdict,
                        status,
                        dispatchedAtIso: dispatchStartedAtIso,
                      });
                    }
                    if (result.dispatch.afterSuccessPatch && successFilesChanged) {
                      applyStatusPatchWithLog({
                        projectDir,
                        statusPath,
                        source: "after_success_patch",
                        patch: {
                          ...result.dispatch.afterSuccessPatch,
                          updated_at: dispatchStartedAtIso,
                        },
                        details: {
                          actor,
                          dispatch_key: dispatchKey,
                          parsed_verdict: parsedVerdict,
                        },
                      });
                      dispatched = false;
                    }
                    if (result.dispatch.afterSuccessPatchFromLatestVerdict && successFilesChanged) {
                      const patch = verdictPatch(parsedVerdict, status);
                      if (patch) {
                        applyStatusPatchWithLog({
                          projectDir,
                          statusPath,
                          source: "after_success_patch_from_latest_verdict",
                          patch: {
                            ...patch,
                            updated_at: dispatchStartedAtIso,
                          },
                          details: {
                            actor,
                            dispatch_key: dispatchKey,
                            parsed_verdict: parsedVerdict,
                          },
                        });
                        dispatched = false;
                      }
                    }
                    if (result.dispatch.afterStatusPatch) {
                      applyStatusPatchWithLog({
                        projectDir,
                        statusPath,
                        source: "after_status_patch",
                        patch: {
                          ...result.dispatch.afterStatusPatch,
                          updated_at: dispatchStartedAtIso,
                        },
                        details: {
                          actor,
                          dispatch_key: dispatchKey,
                          parsed_verdict: parsedVerdict,
                        },
                      });
                      dispatched = false;
                    }
                  }
                }
              }
            } else {
              const promoteChangedFiles = canPromoteChangedFileDispatch({
                dispatch: result.dispatch,
                successFilesChanged,
                transientDispatchFailure,
                parsedVerdict,
              });
              if (promoteChangedFiles) {
                const recoveryDeliveryPath = String(result.dispatch.recoveryDeliverFromChangedFile || "").trim();
                const recoveryDeliveryActorKey =
                  result.dispatch.recoveryDeliveryActor || result.dispatch.deliveryActor || actor;
                const recoveryDeliveryAgent = agentRuntime[recoveryDeliveryActorKey] || deliveryAgent || agent;
                const recoveryDelivery = {
                  ...delivery,
                  account: recoveryDeliveryAgent?.agentId || delivery.account,
                };
                const recoveryDeliveryResult = recoveryDeliveryPath
                  ? deliverAgentPayloads({
                      delivery: recoveryDelivery,
                      actor,
                      run: { stdout: "" },
                      dispatch: {
                        ...result.dispatch,
                        projectDir,
                        deliverFromChangedFile: recoveryDeliveryPath,
                      },
                      nextRuntime,
                    })
                  : { ok: true, sent: 0, failed: 0 };
                logWatchEvent(projectDir, "dispatch_changed_file_promotion", {
                  actor,
                  dispatch_key: dispatchKey,
                  parsed_verdict: parsedVerdict,
                  recovery_delivery_path: recoveryDeliveryPath,
                  recovery_delivery_actor: recoveryDeliveryActorKey,
                  recovery_delivery_ok: Boolean(recoveryDeliveryResult.ok),
                  recovery_delivery_sent: Number(recoveryDeliveryResult.sent || 0),
                  recovery_delivery_failed: Number(recoveryDeliveryResult.failed || 0),
                  recovery_delivery_error_preview: previewText(nextRuntime.last_delivery_error),
                });
                clearDispatchFailure({ runtimePatch: nextRuntime, failureCounts, dispatchKey, recoverySession });
                nextRuntime.last_recovery_action = recoveryDeliveryPath
                  ? recoveryDeliveryResult.ok
                    ? recoveryDeliveryResult.sent > 0
                      ? "accepted_changed_files_after_transient_failure_and_delivered_from_file"
                      : "accepted_changed_files_after_transient_failure"
                    : "accepted_changed_files_after_transient_failure_but_recovery_delivery_failed"
                  : "accepted_changed_files_after_transient_failure";
                nextRuntime.last_dispatch_key = dispatchKey;
                nextRuntime.last_dispatch_actor = actor;
                nextRuntime.last_dispatch_status_mtime_ms = statusMtimeMs;
                nextRuntime.last_dispatch_at = dispatchStartedAtIso;
                if (actor === "reviewer" && parsedVerdict) {
                  persistLatestReviewerFeedback({
                    projectDir,
                    parsedVerdict,
                    status,
                    dispatchedAtIso: dispatchStartedAtIso,
                  });
                }
                if (result.dispatch.afterSuccessPatch) {
                  applyStatusPatchWithLog({
                    projectDir,
                    statusPath,
                    source: "changed_file_promotion_after_success_patch",
                    patch: {
                      ...result.dispatch.afterSuccessPatch,
                      updated_at: dispatchStartedAtIso,
                    },
                    details: {
                      actor,
                      dispatch_key: dispatchKey,
                      parsed_verdict: parsedVerdict,
                    },
                  });
                  dispatched = false;
                }
                if (result.dispatch.afterSuccessPatchFromLatestVerdict && parsedVerdict) {
                  const patch = verdictPatch(parsedVerdict, status);
                  if (patch) {
                    applyStatusPatchWithLog({
                      projectDir,
                      statusPath,
                      source: "changed_file_promotion_after_latest_verdict",
                      patch: {
                        ...patch,
                        updated_at: dispatchStartedAtIso,
                      },
                      details: {
                        actor,
                        dispatch_key: dispatchKey,
                        parsed_verdict: parsedVerdict,
                      },
                    });
                    dispatched = false;
                  }
                }
                if (result.dispatch.afterStatusPatch) {
                  applyStatusPatchWithLog({
                    projectDir,
                    statusPath,
                    source: "changed_file_promotion_after_status_patch",
                    patch: {
                      ...result.dispatch.afterStatusPatch,
                      updated_at: dispatchStartedAtIso,
                    },
                    details: {
                      actor,
                      dispatch_key: dispatchKey,
                      parsed_verdict: parsedVerdict,
                    },
                  });
                  dispatched = false;
                }
              } else {
                recoverableDispatchFailed = transientDispatchFailure;
                blockedDispatchFailureReason = transientDispatchFailure
                  ? ""
                  : String(run.stderr || "").trim() === "openclaw_path_missing"
                    ? "openclaw_path_missing"
                    : "dispatch_failed";
                nextRuntime.last_dispatch_failed_at = dispatchStartedAtIso;
                nextRuntime.last_error = noReply
                  ? "no_reply"
                  : transientDispatchFailure
                    ? "transient_dispatch_failure"
                    : blockedDispatchFailureReason;
                nextRuntime.last_no_reply_signal = noReply ? "yes" : "no";
                nextRuntime.last_transient_failure_signal = transientDispatchFailure ? "yes" : "no";
              }
            }
            if (recoverableDispatchFailed) {
              applyRecoverableDispatchFailure({
                runtimePatch: nextRuntime,
                failureCounts,
                dispatchKey,
                previousFailureCount,
                recoverySession,
                statusMtimeMs,
                nowIso: dispatchStartedAtIso,
                reason: String(nextRuntime.last_error || "retryable_dispatch_failure"),
                resumeSignals,
                resumeSignalPaths,
              });
              logWatchEvent(projectDir, "dispatch_recoverable_failure", {
                actor,
                dispatch_key: dispatchKey,
                error: String(nextRuntime.last_error || "retryable_dispatch_failure"),
                runtime_after: summarizeRuntime(nextRuntime),
              });
            } else if (blockedDispatchFailureReason) {
              applyNonRecoverableDispatchFailure({
                runtimePatch: nextRuntime,
                dispatchKey,
                statusMtimeMs,
                reason: blockedDispatchFailureReason,
                nowIso: dispatchStartedAtIso,
                resumeSignals,
                resumeSignalPaths,
              });
              logWatchEvent(projectDir, "dispatch_blocked_failure", {
                actor,
                dispatch_key: dispatchKey,
                error: blockedDispatchFailureReason,
                runtime_after: summarizeRuntime(nextRuntime),
              });
            }
            nextRuntime.last_dispatch_message = result.dispatch.message;
            nextRuntime.last_dispatch_stdout = String(run.stdout || "").trim();
            nextRuntime.last_dispatch_stderr = String(run.stderr || "").trim();
            nextRuntime.last_dispatch_exit_code = run.status ?? 1;
            logWatchEvent(projectDir, "dispatch_recorded", {
              actor,
              dispatch_key: dispatchKey,
              exit_code: nextRuntime.last_dispatch_exit_code,
              runtime_after: summarizeRuntime(nextRuntime),
            });
          }
        } else {
          logWatchEvent(projectDir, "dispatch_skipped_repeated", {
            dispatch_key: dispatchKey,
            actor: String(result.dispatch.actor || "").trim(),
            reason: String(repeatedDecision.reason || ""),
            status: summarizeStatus(status),
            runtime: summarizeRuntime(runtime),
          });
        }
      }

      writeJson(runtimePath, nextRuntime);

      const nextDelayMs = Number(result?.delayMs || pollMs || 15_000);
      await new Promise((resolve) => setTimeout(resolve, dispatched ? 2_000 : nextDelayMs));
    }
  } catch (error) {
    logWatchEvent(projectDir, "watch_fatal_error", {
      error: previewText(error?.stack || error || "watch_failed", 400),
    });
    throw error;
  } finally {
    const finalRuntime = readJson(runtimePath, {});
    const finalStatus = parseStatusMd(readText(path.join(projectDir, "status.md")));
    logWatchEvent(projectDir, "watch_exited", {
      reason: stopReason(finalStatus) || "watch_stopped",
      status: summarizeStatus(finalStatus),
      runtime: summarizeRuntime(finalRuntime),
    });
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
  const stalePid = existing.pid || null;
  if (existing.pid) {
    writeJson(runtimePath, {
      ...existing,
      state: "stale",
      pid: null,
      project_dir: projectDir,
      stale_pid: stalePid,
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

  console.log(JSON.stringify({ ok: true, reused: false, pid: child.pid, projectDir, stalePid }, null, 2));
}

main().catch((error) => {
  console.error(String(error?.stack || error || "supervisor_failed"));
  process.exit(1);
});
