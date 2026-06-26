import type { IncomingMessage, ServerResponse } from "node:http";
import type { Update } from "telegraf/types";

import { createBot } from "../src/bot.js";

function getHeaderValue(
  headers: IncomingMessage["headers"],
  name: string,
): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

export default async function handler(
  req: IncomingMessage & { body?: unknown; method?: string },
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }

  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (expectedSecret) {
    const actualSecret = getHeaderValue(req.headers, "x-telegram-bot-api-secret-token");
    if (actualSecret !== expectedSecret) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: "Invalid webhook secret" }));
      return;
    }
  }

  const bot = createBot();

  try {
    await bot.handleUpdate((req.body ?? {}) as Update, res);
  } catch (error) {
    console.error("Telegram webhook failed:", error);
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false }));
    }
  }
}
