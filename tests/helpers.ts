import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DB } from "../lib/repositories/shared.ts";
import { openDatabase } from "../lib/database.ts";

export type TestDb = { db: DB; dir: string; file: string; close: () => void };

export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "job-agent-test-"));
}

/**
 * On Windows a just-closed database file can stay locked for a while (e.g. by
 * a virus scanner), making removal fail with EPERM/EBUSY. rmSync retries; if
 * the directory is still locked it is left in the OS temp directory rather
 * than failing a test whose assertions all passed.
 */
export function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EBUSY") throw error;
  }
}

function closer(dbs: () => DB[], dir: string) {
  return () => {
    for (const db of dbs()) if (db.open) db.close();
    removeTempDir(dir);
  };
}

/** A brand-new, fully migrated database in a temp directory. */
export function freshDb(): TestDb {
  const dir = makeTempDir();
  const file = path.join(dir, "jobs.db");
  const db = openDatabase(file);
  return { db, dir, file, close: closer(() => [db], dir) };
}

// The exact schema lib/db.ts created inline before Phase 1 (Phase 0 state).
const LEGACY_SCHEMA = (withErrorColumn: boolean) => `
  CREATE TABLE IF NOT EXISTS batch_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    job_count INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed'
  );
  CREATE TABLE IF NOT EXISTS batch_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_run_id INTEGER NOT NULL REFERENCES batch_runs(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    job_title TEXT NOT NULL,
    job_company TEXT NOT NULL,
    job_location TEXT,
    job_url TEXT,
    job_salary_min REAL,
    job_salary_max REAL,
    job_contract_type TEXT,
    match_score INTEGER,
    match_reason TEXT,
    cover_letter TEXT,
    cv_file BLOB,
    cv_filename TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    reviewed_at TEXT,
    notes TEXT${withErrorColumn ? ",\n    error TEXT" : ""}
  );
  CREATE TABLE IF NOT EXISTS seen_jobs (
    job_id TEXT PRIMARY KEY,
    first_seen TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

/**
 * Creates an un-migrated database exactly as the pre-Phase-1 app left it,
 * seeds it, and closes it. Returns its path.
 */
export function createLegacyDbFile(
  dir: string,
  seed: (db: DB) => void,
  options: { withErrorColumn?: boolean } = {}
): string {
  const file = path.join(dir, "jobs.db");
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(LEGACY_SCHEMA(options.withErrorColumn ?? true));
  seed(db);
  db.close();
  return file;
}

export function seedSeenJobs(db: DB, count: number): string[] {
  const insert = db.prepare("INSERT INTO seen_jobs (job_id, first_seen) VALUES (?, '2026-08-13 20:10:28')");
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = i % 2 === 0 ? `adzuna_${5800000000 + i}` : `reed_${57000000 + i}`;
    insert.run(id);
    ids.push(id);
  }
  return ids;
}

export function count(db: DB, table: string, where = "1 = 1", ...params: unknown[]): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }).n;
}

export function tableExists(db: DB, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
  );
}

/** Silences the migration runner's console output during a test. */
export function quietly<T>(fn: () => T): T {
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}
