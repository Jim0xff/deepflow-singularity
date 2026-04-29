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
  "然后只显示这个菜单：1. 继续一轮对垒 2. 进入 Step 6 升级解读 3. 退出当前项目。",
  "Do not summarize or repeat sentinel/reviewer arguments.",
].join("\n");

const STEP_7_MAIN_MESSAGE = [
  "Auto supervisor dispatch.",
  "Project root: {{projectDir}}",
  "Current step: step_7_drafting",
  "Read status.md, output.md, and draft_review_history.md.",
  "Ignore all prior session context. Use only status.md, output.md, draft_review_history.md from {{projectDir}}. 当前仍处于草稿写作步骤，不是正式版步骤。选项1是唯一允许进入 final_writer / final-output.md 的入口。选项2只能表示继续修改草稿并交给 writer。选项3只能表示重新审稿并交给 reviewer。禁止把选项2或3解释为 final_writer、final-output.md、正式版修订或发布。仅输出5行：第1行=草稿审核已通过，当前仍在草稿阶段，请确认下一步。第2-5行依次=1. 生成正式版文章 / 2. 继续改稿（带上修改意见，小幅修改） / 3. 重新审稿（带上修改意见，较大变更） / 4. 退出当前项目。禁止输出成稿完成、#、标题、正文、final-output.md。",
].join("\n");

const STEP_8_MAIN_MESSAGE = [
  "Auto supervisor dispatch.",
  "Project root: {{projectDir}}",
  "Current step: step_8_final_article",
  "Read status.md, final-output.md, and draft_review_history.md.",
  "当前仍处于正式稿步骤，不是草稿步骤。选项1是唯一允许发布的入口。选项2只能表示继续修改正式稿并交给 final_writer。选项3只能表示重新审稿正式稿并交给 reviewer。禁止把选项2或3解释为 writer、output.md、草稿改写或回到草稿步骤。",
  "开头使用：正式稿已生成，当前仍在正式稿阶段，请确认下一步。",
  "回复必须包含 final-output.md 的正式版全文。",
  "在全文后只显示这个菜单：1. 确认文章 OK 2. 继续修改正式稿（带上修改意见，小幅修改） 3. 重新审稿正式稿（带上修改意见，较大变更） 4. 退出当前项目。",
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

function latestMatchingHistoryBlock(text, matcher) {
  const blocks = parseHistoryBlocks(text);
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (matcher(blocks[index])) return blocks[index];
  }
  return null;
}

function normalizeFieldKey(key) {
  return String(key || "")
    .replace(/^[*-]\s*/, "")
    .replace(/\*\*/g, "")
    .trim()
    .toLowerCase();
}

function parseHeaderPairs(line) {
  return String(line || "")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^([^:=]+)\s*[:=]\s*(.+)$/);
      return match ? [normalizeFieldKey(match[1]), match[2].trim()] : null;
    })
    .filter(Boolean);
}

function normalizeFieldValue(value) {
  return String(value || "").trim().replace(/^`(.+)`$/s, "$1").trim();
}

function normalizeStructuredFieldValue(key, value) {
  const normalized = normalizeFieldValue(value);
  if (!normalized) return "";
  if (key === "timestamp") return normalized;
  if (["role", "actor", "type", "target", "mode", "review_target"].includes(key)) {
    return normalized.split("+")[0].trim();
  }
  return normalized;
}

function looksLikeHistoryTimestamp(value) {
  const text = normalizeFieldValue(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) && Number.isFinite(parseHistoryTimestampMs(text));
}

function parseHistoryTimestampMs(value) {
  const text = normalizeFieldValue(value);
  if (!text) return Number.NaN;
  const candidates = new Set([text]);
  candidates.add(text.replace(/^(\d{4}-\d{2}-\d{2})\s+/, "$1T"));
  for (const candidate of [...candidates]) {
    candidates.add(candidate.replace(/\s+(UTC|GMT)$/i, "Z"));
    candidates.add(candidate.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    candidates.add(
      candidate
        .replace(/^(\d{4}-\d{2}-\d{2})\s+/, "$1T")
        .replace(/\s+(UTC|GMT)$/i, "Z")
        .replace(/([+-]\d{2})(\d{2})$/, "$1:$2")
    );
  }
  for (const candidate of candidates) {
    const ts = Date.parse(candidate);
    if (Number.isFinite(ts)) return ts;
  }
  return Number.NaN;
}

function fieldMatches(value, expected) {
  const actual = String(value || "").trim().toLowerCase();
  const wanted = String(expected || "").trim().toLowerCase();
  if (!actual || !wanted) return false;
  if (actual === wanted) return true;
  return actual
    .split(/\s*_or_\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .includes(wanted);
}

function parseHistoryBlock(raw) {
  const lines = String(raw || "").replace(/\r\n/g, "\n").split("\n");
  const block = { raw: String(raw || "").trim(), timestamp: "", role: "", type: "", target: "", mode: "", review_target: "", instruction: "" };
  let inInstruction = false;
  const instructionLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inInstruction) instructionLines.push("");
      continue;
    }
    if (/^---$/.test(trimmed)) continue;
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      block.timestamp = trimmed.slice(1, -1).trim();
      continue;
    }
    if (/^##\s+/.test(trimmed)) {
      const body = trimmed.replace(/^##\s+/, "");
      const parts = body.split("|").map((part) => part.trim()).filter(Boolean);
      if (parts.length) {
        const first = parts.shift();
        if (looksLikeHistoryTimestamp(first) || !/:|=/.test(first)) block.timestamp = normalizeFieldValue(first);
        for (const [key, value] of parts.flatMap(parseHeaderPairs)) {
          const normalized = normalizeStructuredFieldValue(key, value);
          if (key === "timestamp") block.timestamp = normalized;
          else if (key === "actor" || key === "role") block.role = normalized.toLowerCase();
          else if (key === "type") block.type = normalized;
          else if (key === "target") block.target = normalized;
          else if (key === "mode") block.mode = normalized;
          else if (key === "review_target") block.review_target = normalized;
        }
      }
      continue;
    }
    if (/^instruction\s*:/i.test(trimmed)) {
      inInstruction = true;
      const rest = trimmed.replace(/^instruction\s*:/i, "").trim();
      if (rest) instructionLines.push(rest);
      continue;
    }
    const pairs = !inInstruction ? parseHeaderPairs(trimmed) : [];
    if (pairs.length) {
      for (const [key, value] of pairs) {
        const normalized = normalizeStructuredFieldValue(key, value);
        if (key === "timestamp") block.timestamp = normalized;
        else if (key === "actor" || key === "role") block.role = normalized.toLowerCase();
        else if (key === "type") block.type = normalized;
        else if (key === "target") block.target = normalized;
        else if (key === "mode") block.mode = normalized;
        else if (key === "review_target") block.review_target = normalized;
      }
      continue;
    }
    if (inInstruction) instructionLines.push(line);
  }
  block.instruction = instructionLines.join("\n").trim();
  return block;
}

function parseHistoryBlocks(text) {
  return markdownBlocks(text).map(parseHistoryBlock);
}

function latestFinalWriterFeedback(projectDir) {
  return (
    latestMatchingHistoryBlock(readProjectText(projectDir, "draft_review_history.md"), (block) =>
      fieldMatches(block.target, "final_writer") &&
      fieldMatches(block.type, "step_8_feedback") &&
      fieldMatches(block.role, "editor")
    )?.raw || ""
  );
}

function latestFinalReviewerFeedbackBlock(projectDir) {
  return (
    latestMatchingHistoryBlock(readProjectText(projectDir, "draft_review_history.md"), (block) =>
      fieldMatches(block.target, "reviewer") &&
      fieldMatches(block.type, "step_8_feedback") &&
      fieldMatches(block.role, "editor") &&
      fieldMatches(block.review_target, "final")
    ) || null
  );
}

function latestFinalReviewerReview(projectDir) {
  return (
    latestMatchingHistoryBlock(readProjectText(projectDir, "draft_review_history.md"), (block) =>
      fieldMatches(block.review_target, "final") &&
      fieldMatches(block.role, "reviewer")
    )?.raw || ""
  );
}

function latestDraftReviewerReview(projectDir) {
  return (
    latestMatchingHistoryBlock(readProjectText(projectDir, "draft_review_history.md"), (block) =>
      fieldMatches(block.review_target, "draft") &&
      fieldMatches(block.role, "reviewer")
    )?.raw || ""
  );
}

function latestReviewerFeedbackRecord(projectDir, reviewTarget) {
  try {
    const parsed = JSON.parse(readProjectText(projectDir, path.join("runtime", "reviewer-feedback.json")) || "{}");
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (String(item?.review_target || "").trim().toLowerCase() !== String(reviewTarget || "").trim().toLowerCase()) {
        continue;
      }
      const block = String(item?.block || "").trim();
      if (block) return block;
    }
  } catch {
    // Fall back to parsing the markdown history file.
  }
  return "";
}

function latestDraftReviewerReviewBlock(projectDir) {
  const cached = latestReviewerFeedbackRecord(projectDir, "draft");
  if (cached) return parseHistoryBlock(cached);
  return (
    latestMatchingHistoryBlock(readProjectText(projectDir, "draft_review_history.md"), (block) =>
      fieldMatches(block.review_target, "draft") &&
      fieldMatches(block.role, "reviewer")
    ) || null
  );
}

function latestDraftWriterFeedbackBlock(projectDir) {
  return (
    latestMatchingHistoryBlock(readProjectText(projectDir, "draft_review_history.md"), (block) =>
      fieldMatches(block.role, "editor") &&
      fieldMatches(block.type, "step_7_feedback") &&
      fieldMatches(block.target, "writer")
    ) || null
  );
}

function latestDraftEditorFeedback(projectDir) {
  return latestDraftWriterFeedbackBlock(projectDir)?.raw || "";
}

function latestDraftReviewerFeedbackBlock(projectDir) {
  return (
    latestMatchingHistoryBlock(readProjectText(projectDir, "draft_review_history.md"), (block) =>
      fieldMatches(block.role, "editor") &&
      fieldMatches(block.type, "step_7_feedback") &&
      fieldMatches(block.target, "reviewer")
    ) || null
  );
}

function fileMtimeMs(projectDir, relativePath) {
  try {
    return fs.statSync(path.join(projectDir, relativePath)).mtimeMs || 0;
  } catch {
    return 0;
  }
}

function blockTimestampMs(block) {
  const ts = parseHistoryTimestampMs(String(block?.timestamp || "").trim());
  return Number.isFinite(ts) ? ts : 0;
}

function latestDraftReviewContractFeedback(projectDir) {
  const writerBlock = latestDraftWriterFeedbackBlock(projectDir);
  const reviewerBlock = latestDraftReviewerFeedbackBlock(projectDir);
  const reviewerReviewBlock = latestDraftReviewerReviewBlock(projectDir);
  if (
    reviewerBlock &&
    reviewerReviewBlock &&
    blockTimestampMs(reviewerReviewBlock) >= blockTimestampMs(reviewerBlock) &&
    blockTimestampMs(reviewerBlock) >= blockTimestampMs(writerBlock)
  ) {
    return reviewerBlock.raw || "";
  }
  if (reviewerBlock && blockTimestampMs(reviewerBlock) >= fileMtimeMs(projectDir, "output.md")) {
    return reviewerBlock.raw || "";
  }
  return writerBlock?.raw || reviewerBlock?.raw || "";
}

function latestDraftWriterContractFeedback(projectDir) {
  const writerBlock = latestDraftWriterFeedbackBlock(projectDir);
  const reviewerBlock = latestDraftReviewerFeedbackBlock(projectDir);
  const reviewerReviewBlock = latestDraftReviewerReviewBlock(projectDir);
  if (
    reviewerBlock &&
    reviewerReviewBlock &&
    blockTimestampMs(reviewerReviewBlock) >= blockTimestampMs(reviewerBlock) &&
    blockTimestampMs(reviewerBlock) >= blockTimestampMs(writerBlock)
  ) {
    return reviewerBlock.raw || "";
  }
  return writerBlock?.raw || reviewerBlock?.raw || "";
}

function latestFinalReviewContractFeedback(projectDir) {
  const reviewerBlock = latestFinalReviewerFeedbackBlock(projectDir);
  if (reviewerBlock && blockTimestampMs(reviewerBlock) >= fileMtimeMs(projectDir, "final-output.md")) {
    return reviewerBlock.raw || "";
  }
  return latestFinalWriterFeedback(projectDir) || "";
}

function extractMarkdownSection(text, heading) {
  const escaped = String(heading || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(text || "").match(
    new RegExp(`(?:^|\\n)###\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n###\\s+|\\n##\\s+|$)`, "i"),
  );
  return match ? match[1].trim() : "";
}

function buildStep6AxisSnapshot(projectDir) {
  const handoffText = readProjectText(projectDir, "handoff.md");
  const parts = [];
  for (const [heading, label] of [
    ["what_it_really_means", "WHAT_IT_REALLY_MEANS"],
    ["surface_signal", "SURFACE_SIGNAL"],
    ["deep_signal", "DEEP_SIGNAL"],
    ["upgraded_interpretation", "UPGRADED_INTERPRETATION"],
    ["allowed_boundary_topics", "ALLOWED_BOUNDARY_TOPICS"],
    ["forbidden_expansions", "FORBIDDEN_EXPANSIONS"],
  ]) {
    const section = extractMarkdownSection(handoffText, heading);
    if (!section) continue;
    parts.push(`${label}:\n${section}`);
  }
  return parts.length ? parts.join("\n\n") : "(none)";
}

function buildStep7WriterMessage(ctx) {
  const latestEditorFeedback = latestDraftWriterContractFeedback(ctx.projectDir) || "(none)";
  const latestReviewerReview = latestDraftReviewerReviewBlock(ctx.projectDir)?.raw || "(none)";
  const step6AxisSnapshot = buildStep6AxisSnapshot(ctx.projectDir);
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
    "If a latest reviewer review block is pasted below, treat its MUST_FIX, RISK_POINTS, and USER_GUIDANCE as mandatory revision input and explicitly address them in the next draft.",
    "The Step 6 axis snapshot below is the highest-priority writing contract. It outranks Step 4 counterexamples, safety exceptions, and other boundary materials.",
    "Keep counterexamples and boundary materials as supporting limits only. Do not let them become the title hook, main mechanism chain, or final judgment unless the Step 6 snapshot explicitly upgrades them.",
    "In draft_review_history.md, explicitly state how the pasted latest editor feedback and latest reviewer review were applied.",
    "Weave the story validation and concrete scene evidence into the article instead of dropping them from the draft.",
    "Write the latest full draft to output.md and append the full round to draft_review_history.md.",
    "Group reply must be the latest full draft itself, not a summary or file path.",
    "Do not append any menu, bot handoff options, or @bot instructions.",
    "",
    "Step 6 axis snapshot:",
    step6AxisSnapshot,
    "",
    "Latest draft-stage editor feedback block:",
    latestEditorFeedback,
    "",
    "Latest reviewer review block for this draft target:",
    latestReviewerReview,
  ].join("\n");
}

function buildStep7ReviewerMessage(ctx) {
  const finalReview =
    String(ctx.status?.review_target || "").trim().toLowerCase() === "final" ||
    String(ctx.status?.final_article_ready || "").trim().toLowerCase() === "yes";
  const step6AxisSnapshot = buildStep6AxisSnapshot(ctx.projectDir);
  const latestEditorFeedback = finalReview
    ? latestFinalReviewContractFeedback(ctx.projectDir) || "(none)"
    : latestDraftReviewContractFeedback(ctx.projectDir) || "(none)";
  return [
    "Auto supervisor dispatch.",
    `Project root: ${ctx.projectDir}`,
    `Current step: ${finalReview ? "step_8_final_article" : "step_7_drafting"}`,
    "Read project.md, status.md, handoff.md, output.md, final-output.md, and draft_review_history.md.",
    "Before review, enumerate every file currently under /.openclaw/shared/knowledge/review_gates/ and /.openclaw/shared/knowledge/repair_patterns/, then read them all. Do not select a subset.",
    "Then append one markdown knowledge-read block to draft_review_history.md with these exact fields: role=reviewer, type=review_knowledge_read, sources=..., apply_points_or_none=..., read_fail_or_none=....",
    "If a template_id is bound, read only the bound shared template file /.openclaw/shared/templates/articles/<template_id>.md before review.",
    "Do not read templates from the project directory.",
    "If status.review_target=final or status.final_article_ready=yes, review final-output.md; otherwise review output.md.",
    "If a latest editor feedback block is pasted below, treat it as mandatory review direction.",
    "The Step 6 axis snapshot below is the highest-priority review contract. Boundary and counterexample material may support the argument, but must not replace the primary axis.",
    "Verify the current review target against every item in that block; do not say no new editor feedback exists when this block is not (none).",
    "If any item is unmet, verdict=changes_requested and MUST_FIX must restate the unmet items for the next writer pass.",
    "If safety, high-risk, or other boundary material overtakes the Step 6 primary axis without explicit authorization in the snapshot, verdict=changes_requested and MUST_FIX must call out topic drift.",
    "Append the full review block to draft_review_history.md; include one exact line: verdict=approved or verdict=changes_requested.",
    "Group reply must be the full review block itself, not a completion summary, file path, or status update.",
    "",
    "Step 6 axis snapshot:",
    step6AxisSnapshot,
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
  const latestEditorFeedback = latestFinalWriterFeedback(ctx.projectDir) || "(none)";
  const latestReviewerReview = latestFinalReviewerReview(ctx.projectDir) || "(none)";
  const revise = mode === "revise";
  return [
    "Auto supervisor dispatch.",
    `Project root: ${ctx.projectDir}`,
    "Current step: step_8_final_article",
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
              "1=WRITE_AND_POST_FULL_NEXT_Sx_THEN_SET(workflow_mode=auto,next_actor=reviewer,awaiting_user_choice=no);2=WRITE_CURRENT_STAGE_RESULT_AND_TRANSITION_TO_STEP_6_AND_EXECUTE_STEP_6_FEEDBACK;3=EXIT_CURRENT_PROJECT",
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
          deliveryActor: "main",
          deliveryFailureDoesNotBlockSuccess: true,
          message: buildStep7WriterMessage(ctx),
          deliverFromChangedFile: "output.md",
          deliverChangedFileMode: "full_text",
          recoveryDeliverFromChangedFile: "output.md",
          recoveryDeliveryActor: "main",
          stripLegacyActionMenu: true,
          deliverRequiresChangedFile: true,
          afterSuccessWhenFilesChanged: ["output.md"],
          afterSuccessPatch: {
            workflow_mode: "auto",
            current_step: "step_7_drafting",
            next_actor: "reviewer",
            awaiting_user_choice: "no",
            after_final_writer: "",
            final_article_ready: "no",
            review_target: "draft",
            final_writer_mode: "",
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
          deliveryActor: "main",
          message: buildStep7ReviewerMessage(ctx),
          deliverFromChangedFile: "draft_review_history.md",
          recoveryDeliverFromChangedFile: "draft_review_history.md",
          recoveryDeliveryActor: "main",
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
          key: `step7:${ctx.statusMtimeMs}:main:draft`,
          actor: "main",
          message: fill(STEP_7_MAIN_MESSAGE, ctx.projectDir),
          afterStatusPatch: {
            workflow_mode: "manual",
            current_step: "step_7_drafting",
            next_actor: "main",
            awaiting_user_choice: "yes",
            active_menu_scope: "step_7_menu",
            active_menu_options:
              "1=SET(workflow_mode=auto,current_step=step_8_final_article,next_actor=final_writer,awaiting_user_choice=no,after_final_writer=main,final_article_ready=no,review_target=final,final_writer_mode=generate);2=WRITE_EDITOR_FEEDBACK_AND_SET(workflow_mode=auto,current_step=step_7_drafting,next_actor=writer,awaiting_user_choice=no,after_final_writer=,final_article_ready=no,review_target=draft,final_writer_mode=);3=WRITE_EDITOR_FEEDBACK_AND_SET(workflow_mode=auto,current_step=step_7_drafting,next_actor=reviewer,awaiting_user_choice=no,after_final_writer=,final_article_ready=no,review_target=draft,final_writer_mode=);4=EXIT_CURRENT_PROJECT",
          },
        },
      };
    }

    return { delayMs: 15_000, runtimePatch: { last_decision: "step7_wait" } };
  }

  if (currentStep === "step_8_final_article") {
    if (nextActor === "final_writer") {
      const mode = finalWriterMode(ctx.status);
      const afterFinalWriter = String(ctx.status.after_final_writer || "main").trim();
      const nextAfterFinalWriter = afterFinalWriter === "reviewer" ? "reviewer" : "main";
      if (mode === "revise" && !projectFileHasContent(ctx.projectDir, "final-output.md")) {
        return {
          delayMs: 15_000,
          runtimePatch: {
            last_decision: "step8_final_writer_wait_final_output",
            last_error: "final_output_missing_for_revision",
          },
        };
      }
      if (mode === "revise" && nextAfterFinalWriter === "main" && !latestFinalWriterFeedback(ctx.projectDir)) {
        return {
          delayMs: 15_000,
          runtimePatch: {
            last_decision: "step8_final_writer_wait_editor_feedback",
            last_error: "final_editor_feedback_missing",
          },
        };
      }
      return {
        delayMs: 10_000,
        runtimePatch: { last_decision: "dispatch_step8_final_writer" },
        dispatch: {
          key: `step8:${ctx.statusMtimeMs}:final_writer:${nextAfterFinalWriter}`,
          actor: "final_writer",
          message: buildFinalWriterMessage(ctx),
          suppressDelivery: true,
          recoveryDeliverFromChangedFile: "final-output.md",
          deliverChangedFileMode: "full_text",
          recoveryDeliveryActor: "main",
          stripLegacyActionMenu: true,
          deliverRequiresChangedFile: true,
          afterSuccessWhenFilesChanged: ["final-output.md"],
          afterSuccessPatch: {
            workflow_mode: "auto",
            current_step: "step_8_final_article",
            next_actor: nextAfterFinalWriter,
            awaiting_user_choice: "no",
            final_article_ready: nextAfterFinalWriter === "main" ? "yes" : "no",
            review_target: "final",
            final_writer_mode: "",
          },
        },
      };
    }

    if (nextActor === "reviewer") {
      if (!projectFileHasContent(ctx.projectDir, "final-output.md")) {
        return {
          delayMs: 15_000,
          runtimePatch: {
            last_decision: "step8_final_review_wait_final_output",
            last_error: "final_output_missing_for_review",
          },
        };
      }
      return {
        delayMs: 10_000,
        runtimePatch: { last_decision: "dispatch_step8_reviewer" },
        dispatch: {
          key: `step8:${ctx.statusMtimeMs}:reviewer`,
          actor: "reviewer",
          deliveryActor: "main",
          message: buildStep7ReviewerMessage(ctx),
          deliverFromChangedFile: "draft_review_history.md",
          recoveryDeliverFromChangedFile: "draft_review_history.md",
          recoveryDeliveryActor: "main",
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
        runtimePatch: { last_decision: "dispatch_step8_main" },
        dispatch: {
          key: `step8:${ctx.statusMtimeMs}:main:final`,
          actor: "main",
          message: fill(STEP_8_MAIN_MESSAGE, ctx.projectDir),
          afterStatusPatch: {
            workflow_mode: "manual",
            current_step: "step_8_final_article",
            next_actor: "main",
            awaiting_user_choice: "yes",
            active_menu_scope: "final_article_menu",
            active_menu_options:
              "1=SET(docs_publish_requested=yes,docs_publish_state=pending)+MENU_final_delivery_menu+KEEP_PROJECT;2=WRITE_EDITOR_FEEDBACK_AND_SET(workflow_mode=auto,current_step=step_8_final_article,next_actor=final_writer,awaiting_user_choice=no,after_final_writer=main,final_article_ready=no,review_target=final,final_writer_mode=revise);3=WRITE_EDITOR_FEEDBACK_AND_SET(workflow_mode=auto,current_step=step_8_final_article,next_actor=reviewer,awaiting_user_choice=no,after_final_writer=,final_article_ready=no,review_target=final,final_writer_mode=);4=EXIT_CURRENT_PROJECT",
          },
        },
      };
    }

    return { delayMs: 15_000, runtimePatch: { last_decision: "step8_wait" } };
  }

  return { delayMs: 15_000, runtimePatch: { last_decision: "unsupported_step" } };
}
