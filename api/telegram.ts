import type { IncomingMessage, ServerResponse } from "node:http";
import type { Update } from "telegraf/types";

import { createBot } from "../src/bot.js";
import { log } from "../src/logger.js";

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

function describeUpdate(update: Update): Record<string, unknown> {
  const base: Record<string, unknown> = {
    updateId: update.update_id,
  };

  if ("callback_query" in update && update.callback_query) {
    const callbackQuery = update.callback_query;
    base.updateType = "callback_query";
    base.fromId = callbackQuery.from.id;
    base.callbackData = "data" in callbackQuery ? callbackQuery.data : undefined;
    base.messageId = callbackQuery.message?.message_id;
    base.chatId = callbackQuery.message?.chat.id;
    return base;
  }

  if ("message" in update && update.message) {
    base.updateType = "message";
    base.fromId = update.message.from?.id;
    base.chatId = update.message.chat.id;
    base.text = "text" in update.message ? update.message.text?.slice(0, 120) : undefined;
    return base;
  }

  base.updateType = Object.keys(update).find((key) => key !== "update_id") ?? "unknown";
  return base;
}

export default async function handler(
  req: IncomingMessage & { body?: unknown; method?: string },
  res: ServerResponse,
): Promise<void> {
  const startedAt = Date.now();
  log.info("webhook", "request_received", { method: req.method });

  if (req.method !== "POST") {
    log.warn("webhook", "method_not_allowed", { method: req.method });
    res.statusCode = 405;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }

  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (expectedSecret) {
    const actualSecret = getHeaderValue(req.headers, "x-telegram-bot-api-secret-token");
    if (actualSecret !== expectedSecret) {
      log.warn("webhook", "invalid_secret", {
        hasSecretHeader: Boolean(actualSecret),
      });
      res.statusCode = 401;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: "Invalid webhook secret" }));
      return;
    }
    log.debug("webhook", "secret_ok");
  } else {
    log.debug("webhook", "secret_not_configured");
  }

  const update = (req.body ?? {}) as Update;
  log.info("webhook", "update_received", describeUpdate(update));

  log.debug("webhook", "create_bot_start");
  const bot = createBot();
  log.debug("webhook", "create_bot_done");

  try {
    log.info("webhook", "handle_update_start", { updateId: update.update_id });
    await bot.handleUpdate(update, res);
    log.info("webhook", "handle_update_done", {
      updateId: update.update_id,
      durationMs: Date.now() - startedAt,
      responseEnded: res.writableEnded,
    });
  } catch (error) {
    log.error("webhook", "handle_update_failed", error, {
      updateId: update.update_id,
      durationMs: Date.now() - startedAt,
      responseEnded: res.writableEnded,
    });
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false }));
    }
  }
}