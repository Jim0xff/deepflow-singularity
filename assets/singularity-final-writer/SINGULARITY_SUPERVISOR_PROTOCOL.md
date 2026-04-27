# Singularity Supervisor Protocol

Step 7 draft writing uses `writer -> reviewer -> main`.

Step 8 final-article writing uses `final_writer -> main|reviewer`.

After draft approval, `main` sets `current_step=step_8_final_article` and `next_actor=final_writer`. The final writer reads `output.md` for generate mode or `final-output.md` for revise mode, writes the formal article to `final-output.md`, appends `draft_review_history.md`, and returns to `main` unless `after_final_writer=reviewer`.

Shared status fields for this loop include:

- `after_final_writer: main | reviewer`
- `final_writer_mode: "" | generate | revise`

Docs publish uses `final-output.md`.
