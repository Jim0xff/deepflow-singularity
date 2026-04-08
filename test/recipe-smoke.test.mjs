import { test, expect } from "@jest/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..");

test("recipe scaffold files exist", async () => {
  await access(path.join(projectRoot, "recipe.yaml"));
  await access(path.join(projectRoot, "package.json"));
  await access(path.join(projectRoot, "assets", "singularity-main", "AGENTS.md"));
  await access(path.join(projectRoot, "assets", "singularity-reviewer", "AGENTS.md"));
  await access(path.join(projectRoot, "assets", "singularity-writer", "AGENTS.md"));
  expect(true).toBe(true);
});
