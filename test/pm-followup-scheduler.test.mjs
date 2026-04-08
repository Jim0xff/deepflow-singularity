import { describe, expect, test } from "@jest/globals";

import { createPmFollowupScheduler } from "../dist/runtime/pm-followup-scheduler.js";

describe("pm-followup-scheduler", () => {
  test("sends one follow-up after stale interval and does not repeat until a new visible event", async () => {
    let now = 1_000;
    const notifications = [];
    const bindings = [{ projectId: "demo123", bindingId: "tg:-10001" }];
    const projectStatusPath = "/tmp/docs/projects/demo123/00_meta/project_status.md";
    const projectStatus = [
      "---",
      "project_code: demo123",
      "stage: frontend_in_progress",
      "frontend_status: in_progress",
      "backend_status: waiting_receipt",
      "needs_owner_action: false",
      "---",
      "",
      "# 项目状态",
    ].join("\n");

    const scheduler = createPmFollowupScheduler({
      docsRoot: "/tmp/docs",
      intervalMs: 60_000,
      staleMs: 300_000,
      receiptTimeoutMs: 900_000,
      now: () => now,
      readProjectBindings: async () => bindings,
      readFile: async (filePath) => (filePath === projectStatusPath ? projectStatus : null),
      runFollowup: async (payload) => {
        notifications.push(payload);
      },
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    await scheduler.runNow();
    expect(notifications).toHaveLength(0);

    now += 301_000;
    await scheduler.runNow();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      projectId: "demo123",
      bindingId: "tg:-10001",
      projectStatusPath,
      reason: "visibility_gap",
      waitingRoles: ["backend"],
    });

    now += 301_000;
    await scheduler.runNow();
    expect(notifications).toHaveLength(1);

    scheduler.noteVisibleEvent("demo123");
    now += 301_000;
    await scheduler.runNow();
    expect(notifications).toHaveLength(2);
  });

  test("prefers receipt-timeout follow-up when receipt stays pending beyond receipt timeout", async () => {
    let now = 1_000;
    const notifications = [];
    const bindings = [{ projectId: "demo123", bindingId: "tg:-10001" }];
    const projectStatusPath = "/tmp/docs/projects/demo123/00_meta/project_status.md";
    const projectStatus = [
      "---",
      "project_code: demo123",
      "stage: frontend_in_progress",
      "frontend_status: done",
      "backend_status: waiting_receipt",
      "needs_owner_action: false",
      "---",
      "",
      "# 项目状态",
    ].join("\n");

    const scheduler = createPmFollowupScheduler({
      docsRoot: "/tmp/docs",
      intervalMs: 60_000,
      staleMs: 300_000,
      receiptTimeoutMs: 900_000,
      now: () => now,
      readProjectBindings: async () => bindings,
      readFile: async (filePath) => (filePath === projectStatusPath ? projectStatus : null),
      runFollowup: async (payload) => {
        notifications.push(payload);
      },
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    await scheduler.runNow();
    now += 901_000;
    await scheduler.runNow();

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      projectId: "demo123",
      bindingId: "tg:-10001",
      projectStatusPath,
      reason: "receipt_timeout",
      waitingRoles: ["backend"],
    });
  });
});
