# AGENTS DSL Compression Guide

This guide defines the compression standard for AGENTS-style backend flow-control DSL in this repository.

Reference style:
- `/Users/maozhijian/Documents/GitHub/deepflow/assets/backend-developer/AGENTS.md`
- `/Users/maozhijian/Documents/GitHub/deepflow/assets/backend-worker/AGENTS.md`
- `/Users/maozhijian/Documents/GitHub/deepflow/assets/backend-developer/STATIC_RULES.md`

## Goal

Compress AGENTS without weakening execution certainty.

The target style is:
- short
- programmatic
- transaction-oriented
- unambiguous to the model

The non-goal is:
- maximizing byte reduction at the cost of state clarity
- replacing hard state payloads with local shorthand
- stacking natural-language reminders on top of executable rules

## Core Rule

Compress:
- stable dictionary symbols
- repeated transaction names
- repeated path bundles
- repeated menu action bundles

Do not compress:
- critical state payload fields
- actor/target/handoff fields inside `SET(...)`
- values that distinguish draft vs final control flow
- schema-bearing fields whose explicit text prevents branch confusion

## What Deepflow Does

The backend AGENTS in `deepflow` use short aliases for:
- stable paths
- filenames
- step ids
- repeated field bundles
- repeated transaction names

Examples:
- `ST=status.md`
- `HO=handoff.md`
- `OUT=output.md`
- `S0=...;S1=...`
- `MF=active_menu_scope,active_menu_options,...`
- `AUTO`, `HUMAN_TX`, `BRANCH_TX`, `PRECODE_READ_GATE`

But they do **not** compress critical state payloads into opaque one-letter substitutions inside writes. The style keeps state-machine contracts readable at the write point.

## Compression Standard

### 1. Prefer noun aliases, not payload aliases

Good:
- `ST=status.md`
- `HO=handoff.md`
- `TB=BIND_project.md.template_id+handoff.md.template_id`
- `S5_AUTO=SEQ(...)`

Bad:
- `R=next_actor=reviewer`
- `W=next_actor=writer`
- `TF=review_target=final`

Reason:
- noun aliases reduce duplication
- payload aliases hide branch-critical semantics

### 2. Keep `SET(...)` explicit

Good:
```text
SET(auto,next_actor=reviewer,awaiting_user_choice=no,current_step=step_5_debate)
SET(auto,next_actor=final_writer,awaiting_user_choice=no,review_target=final,final_writer_mode=revise)
```

Bad:
```text
SET(auto,R,A)
SET(auto,V,A,TF)
```

Reason:
- `SET(...)` is the state contract
- explicit payloads reduce menu-scope drift and mixed-state writes

### 3. Compress repeated transactions into named TX/GATE blocks

Good:
```text
S7_REWRITE_READ_TX=SEQ(...)
S7_REWRITE_TX=SEQ(...)
FINAL_READ_TX=SEQ(...)
```

Bad:
- repeating the same long `SEQ(...)` in multiple menu entries
- keeping both a TX and multiple parallel descriptive aliases for the same TX

Rule:
- one semantic action -> one TX/GATE name
- menu entries should call the TX, not restate the body

### 4. Use `SEQ(...)` for ordered obligations

If logic is truly transactional, express it as:
```text
SEQ(step1,step2,step3)
```

Not as:
```text
A+B+C
```

Use `+` only for:
- unordered composition
- field bundles
- rule aggregation

Use `SEQ(...)` for:
- read-before-write
- write-before-handoff
- menu action chains

### 5. Put mandatory reads into read TX/gates

For rewrite flows, required reads should live in the read transaction, not as loose reminders.

Good:
```text
S7_REWRITE_READ_TX=SEQ(
  READ_LATEST_DRAFT_FROM_OUTPUT,
  S7_EDITOR_FB_GATE,
  S7_REVIEWER_GATE,
  S7_RULES_GATE
)
```

Bad:
- one part in TX
- another part only in `MUST_DO`
- another part only in comments/natural language

### 6. Keep one enforcement layer per obligation

If a TX already enforces a requirement, remove duplicate weaker declarations unless they add a distinct guarantee.

Prefer:
- `TX`
- `GATE`
- `FORBIDDEN`

Avoid keeping all three when they say the same thing:
- `MUST_DO`
- `PASS_GATE_BEFORE_*`
- duplicated `FORBIDDEN`

### 7. Use `FORBIDDEN` only for truly separate failure modes

Keep `FORBIDDEN` for:
- mixed states
- impossible actor/target combinations
- skipping a required TX

Do not mirror every TX step again in `FORBIDDEN` if the TX already blocks it.

### 8. Separate draft and final by explicit schema

Draft/final branch separation must stay explicit at the write point.

Good:
- `next_actor=writer,review_target=draft`
- `next_actor=final_writer,review_target=final`

Bad:
- shared shorthand that makes the two branches visually similar

### 9. Scope assertion is worth abbreviating

This is safe to compress:
```text
D=ASSERT_SCOPE(step_7_menu)
F=ASSERT_SCOPE(step_7_final_menu)
```

Because:
- it is a stable control primitive
- it does not hide payload content

### 10. Paths, file ids, and repeated bundles are ideal alias targets

Safe alias targets:
- file names
- directories
- repeated menu bundles
- repeated template-binding bundles
- repeated final/draft transaction names

Unsafe alias targets:
- actor choice
- review target
- menu-state payload fields
- branch-defining state writes

## Preferred Shape

Use this structure when possible:

```text
[KEY]
ST=status.md
HO=handoff.md
OUT=output.md

[STEPX]
READ_TX=SEQ(...)
WRITE_TX=SEQ(READ_TX,...,SET(...))
FORBIDDEN=SKIP_READ_TX_BEFORE_WRITE
```

And for menu actions:

```text
ACTION_A=SEQ(...)
ACTION_B=SEQ(...)
USER_TRIGGER_RULE=scope_action_1->SEQ(ASSERT_SCOPE(...),ACTION_A)+...
```

## Red Flags

Compression has gone too far if any of these appear:

- `SET(...)` contains opaque aliases for branch-critical fields
- draft/final state can no longer be visually distinguished
- the same obligation exists in TX + MUST_DO + GATE + FORBIDDEN
- a new short alias saves bytes but hides state-machine meaning
- menu routes become shorter but harder to audit

## Review Checklist

Before accepting an AGENTS compression change, check:

1. Did any `SET(...)` lose explicit actor/target/state fields?
2. Did any draft/final split become less obvious?
3. Did a new alias hide a state payload instead of a stable noun?
4. Can each menu action still be traced to one concrete TX?
5. Did the change remove redundancy, or only add another abstraction layer?
6. If a failure occurs, can we still inspect the AGENTS and immediately see the exact state write?

## Repository Policy

For `deepflow-singularity`, follow this default:

- compress repeated nouns and repeated transactions
- keep status payload writes explicit
- prefer `SEQ(...)`, `*_TX`, `*_GATE`, `FORBIDDEN`
- remove duplicate `MUST_DO`/gate declarations once a TX fully covers them
- do not shorten `next_actor=...`, `review_target=...`, `awaiting_user_choice=...`, `final_writer_mode=...`

This is the baseline for future AGENTS compression reviews.
