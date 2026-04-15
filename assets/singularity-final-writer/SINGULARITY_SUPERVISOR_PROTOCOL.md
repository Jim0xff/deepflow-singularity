# Singularity Supervisor Protocol

Step 7 draft writing uses `writer -> reviewer -> main`.

After draft approval, `main` may set `next_actor=final_writer`. The final writer reads `output.md`, writes the formal article to `final-output.md`, appends `draft_review_history.md`, and returns to `main` unless `after_final_writer=reviewer`.

Docs publish uses `final-output.md`; legacy projects without final state may fall back to `output.md`.
