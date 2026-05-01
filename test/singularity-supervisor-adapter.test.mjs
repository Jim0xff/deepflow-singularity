import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
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
    expect(result.dispatch.message).toContain("Use latest Sx point ids p1..pn");
    expect(result.dispatch.message).toContain("covered_point_ids");
    expect(result.dispatch.message).toContain("unanswered_point_ids");
    expect(result.dispatch.message).toContain("next_actor=main");
    expect(result.dispatch.afterSuccessPatch).toBeUndefined();
  });

  test("dispatches reviewer for step 5 when current_step is missing but status implies debate", async () => {
    const result = await tick({
      projectDir: "/tmp/project",
      statusMtimeMs: 1001,
      status: {
        workflow_mode: "auto",
        last_completed_step: "step_5_debate",
        next_step: "step_6_feedback",
        next_actor: "reviewer",
        awaiting_user_choice: "no",
      },
    });

    expect(result.dispatch.actor).toBe("reviewer");
    expect(result.dispatch.key).toBe("step5:1001:reviewer");
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
    expect(result.dispatch.message).toContain("3. 退出当前项目");
    expect(result.dispatch.afterStatusPatch.active_menu_options).toContain("WRITE_AND_POST_FULL_NEXT_Sx");
    expect(result.dispatch.afterStatusPatch.active_menu_options).toContain("3=EXIT_CURRENT_PROJECT");
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
    expect(result.dispatch.message).toContain(
      "enumerate every file currently under /.openclaw/shared/knowledge/writing_rules/ and read them all"
    );
    expect(result.dispatch.message).toContain("type=writing_knowledge_read");
    expect(result.dispatch.message).toContain("apply_points_or_none=...");
    expect(result.dispatch.message).toContain("/.openclaw/shared/templates/articles/<template_id>.md");
    expect(result.dispatch.message).toContain("read only the bound shared template file");
    expect(result.dispatch.message).toContain("Do not read templates from the project directory.");
    expect(result.dispatch.suppressDelivery).toBeUndefined();
    expect(result.dispatch.deliverFromChangedFile).toBe("output.md");
    expect(result.dispatch.deliverChangedFileMode).toBe("full_text");
    expect(result.dispatch.deliveryActor).toBe("main");
    expect(result.dispatch.deliveryFailureDoesNotBlockSuccess).toBe(true);
    expect(result.dispatch.recoveryDeliverFromChangedFile).toBe("output.md");
    expect(result.dispatch.recoveryDeliveryActor).toBe("main");
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

  test("does not inject bound source-pack read instructions for writer", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-source-pack-writer-"));
    await writeFile(
      join(projectDir, "project.md"),
      [
        "# Project",
        "",
        "## Bound source packs",
        "- pack_id=black-myth-wukong-core-v1",
        "- pack_id=xiyouji-shituoling-v1",
        "",
      ].join("\n"),
      "utf8"
    );

    const result = await tick({
      projectDir,
      statusMtimeMs: 1022,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "writer",
      },
    });

    expect(result.dispatch.message).not.toContain("Bound source packs for writer:");
    expect(result.dispatch.message).not.toContain("pack_id=black-myth-wukong-core-v1");
    expect(result.dispatch.message).not.toContain("pack_id=xiyouji-shituoling-v1");
    expect(result.dispatch.message).not.toContain("/.openclaw/shared/source-packs/black-myth-wukong-core-v1/PACK.md");
    expect(result.dispatch.message).not.toContain("/.openclaw/shared/source-packs/xiyouji-shituoling-v1/PACK.md");
    expect(result.dispatch.message).not.toContain("type=source_pack_read");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("bound source packs in project do not leak into writer prompt even when guide is present", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-source-pack-ignore-guide-"));
    await writeFile(
      join(projectDir, "project.md"),
      [
        "# Project",
        "",
        "## Bound source packs",
        "- pack_id=black-myth-wukong-core-v1 | guide=/tmp/wrong-pack.md",
        "",
      ].join("\n"),
      "utf8"
    );

    const result = await tick({
      projectDir,
      statusMtimeMs: 1023,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "writer",
      },
    });

    expect(result.dispatch.message).not.toContain("Bound source packs for writer:");
    expect(result.dispatch.message).not.toContain("pack_id=black-myth-wukong-core-v1");
    expect(result.dispatch.message).not.toContain(
      "/.openclaw/shared/source-packs/black-myth-wukong-core-v1/PACK.md"
    );
    expect(result.dispatch.message).not.toContain("/tmp/wrong-pack.md");
    expect(result.dispatch.message).not.toContain("type=source_pack_read");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("dispatches writer with latest writer-target draft feedback block pasted from draft_review_history", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-writer-feedback-"));
    await mkdir(join(projectDir, "runtime"), { recursive: true });
    await writeFile(
      join(projectDir, "handoff.md"),
      [
        "## step_6_feedback",
        "### what_it_really_means",
        "核心不是安全治理，而是员工智力资产的收益权与退出权。",
        "",
        "### allowed_boundary_topics",
        "- 高风险安全场景",
        "",
        "### forbidden_expansions",
        "- 不得把安全场景写成文章主线",
        "",
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "## 2026-04-24 09:40:00 UTC|role:editor|type:step_7_feedback|target:writer",
        "instruction:",
        "旧意见：轻微顺稿。",
        "",
        "## 2026-04-24 09:44:00 UTC|role:editor|type:step_7_feedback|target:writer",
        "instruction:",
        "继续修改一轮：名著映照段目前偏简略，请做有限增厚。",
        "1) 把《是，大臣》与《官场现形记》的映照从观点并列升级到动作并列。",
        "",
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(projectDir, "runtime", "reviewer-feedback.json"),
      JSON.stringify(
        {
          items: [
            {
              ts: "2026-04-24T09:44:55Z",
              review_target: "draft",
              verdict: "changes_requested",
              block: [
                "## 2026-04-24T09:44:55Z | role: reviewer | type: editorial_review | target: output.md | review_target:draft",
                "verdict=changes_requested",
                "### MUST_FIX",
                "1. 把中后段直论证重排为故事承载结构。",
                "2. 继续提高科幻叙事主导占比。",
                "### RISK_POINTS",
                "- 说明书化段落会继续触发退稿。",
                "### USER_GUIDANCE",
                "下一稿继续做形态整改，而不是观点重写。",
              ].join("\n"),
            },
          ],
        },
        null,
        2,
      ) + "\n",
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
    expect(result.dispatch.message).toContain("Latest reviewer review block for this draft target:");
    expect(result.dispatch.message).toContain("把中后段直论证重排为故事承载结构");
    expect(result.dispatch.message).toContain("MUST_FIX, RISK_POINTS, and USER_GUIDANCE as mandatory revision input");
    expect(result.dispatch.message).toContain("Step 6 axis snapshot:");
    expect(result.dispatch.message).toContain("员工智力资产的收益权与退出权");
    expect(result.dispatch.message).toContain("不得把安全场景写成文章主线");
    expect(result.dispatch.message).toContain("Keep counterexamples and boundary materials as supporting limits only");
    expect(result.dispatch.message).not.toContain("旧意见：轻微顺稿。");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("writer falls back to draft_review_history when reviewer feedback cache is absent", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-writer-review-fallback-"));
    await writeFile(join(projectDir, "handoff.md"), "## step_6_feedback\n### what_it_really_means\n主轴。\n", "utf8");
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "## 2026-04-24T09:44:55Z | role: reviewer | type: editorial_review | target: output.md | review_target:draft",
        "verdict=changes_requested",
        "### MUST_FIX",
        "1. 保留 fallback 能力。",
      ].join("\n"),
      "utf8"
    );

    const result = await tick({
      projectDir,
      statusMtimeMs: 1200,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "writer",
      },
    });

    expect(result.dispatch.message).toContain("保留 fallback 能力。");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("dispatches writer with reviewer-target draft editor contract after re-review changes_requested", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-writer-rereview-contract-"));
    await mkdir(join(projectDir, "runtime"), { recursive: true });
    await writeFile(join(projectDir, "handoff.md"), "## step_6_feedback\n### what_it_really_means\n主轴不变。\n", "utf8");
    await writeFile(join(projectDir, "output.md"), "# 标题\n\n正文。\n", "utf8");
    await utimes(join(projectDir, "output.md"), new Date("2026-04-27T13:50:00Z"), new Date("2026-04-27T13:50:00Z"));
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "## 2026-04-27 13:26:21 UTC|role:editor|type:step_7_feedback|target:writer",
        "instruction:",
        "旧 writer 合同：只补标题，不改正文段落。",
        "",
        "## 2026-04-27 13:31:21 UTC|role:editor|type:step_7_feedback|target:reviewer",
        "instruction:",
        "新 reviewer 合同：把“拍板三件事”改成动作链，删掉“接下来两周若...若...”拖尾。",
        "",
        "## 2026-04-27 13:36:39 UTC|role:reviewer|type:editorial_review|target:output.md|review_target:draft|verdict:changes_requested",
        "verdict=changes_requested",
        "### MUST_FIX",
        "1. 把“拍板三件事”改成动作链。",
        "2. 删除“接下来两周若...若...”拖尾。",
        "### USER_GUIDANCE",
        "仅重写“所以周五下午那间办公室里...”至文末。",
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(projectDir, "runtime", "reviewer-feedback.json"),
      JSON.stringify(
        {
          items: [
            {
              ts: "2026-04-27T13:36:39Z",
              review_target: "draft",
              verdict: "changes_requested",
              block: [
                "## 2026-04-27 13:36:39 UTC|role:reviewer|type:editorial_review|target:output.md|review_target:draft|verdict:changes_requested",
                "verdict=changes_requested",
                "### MUST_FIX",
                "1. 把“拍板三件事”改成动作链。",
                "2. 删除“接下来两周若...若...”拖尾。",
                "### USER_GUIDANCE",
                "仅重写“所以周五下午那间办公室里...”至文末。",
              ].join("\n"),
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8"
    );

    const result = await tick({
      projectDir,
      statusMtimeMs: 1300,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "writer",
      },
    });

    expect(result.dispatch.actor).toBe("writer");
    expect(result.dispatch.message).toContain("Latest draft-stage editor feedback block:");
    expect(result.dispatch.message).toContain("新 reviewer 合同：把“拍板三件事”改成动作链");
    expect(result.dispatch.message).not.toContain("旧 writer 合同：只补标题，不改正文段落。");
    expect(result.dispatch.message).toContain("Latest reviewer review block for this draft target:");
    expect(result.dispatch.message).toContain("删除“接下来两周若...若...”拖尾");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("dispatches reviewer with writer-target draft feedback from draft_review_history when reviewing a rewritten draft", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-reviewer-feedback-"));
    await writeFile(
      join(projectDir, "handoff.md"),
      [
        "## step_6_feedback",
        "### what_it_really_means",
        "主链是智力资产蒸馏导致主动性塌缩与创新下降。",
        "",
        "### forbidden_expansions",
        "- 不得把高风险安全场景扩写成主机制",
        "",
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "## 2026-04-24 09:40:00 UTC|role:editor|type:step_7_feedback|target:writer",
        "instruction:",
        "旧意见：轻微顺稿。",
        "",
        "## 2026-04-24 09:44:00 UTC|role:editor|type:step_7_feedback|target:writer",
        "instruction:",
        "先复审再修改：首两段必须明确《2001太空漫游》和《黑镜》的具体场景来源。",
        "黑镜故事段必须补足人物-情节-冲突-映照完整链。",
        "",
      ].join("\n"),
      "utf8"
    );

    const result = await tick({
      projectDir,
      statusMtimeMs: 1022,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "reviewer",
        review_target: "draft",
      },
    });

    expect(result.dispatch.actor).toBe("reviewer");
    expect(result.dispatch.message).toContain("Latest editor feedback block for this review target:");
    expect(result.dispatch.message).toContain("首两段必须明确《2001太空漫游》和《黑镜》的具体场景来源");
    expect(result.dispatch.message).toContain("人物-情节-冲突-映照完整链");
    expect(result.dispatch.message).toContain("mandatory review direction");
    expect(result.dispatch.message).toContain("verdict=changes_requested");
    expect(result.dispatch.message).toContain("Step 6 axis snapshot:");
    expect(result.dispatch.message).toContain("智力资产蒸馏导致主动性塌缩与创新下降");
    expect(result.dispatch.message).toContain("boundary material overtakes the Step 6 primary axis");
    expect(result.dispatch.message).not.toContain("旧意见：轻微顺稿。");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("dispatches reviewer with reviewer-target draft feedback from draft_review_history when re-review is newer than output", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-reviewer-rereview-"));
    await writeFile(
      join(projectDir, "handoff.md"),
      [
        "## step_6_feedback",
        "### what_it_really_means",
        "主链保持不变。",
        "",
        "## latest-feedback",
        "role=editor | type=step_7_feedback | target=writer",
        "旧 writer 合同：继续做结构整改。",
        "",
      ].join("\n"),
      "utf8"
    );
    await writeFile(join(projectDir, "output.md"), "# 当前草稿\n\n正文。", "utf8");
    await utimes(join(projectDir, "output.md"), new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "## 2026-04-27 14:57:57 UTC|role:editor|type:step_7_feedback|target:reviewer",
        "instruction:",
        "执行“较大变更重审”。全文禁用“弱校”这一表达，并输出替换清单与残留项。",
        "",
      ].join("\n"),
      "utf8"
    );

    const result = await tick({
      projectDir,
      statusMtimeMs: 2027,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "reviewer",
        review_target: "draft",
      },
    });

    expect(result.dispatch.actor).toBe("reviewer");
    expect(result.dispatch.message).toContain("Latest editor feedback block for this review target:");
    expect(result.dispatch.message).toContain("全文禁用“弱校”这一表达");
    expect(result.dispatch.message).toContain("替换清单与残留项");
    expect(result.dispatch.message).not.toContain("旧 writer 合同：继续做结构整改。");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("dispatches reviewer with reviewer-target draft feedback from timestamp-style draft_review_history blocks", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-reviewer-rereview-ts-"));
    await writeFile(
      join(projectDir, "handoff.md"),
      [
        "## latest-feedback",
        "role=editor | type=step_7_feedback | target=writer",
        "writer 合同：先做结构调整。",
        "",
      ].join("\n"),
      "utf8"
    );
    await writeFile(join(projectDir, "output.md"), "# 当前草稿\n\n正文。", "utf8");
    await utimes(join(projectDir, "output.md"), new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "---",
        "[2026-04-27T14:57:57Z]",
        "actor: editor",
        "type: step_7_feedback",
        "target: reviewer",
        "instruction:",
        "按 reviewer 重审口径检查标题是否仍然抽象，并清理“弱校”等词。",
        "",
      ].join("\n"),
      "utf8"
    );

    const result = await tick({
      projectDir,
      statusMtimeMs: 20271,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "reviewer",
        review_target: "draft",
      },
    });

    expect(result.dispatch.actor).toBe("reviewer");
    expect(result.dispatch.message).toContain("按 reviewer 重审口径检查标题是否仍然抽象");
    expect(result.dispatch.message).not.toContain("writer 合同：先做结构调整。");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("dispatches reviewer with reviewer-target draft contract after writer rewrites output for a re-review cycle", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-reviewer-rereview-after-writer-"));
    await writeFile(join(projectDir, "handoff.md"), "## step_6_feedback\n### what_it_really_means\n主链保持不变。\n", "utf8");
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "## 2026-04-27 13:26:21 UTC|role:editor|type:step_7_feedback|target:writer",
        "instruction:",
        "旧 writer 合同：只补标题，不改正文段落。",
        "",
        "## 2026-04-27 13:31:21 UTC|role:editor|type:step_7_feedback|target:reviewer",
        "instruction:",
        "新 reviewer 合同：全篇清理机器腔，并给出替换清单。",
        "",
        "## 2026-04-27 13:36:39 UTC|role:reviewer|type:editorial_review|target:output.md|review_target:draft|verdict:changes_requested",
        "verdict=changes_requested",
        "### MUST_FIX",
        "1. 全篇清理机器腔。",
        "2. 给出替换清单。",
        "",
        "## 2026-04-27 13:45:20 UTC | role:writer | type:draft_round | target:step_7_drafting",
        "- changes=output.md 已写入新稿：完成全篇机器腔清理。",
      ].join("\n"),
      "utf8"
    );
    await writeFile(join(projectDir, "output.md"), "# 改后稿\n\n正文。\n", "utf8");
    await utimes(join(projectDir, "output.md"), new Date("2026-04-27T13:45:20Z"), new Date("2026-04-27T13:45:20Z"));

    const result = await tick({
      projectDir,
      statusMtimeMs: 20275,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "reviewer",
        review_target: "draft",
      },
    });

    expect(result.dispatch.actor).toBe("reviewer");
    expect(result.dispatch.message).toContain("Latest editor feedback block for this review target:");
    expect(result.dispatch.message).toContain("新 reviewer 合同：全篇清理机器腔，并给出替换清单。");
    expect(result.dispatch.message).not.toContain("旧 writer 合同：只补标题，不改正文段落。");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("dispatches reviewer with reviewer-target draft feedback when timestamp carries UTC offset", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-reviewer-rereview-offset-"));
    await writeFile(
      join(projectDir, "handoff.md"),
      [
        "## step_6_feedback",
        "### what_it_really_means",
        "主链保持不变。",
        "",
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "## 2026-04-27T22:57:57+08:00|role:editor|type:step_7_feedback|target:writer",
        "instruction:",
        "旧 writer 合同：先做结构调整。",
        "",
        "## 2026-04-27T23:57:57+08:00|role:editor|type:step_7_feedback|target:reviewer",
        "instruction:",
        "offset reviewer 合同：直接按重审意见检查标题和禁词。",
        "",
      ].join("\n"),
      "utf8"
    );
    await writeFile(join(projectDir, "output.md"), "# 当前草稿\n\n正文。", "utf8");
    await utimes(join(projectDir, "output.md"), new Date("2026-04-27T14:59:00Z"), new Date("2026-04-27T14:59:00Z"));

    const result = await tick({
      projectDir,
      statusMtimeMs: 20273,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "reviewer",
        review_target: "draft",
      },
    });

    expect(result.dispatch.actor).toBe("reviewer");
    expect(result.dispatch.message).toContain("offset reviewer 合同：直接按重审意见检查标题和禁词。");
    expect(result.dispatch.message).not.toContain("旧 writer 合同：先做结构调整。");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("dispatches reviewer with reviewer-target draft feedback when timestamp uses milliseconds and compact offset", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-reviewer-rereview-ms-offset-"));
    await writeFile(join(projectDir, "handoff.md"), "## step_6_feedback\n### what_it_really_means\n主链保持不变。\n", "utf8");
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "## 2026-04-27 22:57:57.123 +0800|role:editor|type:step_7_feedback|target:writer",
        "instruction:",
        "旧 writer 合同：先做结构调整。",
        "",
        "## 2026-04-27 23:57:57.456 +0800|role:editor|type:step_7_feedback|target:reviewer",
        "instruction:",
        "毫秒偏移 reviewer 合同：按重审意见检查标题和禁词。",
        "",
      ].join("\n"),
      "utf8"
    );
    await writeFile(join(projectDir, "output.md"), "# 当前草稿\n\n正文。", "utf8");
    await utimes(join(projectDir, "output.md"), new Date("2026-04-27T14:59:00Z"), new Date("2026-04-27T14:59:00Z"));

    const result = await tick({
      projectDir,
      statusMtimeMs: 20274,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "reviewer",
        review_target: "draft",
      },
    });

    expect(result.dispatch.actor).toBe("reviewer");
    expect(result.dispatch.message).toContain("毫秒偏移 reviewer 合同：按重审意见检查标题和禁词。");
    expect(result.dispatch.message).not.toContain("旧 writer 合同：先做结构调整。");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("dispatches reviewer with reviewer-target draft feedback from markdown-field draft_review_history blocks", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-reviewer-rereview-md-"));
    await writeFile(
      join(projectDir, "handoff.md"),
      [
        "## latest-feedback",
        "role=editor | type=step_7_feedback | target=writer",
        "writer 合同：先把四个场景前置。",
        "",
      ].join("\n"),
      "utf8"
    );
    await writeFile(join(projectDir, "output.md"), "# 当前草稿\n\n正文。", "utf8");
    await utimes(join(projectDir, "output.md"), new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "### Round: 2026-04-27 Draft Re-review Feedback",
        "",
        "- **timestamp**: 2026-04-27 14:57:57 UTC",
        "- **role**: editor",
        "- **type**: step_7_feedback",
        "- **target**: reviewer",
        "- **instruction**: 全文禁用“弱校”，并给出替换清单与残留项。",
        "",
      ].join("\n"),
      "utf8"
    );

    const result = await tick({
      projectDir,
      statusMtimeMs: 20272,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "reviewer",
        review_target: "draft",
      },
    });

    expect(result.dispatch.actor).toBe("reviewer");
    expect(result.dispatch.message).toContain("全文禁用“弱校”，并给出替换清单与残留项。");
    expect(result.dispatch.message).not.toContain("writer 合同：先把四个场景前置。");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("dispatches reviewer with writer-target draft feedback when output is newer than reviewer re-review block", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-reviewer-writer-fallback-"));
    await writeFile(
      join(projectDir, "handoff.md"),
      [
        "## step_6_feedback",
        "### what_it_really_means",
        "主链保持不变。",
        "",
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "## 2030-01-01 00:00:00 UTC|role:editor|type:step_7_feedback|target:writer",
        "instruction:",
        "writer 合同：先把四个场景前置，再改 A/B/C 递进。",
        "",
        "## 2026-04-27 14:57:57 UTC|role:editor|type:step_7_feedback|target:reviewer",
        "instruction:",
        "旧 reviewer 合同：检查是否还存在“弱校”等词。",
        "",
      ].join("\n"),
      "utf8"
    );
    await writeFile(join(projectDir, "output.md"), "# 新稿\n\n正文。", "utf8");
    await utimes(join(projectDir, "output.md"), new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z"));

    const result = await tick({
      projectDir,
      statusMtimeMs: 2028,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "reviewer",
        review_target: "draft",
      },
    });

    expect(result.dispatch.actor).toBe("reviewer");
    expect(result.dispatch.message).toContain("writer 合同：先把四个场景前置，再改 A/B/C 递进。");
    expect(result.dispatch.message).not.toContain("旧 reviewer 合同：检查是否还存在“弱校”等词。");

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
    expect(result.dispatch.message).toContain("当前仍处于草稿写作步骤，不是正式版步骤");
    expect(result.dispatch.message).toContain("选项2只能表示继续修改草稿并交给 writer");
    expect(result.dispatch.message).toContain("选项3只能表示重新审稿并交给 reviewer");
    expect(result.dispatch.afterStatusPatch.active_menu_options).toContain(
      "1=SET(workflow_mode=auto,current_step=step_8_final_article,next_actor=final_writer"
    );
    expect(result.dispatch.afterStatusPatch.active_menu_options).toContain("final_writer_mode=generate");
    expect(result.dispatch.afterStatusPatch.active_menu_options).toContain("4=EXIT_CURRENT_PROJECT");
  });

  test("adds source-pack hint to main draft menu when project binds packs", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-source-pack-main-hint-"));
    await writeFile(
      join(projectDir, "project.md"),
      [
        "# Project",
        "",
        "## Bound source packs",
        "- pack_id=black-myth-wukong-core-v1",
        "- pack_id=xiyouji-shituoling-v1",
        "",
      ].join("\n"),
      "utf8"
    );

    const result = await tick({
      projectDir,
      statusMtimeMs: 1042,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "main",
      },
    });

    expect(result.dispatch.message).toContain("附加命令：素材包（已绑定：black-myth-wukong-core-v1, xiyouji-shituoling-v1）");
    expect(result.dispatch.message).not.toContain("If any source packs are bound in project.md, read them before replying.");
    expect(result.dispatch.message).not.toContain("/.openclaw/shared/source-packs/black-myth-wukong-core-v1/PACK.md");

    await rm(projectDir, { recursive: true, force: true });
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
    expect(result.dispatch.message).toContain(
      "enumerate every file currently under /.openclaw/shared/knowledge/review_gates/ and /.openclaw/shared/knowledge/repair_patterns/, then read them all"
    );
    expect(result.dispatch.message).toContain("type=review_knowledge_read");
    expect(result.dispatch.message).toContain("read_fail_or_none=...");
    expect(result.dispatch.message).toContain("Ignore all prior session context.");
    expect(result.dispatch.message).toContain("This dispatch is editorial review only, not Step 5 debate");
    expect(result.dispatch.requireLatestVerdict).toBe(true);
  });

  test("does not inject bound source-pack read instructions for reviewer", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-source-pack-reviewer-"));
    await writeFile(
      join(projectDir, "project.md"),
      [
        "# Project",
        "",
        "## Bound source packs",
        "- pack_id=black-myth-wukong-core-v1",
        "",
      ].join("\n"),
      "utf8"
    );

    const result = await tick({
      projectDir,
      statusMtimeMs: 1042,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "reviewer",
        review_target: "draft",
      },
    });

    expect(result.dispatch.actor).toBe("reviewer");
    expect(result.dispatch.message).not.toContain("Bound source packs for reviewer:");
    expect(result.dispatch.message).not.toContain("type=source_pack_read");
    expect(result.dispatch.message).not.toContain(
      "/.openclaw/shared/source-packs/black-myth-wukong-core-v1/PACK.md"
    );

    await rm(projectDir, { recursive: true, force: true });
  });

  test("dispatches final writer and returns to main with final-output", async () => {
    const result = await tick({
      projectDir: "/tmp/project",
      statusMtimeMs: 106,
      status: {
        workflow_mode: "auto",
        current_step: "step_8_final_article",
        next_actor: "final_writer",
        after_final_writer: "main",
      },
    });

    expect(result.dispatch.actor).toBe("final_writer");
    expect(result.dispatch.key).toBe("step8:106:final_writer:main");
    expect(result.dispatch.message).toContain("Use output.md as the only article base");
    expect(result.dispatch.message).toContain("FULL_REWRITE_REQUIRED");
    expect(result.dispatch.message).toContain("Rewrite the whole article into a publication-grade final article");
    expect(result.dispatch.message).toContain("Latest final-stage editor feedback block:");
    expect(result.dispatch.suppressDelivery).toBe(true);
    expect(result.dispatch.deliverFromChangedFile).toBeUndefined();
    expect(result.dispatch.recoveryDeliverFromChangedFile).toBe("final-output.md");
    expect(result.dispatch.deliverChangedFileMode).toBe("full_text");
    expect(result.dispatch.recoveryDeliveryActor).toBe("main");
    expect(result.dispatch.deliverRequiresChangedFile).toBe(true);
    expect(result.dispatch.afterSuccessWhenFilesChanged).toEqual(["final-output.md"]);
    expect(result.dispatch.afterSuccessPatch).toMatchObject({
      workflow_mode: "auto",
      current_step: "step_8_final_article",
      next_actor: "main",
      awaiting_user_choice: "no",
      final_article_ready: "yes",
      review_target: "final",
      final_writer_mode: "",
    });
  });

  test("does not inject bound source-pack read instructions for final writer", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-source-pack-final-writer-"));
    await writeFile(
      join(projectDir, "project.md"),
      [
        "# Project",
        "",
        "## Bound source packs",
        "- pack_id=black-myth-wukong-core-v1",
        "",
      ].join("\n"),
      "utf8"
    );

    const result = await tick({
      projectDir,
      statusMtimeMs: 1062,
      status: {
        workflow_mode: "auto",
        current_step: "step_8_final_article",
        next_actor: "final_writer",
        after_final_writer: "main",
      },
    });

    expect(result.dispatch.message).toContain("Read project.md, status.md, handoff.md, and output.md.");
    expect(result.dispatch.message).not.toContain("Bound source packs for final_writer:");
    expect(result.dispatch.message).not.toContain("pack_id=black-myth-wukong-core-v1");
    expect(result.dispatch.message).not.toContain("type=source_pack_read");

    await rm(projectDir, { recursive: true, force: true });
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
        "role=editor | type=step_8_feedback | target=final_writer",
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
        current_step: "step_8_final_article",
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
        "- **type**: step_8_feedback",
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
        current_step: "step_8_final_article",
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
        "- **type**: `step_8_feedback`",
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
        current_step: "step_8_final_article",
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

  test("dispatches final writer revision when final editor feedback uses timestamp block format", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-final-writer-timestamp-feedback-"));
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "---",
        "[2026-04-22T13:34:00Z]",
        "actor: editor",
        "type: step_8_feedback",
        "target: final_writer",
        "mode: revise",
        "instruction:",
        "1) 两处表述补上明确时间并自然融入正文",
        "2) 笔记体起手改成专栏叙述过渡",
        "",
        "---",
        "[2026-04-22T13:30:00Z]",
        "actor: reviewer",
        "review_target: final",
        "verdict=changes_requested",
        "instruction:",
        "补一条正式稿意见",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(projectDir, "final-output.md"), "existing final", "utf8");

    const result = await tick({
      projectDir,
      statusMtimeMs: 10618,
      status: {
        workflow_mode: "auto",
        current_step: "step_8_final_article",
        next_actor: "final_writer",
        after_final_writer: "main",
        final_writer_mode: "revise",
      },
    });

    expect(result.dispatch.actor).toBe("final_writer");
    expect(result.dispatch.message).toContain("两处表述补上明确时间并自然融入正文");
    expect(result.dispatch.message).toContain("笔记体起手改成专栏叙述过渡");
    expect(result.dispatch.message).toContain("补一条正式稿意见");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("dispatches final writer revision when final editor feedback uses canonical header format", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-final-writer-canonical-feedback-"));
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "## 2026-04-22T13:34:00Z | role: editor | type: step_8_feedback | target: final_writer | mode: revise",
        "instruction:",
        "1) 两处表述补上明确时间并自然融入正文",
        "2) 笔记体起手改成专栏叙述过渡",
        "",
        "## 2026-04-22T13:30:00Z | role: reviewer | review_target: final",
        "verdict=changes_requested",
        "instruction:",
        "补一条正式稿意见",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(projectDir, "final-output.md"), "existing final", "utf8");

    const result = await tick({
      projectDir,
      statusMtimeMs: 10618,
      status: {
        workflow_mode: "auto",
        current_step: "step_8_final_article",
        next_actor: "final_writer",
        after_final_writer: "main",
        final_writer_mode: "revise",
      },
    });

    expect(result.dispatch.actor).toBe("final_writer");
    expect(result.dispatch.message).toContain("两处表述补上明确时间并自然融入正文");
    expect(result.dispatch.message).toContain("笔记体起手改成专栏叙述过渡");
    expect(result.dispatch.message).toContain("补一条正式稿意见");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("dispatches writer when draft editor feedback target carries canonical suffix text", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-draft-writer-suffixed-target-"));
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "## 2026-04-22T13:34:00Z | role: editor | type: step_7_feedback | target: writer+instruction:",
        "instruction:",
        "按这条意见改稿",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(projectDir, "output.md"), "existing draft", "utf8");

    const result = await tick({
      projectDir,
      statusMtimeMs: 10619,
      status: {
        workflow_mode: "auto",
        current_step: "step_7_drafting",
        next_actor: "writer",
      },
    });

    expect(result.dispatch.actor).toBe("writer");
    expect(result.dispatch.message).toContain("按这条意见改稿");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("dispatches final writer when reviewer review_target uses OR enum text", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-final-review-or-enum-"));
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "## 2026-04-22T13:34:00Z | role: editor | type: step_8_feedback | target: final_writer | mode: revise",
        "instruction:",
        "修正式稿",
        "",
        "## 2026-04-22T13:30:00Z | role: reviewer | type: editorial_review | target: output.md_OR_final-output.md | review_target: draft_OR_final | verdict: approved_OR_changes_requested",
        "verdict=changes_requested",
        "instruction:",
        "补一条正式稿意见",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(projectDir, "final-output.md"), "existing final", "utf8");

    const result = await tick({
      projectDir,
      statusMtimeMs: 10620,
      status: {
        workflow_mode: "auto",
        current_step: "step_8_final_article",
        next_actor: "final_writer",
        after_final_writer: "main",
        final_writer_mode: "revise",
      },
    });

    expect(result.dispatch.actor).toBe("final_writer");
    expect(result.dispatch.message).toContain("修正式稿");
    expect(result.dispatch.message).toContain("补一条正式稿意见");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("final writer prompt requires Chinese output", async () => {
    const result = await tick({
      projectDir: "/tmp/project",
      statusMtimeMs: 10617,
      status: {
        workflow_mode: "auto",
        current_step: "step_8_final_article",
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
        current_step: "step_8_final_article",
        next_actor: "final_writer",
        after_final_writer: "main",
        final_writer_mode: "revise",
      },
    });

    expect(result.dispatch).toBeUndefined();
    expect(result.runtimePatch).toMatchObject({
      last_decision: "step8_final_writer_wait_editor_feedback",
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
        current_step: "step_8_final_article",
        next_actor: "final_writer",
        after_final_writer: "reviewer",
        final_writer_mode: "revise",
      },
    });

    expect(result.dispatch.key).toBe("step8:107:final_writer:reviewer");
    expect(result.dispatch.message).toContain("补一条正式稿意见");
    expect(result.dispatch.message).toContain("Latest final-stage editor feedback block:\n(none)");
    expect(result.dispatch.afterSuccessPatch).toMatchObject({
      current_step: "step_8_final_article",
      next_actor: "reviewer",
      final_article_ready: "no",
      review_target: "final",
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
        current_step: "step_8_final_article",
        next_actor: "main",
        final_article_ready: "yes",
      },
    });

    expect(result.dispatch.actor).toBe("main");
    expect(result.dispatch.key).toBe("step8:108:main:final");
    expect(result.dispatch.message).toContain("final-output.md");
    expect(result.dispatch.message).toContain("Current step: step_8_final_article");
    expect(result.dispatch.afterStatusPatch).toMatchObject({
      current_step: "step_8_final_article",
      active_menu_scope: "final_article_menu",
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
        current_step: "step_8_final_article",
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
        current_step: "step_8_final_article",
        next_actor: "reviewer",
        review_target: "final",
      },
    });

    expect(result.dispatch.actor).toBe("reviewer");
    expect(result.dispatch.key).toBe("step8:110:reviewer");
    expect(result.dispatch.message).toContain("Current step: step_8_final_article");
    expect(result.dispatch.message).toContain("review final-output.md");
    expect(result.dispatch.message).toContain("/.openclaw/shared/knowledge/review_gates/");
    expect(result.dispatch.message).toContain("/.openclaw/shared/knowledge/repair_patterns/");
    expect(result.dispatch.message).toContain(
      "enumerate every file currently under /.openclaw/shared/knowledge/review_gates/ and /.openclaw/shared/knowledge/repair_patterns/, then read them all"
    );
    expect(result.dispatch.message).toContain("type=review_knowledge_read");
    expect(result.dispatch.message).toContain("apply_points_or_none=...");
    expect(result.dispatch.message).toContain("/.openclaw/shared/templates/articles/<template_id>.md");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("dispatches reviewer with reviewer-target final feedback when final re-review is newer than final-output", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-final-rereview-reviewer-target-"));
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "## 2026-04-22T13:34:00Z | role: editor | type: step_8_feedback | target: final_writer | mode: revise",
        "instruction:",
        "旧 final_writer 合同：改正式稿节奏。",
        "",
        "## 2026-04-22T14:34:00Z | role: editor | type: step_8_feedback | target: reviewer | review_target: final",
        "instruction:",
        "按终稿重审口径，逐段核查标题是否过泛，并列出残留抽象表达。",
        "",
      ].join("\n"),
      "utf8"
    );
    await writeFile(join(projectDir, "final-output.md"), "formal article", "utf8");
    await utimes(join(projectDir, "final-output.md"), new Date("2026-04-22T14:00:00Z"), new Date("2026-04-22T14:00:00Z"));

    const result = await tick({
      projectDir,
      statusMtimeMs: 1101,
      status: {
        workflow_mode: "auto",
        current_step: "step_8_final_article",
        next_actor: "reviewer",
        review_target: "final",
      },
    });

    expect(result.dispatch.actor).toBe("reviewer");
    expect(result.dispatch.message).toContain("按终稿重审口径，逐段核查标题是否过泛");
    expect(result.dispatch.message).toContain("列出残留抽象表达");
    expect(result.dispatch.message).not.toContain("旧 final_writer 合同：改正式稿节奏。");

    await rm(projectDir, { recursive: true, force: true });
  });

  test("dispatches reviewer with final-writer feedback when final-output is newer than reviewer-target final re-review feedback", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "singularity-adapter-final-rereview-writer-fallback-"));
    await writeFile(
      join(projectDir, "draft_review_history.md"),
      [
        "## 2030-01-01 00:00:00 UTC|role:editor|type:step_8_feedback|target:final_writer|mode:revise",
        "instruction:",
        "final_writer 合同：统一正式版标题、导语和结尾收束。",
        "",
        "## 2026-04-27 14:57:57 UTC|role:editor|type:step_8_feedback|target:reviewer|review_target:final",
        "instruction:",
        "旧 reviewer 合同：检查是否仍有抽象标题。",
        "",
      ].join("\n"),
      "utf8"
    );
    await writeFile(join(projectDir, "final-output.md"), "formal article", "utf8");
    await utimes(join(projectDir, "final-output.md"), new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z"));

    const result = await tick({
      projectDir,
      statusMtimeMs: 1102,
      status: {
        workflow_mode: "auto",
        current_step: "step_8_final_article",
        next_actor: "reviewer",
        review_target: "final",
      },
    });

    expect(result.dispatch.actor).toBe("reviewer");
    expect(result.dispatch.message).toContain("final_writer 合同：统一正式版标题、导语和结尾收束。");
    expect(result.dispatch.message).not.toContain("旧 reviewer 合同：检查是否仍有抽象标题。");

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
    expect(result.dispatch.deliveryActor).toBe("main");
    expect(result.dispatch.deliverFromChangedFile).toBe("draft_review_history.md");
    expect(result.dispatch.recoveryDeliverFromChangedFile).toBe("draft_review_history.md");
    expect(result.dispatch.recoveryDeliveryActor).toBe("main");
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
