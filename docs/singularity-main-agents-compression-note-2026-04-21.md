# Singularity Main AGENTS Compression Note

Date: 2026-04-21

## Current Baseline

- File: `assets/singularity-main/AGENTS.md`
- Current size: `17466` bytes
- Target: `< 16500` bytes

## Agreed Direction

Compress `main/AGENTS` without weakening workflow gates or supervisor protocol behavior.

The main reduction should come from moving hotspot formatting and briefing/menu presentation rules upstream into hotspot collection spec files. `main/AGENTS` should keep workflow bridge logic only.

## Keep

- Explicit status writes:
  - `SET(current_step=...)`
  - `SET(workflow_mode=...)`
  - `SET(next_actor=...)`
- Explicit blockers:
  - `MUST_RECORD=...`
  - `IF_NOT_RECORDED=BLOCK_NEXT_STEP`
- Explicit transition/exit rules:
  - `IF_ACTION=上一步/下一步/重来/退出项目`
  - `STEP_TRANSITION_*`
  - `ON_PROJECT_EXIT`
- Full `STEP_7_DRAFTING` action payload semantics
- `THESIS_EXTRACTION=LATEST_BRIEFING_ELSE_LATEST_MATERIAL_LIBRARY(type=hotspot_briefing)+...`

## Move Upstream

Create or use hotspot collection spec files to own:

- briefing item format
- summary rule
- source fields rule
- reasoning rule
- score rule
- hotspot interaction/menu presentation
- candidate menu presentation

Intended bridge shape in `main/AGENTS`:

- `HOTSPOT_SPEC=FOLLOW_.../HOTSPOT_BRIEFING_SPEC.md`
- `HOTSPOT_FLOW=FOLLOW_HOTSPOT_SPEC+THESIS_EXTRACTION+FLOW_BRIDGE`

## Safe Compression

### 1. Shorten section names only

Allowed examples:

- `[WORKSPACE_RULES] -> [WS]`
- `[HOTSPOT_AND_THESIS_SOP] -> [HOTSPOT]`
- `[PROJECT_FLOW_LAW] -> [PROJECT]`
- `[SHARED_RECORDING] -> [SHARED]`
- `[USER_FACING_RULES] -> [USER]`
- `[ACTIVE_MENU_STATE] -> [MENU_STATE]`
- `[STEP_3_SELECTED] -> [STEP3]`
- `[STEP_4_VALIDATION] -> [STEP4]`
- `[STEP_5_DEBATE] -> [STEP5]`
- `[STEP_5_EVENT_MODEL] -> [STEP5_EVENTS]`
- `[DEBATE_CONTENT_RULE] -> [DEBATE]`
- `[SOURCE_CITATION_RULE] -> [CITATION]`
- `[STEP_6_FEEDBACK] -> [STEP6]`
- `[STEP_7_DRAFTING] -> [STEP7]`

### 2. Shorten keys only inside already-scoped sections

Allowed examples:

- `STEP_4_FEEDBACK_RULE -> FEEDBACK_RULE`
- `STEP_4_FILE_RULE -> FILE_RULE`
- `STEP_4_STATE -> STATE`
- `STEP_5_FILE_RULE -> FILE_RULE`
- `STEP_5_EVENT_RULE -> EVENT_RULE`
- `STEP_5_GROUP_POST -> GROUP_POST`
- `STEP_5_USER_GUIDANCE -> USER_GUIDANCE`
- `STEP_5_STATE -> STATE`
- `STEP_6_STATE -> STATE`
- `STEP_7_STATE -> STATE`
- `STEP_LABELS -> LABELS`
- `MENU_SELECTION_RULE -> SELECTION_RULE`
- `PROCESS_FILE_VS_RESULT_FILE_RULE -> PROCESS_RESULT_RULE`
- `FACT_REQUIRED_FIELDS -> FACT_FIELDS`
- `WORK_REQUIRED_FIELDS -> WORK_FIELDS`

## Do Not Do

- Do not merge menu sections into a single registry section.
- Do not merge navigation/transition/exit/reentry sections into one block.
- Do not introduce short aliases like:
  - `R=...`
  - `U=...`
  - `N=...`
  - `X=...`
  - `T=...`
- Do not hide explicit gate semantics inside long packed values.
- Do not restore the removed hotspot pre-debate branch unless explicitly requested again.

## Reasoning

Past regressions came from collapsing explicit menu/navigation structure. Section boundaries themselves acted as part of the agent contract. Compression should therefore come from:

1. moving hotspot presentation rules upstream
2. shortening names
3. shortening scoped keys

Compression should not come from weakening explicit workflow gates.
