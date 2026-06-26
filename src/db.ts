import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { createClient } from "@libsql/client/node";

function resolveDatabaseUrl(): string {
  if (process.env.TURSO_DATABASE_URL?.trim()) {
    return process.env.TURSO_DATABASE_URL.trim();
  }

  if (process.env.DATABASE_URL?.trim()) {
    return process.env.DATABASE_URL.trim();
  }

  const localDbPath = path.resolve(process.cwd(), "data", "app.db");
  const localDbDir = path.dirname(localDbPath);
  if (!existsSync(localDbDir)) {
    mkdirSync(localDbDir, { recursive: true });
  }

  return `file:${localDbPath}`;
}

export const db = createClient({
  url: resolveDatabaseUrl(),
  authToken: process.env.TURSO_AUTH_TOKEN?.trim() || undefined,
});
