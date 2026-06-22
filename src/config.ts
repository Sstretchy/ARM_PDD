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

function getCronListEnv(name: string, fallback: string[]): string[] {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const config: AppConfig = {
  botToken: getRequiredEnv("BOT_TOKEN"),
  timezone: process.env.TIMEZONE ?? "Asia/Yerevan",
  touchCrons: getCronListEnv("TOUCH_CRONS", [
    "30 9 * * *",
    "30 11 * * *",
    "30 13 * * *",
    "30 15 * * *",
    "30 17 * * *",
    "0 20 * * *",
    "0 22 * * *",
  ]),
  lessonSize: getNumberEnv("LESSON_SIZE", 3),
};
