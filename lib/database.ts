import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "./repositories/shared.ts";
import { runMigrations } from "./migrate.ts";

/** The location used before JOB_AGENT_DB_PATH existed. Still the default. */
export const DEFAULT_DB_PATH = path.join(process.cwd(), ".data", "jobs.db");

/**
 * JOB_AGENT_DB_PATH (absolute, or relative to the working directory) moves
 * the database, e.g. outside OneDrive. The existing database is never moved
 * automatically.
 */
export function resolveDbPath(
  env: Record<string, string | undefined> = process.env
): string {
  const custom = env.JOB_AGENT_DB_PATH?.trim();
  return custom ? path.resolve(custom) : DEFAULT_DB_PATH;
}

export type OpenDatabaseOptions = {
  /** Run pending migrations (default true). */
  migrate?: boolean;
  /** Where pre-migration backups go. Default: "<db dir>/backups". */
  backupDir?: string;
};

export function openDatabase(filePath: string, options: OpenDatabaseOptions = {}): DB {
  const inMemory = filePath === ":memory:";
  if (!inMemory) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const db = new Database(filePath);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  if (options.migrate ?? true) {
    runMigrations(db, {
      backupDir: inMemory
        ? undefined
        : options.backupDir ?? path.join(path.dirname(filePath), "backups"),
    });
  }
  return db;
}
