type DeploymentNotifyOptions = {
  token: string;
  chatId: string;
  healthUrl: string;
  intervalMs: number;
  maxAttempts: number;
  text: string;
};

export async function runDeploymentNotify(options: DeploymentNotifyOptions): Promise<void> {
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    if (await isHealthy(options.healthUrl)) {
      const sent = await sendTelegramMessage(options.token, options.chatId, options.text);
      if (sent) {
        console.log("[deployment-notify] notification sent");
      } else {
        console.error("[deployment-notify] notification failed");
      }
      return;
    }

    await sleep(options.intervalMs);
  }

  console.error(`[deployment-notify] health check timed out: ${options.healthUrl}`);
}

async function isHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!response.ok) {
      return false;
    }
    const json = (await response.json()) as { ok?: boolean };
    return json.ok === true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
