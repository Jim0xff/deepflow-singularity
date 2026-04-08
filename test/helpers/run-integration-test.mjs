import { spawn, spawnSync } from "node:child_process";

function normalizeEnvValue(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function extractStatusJson(rawOutput) {
  const text = rawOutput.trim();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) {
      return null;
    }
    const candidate = text.slice(first, last + 1);
    return JSON.parse(candidate);
  }
}

function resolveNodeExtraCaCerts() {
  const existing = normalizeEnvValue(process.env.NODE_EXTRA_CA_CERTS);
  if (existing) {
    return existing;
  }

  const status = spawnSync("npx", ["telegram-api-mock-server", "status"], {
    encoding: "utf8",
    env: process.env,
  });

  if (status.error) {
    throw new Error(
      `Failed to run 'npx telegram-api-mock-server status': ${status.error.message}`,
    );
  }

  if (status.status !== 0) {
    throw new Error(
      [
        "Failed to resolve NODE_EXTRA_CA_CERTS from telegram-api-mock-server status.",
        `Exit code: ${status.status}`,
        `stderr: ${normalizeEnvValue(status.stderr)}`,
      ].join("\n"),
    );
  }

  const payload = extractStatusJson(String(status.stdout ?? ""));
  const caPath = normalizeEnvValue(payload?.caPath);
  if (!caPath) {
    throw new Error(
      [
        "telegram-api-mock-server status did not return caPath.",
        "Ensure telegram-api-mock-server is running in mock mode and certificates are ready.",
      ].join("\n"),
    );
  }

  return caPath;
}

function runJestWithEnv(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-vm-modules",
        "./node_modules/jest/bin/jest.js",
        "test/system-integration.test.mjs",
        "--runInBand",
        "--verbose",
      ],
      {
        stdio: "inherit",
        env,
      },
    );

    child.on("error", (error) => {
      reject(error);
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Integration test failed with code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  });
}

const nodeExtraCaCerts = resolveNodeExtraCaCerts();
const env = {
  ...process.env,
  NODE_EXTRA_CA_CERTS: nodeExtraCaCerts,
};

console.log(`[test:integration] NODE_EXTRA_CA_CERTS=${nodeExtraCaCerts}`);

await runJestWithEnv(env);
