import { beforeEach, describe, expect, test } from "@jest/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm, readFile, readdir, access } from "node:fs/promises";
import { spawn } from "node:child_process";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..");
const docsRoot = "/tmp/deepflow-assets/docs";
const executorPath = path.join(projectRoot, "assets", "root", "skills", "docs-manager", "docs-manager-executor.mjs");

describe("docs-manager canonical-v1", () => {
  beforeEach(async () => {
    await rm(docsRoot, { recursive: true, force: true });
  });

  test("ensure canonical-v1 is idempotent and validate passes", async () => {
    const bindingId = "http:dm-idempotent";
    const projectCode = `dmproj-${Date.now()}`;

    await expectOk(["bind", bindingId, projectCode]);
    await expectOk(["ensure", bindingId, "canonical-v1"]);

    await expectOk(["write", bindingId, "status", "first status"]);
    await expectOk(["ensure", bindingId, "canonical-v1"]);

    const statusPath = path.join(docsRoot, "projects", projectCode, "00_meta", "project_status.md");
    const content = await readFile(statusPath, "utf8");
    expect(content).toBe("first status");

    const validate = await runDocsManager(["validate", bindingId, "canonical-v1"]);
    expect(validate.code).toBe(0);
    expect(validate.stdout).toContain("✅ VALID canonical-v1");
  });

  test("validate canonical-v1 reports missing files", async () => {
    const bindingId = "http:dm-validate";
    const projectCode = `dmproj-${Date.now()}`;

    await expectOk(["bind", bindingId, projectCode]);
    await expectOk(["ensure", bindingId, "canonical-v1"]);
    await expectOk(["delete", bindingId, "demo", "--force"]);

    const validate = await runDocsManager(["validate", bindingId, "canonical-v1"]);
    expect(validate.code).toBe(1);
    expect(validate.stdout).toContain("❌ INVALID canonical-v1");
    expect(validate.stdout).toContain("❌ MISSING FILE 05_delivery/current_demo.md");
  });

  test("write uses overwrite semantics for aliases", async () => {
    const bindingId = "http:dm-overwrite";
    const projectCode = `dmproj-${Date.now()}`;

    await expectOk(["bind", bindingId, projectCode]);
    await expectOk(["write", bindingId, "status", "status-v1"]);
    await expectOk(["write", bindingId, "status", "status-v2"]);

    const statusPath = path.join(docsRoot, "projects", projectCode, "00_meta", "project_status.md");
    const content = await readFile(statusPath, "utf8");
    expect(content).toBe("status-v2");

    const entries = await readdir(path.join(docsRoot, "projects", projectCode, "00_meta"));
    const statusVariants = entries.filter((name) => name.startsWith("project_status"));
    expect(statusVariants).toEqual(["project_status.md"]);
  });

  test("append works for history docs and blocks invalid targets", async () => {
    const bindingId = "http:dm-append";
    const projectCode = `dmproj-${Date.now()}`;

    await expectOk(["bind", bindingId, projectCode]);
    await expectOk(["append", bindingId, "decisions", "decision-a"]);
    await expectOk(["append", bindingId, "decisions", "decision-b"]);

    const decisionsPath = path.join(docsRoot, "projects", projectCode, "00_meta", "decisions.md");
    const content = await readFile(decisionsPath, "utf8");
    expect(content).toContain("decision-a\n");
    expect(content).toContain("decision-b\n");

    const writeAppendOnly = await runDocsManager(["write", bindingId, "decisions", "x"]);
    expect(writeAppendOnly.code).toBe(1);
    expect(writeAppendOnly.stderr).toContain("append-only canonical docs");

    const appendStateDoc = await runDocsManager(["append", bindingId, "status", "x"]);
    expect(appendStateDoc.code).toBe(1);
    expect(appendStateDoc.stderr).toContain("append is only allowed");
  });

  test("delete protects required canonical docs unless force is used", async () => {
    const bindingId = "http:dm-delete-protect";
    const projectCode = `dmproj-${Date.now()}`;

    await expectOk(["bind", bindingId, projectCode]);
    await expectOk(["ensure", bindingId, "canonical-v1"]);

    const blocked = await runDocsManager(["delete", bindingId, "status"]);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain("delete blocked for required canonical doc");

    await expectOk(["delete", bindingId, "status", "--force"]);

    const statusPath = path.join(docsRoot, "projects", projectCode, "00_meta", "project_status.md");
    await expect(access(statusPath)).rejects.toThrow();
  });

  test("nodejs aliases resolve under canonical docs", async () => {
    const bindingId = "http:dm-nodejs";
    const projectCode = `dmproj-${Date.now()}`;

    await expectOk(["bind", bindingId, projectCode]);
    await expectOk(["ensure", bindingId, "canonical-v1"]);
    await expectOk(["write", bindingId, "node_task", "task body"]);
    await expectOk(["write", bindingId, "node_receipt", "receipt body"]);

    const taskPath = path.join(docsRoot, "projects", projectCode, "02_handoff", "nodejs_task.md");
    const receiptPath = path.join(docsRoot, "projects", projectCode, "03_receipts", "nodejs_receipt.md");
    await expect(readFile(taskPath, "utf8")).resolves.toBe("task body");
    await expect(readFile(receiptPath, "utf8")).resolves.toBe("receipt body");
  });
});

async function expectOk(args) {
  const result = await runDocsManager(args);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("✅");
  return result;
}

function runDocsManager(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [executorPath, ...toNamedArgs(args)], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });

    if (typeof options.stdin === "string") {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

function toNamedArgs(args) {
  const [action = "", bindingId = "", target = "", fourth = "", ...rest] = args;
  const contentParts = [fourth, ...rest].filter((part) => typeof part === "string" && part.length > 0);
  const named = ["--action", action, "--binding-id", bindingId];

  switch (action) {
    case "bind":
      if (target) {
        named.push("--project-code", target);
      }
      break;
    case "ensure":
    case "validate":
      if (target) {
        named.push("--profile", target);
      }
      break;
    case "write":
    case "append":
      if (target) {
        named.push("--path", target);
      }
      if (contentParts.length > 0) {
        named.push("--content", contentParts.join(" "));
      }
      break;
    case "list":
      if (target) {
        named.push("--path", target);
      }
      break;
    case "delete":
      if (target) {
        named.push("--path", target);
      }
      if (fourth === "--force" || rest.includes("--force")) {
        named.push("--force");
      }
      break;
    case "link":
    case "locate":
      if (target) {
        named.push("--path", target);
      }
      break;
    default:
      break;
  }

  return named;
}
