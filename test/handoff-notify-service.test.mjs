import { describe, expect, test } from "@jest/globals";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHandoffNotifier } from "../dist/handoff-notify/service.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("handoff-notify service", () => {
  test("skips empty handoff file and notifies after non-empty write", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "handoff-notify-"));
    const docsRoot = join(tempRoot, "docs");
    const projectId = "demo123";
    const relativePath = "02_handoff/backend_task.md";
    const absoluteFilePath = join(docsRoot, "projects", projectId, relativePath);

    await mkdir(join(docsRoot, "projects", projectId, "02_handoff"), { recursive: true });
    await writeFile(join(docsRoot, "projects.json"), '{"tg:-10001":"demo123"}\n', "utf8");

    const notifications = [];
    const notifier = createHandoffNotifier({
      docsRoot,
      debounceMs: 50,
      runAgentCommand: async (agentId, message, sessionId) => {
        notifications.push({ agentId, message, sessionId });
      },
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    notifier.start();
    await sleep(100);

    await writeFile(absoluteFilePath, "\n  \n", "utf8");
    await sleep(500);
    expect(notifications).toHaveLength(0);

    await writeFile(absoluteFilePath, "# backend task\nimplement endpoint\n", "utf8");
    await sleep(500);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      agentId: "backend-developer",
      message: `/handle ${projectId} tg:-10001 ${relativePath}`,
      sessionId: "handoff-demo123-backend-developer",
    });

    await notifier.stop();
    await rm(tempRoot, { recursive: true, force: true });
  }, 10000);

  test("dispatches nodejs task handoff to nodejs-developer", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "handoff-notify-nodejs-"));
    const docsRoot = join(tempRoot, "docs");
    const projectId = "demo-node";
    const relativePath = "02_handoff/nodejs_task.md";
    const absoluteFilePath = join(docsRoot, "projects", projectId, relativePath);

    await mkdir(join(docsRoot, "projects", projectId, "02_handoff"), { recursive: true });
    await writeFile(join(docsRoot, "projects.json"), '{"tg:-10001":"demo-node"}\n', "utf8");

    const notifications = [];
    const notifier = createHandoffNotifier({
      docsRoot,
      debounceMs: 50,
      runAgentCommand: async (agentId, message, sessionId) => {
        notifications.push({ agentId, message, sessionId });
      },
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    notifier.start();
    await sleep(100);

    await writeFile(absoluteFilePath, "# nodejs task\nimplement api\n", "utf8");
    await sleep(500);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      agentId: "nodejs-developer",
      message: `/handle ${projectId} tg:-10001 ${relativePath}`,
      sessionId: "handoff-demo-node-nodejs-developer",
    });

    await notifier.stop();
    await rm(tempRoot, { recursive: true, force: true });
  }, 10000);

  test("runs owner-notify hook for project status updates", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "handoff-notify-owner-"));
    const docsRoot = join(tempRoot, "docs");
    const projectId = "demo123";
    const relativePath = "00_meta/project_status.md";
    const absoluteFilePath = join(docsRoot, "projects", projectId, relativePath);

    await mkdir(join(docsRoot, "projects", projectId, "00_meta"), { recursive: true });
    await writeFile(join(docsRoot, "projects.json"), '{"tg:-10001":"demo123"}\n', "utf8");

    const ownerNotifications = [];
    const notifier = createHandoffNotifier({
      docsRoot,
      debounceMs: 50,
      runAgentCommand: async () => {},
      runOwnerNotify: async (payload) => {
        ownerNotifications.push(payload);
      },
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    notifier.start();
    await sleep(100);

    await writeFile(
      absoluteFilePath,
      "---\nproject_code: demo123\nstage: clarification_pending\nfrontend_status: idle\nbackend_status: idle\nneeds_owner_action: false\n---\n\n# 项目状态\n",
      "utf8",
    );
    await sleep(500);

    expect(ownerNotifications).toHaveLength(1);
    expect(ownerNotifications[0]).toEqual({
      actionType: "status_updated",
      projectId: "demo123",
      bindingId: "tg:-10001",
      relativePath: "00_meta/project_status.md",
      filePath: absoluteFilePath,
      beforeContent: "",
    });

    await notifier.stop();
    await rm(tempRoot, { recursive: true, force: true });
  }, 10000);
});
