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
      "project_id: demo-article\nworkflow_mode: manual\nstatus: active\ncurrent_step: step_7_drafting\nnext_actor: main\ndocs_publish_requested: yes\ndocs_publish_state: pending\n",
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
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("--action bind --binding-id http:singularity-demo-article --project-code demo-article");
    expect(calls[1]).toContain("--action ensure --binding-id http:singularity-demo-article --profile canonical-v1");
    expect(calls[2]).toContain("--action write --binding-id http:singularity-demo-article --path 05_delivery/final_article.md --content final article body");

    const statusText = await readFile(join(projectDir, "status.md"), "utf8");
    expect(statusText).toContain("docs_publish_state: done");
    expect(statusText).toContain("docs_publish_requested: no");
    expect(statusText).toContain("docs_publish_path: 05_delivery/final_article.md");

    await rm(root, { recursive: true, force: true });
  });
});
