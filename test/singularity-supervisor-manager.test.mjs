import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createSingularitySupervisorManager } from "../dist/runtime/singularity-supervisor-manager.js";

describe("singularity supervisor manager", () => {
  test("starts supervisor only for auto step_5/step_7 projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "singularity-supervisor-manager-"));
    const callsPath = join(root, "calls.log");
    const scriptPath = join(root, "fake-supervisor.mjs");
    const step5Dir = join(root, "project-step5");

    await mkdir(step5Dir, { recursive: true });
    await writeFile(join(root, "CURRENT_PROJECT"), "project-step5\n", "utf8");

    await writeFile(
      join(step5Dir, "status.md"),
      "workflow_mode: auto\nstatus: active\ncurrent_step: step_5_debate\nnext_actor: reviewer\n",
      "utf8",
    );

    await writeFile(
      scriptPath,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(callsPath)}, process.argv.slice(2).join(" ") + "\\n");\n`,
      "utf8",
    );

    const manager = createSingularitySupervisorManager({
      projectsRoot: root,
      intervalMs: 60_000,
      scriptPath,
    });

    await manager.runNow();

    const calls = (await readFile(callsPath, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls.some((line) => line.includes(`--project-dir ${step5Dir}`))).toBe(true);

    await rm(root, { recursive: true, force: true });
  });

  test("starts supervisor for auto step_5 project when current_step is missing but step status implies debate", async () => {
    const root = await mkdtemp(join(tmpdir(), "singularity-supervisor-manager-step5-fallback-"));
    const callsPath = join(root, "calls.log");
    const scriptPath = join(root, "fake-supervisor.mjs");
    const step5Dir = join(root, "project-step5-fallback");

    await mkdir(step5Dir, { recursive: true });
    await writeFile(join(root, "CURRENT_PROJECT"), "project-step5-fallback\n", "utf8");
    await writeFile(
      join(step5Dir, "status.md"),
      "workflow_mode: auto\nstatus: active\nlast_completed_step: step_5_debate\nnext_step: step_6_feedback\nnext_actor: reviewer\nawaiting_user_choice: no\n",
      "utf8",
    );
    await writeFile(
      scriptPath,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(callsPath)}, process.argv.slice(2).join(" ") + "\\n");\n`,
      "utf8",
    );

    const manager = createSingularitySupervisorManager({
      projectsRoot: root,
      intervalMs: 60_000,
      scriptPath,
    });

    await manager.runNow();

    const calls = (await readFile(callsPath, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls.some((line) => line.includes(`--project-dir ${step5Dir}`))).toBe(true);

    await rm(root, { recursive: true, force: true });
  });

  test("starts supervisor for auto step_7 project when current_step is missing but step status implies drafting", async () => {
    const root = await mkdtemp(join(tmpdir(), "singularity-supervisor-manager-step7-fallback-"));
    const callsPath = join(root, "calls.log");
    const scriptPath = join(root, "fake-supervisor.mjs");
    const step7Dir = join(root, "project-step7-fallback");

    await mkdir(step7Dir, { recursive: true });
    await writeFile(join(root, "CURRENT_PROJECT"), "project-step7-fallback\n", "utf8");
    await writeFile(
      join(step7Dir, "status.md"),
      "workflow_mode: auto\nstatus: active\nnext_actor: writer\nawaiting_user_choice: no\nreview_target: draft\n",
      "utf8",
    );
    await writeFile(
      scriptPath,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(callsPath)}, process.argv.slice(2).join(" ") + "\\n");\n`,
      "utf8",
    );

    const manager = createSingularitySupervisorManager({
      projectsRoot: root,
      intervalMs: 60_000,
      scriptPath,
    });

    await manager.runNow();

    const calls = (await readFile(callsPath, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls.some((line) => line.includes(`--project-dir ${step7Dir}`))).toBe(true);

    await rm(root, { recursive: true, force: true });
  });

  test("publishes approved article to docs-manager when requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "singularity-supervisor-publish-"));
    const callsPath = join(root, "docs-calls.log");
    const scriptPath = join(root, "fake-supervisor.mjs");
    const docsManagerPath = join(root, "fake-docs-manager.mjs");
    const projectDir = join(root, "project-publish");

    await mkdir(projectDir, { recursive: true });
    await writeFile(join(root, "CURRENT_PROJECT"), "project-publish\n", "utf8");
    await writeFile(
      join(projectDir, "status.md"),
      "project_id: demo-article\nworkflow_mode: manual\nstatus: active\ncurrent_step: step_7_drafting\nnext_actor: main\ndocs_binding_state: bound\ndocs_publish_requested: yes\ndocs_publish_state: pending\n",
      "utf8",
    );
    await writeFile(join(projectDir, "output.md"), "final article body", "utf8");
    await writeFile(scriptPath, "", "utf8");
    await writeFile(
      docsManagerPath,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(callsPath)}, process.argv.slice(2).join(" ") + "\\n");\n`,
      "utf8",
    );

    const manager = createSingularitySupervisorManager({
      projectsRoot: root,
      intervalMs: 60_000,
      scriptPath,
      docsManagerPath,
    });

    await manager.runNow();

    const calls = (await readFile(callsPath, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--action write --binding-id http:singularity-demo-article --path 05_delivery/final_article.md --content final article body");

    const statusText = await readFile(join(projectDir, "status.md"), "utf8");
    expect(statusText).toContain("docs_publish_state: done");
    expect(statusText).toContain("docs_publish_requested: no");
    expect(statusText).toContain("docs_publish_path: 05_delivery/final_article.md");

    await rm(root, { recursive: true, force: true });
  });

  test("publishes final-output.md before output.md when present", async () => {
    const root = await mkdtemp(join(tmpdir(), "singularity-supervisor-publish-final-output-"));
    const callsPath = join(root, "docs-calls.log");
    const scriptPath = join(root, "fake-supervisor.mjs");
    const docsManagerPath = join(root, "fake-docs-manager.mjs");
    const projectDir = join(root, "project-final-output");

    await mkdir(projectDir, { recursive: true });
    await writeFile(join(root, "CURRENT_PROJECT"), "project-final-output\n", "utf8");
    await writeFile(
      join(projectDir, "status.md"),
      "project_id: demo-final-output\nworkflow_mode: manual\nstatus: active\ncurrent_step: step_7_drafting\nnext_actor: main\ndocs_binding_state: bound\ndocs_publish_requested: yes\ndocs_publish_state: pending\n",
      "utf8",
    );
    await writeFile(join(projectDir, "output.md"), "draft article body", "utf8");
    await writeFile(join(projectDir, "final-output.md"), "formal article body", "utf8");
    await writeFile(scriptPath, "", "utf8");
    await writeFile(
      docsManagerPath,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(callsPath)}, process.argv.slice(2).join(" ") + "\\n");\n`,
      "utf8",
    );

    const manager = createSingularitySupervisorManager({
      projectsRoot: root,
      intervalMs: 60_000,
      scriptPath,
      docsManagerPath,
    });

    await manager.runNow();

    const calls = (await readFile(callsPath, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--content formal article body");
    expect(calls[0]).not.toContain("draft article body");

    await rm(root, { recursive: true, force: true });
  });

  test("requires final-output.md for final article publish", async () => {
    const root = await mkdtemp(join(tmpdir(), "singularity-supervisor-publish-require-final-"));
    const callsPath = join(root, "docs-calls.log");
    const scriptPath = join(root, "fake-supervisor.mjs");
    const docsManagerPath = join(root, "fake-docs-manager.mjs");
    const projectDir = join(root, "project-require-final");

    await mkdir(projectDir, { recursive: true });
    await writeFile(join(root, "CURRENT_PROJECT"), "project-require-final\n", "utf8");
    await writeFile(
      join(projectDir, "status.md"),
      "project_id: demo-require-final\nworkflow_mode: manual\nstatus: active\ncurrent_step: step_7_drafting\nnext_actor: main\nfinal_article_ready: yes\ndocs_binding_state: bound\ndocs_publish_requested: yes\ndocs_publish_state: pending\n",
      "utf8",
    );
    await writeFile(join(projectDir, "output.md"), "draft article body", "utf8");
    await writeFile(scriptPath, "", "utf8");
    await writeFile(
      docsManagerPath,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(callsPath)}, process.argv.slice(2).join(" ") + "\\n");\n`,
      "utf8",
    );

    const manager = createSingularitySupervisorManager({
      projectsRoot: root,
      intervalMs: 60_000,
      scriptPath,
      docsManagerPath,
    });

    await manager.runNow();

    const calls = await readFile(callsPath, "utf8").catch(() => "");
    expect(calls).toBe("");
    const statusText = await readFile(join(projectDir, "status.md"), "utf8");
    expect(statusText).toContain("docs_publish_state: failed");
    expect(statusText).toContain("docs_publish_error: final_output_empty");

    await rm(root, { recursive: true, force: true });
  });

  test("notifies configured agent with final docs path after publish", async () => {
    const root = await mkdtemp(join(tmpdir(), "singularity-supervisor-publish-notify-"));
    const docsRoot = join(root, "docs");
    const callsPath = join(root, "docs-calls.log");
    const scriptPath = join(root, "fake-supervisor.mjs");
    const docsManagerPath = join(root, "fake-docs-manager.mjs");
    const projectDir = join(root, "project-publish-notify");
    const notifications = [];

    await mkdir(projectDir, { recursive: true });
    await mkdir(join(root, "active"), { recursive: true });
    await writeFile(join(root, "CURRENT_PROJECT"), "project-publish-notify\n", "utf8");
    await writeFile(join(root, "active", "telegram:-10001.current"), "demo-notify\n", "utf8");
    await writeFile(
      join(projectDir, "status.md"),
      "project_id: demo-notify\nworkflow_mode: manual\nstatus: active\ncurrent_step: step_7_drafting\nnext_actor: main\ndocs_binding_state: bound\ndocs_publish_requested: yes\ndocs_publish_state: pending\n",
      "utf8",
    );
    await writeFile(join(projectDir, "output.md"), "notify final article", "utf8");
    await writeFile(scriptPath, "", "utf8");
    await writeFile(
      docsManagerPath,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(callsPath)}, process.argv.slice(2).join(" ") + "\\n");\n`,
      "utf8",
    );

    const manager = createSingularitySupervisorManager({
      projectsRoot: root,
      intervalMs: 60_000,
      scriptPath,
      docsManagerPath,
      docsRoot,
      docsPublishNotifyAgentId: "singularity-video",
      runAgentCommand: async (agentId, message, sessionId) => {
        notifications.push({ agentId, message, sessionId });
      },
    });

    await manager.runNow();

    expect(notifications).toHaveLength(1);
    expect(notifications[0].agentId).toBe("singularity-video");
    expect(notifications[0].sessionId).toBe("docs-publish-demo-notify-singularity-video");
    expect(notifications[0].message).toBe(`/handle tg:-10001 path:${join(docsRoot, "projects", "demo-notify", "05_delivery/final_article.md")}`);

    const statusText = await readFile(join(projectDir, "status.md"), "utf8");
    expect(statusText).toContain("docs_publish_state: done");
    expect(statusText).toContain("docs_publish_notify_state: sent");
    expect(statusText).toContain("docs_publish_notify_agent: singularity-video");

    await rm(root, { recursive: true, force: true });
  });

  test("binds and ensures docs-manager for current active project", async () => {
    const root = await mkdtemp(join(tmpdir(), "singularity-supervisor-bind-"));
    const callsPath = join(root, "docs-calls.log");
    const scriptPath = join(root, "fake-supervisor.mjs");
    const docsManagerPath = join(root, "fake-docs-manager.mjs");
    const projectDir = join(root, "project-active");

    await mkdir(projectDir, { recursive: true });
    await writeFile(join(root, "CURRENT_PROJECT"), "project-active\n", "utf8");
    await writeFile(
      join(projectDir, "status.md"),
      "project_id: demo-active\nworkflow_mode: manual\nstatus: active\ncurrent_step: step_3_selected\nnext_actor: main\n",
      "utf8",
    );
    await writeFile(scriptPath, "", "utf8");
    await writeFile(
      docsManagerPath,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(callsPath)}, process.argv.slice(2).join(" ") + "\\n");\n`,
      "utf8",
    );

    const manager = createSingularitySupervisorManager({
      projectsRoot: root,
      intervalMs: 60_000,
      scriptPath,
      docsManagerPath,
    });

    await manager.runNow();

    const calls = (await readFile(callsPath, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--action bind --binding-id http:singularity-demo-active --project-code demo-active");
    expect(calls[1]).toContain("--action ensure --binding-id http:singularity-demo-active --profile canonical-v1");

    const statusText = await readFile(join(projectDir, "status.md"), "utf8");
    expect(statusText).toContain("docs_binding_state: bound");
    expect(statusText).toContain("docs_publish_binding_id: http:singularity-demo-active");
    expect(statusText).toContain("docs_bound_at:");

    await manager.runNow();
    const callsAfterSecondRun = (await readFile(callsPath, "utf8")).trim().split("\n");
    expect(callsAfterSecondRun).toHaveLength(2);

    await rm(root, { recursive: true, force: true });
  });

  test("repairs missing docs binding during publish", async () => {
    const root = await mkdtemp(join(tmpdir(), "singularity-supervisor-publish-repair-"));
    const callsPath = join(root, "docs-calls.log");
    const scriptPath = join(root, "fake-supervisor.mjs");
    const docsManagerPath = join(root, "fake-docs-manager.mjs");
    const projectDir = join(root, "project-repair");

    await mkdir(projectDir, { recursive: true });
    await writeFile(join(root, "CURRENT_PROJECT"), "project-repair\n", "utf8");
    await writeFile(
      join(projectDir, "status.md"),
      "project_id: demo-repair\nworkflow_mode: manual\nstatus: active\ncurrent_step: step_7_drafting\nnext_actor: main\ndocs_binding_state: bound\ndocs_publish_requested: yes\ndocs_publish_state: pending\n",
      "utf8",
    );
    await writeFile(join(projectDir, "output.md"), "repaired final article", "utf8");
    await writeFile(scriptPath, "", "utf8");
    await writeFile(
      docsManagerPath,
      `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const callsPath = ${JSON.stringify(callsPath)};
const args = process.argv.slice(2).join(" ");
appendFileSync(callsPath, args + "\\n");
if (args.includes("--action write")) {
  const countPath = callsPath + ".write-count";
  let count = 0;
  try {
    count = Number(readFileSync(countPath, "utf8") || "0");
  } catch {}
  writeFileSync(countPath, String(count + 1), "utf8");
  if (count === 0) {
    console.error("❌ project is not bound for http:singularity-demo-repair");
    process.exit(1);
  }
}
`,
      "utf8",
    );

    const manager = createSingularitySupervisorManager({
      projectsRoot: root,
      intervalMs: 60_000,
      scriptPath,
      docsManagerPath,
    });

    await manager.runNow();

    const calls = (await readFile(callsPath, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(4);
    expect(calls[0]).toContain("--action write --binding-id http:singularity-demo-repair");
    expect(calls[1]).toContain("--action bind --binding-id http:singularity-demo-repair --project-code demo-repair");
    expect(calls[2]).toContain("--action ensure --binding-id http:singularity-demo-repair --profile canonical-v1");
    expect(calls[3]).toContain("--action write --binding-id http:singularity-demo-repair");

    const statusText = await readFile(join(projectDir, "status.md"), "utf8");
    expect(statusText).toContain("docs_publish_state: done");
    expect(statusText).toContain("docs_publish_requested: no");
    expect(statusText).toContain("docs_binding_state: bound");
    expect(statusText).toContain("docs_bound_at:");

    await rm(root, { recursive: true, force: true });
  });

  test("does not unbind exited projects before agent unbind status is recorded", async () => {
    const root = await mkdtemp(join(tmpdir(), "singularity-supervisor-no-agent-unbind-"));
    const callsPath = join(root, "docs-calls.log");
    const scriptPath = join(root, "fake-supervisor.mjs");
    const docsManagerPath = join(root, "fake-docs-manager.mjs");
    const projectDir = join(root, "project-exited");

    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "status.md"),
      "project_id: demo-exited\nstatus: exited\ncurrent_step: exited\ndocs_binding_state: bound\ndocs_publish_binding_id: http:singularity-demo-exited\n",
      "utf8",
    );
    await writeFile(scriptPath, "", "utf8");
    await writeFile(
      docsManagerPath,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(callsPath)}, process.argv.slice(2).join(" ") + "\\n");\n`,
      "utf8",
    );

    const manager = createSingularitySupervisorManager({
      projectsRoot: root,
      intervalMs: 60_000,
      scriptPath,
      docsManagerPath,
    });

    await manager.runNow();

    const callsText = await readFile(callsPath, "utf8").catch(() => "");
    expect(callsText.trim()).toBe("");
    const statusText = await readFile(join(projectDir, "status.md"), "utf8");
    expect(statusText).toContain("docs_binding_state: bound");

    await rm(root, { recursive: true, force: true });
  });

  test("clears current pointers only after explicit project exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "singularity-supervisor-exited-clear-"));
    const callsPath = join(root, "docs-calls.log");
    const scriptPath = join(root, "fake-supervisor.mjs");
    const docsManagerPath = join(root, "fake-docs-manager.mjs");
    const projectDir = join(root, "project-exited-current");
    const activeDir = join(root, "active");

    await mkdir(projectDir, { recursive: true });
    await mkdir(activeDir, { recursive: true });
    await writeFile(join(root, "CURRENT_PROJECT"), "project-exited-current\n", "utf8");
    await writeFile(join(activeDir, "telegram:-100.current"), "project-exited-current\n", "utf8");
    await writeFile(
      join(projectDir, "status.md"),
      [
        "project_id: demo-exited-current",
        "status: exited",
        "current_step: exited",
        "docs_binding_state: unbound",
        "docs_publish_binding_id: http:singularity-demo-exited-current",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(scriptPath, "", "utf8");
    await writeFile(
      docsManagerPath,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(callsPath)}, process.argv.slice(2).join(" ") + "\\n");\n`,
      "utf8",
    );

    const manager = createSingularitySupervisorManager({
      projectsRoot: root,
      intervalMs: 60_000,
      scriptPath,
      docsManagerPath,
    });

    await manager.runNow();

    const statusText = await readFile(join(projectDir, "status.md"), "utf8");
    expect(statusText).toContain("docs_binding_state: unbound");
    const callsText = await readFile(callsPath, "utf8").catch(() => "");
    expect(callsText.trim()).toBe("");
    expect((await readFile(join(root, "CURRENT_PROJECT"), "utf8")).trim()).toBe("");
    expect((await readFile(join(activeDir, "telegram:-100.current"), "utf8")).trim()).toBe("");

    await rm(root, { recursive: true, force: true });
  });

  test("does not unbind completed projects and keeps current pointers after publish is done", async () => {
    const root = await mkdtemp(join(tmpdir(), "singularity-supervisor-completed-keep-bound-"));
    const callsPath = join(root, "docs-calls.log");
    const scriptPath = join(root, "fake-supervisor.mjs");
    const docsManagerPath = join(root, "fake-docs-manager.mjs");
    const projectDir = join(root, "project-completed");
    const activeDir = join(root, "active");

    await mkdir(projectDir, { recursive: true });
    await mkdir(activeDir, { recursive: true });
    await writeFile(join(root, "CURRENT_PROJECT"), "project-completed\n", "utf8");
    await writeFile(join(activeDir, "telegram:-100.current"), "project-completed\n", "utf8");
    await writeFile(
      join(projectDir, "status.md"),
      [
        "project_id: demo-completed",
        "status: completed",
        "current_step: completed",
        "docs_binding_state: bound",
        "docs_publish_binding_id: http:singularity-demo-completed",
        "docs_publish_requested: no",
        "docs_publish_state: done",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(scriptPath, "", "utf8");
    await writeFile(
      docsManagerPath,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(callsPath)}, process.argv.slice(2).join(" ") + "\\n");\n`,
      "utf8",
    );

    const manager = createSingularitySupervisorManager({
      projectsRoot: root,
      intervalMs: 60_000,
      scriptPath,
      docsManagerPath,
    });

    await manager.runNow();

    const callsText = await readFile(callsPath, "utf8").catch(() => "");
    expect(callsText.trim()).toBe("");
    const statusText = await readFile(join(projectDir, "status.md"), "utf8");
    expect(statusText).toContain("docs_binding_state: bound");
    expect((await readFile(join(root, "CURRENT_PROJECT"), "utf8")).trim()).toBe("project-completed");
    expect((await readFile(join(activeDir, "telegram:-100.current"), "utf8")).trim()).toBe("project-completed");

    await rm(root, { recursive: true, force: true });
  });

  test("publishes completed pending projects and keeps project bound until explicit exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "singularity-supervisor-completed-publish-"));
    const callsPath = join(root, "docs-calls.log");
    const scriptPath = join(root, "fake-supervisor.mjs");
    const docsManagerPath = join(root, "fake-docs-manager.mjs");
    const projectDir = join(root, "project-completed-pending");
    const activeDir = join(root, "active");

    await mkdir(projectDir, { recursive: true });
    await mkdir(activeDir, { recursive: true });
    await writeFile(join(root, "CURRENT_PROJECT"), "project-completed-pending\n", "utf8");
    await writeFile(join(activeDir, "telegram:-100.current"), "project-completed-pending\n", "utf8");
    await writeFile(
      join(projectDir, "status.md"),
      [
        "project_id: demo-completed-pending",
        "status: completed",
        "current_step: completed",
        "docs_binding_state: bound",
        "docs_publish_binding_id: http:singularity-demo-completed-pending",
        "docs_publish_requested: yes",
        "docs_publish_state: pending",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(projectDir, "output.md"), "completed final article", "utf8");
    await writeFile(scriptPath, "", "utf8");
    await writeFile(
      docsManagerPath,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(callsPath)}, process.argv.slice(2).join(" ") + "\\n");\n`,
      "utf8",
    );

    const manager = createSingularitySupervisorManager({
      projectsRoot: root,
      intervalMs: 60_000,
      scriptPath,
      docsManagerPath,
    });

    await manager.runNow();

    const calls = (await readFile(callsPath, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--action write --binding-id http:singularity-demo-completed-pending --path 05_delivery/final_article.md --content completed final article");

    const statusText = await readFile(join(projectDir, "status.md"), "utf8");
    expect(statusText).toContain("docs_publish_state: done");
    expect(statusText).toContain("docs_publish_requested: no");
    expect(statusText).toContain("docs_binding_state: bound");
    expect((await readFile(join(root, "CURRENT_PROJECT"), "utf8")).trim()).toBe("project-completed-pending");
    expect((await readFile(join(activeDir, "telegram:-100.current"), "utf8")).trim()).toBe("project-completed-pending");

    await rm(root, { recursive: true, force: true });
  });

  test("dedupes concurrent pending publish scans", async () => {
    const root = await mkdtemp(join(tmpdir(), "singularity-supervisor-publish-inflight-"));
    const callsPath = join(root, "docs-calls.log");
    const scriptPath = join(root, "fake-supervisor.mjs");
    const docsManagerPath = join(root, "fake-docs-manager.mjs");
    const projectDir = join(root, "project-pending");

    await mkdir(projectDir, { recursive: true });
    await writeFile(join(root, "CURRENT_PROJECT"), "project-pending\n", "utf8");
    await writeFile(
      join(projectDir, "status.md"),
      [
        "project_id: demo-pending",
        "status: active",
        "current_step: step_7_drafting",
        "docs_binding_state: bound",
        "docs_publish_binding_id: http:singularity-demo-pending",
        "docs_publish_requested: yes",
        "docs_publish_state: pending",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(projectDir, "output.md"), "pending final article", "utf8");
    await writeFile(scriptPath, "", "utf8");
    await writeFile(
      docsManagerPath,
      `import { appendFileSync } from "node:fs";
await new Promise((resolve) => setTimeout(resolve, 150));
appendFileSync(${JSON.stringify(callsPath)}, process.argv.slice(2).join(" ") + "\\n");
`,
      "utf8",
    );

    const manager = createSingularitySupervisorManager({
      projectsRoot: root,
      intervalMs: 60_000,
      scriptPath,
      docsManagerPath,
    });

    await Promise.all([manager.runNow(), manager.runNow()]);

    const calls = (await readFile(callsPath, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--action write --binding-id http:singularity-demo-pending");

    await rm(root, { recursive: true, force: true });
  });
});
