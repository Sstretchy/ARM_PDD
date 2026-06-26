import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client/node";
import dotenv from "dotenv";

dotenv.config();

const args = new Set(process.argv.slice(2));
const isYes = args.has("--yes") || args.has("-y");

const tables = [
  "user_processing_locks",
  "user_flows",
  "quiz_sessions",
  "answers",
  "question_states",
  "error_reports",
  "users",
];

function resolveDatabaseUrl() {
  if (process.env.TURSO_DATABASE_URL?.trim()) {
    return process.env.TURSO_DATABASE_URL.trim();
  }

  if (process.env.DATABASE_URL?.trim()) {
    return process.env.DATABASE_URL.trim();
  }

  return `file:${path.resolve(process.cwd(), "data", "app.db")}`;
}

function maskUrl(url) {
  if (url.startsWith("file:")) {
    return url;
  }

  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}/...`;
  } catch {
    return "<remote-db>";
  }
}

async function main() {
  const databaseUrl = resolveDatabaseUrl();
  const isLocalFile = databaseUrl.startsWith("file:");

  console.log(`Target database: ${maskUrl(databaseUrl)}`);
  console.log("Tables to clear:");
  for (const table of tables) {
    console.log(`  - ${table}`);
  }

  if (!isYes) {
    console.log("\nDry run only. Re-run with --yes to actually delete all data.");
    return;
  }

  const client = createClient({
    url: databaseUrl,
    authToken: process.env.TURSO_AUTH_TOKEN?.trim() || undefined,
  });

  for (const table of tables) {
    try {
      const result = await client.execute(`DELETE FROM ${table}`);
      console.log(`Cleared ${table}: ${result.rowsAffected ?? 0} rows`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("no such table")) {
        console.log(`Skipped ${table}: table does not exist yet`);
        continue;
      }
      throw error;
    }
  }

  if (isLocalFile) {
    const filePath = databaseUrl.replace(/^file:/, "");
    try {
      await client.close();
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        console.log(`\nDeleted local database file: ${filePath}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`\nTables cleared. Could not delete file (${message}). Stop the bot and delete manually if needed.`);
    }
    console.log("Done. A new empty database will be created on next bot start.");
    return;
  }

  console.log("\nDone. Turso database is empty.");
}

main().catch((error) => {
  console.error("Failed to reset database:", error);
  process.exit(1);
});