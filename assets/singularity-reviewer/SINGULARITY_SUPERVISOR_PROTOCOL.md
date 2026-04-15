# Singularity Supervisor Protocol

This protocol defines the minimal shared state used by:

- `singularity-main`
- `singularity-reviewer`
- `singularity-writer`
- `singularity-final-writer`
- `scripts/supervisor/adapters/singularity-flow.mjs`

## Status Fields

All fields live in `/.openclaw/shared/projects/<project_id>/status.md`.

- `workflow_mode: manual | auto`
- `current_step: step_3_selected | step_4_validation | step_5_debate | step_6_feedback | step_7_drafting | completed | exited`
- `next_actor: main | reviewer | writer | final_writer`
- `awaiting_user_choice: yes | no`
- `final_article_ready: yes | no`
- `review_target: draft | final`
- `after_final_writer: main | reviewer`
- `docs_publish_requested: yes | no`
- `docs_publish_state: pending | syncing | done | failed`

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

After draft approval, `main` may set `next_actor=final_writer`. The final writer reads `output.md`, writes the formal article to `final-output.md`, appends `draft_review_history.md`, and returns to `main` unless `after_final_writer=reviewer`.

## Docs Publish

After reviewer approval, if the editor confirms the article is final and acceptable for delivery, `main` must set:

- `docs_publish_requested=yes`
- `docs_publish_state=pending`

The runtime manager syncs `final-output.md` into the bound docs-manager project folder at `05_delivery/final_article.md`. Legacy projects without final state may fall back to `output.md`.

- `docs_publish_state=done`
- `docs_publish_requested=no`
- `docs_publish_path=05_delivery/final_article.md`
- `docs_publish_at=<timestamp>`
