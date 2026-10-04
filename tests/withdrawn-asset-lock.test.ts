import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { DB } from "../lib/repositories/shared.ts";
import { createLegacyDbFile, makeTempDir, quietly, removeTempDir } from "./helpers.ts";
import { MIGRATIONS, runMigrations } from "../lib/migrate.ts";
import { openDatabase } from "../lib/database.ts";
import { recordJobListing } from "../lib/repositories/jobs.ts";
import type { Application } from "../lib/repositories/applications.ts";
import {
  addApplicationAsset,
  approveApplication,
  beginSubmission,
  createApplication,
  getApplication,
  getCurrentAssetsHash,
  recordManualSubmission,
  recordSubmissionResult,
  transitionApplication,
  updateSubmittedStatus,
} from "../lib/repositories/applications.ts";

// Migration 006: assets of an application withdrawn AFTER submission stay
// locked in the database (002 locks by status and does not include
// withdrawn). Raw SQL is used throughout so the database triggers are tested
// directly, not the repository guard in front of them.

const BY_006 = /ASSETS_LOCKED: application content cannot change after the application has been submitted/;
const BY_002 = /ASSETS_LOCKED: application content cannot change after submission has started/;

// Databases opened by a test, closed afterwards.
let opened: DB[] = [];
afterEach(() => {
  for (const db of opened) if (db.open) db.close();
  opened = [];
});

/** An in-memory database with the given migrations (all of them by default). */
function database(migrations = MIGRATIONS): DB {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  quietly(() => runMigrations(db, { migrations }));
  opened.push(db);
  return db;
}

let jobCounter = 0;
function readyApplication(db: DB): Application {
  jobCounter++;
  const job = recordJobListing(db, { sourceId: "reed", externalId: `w${jobCounter}`, title: `Dev ${jobCounter}`, company: "Acme" });
  const app = createApplication(db, { jobId: job.jobId });
  addApplicationAsset(db, { applicationId: app.id, kind: "cover_letter", origin: "generated", contentText: "Dear Acme" });
  addApplicationAsset(db, {
    applicationId: app.id, kind: "tailored_cv_file", origin: "generated",
    file: Buffer.from("%PDF"), filename: "cv.pdf", mimeType: "application/pdf",
  });
  return transitionApplication(db, app.id, "ready_for_review", { actor: "system" });
}

const approve = (db: DB, id: number) =>
  approveApplication(db, id, { reviewedAssetsSha256: getCurrentAssetsHash(db, id) });

function submitted(db: DB): Application {
  const app = approve(db, readyApplication(db).id);
  return recordManualSubmission(db, app.id, { reviewedAssetsSha256: app.approvedAssetsSha256! });
}

/** An application in a post-submission state, reached the legitimate way. */
function inState(db: DB, state: "submitted" | "acknowledged" | "interviewing" | "offer" | "unsuccessful" | "withdrawn"): Application {
  const app = submitted(db);
  const path: Record<typeof state, ("acknowledged" | "interviewing" | "offer" | "unsuccessful" | "withdrawn")[]> = {
    submitted: [],
    acknowledged: ["acknowledged"],
    interviewing: ["acknowledged", "interviewing"],
    offer: ["acknowledged", "interviewing", "offer"],
    unsuccessful: ["unsuccessful"],
    withdrawn: ["acknowledged", "withdrawn"],
  };
  for (const to of path[state]) updateSubmittedStatus(db, app.id, { to, note: to === "withdrawn" ? "Withdrawn" : null });
  return getApplication(db, app.id)!;
}

/**
 * A raw new content version, inserted as not current so that only the lock
 * triggers (not the one-current-version index) can refuse it. Not
 * legacy_import, which 004 refuses on normal applications anyway.
 */
const rawInsert = (db: DB, id: number) => () =>
  db.prepare(
    `INSERT INTO application_assets (application_id, kind, version, is_current, origin, content_text, sha256)
     VALUES (?, 'cover_letter', (SELECT COALESCE(MAX(version), 0) + 1 FROM application_assets WHERE application_id = ? AND kind = 'cover_letter'), 0, 'user_edit', 'raw edit', 'x')`
  ).run(id, id);

/** A raw change of which version is current. */
const rawFlip = (db: DB, id: number) => () =>
  db.prepare("UPDATE application_assets SET is_current = 0 WHERE application_id = ? AND kind = 'cover_letter' AND is_current = 1").run(id);

const assetRows = (db: DB, id: number) =>
  JSON.stringify(db.prepare("SELECT id, version, is_current, sha256 FROM application_assets WHERE application_id = ? ORDER BY id").all(id));

const outcome = (fn: () => unknown): string => {
  try {
    fn();
    return "allowed";
  } catch (error) {
    return (error as Error).message;
  }
};

describe("006 — assets stay locked after submission, in every later status", () => {
  for (const state of ["submitted", "acknowledged", "interviewing", "offer", "unsuccessful", "withdrawn"] as const) {
    test(`${state}: a raw insert and a raw current-version change are refused`, () => {
      const db = database();
      const app = inState(db, state);
      assert.equal(app.status, state);
      const before = assetRows(db, app.id);
      // withdrawn is locked by 006; the other statuses were already locked by 002.
      const expected = state === "withdrawn" ? BY_006 : BY_002;
      assert.throws(rawInsert(db, app.id), expected);
      assert.throws(rawFlip(db, app.id), expected);
      assert.equal(assetRows(db, app.id), before);
    });
  }

  test("mutation check: on v5 (without 006) only withdrawn-after-submission is unlocked; v6 locks it", () => {
    for (const [label, migrations] of [["v5", MIGRATIONS.slice(0, 5)], ["v6", MIGRATIONS]] as const) {
      const db = database(migrations);
      for (const state of ["submitted", "acknowledged", "interviewing", "offer", "unsuccessful"] as const) {
        const app = inState(db, state);
        assert.match(outcome(rawInsert(db, app.id)), BY_002, `${label} ${state}`);
      }
      const withdrawn = inState(db, "withdrawn");
      const insert = outcome(rawInsert(db, withdrawn.id));
      const flip = outcome(rawFlip(db, withdrawn.id));
      if (label === "v5") {
        assert.equal(insert, "allowed", "v5 withdrawn insert");
        assert.equal(flip, "allowed", "v5 withdrawn flip");
      } else {
        assert.match(insert, BY_006);
        assert.match(flip, BY_006);
      }
    }
  });
});

describe("006 — nothing changes before submission", () => {
  test("ready for review: raw and repository edits work as before", () => {
    const db = database();
    const app = readyApplication(db);
    rawInsert(db, app.id)();
    assert.equal(addApplicationAsset(db, { applicationId: app.id, kind: "cover_letter", origin: "user_edit", contentText: "v3" }).version, 3);
  });

  test("approved: an edit still works and still withdraws the approval (002)", () => {
    const db = database();
    const app = approve(db, readyApplication(db).id);
    addApplicationAsset(db, { applicationId: app.id, kind: "cover_letter", origin: "user_edit", contentText: "Edited" });
    const after = getApplication(db, app.id)!;
    assert.equal(after.status, "ready_for_review");
    assert.equal(after.approvedAt, null);
  });

  test("withdrawn BEFORE submission: edits still allowed, raw or through the repository", () => {
    const db = database();
    const app = transitionApplication(db, approve(db, readyApplication(db).id).id, "withdrawn", { actor: "user" });
    assert.equal(app.submittedAt, null);
    rawInsert(db, app.id)();
    rawFlip(db, app.id)();
    assert.ok(addApplicationAsset(db, { applicationId: app.id, kind: "cover_letter", origin: "user_edit", contentText: "Again" }).id);
  });

  test("a failed automated attempt (submission_failed) can still be edited, which withdraws the approval", () => {
    const db = database();
    const app = approve(db, readyApplication(db).id);
    beginSubmission(db, app.id, { method: "manual", actor: "user" });
    recordSubmissionResult(db, app.id, { success: false, error: "Site down" });
    addApplicationAsset(db, { applicationId: app.id, kind: "cover_letter", origin: "user_edit", contentText: "Fixed" });
    assert.equal(getApplication(db, app.id)!.status, "ready_for_review");
  });
});

describe("006 — legacy imports are unaffected", () => {
  test("legacy batch results import with their assets; a legacy approval can still gain a legacy_import asset", () => {
    const dir = makeTempDir();
    try {
      const file = createLegacyDbFile(dir, (legacy) => {
        legacy.prepare("INSERT INTO batch_runs (job_count) VALUES (2)").run();
        legacy.prepare(
          "INSERT INTO batch_results (batch_run_id, job_title, job_company, cover_letter, cv_file, cv_filename, status) VALUES (1, 'Old A', 'Old Co', 'Letter A', X'255044', 'a.pdf', 'approved')"
        ).run();
        legacy.prepare("INSERT INTO batch_results (batch_run_id, job_title, job_company, cover_letter, status) VALUES (1, 'Old B', 'Old Co', 'Letter B', 'pending')").run();
      });
      const db = quietly(() => openDatabase(file));
      opened.push(db);
      assert.ok((db.prepare("SELECT MAX(version) v FROM schema_migrations").get() as { v: number }).v >= 6, "v6 or later (007 adds the daily agent tables)");
      assert.equal((db.prepare("SELECT COUNT(*) n FROM application_assets").get() as { n: number }).n, 3);
      const legacyApproved = db.prepare("SELECT id FROM applications WHERE legacy_batch_result_id = 1").get() as { id: number };
      db.prepare(
        "INSERT INTO application_assets (application_id, kind, version, origin, content_json, sha256) VALUES (?, 'question_answers', 1, 'legacy_import', '[]', 'x')"
      ).run(legacyApproved.id);
      const legacyPending = db.prepare("SELECT id FROM applications WHERE legacy_batch_result_id = 2").get() as { id: number };
      transitionApplication(db, legacyPending.id, "withdrawn", { actor: "user" });
      rawInsert(db, legacyPending.id)();
    } finally {
      removeTempDir(dir);
    }
  });
});

describe("006 — the earlier protections still hold", () => {
  test("on a withdrawn-after-submission application: no delete, no content change, no system events, repository refuses too", () => {
    const db = database();
    const app = inState(db, "withdrawn");
    assert.throws(() => db.prepare("DELETE FROM application_assets WHERE application_id = ?").run(app.id), /APPEND_ONLY/);
    assert.throws(() => db.prepare("UPDATE application_assets SET content_text = 'changed' WHERE application_id = ? AND kind = 'cover_letter'").run(app.id), /IMMUTABLE/);
    assert.throws(
      () => db.prepare("INSERT INTO application_events (application_id, event_type, from_status, to_status, actor) VALUES (?, 'status_change', 'withdrawn', 'submitted', 'system')").run(app.id),
      /SUBMISSION_GATE/
    );
    assert.throws(() => db.prepare("UPDATE applications SET submitted_at = NULL WHERE id = ?").run(app.id), /IMMUTABLE/);
    assert.throws(
      () => addApplicationAsset(db, { applicationId: app.id, kind: "cover_letter", origin: "user_edit", contentText: "Late" }),
      /ASSETS_LOCKED/
    );
  });
});
