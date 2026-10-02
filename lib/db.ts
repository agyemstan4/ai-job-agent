import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DATA_DIR = path.join(process.cwd(), ".data");
const DB_PATH = path.join(DATA_DIR, "jobs.db");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");

db.exec(`
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
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS seen_jobs (
    job_id TEXT PRIMARY KEY,
    first_seen TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── Seen Jobs ────────────────────────────────────────────────

/**
 * Filters out jobs that have already been processed in a previous run.
 * Returns only the jobs that are new.
 */
export function filterNewJobs(jobs: { id: string }[]): typeof jobs {
  const checkStmt = db.prepare("SELECT 1 FROM seen_jobs WHERE job_id = ?");

  return jobs.filter((job) => {
    const exists = checkStmt.get(job.id);
    return !exists;
  });
}

/**
 * Marks a list of job IDs as seen so they won't be processed again.
 */
export function markJobsSeen(jobIds: string[]): void {
  const insertStmt = db.prepare(
    "INSERT OR IGNORE INTO seen_jobs (job_id) VALUES (?)"
  );
  const insertMany = db.transaction((ids: string[]) => {
    for (const id of ids) {
      insertStmt.run(id);
    }
  });
  insertMany(jobIds);
}

/**
 * Optional: clear seen jobs older than N days so listings
 * can re-appear if they're still live after a while.
 */
export function clearOldSeenJobs(olderThanDays = 30): void {
  db.prepare(
    `DELETE FROM seen_jobs WHERE first_seen < datetime('now', ?)`
  ).run(`-${olderThanDays} days`);
}

// ── Batch Runs ──────────────────────────────────────────────

export function createBatchRun(jobCount: number): number {
  const result = db
    .prepare("INSERT INTO batch_runs (job_count) VALUES (?)")
    .run(jobCount);
  return result.lastInsertRowid as number;
}

export function getBatchRuns() {
  return db
    .prepare(
      `SELECT br.*, 
        COUNT(res.id) as total,
        SUM(CASE WHEN res.status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN res.status = 'approved' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN res.status = 'rejected' THEN 1 ELSE 0 END) as rejected
       FROM batch_runs br
       LEFT JOIN batch_results res ON res.batch_run_id = br.id
       GROUP BY br.id
       ORDER BY br.created_at DESC
       LIMIT 20`
    )
    .all();
}

// ── Batch Results ────────────────────────────────────────────

export function saveBatchResult(data: {
  batchRunId: number;
  job: {
    title: string;
    company: string;
    location?: string;
    url?: string;
    salaryMin?: number;
    salaryMax?: number;
    contractType?: string;
    matchScore?: number;
    reason?: string;
  };
  coverLetter?: string;
  cvBuffer?: Buffer;
  cvFilename?: string;
  success: boolean;
  error?: string;
}): number {
  const result = db
    .prepare(
      `INSERT INTO batch_results (
        batch_run_id, job_title, job_company, job_location, job_url,
        job_salary_min, job_salary_max, job_contract_type,
        match_score, match_reason, cover_letter, cv_file, cv_filename,
        status
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?
      )`
    )
    .run(
      data.batchRunId,
      data.job.title,
      data.job.company,
      data.job.location ?? null,
      data.job.url ?? null,
      data.job.salaryMin ?? null,
      data.job.salaryMax ?? null,
      data.job.contractType ?? null,
      data.job.matchScore ?? null,
      data.job.reason ?? null,
      data.coverLetter ?? null,
      data.cvBuffer ?? null,
      data.cvFilename ?? null,
      data.success ? "pending" : "failed"
    );
  return result.lastInsertRowid as number;
}

export function getBatchResults(status?: string) {
  if (status) {
    return db
      .prepare(
        `SELECT id, batch_run_id, created_at, job_title, job_company,
                job_location, job_url, job_salary_min, job_salary_max,
                job_contract_type, match_score, match_reason,
                cover_letter, cv_filename, status, reviewed_at, notes
         FROM batch_results
         WHERE status = ?
         ORDER BY created_at DESC`
      )
      .all(status);
  }
  return db
    .prepare(
      `SELECT id, batch_run_id, created_at, job_title, job_company,
              job_location, job_url, job_salary_min, job_salary_max,
              job_contract_type, match_score, match_reason,
              cover_letter, cv_filename, status, reviewed_at, notes
       FROM batch_results
       ORDER BY created_at DESC`
    )
    .all();
}

export function getResultById(id: number) {
  return db
    .prepare("SELECT * FROM batch_results WHERE id = ?")
    .get(id) as any;
}

export function updateResultStatus(
  id: number,
  status: "approved" | "rejected",
  notes?: string
) {
  db.prepare(
    `UPDATE batch_results 
     SET status = ?, reviewed_at = datetime('now'), notes = ?
     WHERE id = ?`
  ).run(status, notes ?? null, id);
}

export function updateCoverLetter(id: number, coverLetter: string) {
  db.prepare(
    "UPDATE batch_results SET cover_letter = ? WHERE id = ?"
  ).run(coverLetter, id);
}

export default db;