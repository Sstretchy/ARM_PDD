import "dotenv/config";

import type { AppConfig } from "./types.js";

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number`);
  }

  return parsed;
}

export const config: AppConfig = {
  botToken: getRequiredEnv("BOT_TOKEN"),
  timezone: process.env.TIMEZONE ?? "Asia/Yerevan",
  morningCron: process.env.MORNING_CRON ?? "0 10 * * *",
  dayCron: process.env.DAY_CRON ?? "0 15 * * *",
  eveningCron: process.env.EVENING_CRON ?? "0 21 * * *",
  lessonSize: getNumberEnv("LESSON_SIZE", 3),
};
