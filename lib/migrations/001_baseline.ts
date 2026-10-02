import type { DB } from "../repositories/shared.ts";

// The schema lib/db.ts created inline before the migration system existed.
// Safe on both new and pre-existing databases: nothing is dropped or rewritten.
const SQL = `
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
    notes TEXT,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS seen_jobs (
    job_id TEXT PRIMARY KEY,
    first_seen TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

export const migration001Baseline = {
  version: 1,
  name: "baseline",
  checksumSource: `${SQL}\nALTER batch_results ADD error TEXT (if missing)`,
  up(db: DB) {
    db.exec(SQL);

    // Databases created before the "error" column existed need it added.
    const columns = db.prepare("PRAGMA table_info(batch_results)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "error")) {
      db.exec("ALTER TABLE batch_results ADD COLUMN error TEXT");
    }
  },
};
