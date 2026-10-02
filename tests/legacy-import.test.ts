import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../lib/database.ts";
import { importLegacyBatches } from "../lib/migrations/003_import_legacy_batches.ts";
import type { DB } from "../lib/repositories/shared.ts";
import {
  approveApplication,
  beginSubmission,
  getActiveApplicationForJob,
  getAssetFile,
  getCurrentAssets,
  getCurrentAssetsHash,
  listApplicationEvents,
  transitionApplication,
} from "../lib/repositories/applications.ts";
import { count, createLegacyDbFile, makeTempDir, quietly, removeTempDir, seedSeenJobs } from "./helpers.ts";

const PDF = Buffer.from("%PDF-1.4 synthetic tailored cv");
const DOCX = Buffer.from("PK synthetic docx tailored cv");

type AppRow = {
  id: number;
  job_id: number;
  match_id: number;
  run_id: number | null;
  status: string;
  approved_at: string | null;
  approved_assets_sha256: string | null;
  notes: string | null;
  last_error: string | null;
  legacy_batch_result_id: number;
  created_at: string;
  updated_at: string;
};

function appFor(db: DB, legacyId: number): AppRow {
  return db
    .prepare("SELECT * FROM applications WHERE legacy_batch_result_id = ?")
    .get(legacyId) as AppRow;
}

function seedLegacyBatches(db: DB) {
  seedSeenJobs(db, 167);
  db.prepare("INSERT INTO batch_runs (id, created_at, job_count) VALUES (1, '2026-08-10 10:00:00', 3)").run();
  db.prepare("INSERT INTO batch_runs (id, created_at, job_count) VALUES (2, '2026-08-11 10:00:00', 3)").run();
  const insert = db.prepare(
    `INSERT INTO batch_results
       (id, batch_run_id, created_at, job_title, job_company, job_location, job_url,
        job_salary_min, job_salary_max, job_contract_type, match_score, match_reason,
        cover_letter, cv_file, cv_filename, status, reviewed_at, notes, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // 1: pending, PDF + cover letter
  insert.run(1, 1, "2026-08-10 10:01:00", "Junior Android Developer", "QuokkaPay Ltd", "London",
    "https://example.com/1", 30000, 35000, "permanent", 79, "Kotlin match",
    "Dear QuokkaPay…", PDF, "Me_QuokkaPay_CV.pdf", "pending", null, null, null);
  // 2: approved, DOCX fallback, notes
  insert.run(2, 1, "2026-08-10 10:02:00", "Graduate Software Engineer", "Leadwell", "London",
    "https://example.com/2", null, null, null, 72, "Java match",
    "Dear Leadwell…", DOCX, "Me_Leadwell_CV.docx", "approved", "2026-08-10 12:00:00", "Applied manually", null);
  // 3: rejected
  insert.run(3, 1, "2026-08-10 10:03:00", "Frontend Developer", "WebCo", null, null, null, null, null,
    55, "JS", "Dear WebCo…", null, null, "rejected", "2026-08-10 12:05:00", "Not for me", null);
  // 4: failed, with error, no assets
  insert.run(4, 2, "2026-08-11 10:01:00", "Java Developer", "BigCorp", null, null, null, null, null,
    null, null, null, null, null, "failed", null, null, "Tailoring failed.");
  // 5: same vacancy as #1 from a later batch (different formatting), pending
  insert.run(5, 2, "2026-08-11 10:02:00", "Junior Android Developer (Hybrid)", "QuokkaPay Limited", "London",
    "https://example.com/1b", null, null, null, 81, "Kotlin match again",
    "Dear QuokkaPay v2…", null, null, "pending", null, null, null);
  // 6: an unexpected legacy status, out-of-range score
  insert.run(6, 2, "2026-08-11 10:03:00", "Android Engineer", "Unknown", null, null, null, null, null,
    140, null, "Hello", null, null, "on_hold", null, null, null);
}

describe("003 legacy batch import", () => {
  let dir: string;
  let db: DB;

  before(() => {
    dir = makeTempDir();
    const file = createLegacyDbFile(dir, seedLegacyBatches);
    db = quietly(() => openDatabase(file)); // runs 001–003
  });

  after(() => {
    db.close();
    removeTempDir(dir);
  });

  test("leaves every legacy table and row untouched", () => {
    assert.equal(count(db, "seen_jobs"), 167);
    assert.equal(count(db, "batch_runs"), 2);
    assert.equal(count(db, "batch_results"), 6);
    const r2 = db.prepare("SELECT status, cv_filename, notes FROM batch_results WHERE id = 2").get();
    assert.deepEqual(r2, { status: "approved", cv_filename: "Me_Leadwell_CV.docx", notes: "Applied manually" });
  });

  test("imports runs and every result", () => {
    assert.equal(count(db, "pipeline_runs", "kind = 'legacy_batch'"), 2);
    assert.equal(count(db, "applications", "legacy_batch_result_id IS NOT NULL"), 6);
    assert.equal(count(db, "matches", "outcome = 'legacy'"), 6);
    assert.equal(count(db, "job_listings", "source_id = 'legacy'"), 6);
  });

  test("maps legacy statuses", () => {
    assert.equal(appFor(db, 1).status, "ready_for_review");
    assert.equal(appFor(db, 2).status, "approved");
    assert.equal(appFor(db, 3).status, "rejected");
    assert.equal(appFor(db, 4).status, "preparation_failed");
    assert.equal(appFor(db, 5).status, "ready_for_review");
    assert.equal(appFor(db, 6).status, "ready_for_review"); // unknown → review, original kept in event
  });

  test("preserves notes, errors, review time and links runs", () => {
    const approved = appFor(db, 2);
    assert.equal(approved.notes, "Applied manually");
    assert.equal(approved.approved_at, "2026-08-10 12:00:00");
    assert.equal(approved.updated_at, "2026-08-10 12:00:00");
    assert.equal(appFor(db, 4).last_error, "Tailoring failed.");
    const run2 = db.prepare("SELECT id FROM pipeline_runs WHERE legacy_batch_run_id = 2").get() as { id: number };
    assert.equal(appFor(db, 4).run_id, run2.id);
  });

  test("imports cover letters and CV files with the right type", () => {
    const pending = getCurrentAssets(db, appFor(db, 1).id);
    assert.deepEqual(pending.map((a) => a.kind).sort(), ["cover_letter", "tailored_cv_file"]);
    const pdf = pending.find((a) => a.kind === "tailored_cv_file")!;
    assert.equal(pdf.mimeType, "application/pdf");
    assert.deepEqual(getAssetFile(db, pdf.id), PDF);

    const docx = getCurrentAssets(db, appFor(db, 2).id).find((a) => a.kind === "tailored_cv_file")!;
    assert.equal(docx.filename, "Me_Leadwell_CV.docx");
    assert.match(docx.mimeType!, /wordprocessingml/);
    assert.deepEqual(getAssetFile(db, docx.id), DOCX);

    assert.equal(getCurrentAssets(db, appFor(db, 4).id).length, 0);
  });

  test("an imported approval snapshots exactly the imported content", () => {
    const approved = appFor(db, 2);
    assert.equal(approved.approved_assets_sha256, getCurrentAssetsHash(db, approved.id));
  });

  test("merges the same vacancy from two batches into one job, keeping both applications", () => {
    assert.equal(appFor(db, 1).job_id, appFor(db, 5).job_id);
    assert.equal(count(db, "job_listings", "job_id = ?", appFor(db, 1).job_id), 2);
    // Unknown company is never merged.
    assert.notEqual(appFor(db, 6).job_id, appFor(db, 1).job_id);
  });

  test("clamps out-of-range scores and keeps the original status in the event", () => {
    const match = db.prepare("SELECT score FROM matches WHERE id = ?").get(appFor(db, 6).match_id);
    assert.deepEqual(match, { score: 100 });
    const events = listApplicationEvents(db, appFor(db, 6).id);
    assert.equal(events[0].eventType, "migrated");
    assert.deepEqual(events[0].payload, { legacyBatchResultId: 6, legacyBatchRunId: 2, legacyStatus: "on_hold" });
  });

  test("records the old review decision as a migration event", () => {
    const events = listApplicationEvents(db, appFor(db, 3).id);
    assert.deepEqual(
      events.map((e) => [e.eventType, e.toStatus, e.actor, e.createdAt]),
      [
        ["migrated", "rejected", "migration", "2026-08-10 10:03:00"],
        ["status_change", "rejected", "migration", "2026-08-10 12:05:00"],
      ]
    );
  });

  test("is idempotent: re-running imports nothing and duplicates nothing", () => {
    const before = ["pipeline_runs", "jobs", "job_listings", "matches", "applications", "application_assets", "application_events"]
      .map((table) => count(db, table));
    assert.deepEqual(importLegacyBatches(db), { runsImported: 0, resultsImported: 0 });
    assert.deepEqual(importLegacyBatches(db), { runsImported: 0, resultsImported: 0 });
    const after = ["pipeline_runs", "jobs", "job_listings", "matches", "applications", "application_assets", "application_events"]
      .map((table) => count(db, table));
    assert.deepEqual(after, before);
  });

  test("imports legacy rows added later (incremental)", () => {
    db.prepare(
      "INSERT INTO batch_results (id, batch_run_id, job_title, job_company, status) VALUES (7, 2, 'QA Engineer', 'TestCo', 'pending')"
    ).run();
    assert.deepEqual(importLegacyBatches(db), { runsImported: 0, resultsImported: 1 });
    assert.equal(appFor(db, 7).status, "ready_for_review");
    assert.equal(count(db, "batch_results"), 7);
  });

  test("legacy rows still count as the job's active application", () => {
    assert.equal(getActiveApplicationForJob(db, appFor(db, 1).job_id)?.legacyBatchResultId, 5);
  });

  test("a legacy approval cannot be submitted until the user re-approves", () => {
    const id = appFor(db, 2).id;
    assert.throws(() => beginSubmission(db, id, { method: "manual" }), { code: "APPROVAL_REQUIRED" });
    assert.throws(
      () => db.prepare("UPDATE applications SET status = 'submitting' WHERE id = ?").run(id),
      /APPROVAL_GATE|SUBMISSION_GATE|AUDIT/
    );

    transitionApplication(db, id, "ready_for_review", { actor: "user", detail: "Re-review" });
    approveApplication(db, id, { reviewedAssetsSha256: getCurrentAssetsHash(db, id) });
    assert.equal(beginSubmission(db, id, { method: "manual" }).status, "submitting");
  });
});
