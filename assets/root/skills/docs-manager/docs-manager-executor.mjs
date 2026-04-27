#!/usr/bin/env node

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DOCS_ROOT = "/tmp/deepflow-assets/docs";
const PROJECTS_ROOT = path.join(DOCS_ROOT, "projects");
const BINDINGS_FILE = path.join(DOCS_ROOT, "projects.json");
const PROJECT_AUTH_FILE_NAME = ".docs-auth.json";
const CANONICAL_PROFILE = "canonical-v1";
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(process.env.HOME || "/root", ".openclaw");
const AGENTS_ROOT = path.join(OPENCLAW_HOME, "agents");
const SESSION_BACKUPS_ROOT = path.join(OPENCLAW_HOME, "session-backups");
const SESSION_CLEAR_DELAY_MS = 2_000;
const SINGULARITY_SESSION_AGENT_IDS = [
  "singularity-main",
  "singularity-writer",
  "singularity-reviewer",
  "singularity-final-writer",
];

const CANONICAL_DIRS = [
  "00_meta",
  "01_product",
  "02_handoff",
  "03_receipts",
  "04_review",
  "05_delivery",
];

const CANONICAL_FILES = [
  "00_meta/project_status.md",
  "00_meta/decisions.md",
  "00_meta/iteration_log.md",
  "01_product/requirement_brief.md",
  "01_product/prd.md",
  "01_product/open_questions.md",
  "02_handoff/frontend_task.md",
  "02_handoff/backend_task.md",
  "02_handoff/nodejs_task.md",
  "03_receipts/frontend_receipt.md",
  "03_receipts/backend_receipt.md",
  "03_receipts/nodejs_receipt.md",
  "04_review/review_summary.md",
  "04_review/unresolved_issues.md",
  "04_review/lessons_learned.md",
  "05_delivery/current_demo.md",
];

const REQUIRED_CANONICAL_FILES = new Set(CANONICAL_FILES);
const APPEND_ONLY_CANONICAL_FILES = new Set([
  "00_meta/decisions.md",
  "00_meta/iteration_log.md",
  "04_review/lessons_learned.md",
]);

const ALIASES = new Map([
  ["status", "00_meta/project_status.md"],
  ["decisions", "00_meta/decisions.md"],
  ["iteration", "00_meta/iteration_log.md"],
  ["brief", "01_product/requirement_brief.md"],
  ["prd", "01_product/prd.md"],
  ["questions", "01_product/open_questions.md"],
  ["fe_task", "02_handoff/frontend_task.md"],
  ["be_task", "02_handoff/backend_task.md"],
  ["node_task", "02_handoff/nodejs_task.md"],
  ["fe_receipt", "03_receipts/frontend_receipt.md"],
  ["be_receipt", "03_receipts/backend_receipt.md"],
  ["node_receipt", "03_receipts/nodejs_receipt.md"],
  ["review", "04_review/review_summary.md"],
  ["issues", "04_review/unresolved_issues.md"],
  ["lessons", "04_review/lessons_learned.md"],
  ["demo", "05_delivery/current_demo.md"],
]);

const USAGE = "usage: node docs-manager-executor.mjs --action <bind|unbind|current|read|write|append|replace|ensure|validate|list|delete|link|locate|handle_notify|clear_singularity_sessions> --binding-id <bindingId> [--project-code <code>|--path <path-or-alias>|--content <text>|--from <text>|--to <text>|--all|--profile canonical-v1|--force|--account-id <accountId>|--message <text>|--backup-dir <path>|--delay-ms <ms>]";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureStore();

  switch (args.action) {
    case "bind":
      await bindProject(args);
      break;
    case "unbind":
      await unbindProject(args);
      break;
    case "current":
      await showCurrentProject(args);
      break;
    case "read":
      await readDoc(args);
      break;
    case "write":
      await writeDoc(args);
      break;
    case "append":
      await appendDoc(args);
      break;
    case "replace":
      await replaceDoc(args);
      break;
    case "ensure":
      await ensureCanonical(args);
      break;
    case "validate":
      await validateCanonical(args);
      break;
    case "list":
      await listDocs(args);
      break;
    case "delete":
      await deleteDoc(args);
      break;
    case "link":
      await linkDoc(args);
      break;
    case "locate":
      await locateDoc(args);
      break;
    case "handle_notify":
      await handleNotify(args);
      break;
    case "clear_singularity_sessions":
      await clearSingularitySessions(args);
      break;
    default:
      fail(USAGE);
  }
}

function parseArgs(argv) {
  const parsed = {
    action: "",
    bindingId: "",
    projectCode: "",
    relativePath: "",
    content: undefined,
    profile: "",
    force: false,
    accountId: "",
    message: "",
    from: "",
    to: undefined,
    replaceAll: false,
    backupDir: "",
    delayMs: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case "--action":
        parsed.action = requireValue(token, argv[++i]);
        break;
      case "--binding-id":
        parsed.bindingId = requireValue(token, argv[++i]);
        break;
      case "--project-code":
        parsed.projectCode = requireValue(token, argv[++i]);
        break;
      case "--path":
        parsed.relativePath = requireValue(token, argv[++i]);
        break;
      case "--content":
        parsed.content = requireValue(token, argv[++i]);
        break;
      case "--profile":
        parsed.profile = requireValue(token, argv[++i]);
        break;
      case "--account-id":
        parsed.accountId = requireValue(token, argv[++i]);
        break;
      case "--message":
        parsed.message = requireValue(token, argv[++i]);
        break;
      case "--from":
        parsed.from = requireValue(token, argv[++i]);
        break;
      case "--to":
        parsed.to = requireValue(token, argv[++i]);
        break;
      case "--all":
        parsed.replaceAll = true;
        break;
      case "--force":
        parsed.force = true;
        break;
      case "--backup-dir":
        parsed.backupDir = requireValue(token, argv[++i]);
        break;
      case "--delay-ms":
        parsed.delayMs = requireValue(token, argv[++i]);
        break;
      default:
        fail(`unknown argument: ${token}`);
    }
  }

  if (!parsed.action) {
    fail("--action is required");
  }
  if (!parsed.bindingId) {
    fail("--binding-id is required");
  }
  if (argv.length === 0) {
    fail(USAGE);
  }
  return parsed;
}

function requireValue(flag, value) {
  if (!value || value.startsWith("--")) {
    fail(`${flag} requires a value`);
  }
  return value;
}

async function ensureStore() {
  await fs.mkdir(PROJECTS_ROOT, { recursive: true });
  try {
    await fs.access(BINDINGS_FILE);
  } catch {
    await writeAtomic(BINDINGS_FILE, `${JSON.stringify({}, null, 2)}\n`);
  }
}

function fail(message) {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
}

function validateBindingId(bindingId) {
  if (!bindingId) {
    fail("bindingId is required");
  }
  if (!/^tg:-?[0-9]+$|^http:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bindingId)) {
    fail("bindingId must be tg:<chatId> (supports negative Telegram IDs) or http:<conversationId>");
  }
}

function validateProjectCode(projectCode) {
  if (!projectCode) {
    fail("project code is required");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(projectCode)) {
    fail("project code may contain only letters, numbers, dot, underscore, or dash");
  }
}

function validateProfile(profile) {
  if (profile !== CANONICAL_PROFILE) {
    fail(`unsupported profile: ${profile} (expected: ${CANONICAL_PROFILE})`);
  }
}

function normalizeRelativePath(input) {
  const cleaned = String(input ?? "").replace(/^\.\//, "").replace(/^\//, "");
  return cleaned === "." ? "" : cleaned;
}

function normalizeTargetOrAliasPath(input) {
  const cleaned = normalizeRelativePath(input);
  if (!cleaned) {
    fail("relative file path or alias is required");
  }
  return ALIASES.get(cleaned) ?? cleaned;
}

function resolveUnderRoot(rootDir, relativePath) {
  const rootAbs = path.resolve(rootDir);
  const targetAbs = path.resolve(rootDir, relativePath);
  if (targetAbs !== rootAbs && !targetAbs.startsWith(`${rootAbs}${path.sep}`)) {
    fail("path is outside project root");
  }
  return targetAbs;
}

function toRelativeFromRoot(absPath, rootDir) {
  const rootAbs = path.resolve(rootDir);
  const targetAbs = path.resolve(absPath);
  if (targetAbs === rootAbs) {
    return "";
  }
  return path.relative(rootAbs, targetAbs).replaceAll("\\", "/");
}

function buildPublicUrl(origin, relFromDocs) {
  const normalizedOrigin = origin.replace(/\/+$/, "");
  return `${normalizedOrigin}/docs/${relFromDocs}`;
}

function printProjectDocumentsLink(projectCode) {
  const origin = process.env.CLAWCHEF_VAR_ALLOWED_ORIGIN;
  if (!origin) {
    return;
  }
  const url = buildPublicUrl(origin, `projects/${projectCode}`);
  process.stdout.write(`✅ [Documents](${url})\n`);
}

async function readBindings() {
  try {
    const raw = (await fs.readFile(BINDINGS_FILE, "utf8")).trim();
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

async function writeBindings(bindings) {
  await writeAtomic(BINDINGS_FILE, `${JSON.stringify(bindings, null, 2)}\n`);
}

async function writeAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempFile, content, "utf8");
  await fs.rename(tempFile, filePath);
}

async function ensureProjectAuthPassword(projectCode) {
  const projectDir = path.join(PROJECTS_ROOT, projectCode);
  const authPath = path.join(projectDir, PROJECT_AUTH_FILE_NAME);
  await fs.mkdir(projectDir, { recursive: true });

  try {
    const raw = (await fs.readFile(authPath, "utf8")).trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.password === "string" && parsed.password.length > 0) {
        return parsed.password;
      }
    }
  } catch {
    // fallthrough to regenerate
  }

  const password = crypto.randomBytes(24).toString("base64url");
  const payload = {
    projectCode,
    password,
    createdAt: new Date().toISOString(),
  };
  await writeAtomic(authPath, `${JSON.stringify(payload, null, 2)}\n`);
  return password;
}

async function resolveProjectRootForBinding(bindingId) {
  validateBindingId(bindingId);
  const bindings = await readBindings();
  const projectCode = typeof bindings[bindingId] === "string" ? bindings[bindingId] : "";
  if (!projectCode) {
    fail(`project is not bound for ${bindingId}; ask user for project code and run: node docs-manager-executor.mjs --action bind --binding-id ${bindingId} --project-code <project-code>`);
  }
  validateProjectCode(projectCode);
  const projectRoot = path.join(PROJECTS_ROOT, projectCode);
  await fs.mkdir(projectRoot, { recursive: true });
  return projectRoot;
}

async function bindProject(args) {
  validateBindingId(args.bindingId);
  validateProjectCode(args.projectCode);
  const bindings = await readBindings();
  const existingProject = typeof bindings[args.bindingId] === "string" ? bindings[args.bindingId] : "";

  if (existingProject && existingProject !== args.projectCode) {
    fail(`project is already bound for ${args.bindingId} -> ${existingProject}; run unbind first`);
  }

  await fs.mkdir(path.join(PROJECTS_ROOT, args.projectCode), { recursive: true });
  const projectPassword = await ensureProjectAuthPassword(args.projectCode);
  bindings[args.bindingId] = args.projectCode;
  await writeBindings(bindings);

  process.stdout.write(`✅ BOUND ${args.bindingId} -> ${args.projectCode}\n`);
  process.stdout.write(`✅ PASSWORD ${projectPassword}\n`);
  printProjectDocumentsLink(args.projectCode);
}

async function unbindProject(args) {
  validateBindingId(args.bindingId);
  const bindings = await readBindings();
  const projectCode = typeof bindings[args.bindingId] === "string" ? bindings[args.bindingId] : "";
  if (!projectCode) {
    fail(`project is not bound for ${args.bindingId}`);
  }
  let backupDir = "";
  if (shouldResetSingularitySessions(args.bindingId)) {
    backupDir = await backupSingularitySessions({ bindingId: args.bindingId, projectCode });
    await scheduleSingularitySessionClear({
      bindingId: args.bindingId,
      projectCode,
      backupDir,
      delayMs: SESSION_CLEAR_DELAY_MS,
    });
  }
  delete bindings[args.bindingId];
  await writeBindings(bindings);
  if (backupDir) {
    process.stdout.write(`✅ SESSION_BACKUP ${backupDir}\n`);
    process.stdout.write(`✅ SESSION_CLEAR scheduled singularity-* after ${SESSION_CLEAR_DELAY_MS}ms\n`);
  }
  process.stdout.write(`✅ UNBOUND ${args.bindingId} <- ${projectCode}\n`);
}

function shouldResetSingularitySessions(bindingId) {
  return /^http:singularity-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(bindingId || ""));
}

function buildSessionBackupDir(projectCode) {
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return path.join(SESSION_BACKUPS_ROOT, `singularity-sessions-${projectCode}-${stamp}`);
}

async function backupSingularitySessions({ bindingId, projectCode }) {
  const backupDir = buildSessionBackupDir(projectCode);
  const manifest = {
    bindingId,
    projectCode,
    createdAt: new Date().toISOString(),
    delayMs: SESSION_CLEAR_DELAY_MS,
    agents: [],
  };
  await fs.mkdir(backupDir, { recursive: true });

  for (const agentId of SINGULARITY_SESSION_AGENT_IDS) {
    const sessionsDir = path.join(AGENTS_ROOT, agentId, "sessions");
    try {
      const stat = await fs.stat(sessionsDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    const backupAgentDir = path.join(backupDir, agentId);
    await fs.cp(sessionsDir, backupAgentDir, { recursive: true, force: true });
    manifest.agents.push({
      agentId,
      source: sessionsDir,
      backup: backupAgentDir,
    });
  }

  await writeAtomic(path.join(backupDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return backupDir;
}

async function scheduleSingularitySessionClear({ bindingId, projectCode, backupDir, delayMs }) {
  const child = spawn(
    process.execPath,
    [
      path.resolve(process.argv[1]),
      "--action",
      "clear_singularity_sessions",
      "--binding-id",
      bindingId,
      "--project-code",
      projectCode,
      "--backup-dir",
      backupDir,
      "--delay-ms",
      String(delayMs),
    ],
    {
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  );
  child.unref();
}

async function clearSingularitySessions(args) {
  validateBindingId(args.bindingId);
  if (args.delayMs) {
    const ms = Number.parseInt(args.delayMs, 10);
    if (Number.isFinite(ms) && ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }

  const clearedAgents = [];
  for (const agentId of SINGULARITY_SESSION_AGENT_IDS) {
    const sessionsDir = path.join(AGENTS_ROOT, agentId, "sessions");
    try {
      const stat = await fs.stat(sessionsDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    await fs.rm(sessionsDir, { recursive: true, force: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    clearedAgents.push(agentId);
  }

  if (args.backupDir) {
    const resultPath = path.join(args.backupDir, "clear-result.json");
    await writeAtomic(
      resultPath,
      `${JSON.stringify(
        {
          bindingId: args.bindingId,
          projectCode: args.projectCode || "",
          clearedAt: new Date().toISOString(),
          clearedAgents,
        },
        null,
        2,
      )}\n`,
    );
  }

  process.stdout.write(`✅ CLEARED ${clearedAgents.join(",")}\n`);
}

async function showCurrentProject(args) {
  validateBindingId(args.bindingId);
  const bindings = await readBindings();
  const projectCode = typeof bindings[args.bindingId] === "string" ? bindings[args.bindingId] : "";
  if (!projectCode) {
    fail(`project is not bound for ${args.bindingId}; ask user for project code and run: node docs-manager-executor.mjs --action bind --binding-id ${args.bindingId} --project-code <project-code>`);
  }
  validateProjectCode(projectCode);
  process.stdout.write(`✅ BOUND ${args.bindingId} -> ${projectCode}\n`);
  printProjectDocumentsLink(projectCode);
}

async function writeDoc(args) {
  validateBindingId(args.bindingId);
  const relPath = normalizeTargetOrAliasPath(args.relativePath);
  if (APPEND_ONLY_CANONICAL_FILES.has(relPath)) {
    fail(`write is not allowed for append-only canonical docs (use append): ${relPath}`);
  }

  const projectRoot = await resolveProjectRootForBinding(args.bindingId);
  const targetPath = resolveUnderRoot(projectRoot, relPath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const content = args.content ?? (await readStdin());
  await fs.writeFile(targetPath, content, "utf8");
  printWriteLikeResult(targetPath, projectRoot, "WROTE");
}

async function readDoc(args) {
  validateBindingId(args.bindingId);
  const relPath = normalizeTargetOrAliasPath(args.relativePath);
  const projectRoot = await resolveProjectRootForBinding(args.bindingId);
  const targetPath = resolveUnderRoot(projectRoot, relPath);

  let content;
  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isFile()) {
      fail("file not found");
    }
    content = await fs.readFile(targetPath, "utf8");
  } catch {
    fail("file not found");
  }

  process.stdout.write(`✅ ${targetPath}\n`);
  process.stdout.write(content);
}

async function appendDoc(args) {
  validateBindingId(args.bindingId);
  const relPath = normalizeTargetOrAliasPath(args.relativePath);
  if (!APPEND_ONLY_CANONICAL_FILES.has(relPath)) {
    fail("append is only allowed for canonical history docs: decisions, iteration, lessons");
  }

  const projectRoot = await resolveProjectRootForBinding(args.bindingId);
  const targetPath = resolveUnderRoot(projectRoot, relPath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const content = args.content ?? (await readStdin());
  await fs.appendFile(targetPath, `${content}\n`, "utf8");
  printWriteLikeResult(targetPath, projectRoot, "APPENDED");
}

async function replaceDoc(args) {
  validateBindingId(args.bindingId);
  const relPath = normalizeTargetOrAliasPath(args.relativePath);
  if (!args.from) {
    fail("--from is required for replace");
  }
  if (typeof args.to !== "string") {
    fail("--to is required for replace");
  }

  const projectRoot = await resolveProjectRootForBinding(args.bindingId);
  const targetPath = resolveUnderRoot(projectRoot, relPath);

  let content = "";
  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isFile()) {
      fail("file not found");
    }
    content = await fs.readFile(targetPath, "utf8");
  } catch {
    fail("file not found");
  }

  const nextContent = args.replaceAll
    ? content.split(args.from).join(args.to)
    : replaceFirst(content, args.from, args.to);

  await fs.writeFile(targetPath, nextContent, "utf8");
  printWriteLikeResult(targetPath, projectRoot, "REPLACED");
}

function replaceFirst(content, from, to) {
  const index = content.indexOf(from);
  if (index < 0) {
    return content;
  }
  return `${content.slice(0, index)}${to}${content.slice(index + from.length)}`;
}

function printWriteLikeResult(targetPath, projectRoot, fallbackVerb) {
  const relFromDocs = toRelativeFromRoot(targetPath, DOCS_ROOT);
  const relFromProject = toRelativeFromRoot(targetPath, projectRoot);
  const origin = process.env.CLAWCHEF_VAR_ALLOWED_ORIGIN;
  if (origin) {
    process.stdout.write(`✅ [${relFromProject}](${buildPublicUrl(origin, relFromDocs)})\n`);
    return;
  }
  process.stdout.write(`✅ ${fallbackVerb} ${relFromProject}\n`);
}

async function ensureCanonical(args) {
  validateBindingId(args.bindingId);
  validateProfile(args.profile);
  const projectRoot = await resolveProjectRootForBinding(args.bindingId);

  for (const relDir of CANONICAL_DIRS) {
    const targetDir = resolveUnderRoot(projectRoot, relDir);
    await fs.mkdir(targetDir, { recursive: true });
  }

  for (const relFile of CANONICAL_FILES) {
    const targetFile = resolveUnderRoot(projectRoot, relFile);
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    try {
      await fs.access(targetFile);
    } catch {
      await fs.writeFile(targetFile, "", "utf8");
    }
  }

  process.stdout.write(`✅ ENSURED ${args.profile}\n`);
}

async function validateCanonical(args) {
  validateBindingId(args.bindingId);
  validateProfile(args.profile);
  const projectRoot = await resolveProjectRootForBinding(args.bindingId);

  const missing = [];
  for (const relDir of CANONICAL_DIRS) {
    const targetPath = resolveUnderRoot(projectRoot, relDir);
    try {
      const stat = await fs.stat(targetPath);
      if (!stat.isDirectory()) {
        missing.push(`❌ MISSING DIR ${relDir}`);
      }
    } catch {
      missing.push(`❌ MISSING DIR ${relDir}`);
    }
  }

  for (const relFile of CANONICAL_FILES) {
    const targetPath = resolveUnderRoot(projectRoot, relFile);
    try {
      const stat = await fs.stat(targetPath);
      if (!stat.isFile()) {
        missing.push(`❌ MISSING FILE ${relFile}`);
      }
    } catch {
      missing.push(`❌ MISSING FILE ${relFile}`);
    }
  }

  if (missing.length > 0) {
    process.stdout.write(`❌ INVALID ${args.profile}\n`);
    for (const line of missing) {
      process.stdout.write(`${line}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(`✅ VALID ${args.profile}\n`);
}

async function listDocs(args) {
  validateBindingId(args.bindingId);
  const relDir = normalizeRelativePath(args.relativePath);
  const projectRoot = await resolveProjectRootForBinding(args.bindingId);
  const dirPath = resolveUnderRoot(projectRoot, relDir);

  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    fail("directory not found");
  }

  if (entries.length === 0) {
    process.stdout.write("✅ EMPTY\n");
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  const origin = process.env.CLAWCHEF_VAR_ALLOWED_ORIGIN;
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    const relFromProject = toRelativeFromRoot(entryPath, projectRoot);
    if (entry.isDirectory()) {
      process.stdout.write(`✅ DIR ${relFromProject}/\n`);
      continue;
    }
    if (entry.isFile()) {
      if (origin) {
        const relFromDocs = toRelativeFromRoot(entryPath, DOCS_ROOT);
        process.stdout.write(`✅ [${relFromProject}](${buildPublicUrl(origin, relFromDocs)})\n`);
      } else {
        process.stdout.write(`✅ FILE ${relFromProject}\n`);
      }
    }
  }
}

async function deleteDoc(args) {
  validateBindingId(args.bindingId);
  const relPath = normalizeTargetOrAliasPath(args.relativePath);
  if (REQUIRED_CANONICAL_FILES.has(relPath) && !args.force) {
    fail(`delete blocked for required canonical doc: ${relPath} (use --force to override)`);
  }

  const projectRoot = await resolveProjectRootForBinding(args.bindingId);
  const targetPath = resolveUnderRoot(projectRoot, relPath);
  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isFile()) {
      fail("file not found");
    }
  } catch {
    fail("file not found");
  }
  await fs.unlink(targetPath);
  process.stdout.write(`✅ DELETED ${toRelativeFromRoot(targetPath, DOCS_ROOT)}\n`);
}

async function linkDoc(args) {
  validateBindingId(args.bindingId);
  const relPath = normalizeTargetOrAliasPath(args.relativePath);
  const projectRoot = await resolveProjectRootForBinding(args.bindingId);
  const targetPath = resolveUnderRoot(projectRoot, relPath);

  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isFile()) {
      fail("file not found");
    }
  } catch {
    fail("file not found");
  }

  const origin = process.env.CLAWCHEF_VAR_ALLOWED_ORIGIN;
  if (!origin) {
    fail("CLAWCHEF_VAR_ALLOWED_ORIGIN is required");
  }

  const relFromDocs = toRelativeFromRoot(targetPath, DOCS_ROOT);
  process.stdout.write(`✅ ${buildPublicUrl(origin, relFromDocs)}\n`);
}

async function locateDoc(args) {
  validateBindingId(args.bindingId);
  const relPath = normalizeTargetOrAliasPath(args.relativePath);
  const projectRoot = await resolveProjectRootForBinding(args.bindingId);
  const targetPath = resolveUnderRoot(projectRoot, relPath);

  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isFile()) {
      fail("file not found");
    }
  } catch {
    fail("file not found");
  }

  process.stdout.write(`✅ ${targetPath}\n`);
}

async function handleNotify(args) {
  validateBindingId(args.bindingId);
  if (!args.accountId) {
    fail("--account-id is required for handle_notify");
  }
  if (!args.message) {
    fail("--message is required for handle_notify");
  }

  const telegramTarget = parseTelegramChatTarget(args.bindingId);
  const response = await sendTelegramMessage({
    accountId: args.accountId,
    target: telegramTarget,
    message: args.message,
  });

  process.stdout.write(`✅ NOTIFIED ${args.bindingId} ${args.accountId}\n`);
  if (response?.messageId) {
    process.stdout.write(`✅ MESSAGE_ID ${response.messageId}\n`);
  }
}

function parseTelegramChatTarget(bindingId) {
  const match = bindingId.match(/^tg:(-?\d+)$/);
  if (!match) {
    fail("handle_notify requires Telegram bindingId in format tg:<chatId>");
  }
  return match[1];
}

async function sendTelegramMessage({ accountId, target, message }) {
  const args = [
    "message",
    "send",
    "--channel",
    "telegram",
    "--account",
    accountId,
    "--target",
    target,
    "--message",
    message,
    "--json",
  ];
  const { stdout } = await execFile("openclaw", args);
  const jsonStart = stdout.indexOf("{");
  const jsonText = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
  return JSON.parse(jsonText);
}

async function execFile(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr || `command failed with exit code ${code}`));
    });
  });
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
