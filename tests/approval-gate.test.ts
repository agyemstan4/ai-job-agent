import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { TestDb } from "./helpers.ts";
import { freshDb, quietly } from "./helpers.ts";
import { recordJobListing } from "../lib/repositories/jobs.ts";
import type { Application } from "../lib/repositories/applications.ts";
import {
  addApplicationAsset,
  approveApplication,
  beginSubmission,
  createApplication,
  getApplication,
  getCurrentAssetsHash,
  listApplicationEvents,
  recordSubmissionResult,
  rejectApplication,
  transitionApplication,
} from "../lib/repositories/applications.ts";

// The hard requirement: nothing reaches submission without an explicit,
// current approval by the user. Each test attacks the gate from a different
// angle — through the repository API and directly through SQL.

// Any database-level gate rejection (002's APPROVAL_GATE, or 004's AUDIT /
// SUBMISSION_GATE / IMMUTABLE snapshot rule, whichever trigger fires first).
const GATE = /APPROVAL_GATE|SUBMISSION_GATE|AUDIT|IMMUTABLE/;

let t: TestDb;
beforeEach(() => {
  t = quietly(freshDb);
});
afterEach(() => t.close());

function readyApplication(): Application {
  const job = recordJobListing(t.db, { sourceId: "reed", externalId: String(Math.random()), title: "Dev", company: "Acme" });
  const app = createApplication(t.db, { jobId: job.jobId });
  addApplicationAsset(t.db, { applicationId: app.id, kind: "cover_letter", origin: "generated", contentText: "Dear Acme" });
  addApplicationAsset(t.db, {
    applicationId: app.id, kind: "tailored_cv_file", origin: "generated",
    file: Buffer.from("%PDF"), filename: "cv.pdf", mimeType: "application/pdf",
  });
  return transitionApplication(t.db, app.id, "ready_for_review", { actor: "system" });
}

function approve(app: Application): Application {
  return approveApplication(t.db, app.id, { reviewedAssetsSha256: getCurrentAssetsHash(t.db, app.id) });
}

const status = (id: number) => getApplication(t.db, id)!.status;

describe("approval gate — repository API", () => {
  test("the happy path: ready → approved (by user) → submitting → submitted", () => {
    const app = approve(readyApplication());
    assert.equal(app.status, "approved");
    assert.ok(app.approvedAt);
    const approval = listApplicationEvents(t.db, app.id).find((e) => e.toStatus === "approved")!;
    assert.equal(approval.actor, "user");

    assert.equal(beginSubmission(t.db, app.id, { method: "manual", actor: "user" }).status, "submitting");
    const done = recordSubmissionResult(t.db, app.id, { success: true, reference: "REF-1" }, "user");
    assert.equal(done.status, "submitted");
    assert.equal(done.submissionReference, "REF-1");
  });

  test("cannot begin submission for any unapproved status", () => {
    const app = readyApplication();
    assert.throws(() => beginSubmission(t.db, app.id, { method: "api", actor: "user" }), { code: "APPROVAL_REQUIRED" });

    const preparing = createApplication(t.db, {
      jobId: recordJobListing(t.db, { sourceId: "reed", externalId: "p", title: "QA", company: "Other" }).jobId,
    });
    assert.throws(() => beginSubmission(t.db, preparing.id, { method: "api", actor: "user" }), { code: "APPROVAL_REQUIRED" });

    rejectApplication(t.db, app.id);
    assert.throws(() => beginSubmission(t.db, app.id, { method: "api", actor: "user" }), { code: "APPROVAL_REQUIRED" });
    assert.equal(status(app.id), "rejected");
  });

  test("the generic transition cannot reach any gated status", () => {
    const app = readyApplication();
    for (const to of ["approved", "submitting", "submitted", "submission_failed"] as const) {
      assert.throws(() => transitionApplication(t.db, app.id, to, { actor: "system" }), { code: "GATED_TRANSITION" });
    }
    assert.equal(status(app.id), "ready_for_review");
  });

  test("approval requires ready_for_review and some content", () => {
    const job = recordJobListing(t.db, { sourceId: "reed", externalId: "e", title: "Dev", company: "Empty" });
    const empty = transitionApplication(t.db, createApplication(t.db, { jobId: job.jobId }).id, "ready_for_review", { actor: "system" });
    assert.throws(() => approveApplication(t.db, empty.id, { reviewedAssetsSha256: getCurrentAssetsHash(t.db, empty.id) }), {
      code: "NOTHING_TO_APPROVE",
    });

    const preparing = createApplication(t.db, {
      jobId: recordJobListing(t.db, { sourceId: "reed", externalId: "q", title: "QA", company: "Q" }).jobId,
    });
    assert.throws(() => approveApplication(t.db, preparing.id, { reviewedAssetsSha256: "x" }), { code: "INVALID_TRANSITION" });
  });

  test("approval is refused if the content changed after the user reviewed it", () => {
    const app = readyApplication();
    const reviewedHash = getCurrentAssetsHash(t.db, app.id);
    addApplicationAsset(t.db, { applicationId: app.id, kind: "cover_letter", origin: "generated", contentText: "Regenerated" });
    assert.throws(() => approveApplication(t.db, app.id, { reviewedAssetsSha256: reviewedHash }), { code: "STALE_REVIEW" });
    assert.equal(status(app.id), "ready_for_review");
  });

  test("changing content after approval withdraws the approval", () => {
    const app = approve(readyApplication());
    addApplicationAsset(t.db, { applicationId: app.id, kind: "cover_letter", origin: "user_edit", contentText: "Edited" });

    const after = getApplication(t.db, app.id)!;
    assert.equal(after.status, "ready_for_review");
    assert.equal(after.approvedAt, null);
    assert.equal(after.approvedAssetsSha256, null);
    const withdrawn = listApplicationEvents(t.db, app.id).find((e) => e.actor === "system" && e.fromStatus === "approved")!;
    assert.match(withdrawn.detail!, /Approval withdrawn/);
    assert.throws(() => beginSubmission(t.db, app.id, { method: "manual", actor: "user" }), { code: "APPROVAL_REQUIRED" });

    // Re-approving the new content opens the gate again.
    approve(getApplication(t.db, app.id)!);
    assert.equal(beginSubmission(t.db, app.id, { method: "manual", actor: "user" }).status, "submitting");
  });

  test("going back to review after approval requires a fresh approval", () => {
    const app = approve(readyApplication());
    transitionApplication(t.db, app.id, "ready_for_review", { actor: "user" });
    assert.throws(() => beginSubmission(t.db, app.id, { method: "manual", actor: "user" }), { code: "APPROVAL_REQUIRED" });
  });

  test("a failed submission can be retried without re-approval, but not after edits", () => {
    const app = approve(readyApplication());
    beginSubmission(t.db, app.id, { method: "email", actor: "user" });
    assert.equal(recordSubmissionResult(t.db, app.id, { success: false, error: "SMTP down" }).status, "submission_failed");
    assert.equal(beginSubmission(t.db, app.id, { method: "email", actor: "user" }).status, "submitting");
    recordSubmissionResult(t.db, app.id, { success: false, error: "SMTP down again" });

    addApplicationAsset(t.db, { applicationId: app.id, kind: "cover_letter", origin: "user_edit", contentText: "Edited" });
    assert.equal(status(app.id), "ready_for_review");
    assert.throws(() => beginSubmission(t.db, app.id, { method: "email", actor: "user" }), { code: "APPROVAL_REQUIRED" });
  });

  test("content is locked once submission has started", () => {
    const app = approve(readyApplication());
    beginSubmission(t.db, app.id, { method: "manual", actor: "user" });
    assert.throws(
      () => addApplicationAsset(t.db, { applicationId: app.id, kind: "cover_letter", origin: "user_edit", contentText: "Late edit" }),
      /ASSETS_LOCKED/
    );
  });

  test("submission results can only be recorded while submitting", () => {
    const app = approve(readyApplication());
    assert.throws(() => recordSubmissionResult(t.db, app.id, { success: true }), { code: "INVALID_TRANSITION" });
  });
});

describe("approval gate — enforced by the database (bypassing the repository)", () => {
  test("cannot insert an application that is already approved or submitting", () => {
    const job = recordJobListing(t.db, { sourceId: "reed", externalId: "1", title: "Dev", company: "Acme" });
    for (const s of ["approved", "submitting", "submitted"]) {
      assert.throws(
        () =>
          t.db
            .prepare("INSERT INTO applications (job_id, status, approved_at, approved_assets_sha256) VALUES (?, ?, datetime('now'), 'x')")
            .run(job.jobId, s),
        GATE
      );
    }
  });

  test("cannot set status to approved without a preceding user approval event", () => {
    const app = readyApplication();
    assert.throws(
      () =>
        t.db
          .prepare("UPDATE applications SET status = 'approved', approved_at = datetime('now'), approved_assets_sha256 = 'x' WHERE id = ?")
          .run(app.id),
      GATE
    );
  });

  test("the system, scheduler or anyone but the user cannot record an approval event", () => {
    const app = readyApplication();
    for (const actor of ["system", "scheduler"]) {
      assert.throws(
        () =>
          t.db
            .prepare("INSERT INTO application_events (application_id, event_type, to_status, actor) VALUES (?, 'status_change', 'approved', ?)")
            .run(app.id, actor),
        /CHECK constraint failed/
      );
    }
  });

  test("cannot jump straight to submitting or submitted", () => {
    const app = readyApplication();
    for (const s of ["submitting", "submitted"]) {
      assert.throws(
        () =>
          t.db
            .prepare("UPDATE applications SET status = ?, approved_at = datetime('now'), approved_assets_sha256 = 'x' WHERE id = ?")
            .run(s, app.id),
        GATE
      );
    }
    assert.equal(status(app.id), "ready_for_review");
  });

  test("approved cannot skip straight to submitted", () => {
    const app = approve(readyApplication());
    assert.throws(() => t.db.prepare("UPDATE applications SET status = 'submitted' WHERE id = ?").run(app.id), GATE);
  });

  test("approval requires approved_at and a content snapshot", () => {
    const app = approve(readyApplication());
    assert.throws(
      () => t.db.prepare("UPDATE applications SET approved_at = NULL WHERE id = ?").run(app.id),
      /CHECK constraint failed/
    );
  });

  test("swapping the current asset version after approval withdraws the approval", () => {
    const app = readyApplication();
    addApplicationAsset(t.db, { applicationId: app.id, kind: "cover_letter", origin: "generated", contentText: "v2" });
    approve(getApplication(t.db, app.id)!);
    // Sneakily point "current" back at v1 via SQL.
    t.db.prepare("UPDATE application_assets SET is_current = 0 WHERE application_id = ? AND kind = 'cover_letter' AND version = 2").run(app.id);
    assert.equal(status(app.id), "ready_for_review");
    t.db.prepare("UPDATE application_assets SET is_current = 1 WHERE application_id = ? AND kind = 'cover_letter' AND version = 1").run(app.id);
    assert.throws(() => beginSubmission(t.db, app.id, { method: "manual", actor: "user" }), { code: "APPROVAL_REQUIRED" });
    assert.throws(() => t.db.prepare("UPDATE applications SET status = 'submitting' WHERE id = ?").run(app.id), GATE);
  });

  test("the event history is append-only", () => {
    const app = approve(readyApplication());
    assert.throws(() => t.db.prepare("UPDATE application_events SET actor = 'user' WHERE application_id = ?").run(app.id), /APPEND_ONLY/);
    assert.throws(() => t.db.prepare("DELETE FROM application_events WHERE application_id = ?").run(app.id), /APPEND_ONLY/);
  });
});
