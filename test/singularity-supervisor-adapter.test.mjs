import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { tick } from "../scripts/supervisor/adapters/singularity-flow.mjs";

describe("singularity supervisor adapter", () => {
  function between(text, startMarker, endMarker) {
    const start = text.indexOf(startMarker);
    if (start === -1) return "";
    const from = start + startMarker.length;
    if (!endMarker) return text.slice(from);
    const end = text.indexOf(endMarker, from);
    return text.slice(from, end === -1 ? undefined : end);
  }

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
    expect(result.dispatch.message).toContain("Do not show a menu");
    expect(result.dispatch.message).toContain("next_actor=main");
    expect(result.dispatch.afterSuccessPatch).toBeUndefined();
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
    expect(result.dispatch.afterStatusPatch.active_menu_options).toContain("WRITE_AND_POST_FULL_NEXT_Sx");
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
    expect(result.dispatch.message).toContain("/.openclaw/shared/knowledge/writing_rules/");
    expect(result.dispatch.message).toContain("type=writing_knowledge_read");
    expect(result.dispatch.message).toContain("apply_points_or_none=...");
    expect(result.dispatch.message).toContain("/.openclaw/shared/templates/articles/<template_id>.md");
    expect(result.dispatch.message).toContain("Do not read templates from the project directory.");
    expect(result.dispatch.stripLegacyActionMenu).toBe(true);
    expect(result.dispatch.deliverRequiresChangedFile).toBe(true);
    expect(result.dispatch.afterSuccessWhenFilesChanged).toEqual(["output.md"]);
    expect(result.dispatch.afterSuccessPatch).toMatchObject({
      workflow_mode: "auto",
      current_step: "step_7_drafting",
      next_actor: "reviewer",
      awaiting_user_choice: "no",
      final_article_ready: "no",
      review_target: "draft",
    });
  });

  test("dispatches writer with latest draft-stage editor feedback block pasted from handoff", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-writer-feedback-"));
    await writeFile(
      join(projectDir, "handoff.md"),
      [
        "## old-feedback",
        "role=editor | type=step_7_feedback | target=writer",
        "旧意见：轻微顺稿。",
        "",
        "## latest-feedback",
        "role=editor | type=step_7_feedback | target=writer",
        "继续修改一轮：名著映照段目前偏简略，请做有限增厚。",
        "1) 把《是，大臣》与《官场现形记》的映照从观点并列升级到动作并列。",
        "",
      ].join("\n"),
      "utf8"
    );

    const result = await tick({
      projectDir,
      statusMtimeMs: 1021,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "writer",
      },
    });

    expect(result.dispatch.actor).toBe("writer");
    expect(result.dispatch.message).toContain("Latest draft-stage editor feedback block:");
    expect(result.dispatch.message).toContain("继续修改一轮：名著映照段目前偏简略，请做有限增厚。");
    expect(result.dispatch.message).toContain("动作并列");
    expect(result.dispatch.message).toContain("treat it as mandatory revision input");
    expect(result.dispatch.message).not.toContain("旧意见：轻微顺稿。");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("returns step 7 to manual after draft approval menu", async () => {
    const result = await tick({
      projectDir: "/tmp/project",
      statusMtimeMs: 104,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "main",
      },
    });

    expect(result.dispatch.actor).toBe("main");
    expect(result.dispatch.afterStatusPatch).toMatchObject({
      workflow_mode: "manual",
      current_step: "step_7_drafting",
      next_actor: "main",
      awaiting_user_choice: "yes",
      active_menu_scope: "step_7_menu",
    });
    expect(result.dispatch.message).toContain("4. 退出当前项目");
    expect(result.dispatch.message).toContain("1. 生成正式版文章");
    expect(result.dispatch.afterStatusPatch.active_menu_options).toContain("1=SET(workflow_mode=auto,next_actor=final_writer");
    expect(result.dispatch.afterStatusPatch.active_menu_options).toContain("final_writer_mode=generate");
    expect(result.dispatch.afterStatusPatch.active_menu_options).toContain("4=EXIT_CURRENT_PROJECT");
  });

  test("dispatches reviewer for step 7 with strict review knowledge-read gate", async () => {
    const result = await tick({
      projectDir: "/tmp/project",
      statusMtimeMs: 1041,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "reviewer",
        review_target: "draft",
      },
    });

    expect(result.dispatch.actor).toBe("reviewer");
    expect(result.dispatch.message).toContain("/.openclaw/shared/knowledge/review_gates/");
    expect(result.dispatch.message).toContain("/.openclaw/shared/knowledge/repair_patterns/");
    expect(result.dispatch.message).toContain("type=review_knowledge_read");
    expect(result.dispatch.message).toContain("read_fail_or_none=...");
    expect(result.dispatch.requireLatestVerdict).toBe(true);
  });

  test("dispatches final writer and returns to main with final-output", async () => {
    const result = await tick({
      projectDir: "/tmp/project",
      statusMtimeMs: 106,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "final_writer",
        after_final_writer: "main",
      },
    });

    expect(result.dispatch.actor).toBe("final_writer");
    expect(result.dispatch.key).toBe("step7:106:final_writer:main");
    expect(result.dispatch.message).toContain("Use output.md as the only article base");
    expect(result.dispatch.message).toContain("FULL_REWRITE_REQUIRED");
    expect(result.dispatch.message).toContain("Rewrite the whole article into a publication-grade final article");
    expect(result.dispatch.message).toContain("Latest final-stage editor feedback block:");
    expect(result.dispatch.suppressDelivery).toBe(true);
    expect(result.dispatch.deliverRequiresChangedFile).toBe(true);
    expect(result.dispatch.afterSuccessWhenFilesChanged).toEqual(["final-output.md"]);
    expect(result.dispatch.afterSuccessPatch).toMatchObject({
      workflow_mode: "auto",
      current_step: "step_7_drafting",
      next_actor: "main",
      awaiting_user_choice: "no",
      final_article_ready: "yes",
      final_writer_mode: "",
    });
  });

  test("dispatches final writer revision with latest final feedback and review blocks only", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-final-writer-revise-"));
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "## old-draft",
        "role=editor | target=writer",
        "### instruction",
        "草稿阶段旧意见",
        "",
        "## final-feedback",
        "role=editor | type=step_7_feedback | target=final_writer",
        "### instruction",
        "主编反馈：中文。",
        "",
        "## final-review",
        "role=reviewer | review_target=final",
        "verdict=changes_requested",
        "### Should Fix",
        "补一条正式稿意见",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(projectDir, "final-output.md"), "english final", "utf8");

    const result = await tick({
      projectDir,
      statusMtimeMs: 1061,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "final_writer",
        after_final_writer: "main",
        final_writer_mode: "revise",
      },
    });

    expect(result.dispatch.message).toContain("Use final-output.md as the only article base");
    expect(result.dispatch.message).toContain("FULL_REWRITE_REQUIRED");
    expect(result.dispatch.message).toContain("Removing process notes, translating only, or making partial line edits is not enough");
    expect(result.dispatch.message).toContain("主编反馈：中文。");
    expect(result.dispatch.message).toContain("补一条正式稿意见");
    expect(result.dispatch.message).toContain("Do not reuse draft-stage review history");
    expect(result.dispatch.message).not.toContain("草稿阶段旧意见");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("dispatches final writer revision when final editor feedback uses markdown field lines", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-final-writer-markdown-feedback-"));
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "## final-feedback",
        "- **id**: F_final_2026-04-17-01",
        "- **role**: editor",
        "- **type**: step_7_feedback",
        "- **target**: final_writer",
        "- **instruction**: 将当前英文终稿完整转为中文版本。",
        "",
        "## final-review",
        "- **role**: reviewer",
        "- **review_target**: final",
        "verdict=changes_requested",
        "### Should Fix",
        "补一条正式稿意见",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(projectDir, "final-output.md"), "english final", "utf8");

    const result = await tick({
      projectDir,
      statusMtimeMs: 10615,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "final_writer",
        after_final_writer: "main",
        final_writer_mode: "revise",
      },
    });

    expect(result.dispatch.actor).toBe("final_writer");
    expect(result.dispatch.message).toContain("将当前英文终稿完整转为中文版本");
    expect(result.dispatch.message).toContain("补一条正式稿意见");
    const editorSection = between(
      result.dispatch.message,
      "Latest final-stage editor feedback block:\n",
      "\nLatest final-stage reviewer block:\n"
    );
    const reviewerSection = between(result.dispatch.message, "Latest final-stage reviewer block:\n", "");
    expect(editorSection).toContain("将当前英文终稿完整转为中文版本");
    expect(editorSection).not.toContain("补一条正式稿意见");
    expect(reviewerSection).toContain("补一条正式稿意见");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("dispatches final writer revision when markdown field values are wrapped in backticks", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-final-writer-backtick-feedback-"));
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "### Round: 2026-04-17 Final Revision Feedback",
        "",
        "- **id**: `F_final_2026-04-17-01`",
        "- **role**: `editor`",
        "- **type**: `step_7_feedback`",
        "- **target**: `final_writer`",
        "- **instruction**: 将当前英文终稿完整转为中文版本。",
        "",
        "### Round: 2026-04-17 Final Review",
        "- **role**: `reviewer`",
        "- **review_target**: `final`",
        "verdict=changes_requested",
        "### Should Fix",
        "补一条正式稿意见",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(projectDir, "final-output.md"), "english final", "utf8");

    const result = await tick({
      projectDir,
      statusMtimeMs: 10616,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "final_writer",
        after_final_writer: "main",
        final_writer_mode: "revise",
      },
    });

    expect(result.dispatch.actor).toBe("final_writer");
    expect(result.dispatch.message).toContain("将当前英文终稿完整转为中文版本");
    expect(result.dispatch.message).toContain("补一条正式稿意见");
    const editorSection = between(
      result.dispatch.message,
      "Latest final-stage editor feedback block:\n",
      "\nLatest final-stage reviewer block:\n"
    );
    const reviewerSection = between(result.dispatch.message, "Latest final-stage reviewer block:\n", "");
    expect(editorSection).toContain("将当前英文终稿完整转为中文版本");
    expect(editorSection).not.toContain("补一条正式稿意见");
    expect(reviewerSection).toContain("补一条正式稿意见");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("final writer prompt requires Chinese output", async () => {
    const result = await tick({
      projectDir: "/tmp/project",
      statusMtimeMs: 10617,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "final_writer",
        after_final_writer: "main",
        final_writer_mode: "generate",
      },
    });

    expect(result.dispatch.actor).toBe("final_writer");
    expect(result.dispatch.message).toContain("Write the final article in Chinese.");
    expect(result.dispatch.message).toContain("Do not output English or any other non-Chinese full article.");
  });

  test("waits for final editor feedback block before dispatching final writer revision", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-final-writer-missing-feedback-"));
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "## old-draft",
        "role=editor | target=writer",
        "### instruction",
        "草稿阶段旧意见",
        "",
        "## final-review",
        "role=reviewer | review_target=final",
        "verdict=changes_requested",
        "### Should Fix",
        "补一条正式稿意见",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(projectDir, "final-output.md"), "english final", "utf8");

    const result = await tick({
      projectDir,
      statusMtimeMs: 1062,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "final_writer",
        after_final_writer: "main",
        final_writer_mode: "revise",
      },
    });

    expect(result.dispatch).toBeUndefined();
    expect(result.runtimePatch).toMatchObject({
      last_decision: "step7_final_writer_wait_editor_feedback",
      last_error: "final_editor_feedback_missing",
    });

    await rm(projectDir, { recursive: true, force: true });
  });

  test("returns final writer to reviewer during final review loop without requiring editor block", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-final-writer-reviewer-loop-"));
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "## final-review",
        "role=reviewer | review_target=final",
        "verdict=changes_requested",
        "### Should Fix",
        "补一条正式稿意见",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(projectDir, "final-output.md"), "english final", "utf8");

    const result = await tick({
      projectDir,
      statusMtimeMs: 107,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "final_writer",
        after_final_writer: "reviewer",
        final_writer_mode: "revise",
      },
    });

    expect(result.dispatch.key).toBe("step7:107:final_writer:reviewer");
    expect(result.dispatch.message).toContain("补一条正式稿意见");
    expect(result.dispatch.message).toContain("Latest final-stage editor feedback block:\n(none)");
    expect(result.dispatch.afterSuccessPatch).toMatchObject({
      next_actor: "reviewer",
      final_article_ready: "no",
      final_writer_mode: "",
    });

    await rm(projectDir, { recursive: true, force: true });
  });

  test("posts final article menu after final writer", async () => {
    const result = await tick({
      projectDir: "/tmp/project",
      statusMtimeMs: 108,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "main",
        final_article_ready: "yes",
      },
    });

    expect(result.dispatch.actor).toBe("main");
    expect(result.dispatch.message).toContain("final-output.md");
    expect(result.dispatch.afterStatusPatch).toMatchObject({
      active_menu_scope: "step_7_final_menu",
      workflow_mode: "manual",
      awaiting_user_choice: "yes",
    });
    expect(result.dispatch.afterStatusPatch.active_menu_options).toContain("1=SET(docs_publish_requested=yes");
    expect(result.dispatch.afterStatusPatch.active_menu_options).toContain("next_actor=final_writer");
    expect(result.dispatch.afterStatusPatch.active_menu_options).toContain("final_writer_mode=revise");
  });

  test("blocks final review until final-output exists", async () => {
    const result = await tick({
      projectDir: "/tmp/project",
      statusMtimeMs: 109,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "reviewer",
        review_target: "final",
      },
    });

    expect(result.dispatch).toBeUndefined();
    expect(result.runtimePatch.last_error).toBe("final_output_missing_for_review");
  });

  test("dispatches reviewer for final review when final-output exists", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-final-review-"));
    await writeFile(join(projectDir, "final-output.md"), "formal article", "utf8");

    const result = await tick({
      projectDir,
      statusMtimeMs: 110,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "reviewer",
        review_target: "final",
      },
    });

    expect(result.dispatch.actor).toBe("reviewer");
    expect(result.dispatch.message).toContain("review final-output.md");
    expect(result.dispatch.message).toContain("/.openclaw/shared/knowledge/review_gates/");
    expect(result.dispatch.message).toContain("/.openclaw/shared/knowledge/repair_patterns/");
    expect(result.dispatch.message).toContain("type=review_knowledge_read");
    expect(result.dispatch.message).toContain("apply_points_or_none=...");
    expect(result.dispatch.message).toContain("/.openclaw/shared/templates/articles/<template_id>.md");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("step 7 reviewer delivers the review block and advances from latest verdict", async () => {
    const result = await tick({
      projectDir: "/tmp/project",
      statusMtimeMs: 105,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "reviewer",
      },
    });

    expect(result.dispatch.actor).toBe("reviewer");
    expect(result.dispatch.deliverFromChangedFile).toBe("draft_review_history.md");
    expect(result.dispatch.deliverRequiresChangedFile).toBe(true);
    expect(result.dispatch.afterSuccessWhenFilesChanged).toEqual(["draft_review_history.md"]);
    expect(result.dispatch.afterSuccessPatchFromLatestVerdict).toBe(true);
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
