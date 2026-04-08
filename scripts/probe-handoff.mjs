import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { createHandoffNotifier } from "../dist/handoff-notify/index.js";

const docsRoot = resolve(process.env.DOCS_ROOT ?? "/tmp/deepflow-assets/docs");
const bindingId = process.env.HANDOFF_PROBE_BINDING_ID ?? "http:probe-handoff";
const projectId = process.env.HANDOFF_PROBE_PROJECT_ID ?? `handoff-probe-${Date.now()}`;
const relativePath = process.env.HANDOFF_PROBE_RELATIVE_PATH ?? "02_handoff/backend_task.md";
const projectFilePath = join(docsRoot, "projects", projectId, relativePath);
const bindingsPath = join(docsRoot, "projects.json");
const debounceMs = Number.parseInt(process.env.HANDOFF_PROBE_DEBOUNCE_MS ?? "200", 10);

const calls = [];

await fs.mkdir(join(docsRoot, "projects", projectId, "02_handoff"), { recursive: true });
await fs.mkdir(join(docsRoot, "projects", projectId, "03_receipts"), { recursive: true });

const bindings = await readJsonObject(bindingsPath);
bindings[bindingId] = projectId;
await fs.writeFile(bindingsPath, `${JSON.stringify(bindings, null, 2)}\n`, "utf8");

const notifier = createHandoffNotifier({
  docsRoot,
  debounceMs,
  runAgentCommand: async (agentId, message, sessionId) => {
    const call = { agentId, message, sessionId };
    calls.push(call);
    console.log(`[probe-handoff] trigger ${JSON.stringify(call)}`);
  },
});

console.log(`[probe-handoff] docsRoot=${docsRoot}`);
console.log(`[probe-handoff] projectId=${projectId}`);
console.log(`[probe-handoff] bindingId=${bindingId}`);
console.log(`[probe-handoff] relativePath=${relativePath}`);

notifier.start();

await sleep(150);
await fs.writeFile(projectFilePath, `probe write at ${new Date().toISOString()}\n`, "utf8");
await sleep(700);
await notifier.stop();

if (calls.length === 0) {
  console.error("[probe-handoff] failed: no notification was triggered");
  process.exit(1);
}

console.log(`[probe-handoff] success: ${calls.length} notification(s) captured`);

async function readJsonObject(filePath) {
  try {
    const raw = (await fs.readFile(filePath, "utf8")).trim();
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
