# Singularity Supervisor Protocol

This protocol defines the minimal shared state used by:

- `singularity-main`
- `singularity-reviewer`
- `singularity-writer`
- `scripts/supervisor/adapters/singularity-flow.mjs`

## Status Fields

All fields live in `/.openclaw/shared/projects/<project_id>/status.md`.

- `workflow_mode: manual | auto`
- `current_step: step_3_selected | step_4_validation | step_5_debate | step_6_feedback | step_7_drafting | completed | exited`
- `next_actor: main | reviewer | writer`
- `awaiting_user_choice: yes | no`

`main` owns major step transitions. `reviewer` and `writer` only hand off the next actor inside active auto flows.

## Step 5 Debate

Entry by `main`:

- `current_step=step_5_debate`
- `workflow_mode=auto`
- `next_actor=reviewer`
- `awaiting_user_choice=no`

After a reviewer debate round:

- `current_step=step_5_debate`
- `workflow_mode=auto`
- `next_actor=main`
- `awaiting_user_choice=yes`

After `main` posts the round menu:

- if user chooses continue debate:
  - `current_step=step_5_debate`
  - `workflow_mode=auto`
  - `next_actor=reviewer`
  - `awaiting_user_choice=no`

- if user chooses enter step 6:
  - `current_step=step_6_feedback`
  - `workflow_mode=manual`
  - `next_actor=main`
  - `awaiting_user_choice=no`

## Step 7 Drafting

Entry by `main`:

- `current_step=step_7_drafting`
- `workflow_mode=auto`
- `next_actor=writer`
- `awaiting_user_choice=no`

After writer finishes a draft or revision:

- `current_step=step_7_drafting`
- `workflow_mode=auto`
- `next_actor=reviewer`
- `awaiting_user_choice=no`

After reviewer finishes review:

- if `verdict=changes_requested`:
  - `current_step=step_7_drafting`
  - `workflow_mode=auto`
  - `next_actor=writer`
  - `awaiting_user_choice=no`

- if `verdict=approved`:
  - `current_step=step_7_drafting`
  - `workflow_mode=auto`
  - `next_actor=main`
  - `awaiting_user_choice=no`

After `main` posts the final wrap-up, the workflow may return to `manual` or transition to `completed`.

