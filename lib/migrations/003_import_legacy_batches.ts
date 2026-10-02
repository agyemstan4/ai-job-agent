import type { DB } from "../repositories/shared.ts";
import {
  assetSetHash,
  fingerprintV1,
  FINGERPRINT_VERSION,
  mimeTypeForFilename,
  sha256,
} from "../repositories/shared.ts";

// Copies legacy batch_runs / batch_results into the new model.
//
// - Read-only towards the legacy tables: nothing in batch_runs, batch_results
//   or seen_jobs is modified or deleted.
// - Idempotent: rows already imported (tracked by pipeline_runs.legacy_batch_run_id
//   and applications.legacy_batch_result_id) are skipped, so it is safe to run
//   any number of times.
// - Self-contained SQL (it must not depend on repository code that may evolve
//   with later schema versions). Only frozen helpers from shared.ts are used.

const REVISION = "003_import_legacy_batches r1";

type LegacyRun = { id: number; created_at: string; job_count: number; status: string };

type LegacyResult = {
  id: number;
  batch_run_id: number;
  created_at: string;
  job_title: string;
  job_company: string;
  job_location: string | null;
  job_url: string | null;
  job_salary_min: number | null;
  job_salary_max: number | null;
  job_contract_type: string | null;
  match_score: number | null;
  match_reason: string | null;
  cover_letter: string | null;
  cv_file: Buffer | null;
  cv_filename: string | null;
  status: string;
  reviewed_at: string | null;
  notes: string | null;
  error: string | null;
};

const STATUS_MAP: Record<string, "ready_for_review" | "approved" | "rejected" | "preparation_failed"> = {
  pending: "ready_for_review",
  approved: "approved",
  rejected: "rejected",
  failed: "preparation_failed",
};

export type LegacyImportResult = { runsImported: number; resultsImported: number };

export function importLegacyBatches(db: DB): LegacyImportResult {
  return db.transaction((): LegacyImportResult => {
    // ── Runs ──
    const legacyRuns = db
      .prepare(
        `SELECT id, created_at, job_count, status FROM batch_runs
         WHERE id NOT IN (SELECT legacy_batch_run_id FROM pipeline_runs
                          WHERE legacy_batch_run_id IS NOT NULL)
         ORDER BY id`
      )
      .all() as LegacyRun[];

    const insertRun = db.prepare(
      `INSERT INTO pipeline_runs
         (kind, triggered_by, status, stats_json, legacy_batch_run_id, started_at, finished_at)
       VALUES ('legacy_batch', 'migration', 'completed', ?, ?, ?, ?)`
    );
    for (const run of legacyRuns) {
      insertRun.run(
        JSON.stringify({ jobCount: run.job_count, legacyStatus: run.status }),
        run.id,
        run.created_at,
        run.created_at
      );
    }

    const runIdFor = db.prepare(
      "SELECT id FROM pipeline_runs WHERE legacy_batch_run_id = ?"
    );

    // ── Results ──
    const legacyResults = db
      .prepare(
        `SELECT * FROM batch_results
         WHERE id NOT IN (SELECT legacy_batch_result_id FROM applications
                          WHERE legacy_batch_result_id IS NOT NULL)
         ORDER BY id`
      )
      .all() as LegacyResult[];

    const insertJob = db.prepare(
      `INSERT OR IGNORE INTO jobs
         (fingerprint, fingerprint_version, title, company, location, salary_min, salary_max,
          contract_type, first_seen_at, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const jobIdFor = db.prepare("SELECT id FROM jobs WHERE fingerprint = ?");
    const insertListing = db.prepare(
      `INSERT OR IGNORE INTO job_listings
         (job_id, source_id, external_id, url, title, company, location, salary_min, salary_max,
          first_seen_run_id, last_seen_run_id, first_seen_at, last_seen_at)
       VALUES (?, 'legacy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertMatch = db.prepare(
      `INSERT INTO matches
         (job_id, candidate_profile_id, run_id, outcome, score, score_source, reason, created_at, updated_at)
       VALUES (?, NULL, ?, 'legacy', ?, ?, ?, ?, ?)`
    );
    const insertApplication = db.prepare(
      `INSERT INTO applications
         (job_id, match_id, run_id, status, approved_at, approved_assets_sha256,
          notes, last_error, legacy_batch_result_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertAsset = db.prepare(
      `INSERT INTO application_assets
         (application_id, kind, version, is_current, origin, content_text, file_blob,
          filename, mime_type, sha256, created_at)
       VALUES (?, ?, 1, 1, 'legacy_import', ?, ?, ?, ?, ?, ?)`
    );
    const insertEvent = db.prepare(
      `INSERT INTO application_events
         (application_id, event_type, from_status, to_status, actor, detail, payload_json, created_at)
       VALUES (?, ?, ?, ?, 'migration', ?, ?, ?)`
    );

    for (const result of legacyResults) {
      const externalId = `batch_result:${result.id}`;
      const runId = (runIdFor.get(result.batch_run_id) as { id: number } | undefined)?.id ?? null;

      // Job (merged by fingerprint with any job already known)
      const fingerprint = fingerprintV1({
        title: result.job_title,
        company: result.job_company,
        sourceId: "legacy",
        externalId,
      });
      insertJob.run(
        fingerprint,
        FINGERPRINT_VERSION,
        result.job_title,
        result.job_company,
        result.job_location,
        result.job_salary_min,
        result.job_salary_max,
        result.job_contract_type,
        result.created_at,
        result.created_at,
        result.created_at
      );
      const jobId = (jobIdFor.get(fingerprint) as { id: number }).id;

      insertListing.run(
        jobId,
        externalId,
        result.job_url,
        result.job_title,
        result.job_company,
        result.job_location,
        result.job_salary_min,
        result.job_salary_max,
        runId,
        runId,
        result.created_at,
        result.created_at
      );

      // Match (legacy: no profile version was recorded at the time)
      const score =
        typeof result.match_score === "number" && Number.isFinite(result.match_score)
          ? Math.round(Math.min(100, Math.max(0, result.match_score)))
          : null;
      const matchId = Number(
        insertMatch.run(
          jobId,
          runId,
          score,
          score === null ? null : "legacy",
          result.match_reason,
          result.created_at,
          result.created_at
        ).lastInsertRowid
      );

      // Assets (hashed first so an imported approval snapshots exactly them)
      const assets: {
        kind: "cover_letter" | "tailored_cv_file";
        text: string | null;
        blob: Buffer | null;
        filename: string | null;
        mimeType: string | null;
        sha256: string;
      }[] = [];
      if (result.cover_letter) {
        assets.push({
          kind: "cover_letter",
          text: result.cover_letter,
          blob: null,
          filename: null,
          mimeType: "text/plain",
          sha256: sha256(result.cover_letter),
        });
      }
      if (result.cv_file) {
        assets.push({
          kind: "tailored_cv_file",
          text: null,
          blob: result.cv_file,
          filename: result.cv_filename,
          mimeType: mimeTypeForFilename(result.cv_filename),
          sha256: sha256(result.cv_file),
        });
      }

      const legacyStatus = result.status;
      const status = STATUS_MAP[legacyStatus] ?? "ready_for_review";
      const reviewedAt = result.reviewed_at ?? null;
      const approvedAt = status === "approved" ? reviewedAt ?? result.created_at : null;
      const approvedHash =
        status === "approved"
          ? assetSetHash(assets.map((a) => ({ kind: a.kind, version: 1, sha256: a.sha256 })))
          : null;

      const applicationId = Number(
        insertApplication.run(
          jobId,
          matchId,
          runId,
          status,
          approvedAt,
          approvedHash,
          result.notes,
          result.error,
          result.id,
          result.created_at,
          reviewedAt ?? result.created_at
        ).lastInsertRowid
      );

      for (const asset of assets) {
        insertAsset.run(
          applicationId,
          asset.kind,
          asset.text,
          asset.blob,
          asset.filename,
          asset.mimeType,
          asset.sha256,
          result.created_at
        );
      }

      insertEvent.run(
        applicationId,
        "migrated",
        null,
        status,
        "Imported from legacy batch_results",
        JSON.stringify({
          legacyBatchResultId: result.id,
          legacyBatchRunId: result.batch_run_id,
          legacyStatus,
        }),
        result.created_at
      );
      if (status === "approved" || status === "rejected") {
        insertEvent.run(
          applicationId,
          "status_change",
          "ready_for_review",
          status,
          "Review decision imported from legacy batch_results",
          null,
          reviewedAt ?? result.created_at
        );
      }
    }

    return { runsImported: legacyRuns.length, resultsImported: legacyResults.length };
  })();
}

export const migration003ImportLegacyBatches = {
  version: 3,
  name: "import_legacy_batches",
  checksumSource: REVISION,
  up(db: DB) {
    importLegacyBatches(db);
  },
};
