import { tick } from "../scripts/supervisor/adapters/singularity-flow.mjs";

describe("singularity supervisor adapter", () => {
  test("dispatches reviewer for step 5 auto debate", async () => {
    const result = await tick({
      projectDir: "/tmp/project",
      statusMtimeMs: 100,
      status: {
        workflow_mode: "auto",
        current_step: "step_5_debate",
        next_actor: "reviewer",
        awaiting_user_choice: "no",
      },
    });

    expect(result.dispatch.actor).toBe("reviewer");
    expect(result.dispatch.key).toBe("step5:100:reviewer");
  });

  test("dispatches main only when step 5 is waiting for user choice", async () => {
    const result = await tick({
      projectDir: "/tmp/project",
      statusMtimeMs: 101,
      status: {
        workflow_mode: "auto",
        current_step: "step_5_debate",
        next_actor: "main",
        awaiting_user_choice: "yes",
      },
    });

    expect(result.dispatch.actor).toBe("main");
    expect(result.dispatch.key).toBe("step5:101:main:awaiting");
    expect(result.dispatch.afterStatusPatch).toMatchObject({
      workflow_mode: "manual",
      current_step: "step_5_debate",
      next_actor: "main",
      awaiting_user_choice: "yes",
      active_menu_scope: "step_5_menu",
    });
  });

  test("dispatches writer for step 7 drafting", async () => {
    const result = await tick({
      projectDir: "/tmp/project",
      statusMtimeMs: 102,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "writer",
      },
    });

    expect(result.dispatch.actor).toBe("writer");
    expect(result.dispatch.key).toBe("step7:102:writer");
  });

  test("waits when workflow mode is manual", async () => {
    const result = await tick({
      projectDir: "/tmp/project",
      statusMtimeMs: 103,
      status: {
        workflow_mode: "manual",
        current_step: "step_7_drafting",
        next_actor: "writer",
      },
    });

    expect(result.dispatch).toBeUndefined();
    expect(result.runtimePatch.last_decision).toBe("workflow_mode_not_auto");
  });
});
