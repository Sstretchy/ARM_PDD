import type { IncomingMessage, ServerResponse } from "node:http";

import { config } from "../../src/config.js";
import { createBot, runScheduledTouch } from "../../src/bot.js";

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
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }

  const expectedSecret = process.env.SCHEDULER_SECRET?.trim();
  if (expectedSecret) {
    const actualSecret = getHeaderValue(req.headers, "x-scheduler-secret");
    if (actualSecret !== expectedSecret) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: "Invalid scheduler secret" }));
      return;
    }
  }

  const slot = parseSlot(req.query?.slot);
  if (slot === undefined || slot < 0 || slot >= config.touchCrons.length) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Invalid slot" }));
    return;
  }

  createBot();

  try {
    await runScheduledTouch(slot);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, slot }));
  } catch (error) {
    console.error(`Scheduled touch failed for slot ${slot}:`, error);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, slot }));
  }
}
