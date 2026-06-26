import type { IncomingMessage, ServerResponse } from "node:http";

import { config } from "../../src/config.js";
import { createBot, runScheduledTouch } from "../../src/bot.js";
import { log } from "../../src/logger.js";

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

function parseSlot(rawSlot: string | string[] | undefined): number | undefined {
  const value = Array.isArray(rawSlot) ? rawSlot[0] : rawSlot;
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return undefined;
  }

  return parsed;
}

export default async function handler(
  req: IncomingMessage & {
    method?: string;
    query?: { slot?: string | string[] };
  },
  res: ServerResponse,
): Promise<void> {
  const startedAt = Date.now();
  log.info("cron", "request_received", { method: req.method, query: req.query });

  if (req.method !== "POST") {
    log.warn("cron", "method_not_allowed", { method: req.method });
    res.statusCode = 405;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }

  const expectedSecret = process.env.SCHEDULER_SECRET?.trim();
  if (expectedSecret) {
    const actualSecret = getHeaderValue(req.headers, "x-scheduler-secret");
    if (actualSecret !== expectedSecret) {
      log.warn("cron", "invalid_secret", { hasSecretHeader: Boolean(actualSecret) });
      res.statusCode = 401;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: "Invalid scheduler secret" }));
      return;
    }
    log.debug("cron", "secret_ok");
  }

  const slot = parseSlot(req.query?.slot);
  if (slot === undefined || slot < 0 || slot >= config.touchCrons.length) {
    log.warn("cron", "invalid_slot", {
      slot,
      maxSlot: config.touchCrons.length - 1,
    });
    res.statusCode = 400;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Invalid slot" }));
    return;
  }

  log.info("cron", "slot_accepted", { slot });
  createBot();

  try {
    log.info("cron", "run_scheduled_touch_start", { slot });
    await runScheduledTouch(slot);
    log.info("cron", "run_scheduled_touch_done", {
      slot,
      durationMs: Date.now() - startedAt,
    });
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, slot }));
  } catch (error) {
    log.error("cron", "run_scheduled_touch_failed", error, {
      slot,
      durationMs: Date.now() - startedAt,
    });
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, slot }));
  }
}