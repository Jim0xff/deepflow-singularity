import {
  chunkMessageText,
  parseAgentPayloadTexts,
  parseLatestVerdict,
  runOpenClawAgent,
  sendOpenClawMessage,
  stripLegacyActionMenu,
} from "../scripts/supervisor/lib.mjs";

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
});
