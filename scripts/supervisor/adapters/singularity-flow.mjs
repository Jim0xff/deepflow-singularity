const STEP_5_REVIEWER_MESSAGE = [
  "Auto supervisor dispatch.",
  "Project root: {{projectDir}}",
  "Current step: step_5_debate",
  "Read project.md, status.md, interaction_log.md, materials.md.",
  "Act as the reviewer for the current debate round.",
  "Append the full reviewer output to interaction_log.md.",
  "Group reply must be the full counter-argument itself: Counter-Argument, Objections, Counter-Evidence, Limits, Open Questions.",
  "Do not reply with a completion summary, file path, or write-status report.",
].join("\n");

const STEP_5_MAIN_MESSAGE = [
  "Auto supervisor dispatch.",
  "Project root: {{projectDir}}",
  "Current step: step_5_debate",
  "Read status.md.",
  "只回复：本轮对垒已完成。",
  "然后只显示这个菜单：1. 继续一轮对垒 2. 进入 Step 6 升级解读。",
  "Do not summarize or repeat sentinel/reviewer arguments.",
].join("\n");

const STEP_7_WRITER_MESSAGE = [
  "Auto supervisor dispatch.",
  "Project root: {{projectDir}}",
  "Current step: step_7_drafting",
  "Read project.md, status.md, handoff.md, interaction_log.md, materials.md, output.md, and draft_review_history.md.",
  "Draft or revise the article according to the latest handoff, review history, and Step 4 story validation recorded in interaction_log.md and materials.md.",
  "Weave the story validation and concrete scene evidence into the article instead of dropping them from the draft.",
  "Write the latest full draft to output.md and append the full round to draft_review_history.md.",
  "Group reply must be the latest full draft itself, not a summary or file path.",
  "Do not append any menu, bot handoff options, or @bot instructions.",
].join("\n");

const STEP_7_REVIEWER_MESSAGE = [
  "Auto supervisor dispatch.",
  "Project root: {{projectDir}}",
  "Current step: step_7_drafting",
  "Read project.md, status.md, handoff.md, output.md, and draft_review_history.md.",
  "Review the latest draft.",
  "Append the full review block to draft_review_history.md; include one exact line: verdict=approved or verdict=changes_requested.",
  "Group reply must be the full review block itself, not a completion summary, file path, or status update.",
].join("\n");

const STEP_7_MAIN_MESSAGE = [
  "Auto supervisor dispatch.",
  "Project root: {{projectDir}}",
  "Current step: step_7_drafting",
  "Read status.md, output.md, and draft_review_history.md.",
  "只回复：成稿审核已通过，请确认下一步。",
  "然后只显示这个菜单：1. 确认文章 OK 并成稿 2. 继续修改 3. 重新审稿。",
  "Do not summarize the draft or expose raw internal step codes.",
].join("\n");

function fill(template, projectDir) {
  return template.replaceAll("{{projectDir}}", projectDir);
}

export async function tick(ctx) {
  const workflowMode = String(ctx.status.workflow_mode || "").trim();
  const currentStep = String(ctx.status.current_step || "").trim();
  const nextActor = String(ctx.status.next_actor || "").trim();
  const awaitingUserChoice = String(ctx.status.awaiting_user_choice || "no").trim().toLowerCase();

  if (workflowMode !== "auto") {
    return { delayMs: 15_000, runtimePatch: { last_decision: "workflow_mode_not_auto" } };
  }

  if (currentStep === "step_5_debate") {
    if (nextActor === "reviewer" && awaitingUserChoice !== "yes") {
      return {
        delayMs: 10_000,
        runtimePatch: { last_decision: "dispatch_step5_reviewer" },
        dispatch: {
          key: `step5:${ctx.statusMtimeMs}:reviewer`,
          actor: "reviewer",
          message: fill(STEP_5_REVIEWER_MESSAGE, ctx.projectDir),
        },
      };
    }

    if (nextActor === "main" && awaitingUserChoice === "yes") {
      return {
        delayMs: 10_000,
        runtimePatch: { last_decision: "dispatch_step5_main" },
        dispatch: {
          key: `step5:${ctx.statusMtimeMs}:main:awaiting`,
          actor: "main",
          message: fill(STEP_5_MAIN_MESSAGE, ctx.projectDir),
          afterStatusPatch: {
            workflow_mode: "manual",
            current_step: "step_5_debate",
            next_actor: "main",
            awaiting_user_choice: "yes",
            active_menu_scope: "step_5_menu",
            active_menu_options:
              "1=WRITE_NEXT_SENTINEL_ONLY_AND_SET(workflow_mode=auto,next_actor=reviewer,awaiting_user_choice=no);2=WRITE_CURRENT_STAGE_RESULT_AND_TRANSITION_TO_STEP_6_AND_EXECUTE_STEP_6_FEEDBACK",
          },
        },
      };
    }

    return { delayMs: 15_000, runtimePatch: { last_decision: "step5_wait" } };
  }

  if (currentStep === "step_7_drafting") {
    if (nextActor === "writer") {
      return {
        delayMs: 10_000,
        runtimePatch: { last_decision: "dispatch_step7_writer" },
        dispatch: {
          key: `step7:${ctx.statusMtimeMs}:writer`,
          actor: "writer",
          message: fill(STEP_7_WRITER_MESSAGE, ctx.projectDir),
          stripLegacyActionMenu: true,
          afterSuccessWhenFilesChanged: ["output.md", "draft_review_history.md"],
          afterSuccessPatch: {
            workflow_mode: "auto",
            current_step: "step_7_drafting",
            next_actor: "reviewer",
            awaiting_user_choice: "no",
          },
        },
      };
    }

    if (nextActor === "reviewer") {
      return {
        delayMs: 10_000,
        runtimePatch: { last_decision: "dispatch_step7_reviewer" },
        dispatch: {
          key: `step7:${ctx.statusMtimeMs}:reviewer`,
          actor: "reviewer",
          message: fill(STEP_7_REVIEWER_MESSAGE, ctx.projectDir),
          deliverFromChangedFile: "draft_review_history.md",
          deliverRequiresChangedFile: true,
          afterSuccessWhenFilesChanged: ["draft_review_history.md"],
          afterSuccessPatchFromLatestVerdict: true,
          requireLatestVerdict: true,
        },
      };
    }

    if (nextActor === "main") {
      return {
        delayMs: 10_000,
        runtimePatch: { last_decision: "dispatch_step7_main" },
        dispatch: {
          key: `step7:${ctx.statusMtimeMs}:main`,
          actor: "main",
          message: fill(STEP_7_MAIN_MESSAGE, ctx.projectDir),
          afterStatusPatch: {
            workflow_mode: "manual",
            current_step: "step_7_drafting",
            next_actor: "main",
            awaiting_user_choice: "yes",
            active_menu_scope: "step_7_menu",
            active_menu_options:
              "1=CONFIRM_ARTICLE_OK_AND_FINALIZE;2=WRITE_EDITOR_FEEDBACK_AND_SET(workflow_mode=auto,next_actor=writer,awaiting_user_choice=no);3=SET(workflow_mode=auto,next_actor=reviewer,awaiting_user_choice=no)",
          },
        },
      };
    }

    return { delayMs: 15_000, runtimePatch: { last_decision: "step7_wait" } };
  }

  return { delayMs: 15_000, runtimePatch: { last_decision: "unsupported_step" } };
}
