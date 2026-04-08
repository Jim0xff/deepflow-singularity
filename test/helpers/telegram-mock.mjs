import { includesIgnoreCase } from "./assertions.mjs";
import { sleep } from "./http-process.mjs";

export async function sendTelegramCommand({ adminClient, botToken, chatId, userId, text, expectedContains }) {
  const injectedMessageId = Date.now();
  console.log(`[telegram-it] send -> chat=${chatId} user=${userId} messageId=${injectedMessageId} text=${text}`);

  const before = await adminClient.listOutbound(botToken);
  const beforeCursor = before.events.length;

  await adminClient.injectUpdate({
    token: botToken,
    update: {
      message: {
        message_id: injectedMessageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: "supergroup", title: "deepflow-integration" },
        from: { id: userId, is_bot: false, first_name: "IntegrationUser" },
        text,
      },
    },
  });

  const reply = await waitForFinalReplyText({
    adminClient,
    botToken,
    chatId,
    afterCursor: beforeCursor,
    timeoutMs: 60000,
    settleMs: 5000,
    expectedContains,
  });

  console.log(`[telegram-it] reply <- chat=${chatId} messageId=${reply.messageId ?? "unknown"} text=${reply.text}`);

  return reply.text;
}

export async function waitForFinalReplyText({
  adminClient,
  botToken,
  chatId,
  afterCursor,
  timeoutMs,
  settleMs,
  expectedContains,
}) {
  const start = Date.now();
  let lastSeenCount = 0;
  let lastChangeAt = 0;
  let lastText = "";
  let lastMessageId = null;
  let lastSeenMessageIds = [];

  while (Date.now() - start < timeoutMs) {
    const response = await adminClient.listOutbound(botToken);
    const events = response.events
      .slice(afterCursor)
      .filter((event) => String(event.payload.chat_id) === String(chatId))
      .filter((event) => event.method === "sendMessage" || event.method === "editMessageText");

    if (events.length > 0) {
      if (events.length !== lastSeenCount) {
        lastSeenCount = events.length;
        lastChangeAt = Date.now();
        lastSeenMessageIds = events
          .map((event) => Number.parseInt(String(event.payload.message_id), 10))
          .filter((id) => Number.isFinite(id));

        if (process.env.TELEGRAM_IT_DEBUG_IDS === "1") {
          for (const event of events) {
            const messageId = Number.parseInt(String(event.payload.message_id), 10);
            const replyTo = Number.parseInt(String(event.payload.reply_to_message_id), 10);
            const eventText = typeof event.payload.text === "string" ? event.payload.text : "";
            console.log(
              `[telegram-it] outbound candidate -> method=${event.method} messageId=${Number.isFinite(messageId) ? messageId : "unknown"} replyTo=${Number.isFinite(replyTo) ? replyTo : "none"} text=${eventText}`,
            );
          }
        }

        const textEvents = events.filter((event) => typeof event.payload.text === "string");
        if (textEvents.length > 0) {
          const latestEvent = textEvents[textEvents.length - 1];
          const latestText = latestEvent.payload.text;
          const parsedMessageId = Number.parseInt(String(latestEvent.payload.message_id), 10);
          if (Number.isFinite(parsedMessageId)) {
            lastMessageId = parsedMessageId;
          }
          if (typeof latestText === "string") {
            lastText = latestText;
          }
        }
      }

      if (lastText && Date.now() - lastChangeAt >= settleMs) {
        if (replyMatchesExpected(lastText, expectedContains)) {
          return {
            text: lastText,
            messageId: lastMessageId,
          };
        }
      }

      if (lastText && !expectedContains && Date.now() - lastChangeAt >= settleMs) {
        return {
          text: lastText,
          messageId: lastMessageId,
        };
      }
    }
    await sleep(300);
  }

  throw new Error(
    `timeout waiting for final outbound reply text for chat ${chatId}; lastMessageId=${lastMessageId ?? "unknown"}; lastSeenMessageIds=${JSON.stringify(lastSeenMessageIds)}; lastText=${JSON.stringify(lastText)}`,
  );
}

export function replyMatchesExpected(text, expectedContains) {
  if (!expectedContains) {
    return true;
  }
  if (Array.isArray(expectedContains)) {
    return expectedContains.some((fragment) => includesIgnoreCase(text, fragment));
  }
  return includesIgnoreCase(text, expectedContains);
}

export function withMention(mention, text) {
  return `${mention} ${text}`;
}

export async function resolveBotUsername(botToken) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      [
        "Failed to resolve bot username via Telegram getMe.",
        "Ensure telegram-api-mock-server is running and NODE_EXTRA_CA_CERTS is set correctly.",
        `Status: ${response.status}`,
        `Response: ${body}`,
      ].join("\n"),
    );
  }

  const payload = await response.json();
  const username = payload?.result?.username;
  if (typeof username !== "string" || username.trim().length === 0) {
    throw new Error("Telegram getMe returned no username for target bot token.");
  }

  return username.trim();
}

export async function waitForSendMessageContaining({
  adminClient,
  botToken,
  chatId,
  expectedTextFragment,
  timeoutMs,
}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const response = await adminClient.listOutbound(botToken);
    const matched = response.events.find((event) => {
      if (event.method !== "sendMessage") {
        return false;
      }
      if (String(event.payload.chat_id) !== String(chatId)) {
        return false;
      }
      const text = typeof event.payload.text === "string" ? event.payload.text : "";
      return text.includes(expectedTextFragment);
    });

    if (matched) {
      return typeof matched.payload.text === "string" ? matched.payload.text : "";
    }

    await sleep(1000);
  }

  throw new Error(
    `timeout waiting for deployment notify message containing '${expectedTextFragment}' for chat ${chatId}`,
  );
}

export async function ensureTelegramMockAvailable({ adminClient, adminBaseUrl }) {
  try {
    const health = await adminClient.health();
    if (!health?.ok) {
      throw new Error("health check returned a non-ok response");
    }
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        `telegram-api-mock-server is not reachable at ${adminBaseUrl}.`,
        "Start telegram-api-mock-server before running npm run test:integration.",
        "Example:",
        "npx telegram-api-mock-server start --mode mock --intercept-mode nftables --admin-host 127.0.0.1 --admin-port 19091 --admin-token change-me --cert-dir /tmp/tg-mock-certs",
        `Original error: ${details}`,
      ].join("\n"),
    );
  }
}
