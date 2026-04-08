import { spawn, type ChildProcess } from "node:child_process";

type OpenclawGatewayOptions = {
  openclawGatewayUrl: string;
  onUnexpectedExit: (code: number | null, signal: NodeJS.Signals | null) => void;
};

export type OpenclawGatewayService = {
  start: () => void;
  stop: () => Promise<void>;
  isReady: () => boolean;
  isRunning: () => boolean;
};

export function createOpenclawGatewayService(options: OpenclawGatewayOptions): OpenclawGatewayService {
  let gatewayProcess: ChildProcess | null = null;
  let gatewayReady = false;

  function start(): void {
    gatewayReady = false;
    gatewayProcess = spawn("openclaw", ["gateway", "run"], {
      stdio: "inherit",
      env: process.env,
    });

    void monitorGatewayReadiness();

    gatewayProcess.on("exit", (code, signal) => {
      gatewayReady = false;
      console.error(`[openclaw] gateway exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      options.onUnexpectedExit(code, signal);
    });
  }

  async function stop(): Promise<void> {
    gatewayReady = false;

    if (!gatewayProcess || gatewayProcess.killed || gatewayProcess.exitCode !== null) {
      gatewayProcess = null;
      return;
    }

    gatewayProcess.kill("SIGTERM");
    await Promise.race([onceExit(gatewayProcess), sleep(10000)]);

    if (gatewayProcess.exitCode === null && !gatewayProcess.killed) {
      gatewayProcess.kill("SIGKILL");
      await onceExit(gatewayProcess);
    }

    gatewayProcess = null;
  }

  function isReady(): boolean {
    return gatewayReady && isRunning();
  }

  function isRunning(): boolean {
    return Boolean(gatewayProcess && gatewayProcess.exitCode === null && !gatewayProcess.killed);
  }

  async function monitorGatewayReadiness(): Promise<void> {
    const maxAttempts = 180;
    const intervalMs = 1000;
    const gatewayHealthUrl = `${options.openclawGatewayUrl.replace(/\/$/, "")}/health`;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (!gatewayProcess || gatewayProcess.exitCode !== null || gatewayProcess.killed) {
        gatewayReady = false;
        return;
      }

      if (await isHealthy(gatewayHealthUrl)) {
        gatewayReady = true;
        console.log(`[openclaw-ready] gateway ready after ${attempt}s (${gatewayHealthUrl})`);
        return;
      }

      await sleep(intervalMs);
    }

    gatewayReady = false;
    console.warn(`[openclaw-ready] gateway not ready within ${maxAttempts}s (${gatewayHealthUrl})`);
  }

  return {
    start,
    stop,
    isReady,
    isRunning,
  };
}

async function isHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

function onceExit(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null) {
      resolvePromise();
      return;
    }
    child.once("exit", () => {
      resolvePromise();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
