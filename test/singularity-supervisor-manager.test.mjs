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
    const manualDir = join(root, "project-manual");
    const step7Dir = join(root, "project-step7");

    await mkdir(step5Dir, { recursive: true });
    await mkdir(manualDir, { recursive: true });
    await mkdir(step7Dir, { recursive: true });

    await writeFile(
      join(step5Dir, "status.md"),
      "workflow_mode: auto\nstatus: active\ncurrent_step: step_5_debate\nnext_actor: reviewer\n",
      "utf8",
    );
    await writeFile(
      join(manualDir, "status.md"),
      "workflow_mode: manual\nstatus: active\ncurrent_step: step_5_debate\nnext_actor: reviewer\n",
      "utf8",
    );
    await writeFile(
      join(step7Dir, "status.md"),
      "workflow_mode: auto\nstatus: active\ncurrent_step: step_7_drafting\nnext_actor: writer\n",
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
    expect(calls).toHaveLength(2);
    expect(calls.some((line) => line.includes(`--project-dir ${step5Dir}`))).toBe(true);
    expect(calls.some((line) => line.includes(`--project-dir ${step7Dir}`))).toBe(true);
    expect(calls.some((line) => line.includes(`--project-dir ${manualDir}`))).toBe(false);

    await rm(root, { recursive: true, force: true });
  });
});
