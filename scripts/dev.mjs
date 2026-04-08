import chokidar from "chokidar";
import dotenv from "dotenv";
import { spawn } from "node:child_process";
import process from "node:process";

dotenv.config();

const watchTargets = ["recipe.yaml", "assets"];
const cookDebounceMs = 500;
const dotenvRefPath = ".env";
const recipePath = "recipe.yaml";
const rootAssetsPattern = "assets/root/**";

let shuttingDown = false;
let watcher = null;
let gatewayProcess = null;
let pendingCookTimer = null;
let pendingChangedPaths = new Set();
let reloadRunning = false;
let reloadQueued = false;
let gatewayStopInProgress = false;

function runCommand(command, args, label) {
  return new Promise((resolve, reject) => {
    const fullCommand = formatCommand(command, args);
    console.log(`${label}:`);
    console.log(`[dev] exec> ${fullCommand}`);
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  });
}

function formatCommand(command, args) {
  return [command, ...args.map(shellQuote)].join(" ");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runCookFull() {
  await runCommand(
    "clawchef",
    ["cook", ".", "-s", "--gateway-mode", "none", "--dotenv-ref", dotenvRefPath],
    "[dev] initial cook",
  );
}

async function runCookFiles() {
  await runCommand(
    "clawchef",
    ["cook", ".", "-s", "--scope", "files", "--gateway-mode", "none", "--dotenv-ref", dotenvRefPath],
    "[dev] incremental cook",
  );
}

async function runCookStateful() {
  await runCommand(
    "clawchef",
    ["cook", ".", "-s", "--scope", "stateful", "--gateway-mode", "none", "--dotenv-ref", dotenvRefPath],
    "[dev] stateful cook",
  );
}

async function runCookWorkspace(workspaceName) {
  await runCookFilesWithPatterns([`workspace-${workspaceName}/**`]);
}

async function runCookFilesWithPatterns(filePatterns) {
  const args = ["cook", ".", "-s", "--scope", "files", "--gateway-mode", "none", "--dotenv-ref", dotenvRefPath];
  for (const pattern of filePatterns) {
    args.push("--file", pattern);
  }
  await runCommand("clawchef", args, `[dev] files cook (${filePatterns.join(", ")})`);
}

function startGateway() {
  if (gatewayProcess && gatewayProcess.exitCode === null && !gatewayProcess.killed) {
    return;
  }

  console.log("[dev] starting openclaw gateway");
  gatewayProcess = spawn("openclaw", ["gateway", "run", "--force"], {
    stdio: "inherit",
    env: process.env,
  });

  gatewayProcess.on("exit", (code, signal) => {
    gatewayProcess = null;

    if (shuttingDown || gatewayStopInProgress) {
      return;
    }

    console.warn(
      `[dev] openclaw gateway exited unexpectedly code=${code ?? "null"} signal=${signal ?? "null"}; restarting`,
    );
    startGateway();
  });
}

async function runReloadOnce() {
  const cookPlan = buildCookPlan(consumeChangedPaths());
  if (cookPlan.length === 0) {
    console.log("[dev] no actionable change detected, skip reload");
    return;
  }

  console.log("[dev] reloading gateway for file changes");
  await terminateGateway();

  try {
    for (const step of cookPlan) {
      if (step.type === "stateful") {
        await runCookStateful();
        continue;
      }
      if (step.type === "workspace") {
        await runCookWorkspace(step.workspace);
        continue;
      }
      await runCookFilesWithPatterns(step.patterns);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[dev] incremental cook failed; gateway remains stopped: ${message}`);
    return;
  }

  if (!shuttingDown) {
    startGateway();
  }
}

async function processReloadQueue() {
  if (reloadRunning || shuttingDown) {
    reloadQueued = true;
    return;
  }

  reloadRunning = true;
  try {
    do {
      reloadQueued = false;
      await runReloadOnce();
    } while (reloadQueued && !shuttingDown);
  } finally {
    reloadRunning = false;
  }
}

function scheduleCookFiles(eventName, changedPath) {
  if (shuttingDown) {
    return;
  }

  const filePath = changedPath ?? "(unknown)";
  console.log(`[dev] change detected: ${eventName} ${filePath}`);
  trackChangedPath(changedPath);

  if (pendingCookTimer) {
    clearTimeout(pendingCookTimer);
  }

  pendingCookTimer = setTimeout(() => {
    pendingCookTimer = null;
    void processReloadQueue();
  }, cookDebounceMs);
}

function normalizeChangedPath(pathValue) {
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    return "";
  }
  return pathValue.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/").replace(/\/$/, "");
}

function trackChangedPath(pathValue) {
  const normalized = normalizeChangedPath(pathValue);
  if (!normalized) {
    return;
  }
  pendingChangedPaths.add(normalized);
}

function consumeChangedPaths() {
  const snapshot = pendingChangedPaths;
  pendingChangedPaths = new Set();
  return snapshot;
}

function buildCookPlan(changedPaths) {
  const workspaces = new Set();
  let rootAssetsChanged = false;
  let requiresStateful = false;

  for (const pathValue of changedPaths) {
    const normalized = normalizeChangedPath(pathValue);
    if (!normalized) {
      continue;
    }

    if (normalized === recipePath) {
      requiresStateful = true;
      break;
    }

    if (normalized === "assets") {
      requiresStateful = true;
      break;
    }

    if (!normalized.startsWith("assets/")) {
      continue;
    }

    const segments = normalized.split("/");
    if (segments.length < 2) {
      requiresStateful = true;
      break;
    }

    const scopeName = segments[1];
    if (!scopeName) {
      requiresStateful = true;
      break;
    }

    if (scopeName === "root") {
      rootAssetsChanged = true;
      continue;
    }

    workspaces.add(scopeName);
  }

  if (requiresStateful) {
    return [{ type: "stateful" }];
  }

  const steps = [];
  if (rootAssetsChanged) {
    steps.push({ type: "files", patterns: [rootAssetsPattern] });
  }

  for (const workspaceName of [...workspaces].sort()) {
    steps.push({ type: "workspace", workspace: workspaceName });
  }

  return steps;
}

function startWatcher() {
  watcher = chokidar.watch(watchTargets, {
    ignoreInitial: true,
    ignored: (pathValue) => pathValue.includes("/.git/") || pathValue.includes("/.openclaw/"),
  });

  watcher.on("all", (eventName, changedPath) => {
    scheduleCookFiles(eventName, changedPath);
  });

  console.log(`[dev] watching: ${watchTargets.join(", ")}`);
}

function onceExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }
    child.once("exit", () => resolve(true));
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function terminateGateway() {
  gatewayStopInProgress = true;

  if (!gatewayProcess || gatewayProcess.killed || gatewayProcess.exitCode !== null) {
    gatewayStopInProgress = false;
    return;
  }

  gatewayProcess.kill("SIGTERM");
  const exited = await Promise.race([onceExit(gatewayProcess), sleep(10000).then(() => false)]);
  if (!exited) {
    gatewayProcess.kill("SIGKILL");
    await onceExit(gatewayProcess);
  }

  gatewayProcess = null;
  gatewayStopInProgress = false;
}

async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  if (pendingCookTimer) {
    clearTimeout(pendingCookTimer);
    pendingCookTimer = null;
  }

  if (watcher) {
    await watcher.close();
    watcher = null;
  }

  await terminateGateway();
}

async function main() {
  process.on("SIGINT", () => {
    void shutdown().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().then(() => process.exit(0));
  });

  await runCookFull();
  startGateway();
  startWatcher();
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[dev] failed: ${message}`);
  await shutdown();
  process.exit(1);
});
