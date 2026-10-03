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
  currentAssetIdSet,
  getApplication,
  getCurrentAssets,
  getCurrentAssetsHash,
  recordSubmissionResult,
  rejectApplication,
  transitionApplication,
} from "../lib/repositories/applications.ts";

// Migration 004: the database-level gaps found in the Phase 1 review.

const GATE = /APPROVAL_GATE|SUBMISSION_GATE|AUDIT/;

let t: TestDb;
let jobCounter = 0;
beforeEach(() => {
  t = quietly(freshDb);
});
afterEach(() => t.close());

function readyApplication(): Application {
  jobCounter++;
  const job = recordJobListing(t.db, {
    sourceId: "reed", externalId: `h${jobCounter}`, title: `Dev ${jobCounter}`, company: "Acme",
  });
  const app = createApplication(t.db, { jobId: job.jobId });
  addApplicationAsset(t.db, { applicationId: app.id, kind: "cover_letter", origin: "generated", contentText: "Dear Acme" });
  addApplicationAsset(t.db, {
    applicationId: app.id, kind: "tailored_cv_file", origin: "generated",
    file: Buffer.from("%PDF"), filename: "cv.pdf", mimeType: "application/pdf",
  });
  return transitionApplication(t.db, app.id, "ready_for_review", { actor: "system" });
}

const approve = (id: number) =>
  approveApplication(t.db, id, { reviewedAssetsSha256: getCurrentAssetsHash(t.db, id) });

function submitted(): Application {
  const app = approve(readyApplication().id);
  beginSubmission(t.db, app.id, { method: "manual", actor: "user" });
  return recordSubmissionResult(t.db, app.id, { success: true, reference: "REF" }, "user");
}

/** An application as migration 003 imports a legacy "approved" batch result. */
function legacyApprovedApplication(): Application {
  jobCounter++;
  const job = recordJobListing(t.db, {
    sourceId: "legacy", externalId: `batch_result:${jobCounter}`, title: `Legacy ${jobCounter}`, company: "OldCo",
  });
  const id = Number(
    t.db
      .prepare(
        `INSERT INTO applications (job_id, status, approved_at, approved_assets_sha256, legacy_batch_result_id)
         VALUES (?, 'approved', datetime('now'), 'legacy-hash', ?)`
      )
      .run(job.jobId, jobCounter).lastInsertRowid
  );
  t.db.prepare(
    "INSERT INTO application_assets (application_id, kind, version, origin, content_text, sha256) VALUES (?, 'cover_letter', 1, 'legacy_import', 'Old letter', 'h')"
  ).run(id);
  t.db.prepare(
    "INSERT INTO application_events (application_id, event_type, from_status, to_status, actor) VALUES (?, 'status_change', 'ready_for_review', 'approved', 'migration')"
  ).run(id);
  return getApplication(t.db, id)!;
}

const raw = (sql: string, ...params: unknown[]) => () => t.db.prepare(sql).run(...params);
const status = (id: number) => getApplication(t.db, id)!.status;

describe("004 — repository behaviour", () => {
  test("approval records the exact asset ID set", () => {
    const app = approve(readyApplication().id);
    const ids = getCurrentAssets(t.db, app.id).map((a) => a.id).sort((a, b) => a - b).join(",");
    assert.equal(app.approvedAssetIds, ids);
    assert.equal(app.approvedAssetIds, currentAssetIdSet(t.db, app.id));
  });

  test("post-submission transitions keep the full approval and submission record", () => {
    const app = submitted();
    const snapshot = [app.approvedAt, app.approvedAssetsSha256, app.approvedAssetIds, app.submittedAt];
    assert.ok(snapshot.every((v) => v !== null));
    for (const to of ["acknowledged", "interviewing", "offer", "withdrawn"] as const) {
      const after = transitionApplication(t.db, app.id, to, { actor: "user" });
      assert.equal(after.status, to);
      assert.deepEqual([after.approvedAt, after.approvedAssetsSha256, after.approvedAssetIds, after.submittedAt], snapshot);
    }
  });

  test("submitted → unsuccessful also keeps the record", () => {
    const app = submitted();
    const after = transitionApplication(t.db, app.id, "unsuccessful", { actor: "user" });
    assert.ok(after.approvedAt && after.approvedAssetIds && after.submittedAt);
  });

  test("rejecting or withdrawing an approved application clears the whole snapshot", () => {
    const rejected = rejectApplication(t.db, approve(readyApplication().id).id);
    const withdrawn = transitionApplication(t.db, approve(readyApplication().id).id, "withdrawn", { actor: "user" });
    for (const app of [rejected, withdrawn]) {
      assert.deepEqual([app.approvedAt, app.approvedAssetsSha256, app.approvedAssetIds], [null, null, null]);
    }
  });

  test("a content change revokes approval and clears the asset snapshot too", () => {
    const app = approve(readyApplication().id);
    addApplicationAsset(t.db, { applicationId: app.id, kind: "cover_letter", origin: "user_edit", contentText: "Edited" });
    const after = getApplication(t.db, app.id)!;
    assert.equal(after.status, "ready_for_review");
    assert.deepEqual([after.approvedAt, after.approvedAssetsSha256, after.approvedAssetIds], [null, null, null]);
  });

  test("the full happy path still works with event-first ordering", () => {
    const app = submitted();
    assert.equal(app.status, "submitted");
    assert.equal(transitionApplication(t.db, app.id, "acknowledged", { actor: "user" }).status, "acknowledged");
  });
});

describe("004 — database enforcement (bypassing the repository)", () => {
  test("post-submission statuses cannot be reached without submitting", () => {
    const app = readyApplication();
    for (const s of ["acknowledged", "interviewing", "offer", "unsuccessful"]) {
      assert.throws(raw("UPDATE applications SET status = ? WHERE id = ?", s, app.id), GATE);
    }
    const approved = approve(readyApplication().id);
    assert.throws(raw("UPDATE applications SET status = 'acknowledged' WHERE id = ?", approved.id), GATE);
    assert.equal(status(app.id), "ready_for_review");
  });

  test("a status change without a matching event is refused", () => {
    const app = approve(readyApplication().id);
    assert.throws(raw("UPDATE applications SET status = 'ready_for_review' WHERE id = ?", app.id), /AUDIT/);
    assert.equal(status(app.id), "approved");
  });

  test("an event for a different transition does not authorise a status change", () => {
    const app = readyApplication();
    t.db.prepare(
      "INSERT INTO application_events (application_id, event_type, from_status, to_status, actor) VALUES (?, 'status_change', 'preparing', 'rejected', 'user')"
    ).run(app.id);
    assert.throws(raw("UPDATE applications SET status = 'rejected' WHERE id = ?", app.id), /AUDIT/);
  });

  test("the review-time tamper sequence is now blocked at its first step", () => {
    // Previously: approve → silently back to review → swap content → silently re-approve → submit.
    const app = approve(readyApplication().id);
    assert.throws(raw("UPDATE applications SET status = 'ready_for_review' WHERE id = ?", app.id), /AUDIT/);
  });

  test("approval must snapshot exactly the current asset set", () => {
    const app = readyApplication();
    const hash = getCurrentAssetsHash(t.db, app.id);
    const addApprovalEvent = () =>
      t.db.prepare(
        "INSERT INTO application_events (application_id, event_type, from_status, to_status, actor) VALUES (?, 'status_change', 'ready_for_review', 'approved', 'user')"
      ).run(app.id);
    for (const ids of [null, "999", "1"]) {
      addApprovalEvent();
      assert.throws(
        raw(
          "UPDATE applications SET status = 'approved', approved_at = datetime('now'), approved_assets_sha256 = ?, approved_asset_ids = ? WHERE id = ?",
          hash, ids, app.id
        ),
        /APPROVAL_GATE/
      );
    }
  });

  test("submission is refused when the current assets differ from the approved set", () => {
    // Only a legacy-imported application can still gain an asset without 002
    // revoking its approval ('legacy_import' origin, H1). Re-approve one by
    // the user, then add such an asset: the approved set is now stale.
    const app = legacyApprovedApplication();
    transitionApplication(t.db, app.id, "ready_for_review", { actor: "user" });
    approve(app.id);
    t.db.prepare(
      "INSERT INTO application_assets (application_id, kind, version, origin, content_json, sha256) VALUES (?, 'question_answers', 1, 'legacy_import', '[]', 'x')"
    ).run(app.id);
    assert.equal(status(app.id), "approved");
    assert.throws(() => beginSubmission(t.db, app.id, { method: "manual", actor: "user" }), { code: "APPROVAL_REQUIRED" });
    t.db.prepare(
      "INSERT INTO application_events (application_id, event_type, from_status, to_status, actor) VALUES (?, 'status_change', 'approved', 'submitting', 'user')"
    ).run(app.id);
    assert.throws(raw("UPDATE applications SET status = 'submitting' WHERE id = ?", app.id), /APPROVAL_GATE/);
  });

  test("submitted requires submitted_at", () => {
    const app = approve(readyApplication().id);
    beginSubmission(t.db, app.id, { method: "manual", actor: "user" });
    t.db.prepare(
      "INSERT INTO application_events (application_id, event_type, from_status, to_status, actor) VALUES (?, 'submission_attempt', 'submitting', 'submitted', 'user')"
    ).run(app.id);
    assert.throws(raw("UPDATE applications SET status = 'submitted' WHERE id = ?", app.id), /SUBMISSION_GATE/);
  });

  test("the approval and submission record is read-only after submission", () => {
    const app = submitted();
    for (const column of ["approved_at", "approved_assets_sha256", "approved_asset_ids", "submitted_at"]) {
      assert.throws(raw(`UPDATE applications SET ${column} = NULL WHERE id = ?`, app.id), /IMMUTABLE|CHECK/);
      assert.throws(raw(`UPDATE applications SET ${column} = 'tampered' WHERE id = ?`, app.id), /IMMUTABLE/);
    }
  });

  test("assets cannot be deleted", () => {
    const app = readyApplication();
    assert.throws(raw("DELETE FROM application_assets WHERE application_id = ?", app.id), /APPEND_ONLY/);
    assert.equal(getCurrentAssets(t.db, app.id).length, 2);
  });

  test("'migration' approvals are refused for non-legacy applications", () => {
    const app = readyApplication();
    assert.throws(
      raw(
        "INSERT INTO application_events (application_id, event_type, from_status, to_status, actor) VALUES (?, 'status_change', 'ready_for_review', 'approved', 'migration')",
        app.id
      ),
      /APPROVAL_GATE/
    );
  });
});

describe("004 — H1–H3: the bypasses found in the final review", () => {
  const eventCount = (id: number) =>
    (t.db.prepare("SELECT COUNT(*) AS n FROM application_events WHERE application_id = ?").get(id) as { n: number }).n;

  test("review bypass 1 is blocked at every step (legacy asset → rewrite snapshot → submit)", () => {
    const app = approve(readyApplication().id);
    const before = {
      assets: currentAssetIdSet(t.db, app.id),
      hash: getCurrentAssetsHash(t.db, app.id),
      events: eventCount(app.id),
    };

    // Step 1: smuggle in unreviewed content without revoking approval.
    assert.throws(
      raw(
        "INSERT INTO application_assets (application_id, kind, version, origin, content_json, sha256) VALUES (?, 'question_answers', 1, 'legacy_import', '[\"UNREVIEWED\"]', 'x')",
        app.id
      ),
      /APPROVAL_GATE: legacy_import assets/
    );
    // Steps 2 and 2b: rewrite the approval snapshot while still approved.
    assert.throws(raw("UPDATE applications SET approved_asset_ids = '999' WHERE id = ?", app.id), /IMMUTABLE/);
    assert.throws(raw("UPDATE applications SET approved_assets_sha256 = 'forged' WHERE id = ?", app.id), /IMMUTABLE/);

    // Nothing changed: same content, same snapshot, no silent writes.
    const after = getApplication(t.db, app.id)!;
    assert.equal(currentAssetIdSet(t.db, app.id), before.assets);
    assert.equal(after.approvedAssetIds, before.assets);
    assert.equal(after.approvedAssetsSha256, before.hash);
    assert.equal(eventCount(app.id), before.events);
  });

  test("review bypass 2 is blocked: an approved application cannot be moved to another job", () => {
    const app = approve(readyApplication().id);
    const otherJob = recordJobListing(t.db, { sourceId: "reed", externalId: "other", title: "Other", company: "Never Reviewed Ltd" });
    assert.throws(raw("UPDATE applications SET job_id = ? WHERE id = ?", otherJob.jobId, app.id), /IMMUTABLE: an application's job/);
    assert.equal(getApplication(t.db, app.id)!.jobId, app.jobId);
    // The legitimate submission still targets the job that was approved.
    assert.equal(beginSubmission(t.db, app.id, { method: "manual", actor: "user" }).jobId, app.jobId);
  });

  test("H1: legacy_import assets are rejected on normal applications in any status", () => {
    for (const app of [readyApplication(), approve(readyApplication().id)]) {
      assert.throws(
        raw(
          "INSERT INTO application_assets (application_id, kind, version, origin, content_text, sha256) VALUES (?, 'question_answers', 1, 'legacy_import', 'x', 'x')",
          app.id
        ),
        /APPROVAL_GATE: legacy_import assets/
      );
    }
  });

  test("H1: legacy-imported applications still accept legacy_import assets", () => {
    const app = legacyApprovedApplication();
    assert.equal(getCurrentAssets(t.db, app.id).length, 1);
    assert.equal(getCurrentAssets(t.db, app.id)[0].origin, "legacy_import");
  });

  test("H2: the snapshot cannot be planted before approval", () => {
    const app = readyApplication();
    const ids = currentAssetIdSet(t.db, app.id);
    for (const [column, value] of [
      ["approved_at", "2026-01-01 00:00:00"],
      ["approved_assets_sha256", getCurrentAssetsHash(t.db, app.id)],
      ["approved_asset_ids", ids],
    ]) {
      assert.throws(raw(`UPDATE applications SET ${column} = ? WHERE id = ?`, value, app.id), /IMMUTABLE: the approval snapshot/);
    }
  });

  test("H2: the snapshot cannot be changed while approved", () => {
    const app = approve(readyApplication().id);
    assert.throws(raw("UPDATE applications SET approved_at = '2020-01-01 00:00:00' WHERE id = ?", app.id), /IMMUTABLE/);
    assert.throws(raw("UPDATE applications SET approved_asset_ids = ? WHERE id = ?", app.approvedAssetIds + ",999", app.id), /IMMUTABLE/);
  });

  test("H2: a legacy approval cannot be made submittable by filling in its snapshot", () => {
    const app = legacyApprovedApplication();
    assert.throws(
      raw("UPDATE applications SET approved_asset_ids = ? WHERE id = ?", currentAssetIdSet(t.db, app.id), app.id),
      /IMMUTABLE/
    );
    assert.throws(() => beginSubmission(t.db, app.id, { method: "manual", actor: "user" }), { code: "APPROVAL_REQUIRED" });
  });

  test("H2: setting the snapshot alongside a non-approval status change is refused", () => {
    const app = readyApplication();
    t.db.prepare(
      "INSERT INTO application_events (application_id, event_type, from_status, to_status, actor) VALUES (?, 'status_change', 'ready_for_review', 'rejected', 'user')"
    ).run(app.id);
    assert.throws(
      raw("UPDATE applications SET status = 'rejected', approved_at = datetime('now') WHERE id = ?", app.id),
      /IMMUTABLE: the approval snapshot/
    );
  });

  test("H2: clearing the snapshot stays allowed and only weakens the approval", () => {
    const app = approve(readyApplication().id);
    t.db.prepare("UPDATE applications SET approved_asset_ids = NULL WHERE id = ?").run(app.id);
    assert.equal(getApplication(t.db, app.id)!.approvedAssetIds, null);
    assert.throws(() => beginSubmission(t.db, app.id, { method: "manual", actor: "user" }), { code: "APPROVAL_REQUIRED" });
  });

  test("H2: the legitimate repository paths still set and clear the snapshot", () => {
    const app = approve(readyApplication().id); // set by approval
    assert.ok(app.approvedAt && app.approvedAssetsSha256 && app.approvedAssetIds);
    const cleared = transitionApplication(t.db, app.id, "ready_for_review", { actor: "user" }); // cleared by leaving
    assert.deepEqual([cleared.approvedAt, cleared.approvedAssetsSha256, cleared.approvedAssetIds], [null, null, null]);
    const again = approve(app.id);
    addApplicationAsset(t.db, { applicationId: again.id, kind: "cover_letter", origin: "user_edit", contentText: "v3" }); // revoked
    assert.equal(getApplication(t.db, again.id)!.approvedAssetIds, null);
  });

  test("H3: job_id is immutable in every status, including before approval", () => {
    const app = readyApplication();
    const otherJob = recordJobListing(t.db, { sourceId: "reed", externalId: "h3", title: "Else", company: "Elsewhere" });
    assert.throws(raw("UPDATE applications SET job_id = ? WHERE id = ?", otherJob.jobId, app.id), /IMMUTABLE/);
    const done = submitted();
    assert.throws(raw("UPDATE applications SET job_id = ? WHERE id = ?", otherJob.jobId, done.id), /IMMUTABLE/);
  });
});
