import fs from "node:fs";
import path from "node:path";

const STEP_5_REVIEWER_MESSAGE = [
  "Auto supervisor dispatch.",
  "Project root: {{projectDir}}",
  "Current step: step_5_debate",
  "Read project.md, status.md, interaction_log.md, materials.md.",
  "Act as the reviewer for the current debate round.",
  "Use latest Sx point ids p1..pn; if absent, assign p1..pn in order. If grouping, state covered_point_ids and unanswered_point_ids.",
  "Append the full reviewer output to interaction_log.md.",
  "Group reply must be the full counter-argument itself: Counter-Argument, Objections, Counter-Evidence, Limits, Open Questions.",
  "Do not reply with a completion summary, file path, or write-status report.",
  "Do not show a menu in the group reply.",
  "Still update status.md to workflow_mode=auto,current_step=step_5_debate,next_actor=main,awaiting_user_choice=yes.",
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

const STEP_7_MAIN_MESSAGE = [
  "Auto supervisor dispatch.",
  "Project root: {{projectDir}}",
  "Current step: step_7_drafting",
  "Read status.md, output.md, and draft_review_history.md.",
  "只回复：成稿审核已通过，请确认下一步。",
  "然后只显示这个菜单：1. 生成正式版文章 2. 继续修改 3. 重新审稿 4. 退出当前项目。",
  "Do not summarize the draft or expose raw internal step codes.",
].join("\n");

const STEP_7_FINAL_MAIN_MESSAGE = [
  "Auto supervisor dispatch.",
  "Project root: {{projectDir}}",
  "Current step: step_7_drafting",
  "Read status.md, final-output.md, and draft_review_history.md.",
  "开头使用：成稿完成，请确认。",
  "回复必须包含 final-output.md 的正式版全文。",
  "在全文后只显示这个菜单：1. 确认文章 OK 2. 继续修改 3. 重新审稿 4. 退出当前项目。",
  "Do not summarize the article or expose raw internal step codes.",
].join("\n");

function fill(template, projectDir) {
  return template.replaceAll("{{projectDir}}", projectDir);
}

function projectFileHasContent(projectDir, relativePath) {
  try {
    return fs.readFileSync(path.join(projectDir, relativePath), "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

function readProjectText(projectDir, relativePath) {
  try {
    return fs.readFileSync(path.join(projectDir, relativePath), "utf8");
  } catch {
    return "";
  }
}

function markdownBlocks(text) {
  return String(text || "")
    .trim()
    .replace(/\r\n/g, "\n")
    .split(/\n(?=(?:##\s|---\n(?:###\s+Round:|\[)|###\s+Round:))/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function latestMatchingBlock(text, matcher) {
  const blocks = markdownBlocks(text);
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (matcher(blocks[index])) return blocks[index];
  }
  return "";
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function blockHasField(block, key, value) {
  const keyPattern = new RegExp(`\\b${escapeRegex(key)}\\b`, "i");
  const valuePattern = new RegExp(`\\b${escapeRegex(value)}\\b`, "i");
  return String(block)
    .split(/\r?\n/)
    .some((line) => keyPattern.test(line) && valuePattern.test(line));
}

function blockHasAnyField(block, keys, value) {
  return keys.some((key) => blockHasField(block, key, value));
}

function latestFinalEditorFeedback(projectDir) {
  return latestMatchingBlock(readProjectText(projectDir, "draft_review_history.md"), (block) =>
    blockHasField(block, "target", "final_writer") &&
    blockHasField(block, "type", "step_7_feedback") &&
    blockHasAnyField(block, ["role", "actor"], "editor")
  );
}

function latestFinalReviewerReview(projectDir) {
  return latestMatchingBlock(readProjectText(projectDir, "draft_review_history.md"), (block) =>
    blockHasField(block, "review_target", "final") &&
    blockHasAnyField(block, ["role", "actor"], "reviewer")
  );
}

function latestDraftEditorFeedback(projectDir) {
  return latestMatchingBlock(readProjectText(projectDir, "handoff.md"), (block) =>
    blockHasField(block, "role", "editor") &&
    blockHasField(block, "type", "step_7_feedback") &&
    blockHasField(block, "target", "writer")
  );
}

function buildStep7WriterMessage(ctx) {
  const latestEditorFeedback = latestDraftEditorFeedback(ctx.projectDir) || "(none)";
  return [
    "Auto supervisor dispatch.",
    `Project root: ${ctx.projectDir}`,
    "Current step: step_7_drafting",
    "Read project.md, status.md, handoff.md, interaction_log.md, materials.md, output.md, and draft_review_history.md.",
    "Before drafting, enumerate every file currently under /.openclaw/shared/knowledge/writing_rules/ and read them all. Do not select a subset.",
    "Then append one markdown knowledge-read block to draft_review_history.md with these exact fields: role=writer, type=writing_knowledge_read, sources=..., apply_points_or_none=..., read_fail_or_none=....",
    "If a template_id is bound, read only the bound shared template file /.openclaw/shared/templates/articles/<template_id>.md before drafting.",
    "Do not read templates from the project directory.",
    "Draft or revise the article draft according to the latest handoff, review history, and Step 4 story validation recorded in interaction_log.md and materials.md.",
    "If a latest editor feedback block is pasted below, treat it as mandatory revision input and apply it before any broader rewriting.",
    "In draft_review_history.md, explicitly state how the pasted latest editor feedback was applied.",
    "Weave the story validation and concrete scene evidence into the article instead of dropping them from the draft.",
    "Write the latest full draft to output.md and append the full round to draft_review_history.md.",
    "Group reply must be the latest full draft itself, not a summary or file path.",
    "Do not append any menu, bot handoff options, or @bot instructions.",
    "",
    "Latest draft-stage editor feedback block:",
    latestEditorFeedback,
  ].join("\n");
}

function buildStep7ReviewerMessage(ctx) {
  const finalReview =
    String(ctx.status?.review_target || "").trim().toLowerCase() === "final" ||
    String(ctx.status?.final_article_ready || "").trim().toLowerCase() === "yes";
  const latestEditorFeedback = finalReview
    ? latestFinalEditorFeedback(ctx.projectDir) || "(none)"
    : latestDraftEditorFeedback(ctx.projectDir) || "(none)";
  return [
    "Auto supervisor dispatch.",
    `Project root: ${ctx.projectDir}`,
    "Current step: step_7_drafting",
    "Read project.md, status.md, handoff.md, output.md, final-output.md, and draft_review_history.md.",
    "Before review, enumerate every file currently under /.openclaw/shared/knowledge/review_gates/ and /.openclaw/shared/knowledge/repair_patterns/, then read them all. Do not select a subset.",
    "Then append one markdown knowledge-read block to draft_review_history.md with these exact fields: role=reviewer, type=review_knowledge_read, sources=..., apply_points_or_none=..., read_fail_or_none=....",
    "If a template_id is bound, read only the bound shared template file /.openclaw/shared/templates/articles/<template_id>.md before review.",
    "Do not read templates from the project directory.",
    "If status.review_target=final or status.final_article_ready=yes, review final-output.md; otherwise review output.md.",
    "If a latest editor feedback block is pasted below, treat it as mandatory review direction.",
    "Verify the current review target against every item in that block; do not say no new editor feedback exists when this block is not (none).",
    "If any item is unmet, verdict=changes_requested and MUST_FIX must restate the unmet items for the next writer pass.",
    "Append the full review block to draft_review_history.md; include one exact line: verdict=approved or verdict=changes_requested.",
    "Group reply must be the full review block itself, not a completion summary, file path, or status update.",
    "",
    "Latest editor feedback block for this review target:",
    latestEditorFeedback,
  ].join("\n");
}

function finalWriterMode(status = {}) {
  return String(status.final_writer_mode || "").trim().toLowerCase() === "revise" ? "revise" : "generate";
}

function buildFinalWriterMessage(ctx) {
  const mode = finalWriterMode(ctx.status);
  const latestEditorFeedback = latestFinalEditorFeedback(ctx.projectDir) || "(none)";
  const latestReviewerReview = latestFinalReviewerReview(ctx.projectDir) || "(none)";
  const revise = mode === "revise";
  return [
    "Auto supervisor dispatch.",
    `Project root: ${ctx.projectDir}`,
    "Current step: step_7_drafting",
    `Read status.md, handoff.md, and ${revise ? "final-output.md" : "output.md"}.`,
    revise
      ? "Use final-output.md as the only article base for this formal revision."
      : "Use output.md as the only article base for this first formal pass.",
    "Write the final article in Chinese.",
    "FULL_REWRITE_REQUIRED: treat the article base as source material, not as near-final copy to lightly edit.",
    "Rewrite the whole article into a publication-grade final article: rewrite title, lead, transitions, paragraph rhythm, and ending.",
    "Preserve the approved thesis, evidence chain, literary references, boundaries, and reviewer decisions unless the pasted final-stage feedback explicitly changes them.",
    "Do not output English or any other non-Chinese full article.",
    "Removing process notes, translating only, or making partial line edits is not enough; final-output.md must be a freshly rewritten final article.",
    "Apply only the final-stage feedback blocks pasted below.",
    "Do not reuse draft-stage review history or older draft-stage feedback.",
    "Write the full formal article to final-output.md and append the full final-writing round to draft_review_history.md.",
    "Do not overwrite output.md.",
    "Do not append any menu, bot handoff options, or @bot instructions.",
    "",
    "Latest final-stage editor feedback block:",
    latestEditorFeedback,
    "",
    "Latest final-stage reviewer block:",
    latestReviewerReview,
  ].join("\n");
}

function resolveCurrentStep(status) {
  const currentStep = String(status.current_step || "").trim();
  if (currentStep) return currentStep;

  const workflowMode = String(status.workflow_mode || "").trim();
  const lastCompletedStep = String(status.last_completed_step || "").trim();
  const nextStep = String(status.next_step || "").trim();

  if (workflowMode !== "auto") return "";

  if (lastCompletedStep === "step_5_debate" && nextStep === "step_6_feedback") {
    return "step_5_debate";
  }

  return "";
}

export async function tick(ctx) {
  const workflowMode = String(ctx.status.workflow_mode || "").trim();
  const currentStep = resolveCurrentStep(ctx.status);
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
              "1=WRITE_AND_POST_FULL_NEXT_Sx_THEN_SET(workflow_mode=auto,next_actor=reviewer,awaiting_user_choice=no);2=WRITE_CURRENT_STAGE_RESULT_AND_TRANSITION_TO_STEP_6_AND_EXECUTE_STEP_6_FEEDBACK",
          },
        },
      };
    }

    return { delayMs: 15_000, runtimePatch: { last_decision: "step5_wait" } };
  }

  if (currentStep === "step_7_drafting") {
    if (nextActor === "final_writer") {
      const mode = finalWriterMode(ctx.status);
      const afterFinalWriter = String(ctx.status.after_final_writer || "main").trim();
      const nextAfterFinalWriter = afterFinalWriter === "reviewer" ? "reviewer" : "main";
      if (mode === "revise" && !projectFileHasContent(ctx.projectDir, "final-output.md")) {
        return {
          delayMs: 15_000,
          runtimePatch: {
            last_decision: "step7_final_writer_wait_final_output",
            last_error: "final_output_missing_for_revision",
          },
        };
      }
      if (mode === "revise" && nextAfterFinalWriter === "main" && !latestFinalEditorFeedback(ctx.projectDir)) {
        return {
          delayMs: 15_000,
          runtimePatch: {
            last_decision: "step7_final_writer_wait_editor_feedback",
            last_error: "final_editor_feedback_missing",
          },
        };
      }
      return {
        delayMs: 10_000,
        runtimePatch: { last_decision: "dispatch_step7_final_writer" },
        dispatch: {
          key: `step7:${ctx.statusMtimeMs}:final_writer:${nextAfterFinalWriter}`,
          actor: "final_writer",
          message: buildFinalWriterMessage(ctx),
          suppressDelivery: true,
          stripLegacyActionMenu: true,
          deliverRequiresChangedFile: true,
          afterSuccessWhenFilesChanged: ["final-output.md"],
          afterSuccessPatch: {
            workflow_mode: "auto",
            current_step: "step_7_drafting",
            next_actor: nextAfterFinalWriter,
            awaiting_user_choice: "no",
            final_article_ready: nextAfterFinalWriter === "main" ? "yes" : "no",
            final_writer_mode: "",
          },
        },
      };
    }

    if (nextActor === "writer") {
      return {
        delayMs: 10_000,
        runtimePatch: { last_decision: "dispatch_step7_writer" },
        dispatch: {
          key: `step7:${ctx.statusMtimeMs}:writer`,
          actor: "writer",
          message: buildStep7WriterMessage(ctx),
          stripLegacyActionMenu: true,
          deliverRequiresChangedFile: true,
          afterSuccessWhenFilesChanged: ["output.md"],
          afterSuccessPatch: {
            workflow_mode: "auto",
            current_step: "step_7_drafting",
            next_actor: "reviewer",
            awaiting_user_choice: "no",
            final_article_ready: "no",
            review_target: "draft",
            final_writer_mode: "",
          },
        },
      };
    }

    if (nextActor === "reviewer") {
      const finalReview =
        String(ctx.status.review_target || "").trim().toLowerCase() === "final" ||
        String(ctx.status.final_article_ready || "").trim().toLowerCase() === "yes";
      if (finalReview && !projectFileHasContent(ctx.projectDir, "final-output.md")) {
        return {
          delayMs: 15_000,
          runtimePatch: {
            last_decision: "step7_final_review_wait_final_output",
            last_error: "final_output_missing_for_review",
          },
        };
      }
      return {
        delayMs: 10_000,
        runtimePatch: { last_decision: "dispatch_step7_reviewer" },
        dispatch: {
          key: `step7:${ctx.statusMtimeMs}:reviewer`,
          actor: "reviewer",
          message: buildStep7ReviewerMessage(ctx),
          deliverFromChangedFile: "draft_review_history.md",
          deliverRequiresChangedFile: true,
          afterSuccessWhenFilesChanged: ["draft_review_history.md"],
          afterSuccessPatchFromLatestVerdict: true,
          requireLatestVerdict: true,
        },
      };
    }

    if (nextActor === "main") {
      const finalArticleReady = String(ctx.status.final_article_ready || "").trim().toLowerCase() === "yes";
      return {
        delayMs: 10_000,
        runtimePatch: { last_decision: finalArticleReady ? "dispatch_step7_final_main" : "dispatch_step7_main" },
        dispatch: {
          key: `step7:${ctx.statusMtimeMs}:main:${finalArticleReady ? "final" : "draft"}`,
          actor: "main",
          message: fill(finalArticleReady ? STEP_7_FINAL_MAIN_MESSAGE : STEP_7_MAIN_MESSAGE, ctx.projectDir),
          afterStatusPatch: {
            workflow_mode: "manual",
            current_step: "step_7_drafting",
            next_actor: "main",
            awaiting_user_choice: "yes",
            active_menu_scope: finalArticleReady ? "step_7_final_menu" : "step_7_menu",
            active_menu_options: finalArticleReady
              ? "1=SET(docs_publish_requested=yes,docs_publish_state=pending)+MENU_final_delivery_menu+KEEP_PROJECT;2=WRITE_EDITOR_FEEDBACK_AND_SET(workflow_mode=auto,next_actor=final_writer,awaiting_user_choice=no,after_final_writer=main,final_article_ready=no,review_target=final,final_writer_mode=revise);3=SET(workflow_mode=auto,next_actor=reviewer,awaiting_user_choice=no,review_target=final,final_writer_mode=);4=EXIT_CURRENT_PROJECT"
              : "1=SET(workflow_mode=auto,next_actor=final_writer,awaiting_user_choice=no,after_final_writer=main,final_article_ready=no,review_target=final,final_writer_mode=generate);2=WRITE_EDITOR_FEEDBACK_AND_SET(workflow_mode=auto,next_actor=writer,awaiting_user_choice=no,final_article_ready=no,review_target=draft,final_writer_mode=);3=SET(workflow_mode=auto,next_actor=reviewer,awaiting_user_choice=no,review_target=draft,final_writer_mode=);4=EXIT_CURRENT_PROJECT",
          },
        },
      };
    }

    return { delayMs: 15_000, runtimePatch: { last_decision: "step7_wait" } };
  }

  return { delayMs: 15_000, runtimePatch: { last_decision: "unsupported_step" } };
}
