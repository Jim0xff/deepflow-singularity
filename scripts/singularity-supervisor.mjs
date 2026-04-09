#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const corePath = path.join(__dirname, "supervisor", "core.mjs");
const adapterPath = path.join(__dirname, "supervisor", "adapters", "singularity-flow.mjs");

const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [corePath, ...args, "--adapter", adapterPath], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);

