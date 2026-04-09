const STEP_5_REVIEWER_MESSAGE = [
  "Auto supervisor dispatch.",
  "Project root: {{projectDir}}",
  "Current step: step_5_debate",
  "Read project.md, status.md, interaction_log.md, materials.md.",
  "Act as the reviewer for the current debate round.",
  "Append the full reviewer output to interaction_log.md.",
].join("\n");

const STEP_5_MAIN_MESSAGE = [
  "Auto supervisor dispatch.",
  "Project root: {{projectDir}}",
  "Current step: step_5_debate",
  "Read status.md and interaction_log.md.",
  "Post the latest debate round to the group and show the step_5_menu.",
  "Keep the reply user-facing and end with the current numeric menu.",
].join("\n");

const STEP_7_WRITER_MESSAGE = [
  "Auto supervisor dispatch.",
  "Project root: {{projectDir}}",
  "Current step: step_7_drafting",
  "Read project.md, status.md, handoff.md, interaction_log.md, materials.md, output.md, and draft_review_history.md.",
  "Draft or revise the article according to the latest handoff, review history, and Step 4 story validation recorded in interaction_log.md and materials.md.",
  "Weave the story validation and concrete scene evidence into the article instead of dropping them from the draft.",
  "Write the latest full draft to output.md and append the full round to draft_review_history.md.",
].join("\n");

const STEP_7_REVIEWER_MESSAGE = [
  "Auto supervisor dispatch.",
  "Project root: {{projectDir}}",
  "Current step: step_7_drafting",
  "Read project.md, status.md, handoff.md, output.md, and draft_review_history.md.",
  "Review the latest draft.",
  "Append the full review block to draft_review_history.md and set verdict to approved or changes_requested in your normal review format.",
].join("\n");

const STEP_7_MAIN_MESSAGE = [
  "Auto supervisor dispatch.",
  "Project root: {{projectDir}}",
  "Current step: step_7_drafting",
  "Read status.md, output.md, and draft_review_history.md.",
  "If review is approved, post the latest draft summary and the next menu to the group.",
  "Keep the reply user-facing and do not expose raw internal step codes.",
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
        },
      };
    }

    return { delayMs: 15_000, runtimePatch: { last_decision: "step7_wait" } };
  }

  return { delayMs: 15_000, runtimePatch: { last_decision: "unsupported_step" } };
}
