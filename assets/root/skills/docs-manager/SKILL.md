---
name: docs-manager
description: Manage canonical project docs state (bind, read, write, append, replace, ensure, validate, list, link, delete, locate, handle_notify)
---

Use this skill whenever users ask to bind a chat/session to a project, initialize canonical docs, write/append docs, validate docs completeness, list docs, delete docs, or get docs links.

Trigger rule: if user intent is docs state persistence (canonical docs protocol), docs CRUD/link/bind, prefer this skill over generic file/workspace tools.

You can accept both interaction styles:

- Command style (preferred for deterministic execution): `/bind`, `/unbind`, `/project`, `/ensure`, `/validate`, `/write`, `/append`, `/replace`, `/list`, `/link`, `/delete`, `/locate`
- Natural language style: normal user requests for docs operations

If user provides command style, execute the command semantics directly without reinterpretation.

Always use this command pattern:

```bash
node {baseDir}/docs-manager-executor.mjs --action <action> --binding-id <bindingId> [named-options]
```

Important:

- `docs-manager` is a skill name, not a shell executable.
- Never run `docs-manager ...` directly in shell.
- Never use positional args for docs-manager execution.
- If execution is needed, always run `node {baseDir}/docs-manager-executor.mjs ...` with named args.

Supported actions:

- `--action bind --binding-id <bindingId> --project-code <project-code>`: bind this chat/session to a project code. On first bind, generate a project password and persist it under that project directory.
- `--action unbind --binding-id <bindingId>`: unbind current project from this chat/session.
- `--action current --binding-id <bindingId>`: show current bound project for this binding.
- `--action ensure --binding-id <bindingId> --profile canonical-v1`: idempotently initialize canonical docs directories and placeholder files under the bound project.
- `--action validate --binding-id <bindingId> --profile canonical-v1`: validate canonical docs completeness and return missing dirs/files.
- `--action read --binding-id <bindingId> --path <relative-file-path-or-alias>`: resolve the canonical doc under the bound project and return its absolute path followed by full file content.
- `--action write --binding-id <bindingId> --path <relative-file-path-or-alias> [--content <text>]`: overwrite content for state-style docs under the bound project directory.
- `--action append --binding-id <bindingId> --path <relative-file-path-or-alias> [--content <text>]`: append content for history-style canonical docs (`decisions`, `iteration`, `lessons`).
- `--action replace --binding-id <bindingId> --path <relative-file-path-or-alias> --from <text> --to <text> [--all]`: replace text in a canonical doc (`--all` replaces all matches; default replaces first match).
- `--action list --binding-id <bindingId> [--path <relative-dir>]`: list directories and files under the bound project directory. File entries are returned as links, with link text as project-relative path.
- `--action delete --binding-id <bindingId> --path <relative-file-path-or-alias> [--force]`: delete one document file under the bound project directory. Required canonical docs are protected unless `--force` is provided.
- `--action link --binding-id <bindingId> --path <relative-file-path-or-alias>`: return the public URL for the document.
- `--action locate --binding-id <bindingId> --path <relative-file-path-or-alias>`: return the absolute file path in storage.
- `--action handle_notify --binding-id <bindingId> --account-id <accountId> --message <text>`: send Telegram message to the chat extracted from `bindingId`.

Canonical alias mapping (project-local only):

- `status` -> `00_meta/project_status.md`
- `decisions` -> `00_meta/decisions.md`
- `iteration` -> `00_meta/iteration_log.md`
- `brief` -> `01_product/requirement_brief.md`
- `prd` -> `01_product/prd.md`
- `questions` -> `01_product/open_questions.md`
- `fe_task` -> `02_handoff/frontend_task.md`
- `be_task` -> `02_handoff/backend_task.md`
- `node_task` -> `02_handoff/nodejs_task.md`
- `fe_receipt` -> `03_receipts/frontend_receipt.md`
- `be_receipt` -> `03_receipts/backend_receipt.md`
- `node_receipt` -> `03_receipts/nodejs_receipt.md`
- `review` -> `04_review/review_summary.md`
- `issues` -> `04_review/unresolved_issues.md`
- `lessons` -> `04_review/lessons_learned.md`
- `demo` -> `05_delivery/current_demo.md`

Write/append split:

- `write` is for state docs (overwrite semantics).
- `append` is for history docs only (`decisions`, `iteration`, `lessons`).
- `write` must not be used for append-only docs.

Canonical required docs (protected from default delete):

- `00_meta/project_status.md`
- `00_meta/decisions.md`
- `00_meta/iteration_log.md`
- `01_product/requirement_brief.md`
- `01_product/prd.md`
- `01_product/open_questions.md`
- `02_handoff/frontend_task.md`
- `02_handoff/backend_task.md`
- `02_handoff/nodejs_task.md`
- `03_receipts/frontend_receipt.md`
- `03_receipts/backend_receipt.md`
- `03_receipts/nodejs_receipt.md`
- `04_review/review_summary.md`
- `04_review/unresolved_issues.md`
- `04_review/lessons_learned.md`
- `05_delivery/current_demo.md`

Publish verification (required):
- After `write`, run `locate` for the same path to verify file exists.
- Return the final `link` only after locate succeeds.
- If link is not accessible, report failure and do not claim publish success.

Command-style mapping (chat-level):

- `/bind <project-code>`: bind current `bindingId` to project.
- `/unbind`: unbind current project from current `bindingId`.
- `/project`: show current bound project for current `bindingId`.
- `/ensure canonical-v1`: initialize canonical docs skeleton for current project.
- `/validate canonical-v1`: validate canonical docs completeness for current project.
- `/write <relative-path-or-alias> <content>`: write one-line content directly.
- `/write <relative-path-or-alias>` then content in stdin/message body: write body as file content.
- `/append <relative-path-or-alias> <content>`: append one-line content directly.
- `/append <relative-path-or-alias>` then content in stdin/message body: append body as file content.
- `/replace <relative-path-or-alias> <from> <to> [--all]`: replace text in one canonical file.
- `/list [relative-path]`: list docs under current bound project.
- `/link <relative-path-or-alias>`: return doc URL.
- `/delete <relative-path-or-alias> [--force]`: delete doc.
- `/locate <relative-path-or-alias>`: return absolute file path.

BindingId derivation rules for command-style:

- In Telegram chats, derive `bindingId` from conversation metadata as `tg:<chatId>`.
- In non-Telegram channels, derive `bindingId` as `http:<conversationId>`.
- Do not ask user to provide `bindingId` for command-style `/bind`, `/project`, `/ensure`, `/validate`, `/write`, `/append`, `/list`, `/link`, `/delete`, `/locate`.
- If user provides `/bind <project-code>`, treat the argument as project code only.

Execution rules:

- Do not run `bind` if the current request is ensure/validate/write/append/list/delete/link and no project switch was explicitly requested by the user.
- Only run `bind` when either (a) the binding is missing, or (b) user explicitly asks to switch/rebind project.
- If `bindingId` is already bound to another project, require `unbind` before binding to a different project.
- Binding the same project again is allowed and should be treated as idempotent success.
- On bind success, return the generated/reused project password to the user.
- Never derive project code from a doc path. Values like `integration-*` belong to relative paths, not project codes.
- If a step unexpectedly produces another `BOUND ...` during non-bind actions, treat that run as invalid and rerun the intended action without rebinding.
- For command style, treat path/content/project arguments as immutable tokens; do not rewrite or infer replacements.
- Prefer this canonical flow for new projects: `bind` -> `ensure canonical-v1` -> `validate canonical-v1` -> `write`/`append`.
- For canonical docs body reads, prefer `--action read` so binding resolution, path resolution, and file read happen in one executor call.
- Use `locate` only when absolute file path is specifically needed as output.
- Never read canonical docs with direct relative paths outside docs-manager (for example `read 00_meta/decisions.md`), because tools may resolve them under agent workspace paths like `.../workspace-product-designer/...`.
- Return status with emoji for every command result:
  - Success lines must start with `✅ `.
  - Failure messages must start with `❌ `.

Notes:

- `bindingId` must include source prefix:
  - Telegram: `tg:<chatId>` (supports negative group/supergroup IDs, e.g. `tg:-1001234567890`)
  - HTTP/non-Telegram: `http:<conversationId>`
- If the current `bindingId` is not bound, ask the user for project code first, run `bind`, then continue the original action.
- Use relative paths only for docs-manager command arguments.
- When invoking file-reading tools, always use the absolute path returned by `locate`.
- Treat storage layout and persistence details as internal implementation.
- Never bypass this skill by directly manipulating files for docs operations.
- Never treat `docs-manager` as a binary command name.
- Never execute `docs-manager.sh`; the only executor is `docs-manager-executor.mjs`.
- For `handle_notify`, `--account-id` and `--message` are required and have no default values.
- `handle_notify` only accepts Telegram-form binding ids (`tg:<chatId>`).
