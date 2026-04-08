import { expect, test } from "@jest/globals";
import { spawn } from "node:child_process";
import path from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { includesIgnoreCase } from "./helpers/assertions.mjs";
import { sleep } from "./helpers/http-process.mjs";
import { sendTelegramCommand, waitForSendMessageContaining, withMention } from "./helpers/telegram-mock.mjs";

export function registerQaEngineerCases({ state, docsRoot, testDir }) {
  test("qa /handle forwards message to binding chat", async () => {
    const projectId = `qa-handle-${Date.now()}`;
    const targetChatId = state.telegramChatId - 5000;
    const bindingId = `tg:${targetChatId}`;

    await state.adminClient.injectUpdate({
      token: state.qaBotToken,
      update: {
        message: {
          message_id: Date.now(),
          date: Math.floor(Date.now() / 1000),
          chat: { id: targetChatId, type: "supergroup", title: "deepflow-it-target" },
          from: { id: state.telegramUserId, is_bot: false, first_name: "IntegrationUser" },
          text: withMention(state.qaBotMention, "warmup"),
        },
      },
    });
    await sleep(800);

    const bindReply = await sendTelegramCommand({
      adminClient: state.adminClient,
      botToken: state.pmBotToken,
      chatId: targetChatId,
      userId: state.telegramUserId,
      text: withMention(state.pmBotMention, `/bind ${projectId}`),
      expectedContains: projectId,
    });
    expect(includesIgnoreCase(bindReply, "✅")).toBe(true);

    await runOpenclawHandleCommand({
      projectRoot: path.resolve(testDir, ".."),
      projectId,
      bindingId,
      relativeFilePath: "03_receipts/backend_receipt.md",
      sessionId: `qa-handle-it-${Date.now()}`,
    });

    const notifyText = await waitForSendMessageContaining({
      adminClient: state.adminClient,
      botToken: state.qaBotToken,
      chatId: targetChatId,
      expectedTextFragment: "handle command recived",
      timeoutMs: 90000,
    });

    expect(includesIgnoreCase(notifyText, "handle command recived")).toBe(true);
  }, 120000);

  test.skip("/testplan creates e2e plan from prepared docs", async () => {
    const projectCode = `qa-it-${Date.now()}`;
    const fixtureDir = path.join(testDir, "assets", "qa-engineer");
    const projectDir = path.join(docsRoot, "projects", projectCode);
    const bindingsFile = path.join(docsRoot, "projects.json");

    await mkdir(projectDir, { recursive: true });

    const prdContent = await readFile(path.join(fixtureDir, "PRD.md"), "utf8");
    const frontendDesignContent = await readFile(path.join(fixtureDir, "frontend-design.md"), "utf8");

    await writeFile(path.join(projectDir, "PRD.md"), prdContent, "utf8");
    await writeFile(path.join(projectDir, "frontend-design.md"), frontendDesignContent, "utf8");

    const bindingId = `tg:${state.telegramChatId}`;
    await writeFile(bindingsFile, `${JSON.stringify({ [bindingId]: projectCode }, null, 2)}\n`, "utf8");

    const replyText = await sendTelegramCommand({
      adminClient: state.adminClient,
      botToken: state.qaBotToken,
      chatId: state.telegramChatId,
      userId: state.telegramUserId,
      text: withMention(state.qaBotMention, "/testplan"),
    });

    const generatedPlanPath = await waitForGeneratedTestPlan(projectDir, 120000);
    const generatedPlan = await readFile(generatedPlanPath, "utf8");

    expect(generatedPlan.length).toBeGreaterThan(200);
    expect(includesIgnoreCase(generatedPlan, "e2e")).toBe(true);
    expect(includesIgnoreCase(replyText, "✅") || includesIgnoreCase(replyText, "test") || includesIgnoreCase(replyText, "plan")).toBe(true);
  }, 180000);
}

async function runOpenclawHandleCommand({ projectRoot, projectId, bindingId, relativeFilePath, sessionId }) {
  const message = `/handle ${projectId} ${bindingId} ${relativeFilePath}`;
  await new Promise((resolve, reject) => {
    const child = spawn(
      "openclaw",
      ["agent", "--agent", "qa-engineer", "--message", message, "--session-id", sessionId],
      {
        cwd: projectRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `openclaw agent /handle failed with code=${code ?? "null"}\nstdout=${stdout}\nstderr=${stderr}`,
        ),
      );
    });
  });
}

async function waitForGeneratedTestPlan(projectDir, timeoutMs) {
  const start = Date.now();
  const qaDir = path.join(projectDir, "qa");

  while (Date.now() - start < timeoutMs) {
    try {
      const files = await readdir(qaDir);
      const matched = files.find((name) => /^e2e-test-plan-\d{4}-\d{2}-\d{2}\.md$/.test(name));
      if (matched) {
        return path.join(qaDir, matched);
      }
    } catch {
      // keep waiting
    }

    await sleep(500);
  }

  throw new Error("timeout waiting for generated qa e2e test plan document");
}
