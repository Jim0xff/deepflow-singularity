# AGENTS.md

Guidance for coding agents working in `/home/ubuntu/deepflow`.

## Project Snapshot

- Runtime: Node.js (ESM, `"type": "module"`).
- Primary config: `recipe.yaml` (OpenClaw recipe/workspaces/channels).
- Main verification currently comes from Jest tests in `test/`.
- This is a scaffold-style repo; keep edits minimal, explicit, and reproducible.

## Repository Layout

- `recipe.yaml`: top-level Deepflow/OpenClaw recipe definition.
- `package.json`: npm scripts and dev dependencies.
- `test/recipe-smoke.test.mjs`: smoke tests for scaffold files.
- `assets/`: per-workspace agent assets.
- `assets/*/scripts/scheduling.mjs`: small Node CLI helper scripts.
- `Dockerfile`: container setup and gateway startup command.

## Source of Truth for Commands

- Always prefer `package.json` scripts when available.
- If a command is missing from scripts, use direct Node commands shown below.
- Do not invent CI-only commands that do not exist in this repository.

## Install / Bootstrap

- Install dependencies: `npm install`
- Clean install (CI-like): `npm ci`

## Build Commands

- There is currently **no explicit build script** in `package.json`.
- Treat this repo as config + scripts + tests unless build tooling is added.
- If you need a quick syntax check for ESM files, use:
  - `node --check test/recipe-smoke.test.mjs`
  - `node --check assets/backend-developer/scripts/scheduling.mjs`

## Lint / Format Commands

- There is currently **no lint script** (`npm run lint` is undefined).
- There is currently **no formatter config** (Prettier/Biome/ESLint not configured).
- Follow existing style in files and keep formatting consistent manually.
- If you add lint/format tooling, update this file with exact commands.

## Test Commands

- Run all tests:
  - `npm test`
- Run the recipe smoke test suite:
  - `npm run test:recipe`

## Running a Single Test (Important)

- Run one test file:
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js test/recipe-smoke.test.mjs --runInBand --verbose`
- Run one test by name pattern:
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js test/recipe-smoke.test.mjs --runInBand --verbose -t "recipe scaffold files exist"`
- Combine file + name pattern when a file has multiple tests.
- Prefer exact test-name patterns to avoid accidental partial matches.

## Docker / Runtime Commands

- Build image (if needed): `docker build -t deepflow .`
- Run gateway container (example): `docker run --rm deepflow`
- Dockerfile currently runs `npx clawchef cook .` during image build.

## Code Style Guidelines

These conventions are inferred from current repository code.

### JavaScript / Module System

- Use ESM (`import` / `export`), not CommonJS (`require`).
- Keep `"type": "module"` compatibility for new JS files.
- Prefer `.mjs` for executable scripts and tests in this repo.

### Imports

- Import Node built-ins via `node:` specifiers (example: `node:process`).
- Group imports at top of file; no inline imports in function bodies.
- Keep import list stable and readable; remove unused imports.
- Use double quotes for import specifiers.

### Formatting

- Use 2-space indentation.
- Use semicolons.
- Use double-quoted strings.
- Keep lines concise; wrap long expressions for readability.
- Preserve one blank line between logical blocks.

### Naming Conventions

- Variables/functions: `camelCase`.
- Constants that are not exported may still use `camelCase` (match existing files).
- Test descriptions should be human-readable sentence fragments.
- Script filenames should be descriptive and lowercase (existing pattern: `scheduling.mjs`).

### Types / Type Safety

- Codebase is plain JavaScript; no TypeScript config exists.
- Prefer simple runtime validation for external input (CLI args, env vars).
- Fail early when required values are missing.
- If adding TypeScript later, keep strictness high and document compiler settings.

### Error Handling

- Use guard clauses for invalid input.
- For CLI scripts, print actionable error messages to stderr.
- Exit with non-zero code on failure (`process.exit(1)` pattern is established).
- In tests, rely on Jest assertions (`expect(...)`).

### Test Style

- Use Jest test runner (`@jest/globals`).
- Use async tests when awaiting filesystem/process operations.
- Keep tests deterministic and filesystem-path safe.
- Prefer explicit file existence/access checks for scaffold verification.

### File and Path Handling

- Use `node:path` helpers instead of manual path concatenation.
- Use `fileURLToPath(import.meta.url)` in ESM tests/scripts when resolving local paths.
- Resolve project root from current file location when needed.

### Dependencies

- Keep dependencies minimal; this scaffold currently has very few packages.
- Prefer Node built-ins before adding third-party libraries.
- Document why any new dependency is required in PR/commit notes.

## Editing Rules for Agents

- Make the smallest change that solves the task.
- Do not reformat unrelated files.
- Do not rename files unless required by the task.
- Preserve existing behavior in scaffold assets unless asked to change it.
- Update tests when behavior changes.

## Validation Checklist Before Finishing

- Run relevant tests (`npm test` at minimum for broad changes).
- If only one area changed, run the narrowest test command first.
- Ensure modified scripts still run with Node ESM.
- Re-open changed files and verify style consistency.

## Cursor / Copilot Rules

- `.cursorrules`: not present at repository root.
- `.cursor/rules/`: not present.
- `.github/copilot-instructions.md`: not present.
- If any of these are added later, treat them as higher-priority guidance and update this file.

## When Unsure

- Prefer existing repository patterns over personal style preferences.
- Prefer explicit commands and deterministic tests.
- Ask for missing secrets/credentials instead of mocking them silently.
- Keep agent outputs practical, concise, and action-oriented.
