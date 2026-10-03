import { openDatabase, resolveDbPath } from "./database.ts";

// Opens the database (default .data/jobs.db, or JOB_AGENT_DB_PATH) and applies
// any pending schema migrations — see lib/migrate.ts and lib/migrations/.
const db = openDatabase(resolveDbPath());

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

// ── Legacy batch tables (read-only since Phase 1b Step 10) ─
// Applications, assets and events are written instead; see
// lib/pipeline/applications.ts.

// ── Batch Runs ──────────────────────────────────────────────

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

export function getBatchResults(status?: string) {
  if (status) {
    return db
      .prepare(
        `SELECT id, batch_run_id, created_at, job_title, job_company,
                job_location, job_url, job_salary_min, job_salary_max,
                job_contract_type, match_score, match_reason,
                cover_letter, cv_filename, status, reviewed_at, notes, error
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
              cover_letter, cv_filename, status, reviewed_at, notes, error
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

export default db;