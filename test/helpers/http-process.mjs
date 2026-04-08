export function randomPort() {
  return 22000 + Math.floor(Math.random() * 10000);
}

export async function waitForHttpOk(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await sleep(1000);
  }
  throw new Error(`timeout waiting for ${url}`);
}

export async function terminateProcess(child) {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  child.kill("SIGTERM");
  const exited = await Promise.race([onceExit(child), sleep(500).then(() => false)]);

  if (!exited) {
    child.kill("SIGKILL");
    await onceExit(child);
  }

  child.stdout?.destroy();
  child.stderr?.destroy();
}

export function onceExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }
    child.once("exit", () => resolve(true));
  });
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
