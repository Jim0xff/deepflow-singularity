# Integration Guideline (for Developers)

This guideline is for deepflow developers and defines how product-designer, frontend-developer, and backend-developer work is integrated.

## 1. Core Principles

1) `recipe.yaml` is usually unchanged
- Do not modify `recipe.yaml` for normal implementation and integration tasks.
- Only change it when orchestration structure must change (workspace/agent/channel/global orchestration parameters).
- If `recipe.yaml` is changed, explain why and what is impacted in the change description.

2) Agent workspace internals are not restricted
- There is no forced internal directory structure inside each agent workspace.
- Each agent may organize files and subdirectories as needed.
- Keep changes readable, maintainable, and minimal.

## 2. Integration Test Convention

- Agent integration tests should be placed under the repository root `test/` directory.
- Split tests by responsibility into separate files instead of putting all scenarios in one file.
- Use test file names that clearly describe covered integration behavior.

## 3. Cross-Agent Document Sharing (Required)

- For documents shared across agents, all file access must go through the `docs-manager` skill.
- Do not bypass `docs-manager` by directly reading/writing shared docs paths.
- Publishing, linking, locating, listing, and deleting shared docs must follow `docs-manager` command semantics.

## 4. Change Scope

- Follow minimal-change scope by default: modify only what is required for the current task.
- Avoid unrelated broad refactors, renames, or directory migrations.

## 5. Pre-Commit Checklist

- [ ] Did this change avoid unnecessary `recipe.yaml` edits?
- [ ] Are integration tests placed under root `test/` and split by file where appropriate?
- [ ] Are all cross-agent shared docs operations done via `docs-manager`?
- [ ] Is the integration scope and impact clearly documented?
