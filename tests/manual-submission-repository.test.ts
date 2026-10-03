import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { TestDb } from "./helpers.ts";
import { count, freshDb, quietly } from "./helpers.ts";
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
  getSubmissionRecord,
  listApplicationEvents,
  listReferenceHistory,
  listStatusHistory,
  listTrackedApplications,
  MAX_SUBMISSION_REFERENCE_LENGTH,
  recordManualSubmission,
  rejectApplication,
  setSubmissionReference,
  trackerGroupOf,
  transitionApplication,
  updateSubmittedStatus,
} from "../lib/repositories/applications.ts";
import { toDbTimestamp } from "../lib/repositories/shared.ts";

// Phase 2 checkpoint 2b: the manual submission repository.

let t: TestDb;
let jobCounter = 0;
beforeEach(() => {
  t = quietly(freshDb);
});
afterEach(() => t.close());

function readyApplication(): Application {
  jobCounter++;
  const job = recordJobListing(t.db, {
    sourceId: "reed", externalId: `r${jobCounter}`, title: `Dev ${jobCounter}`, company: "Acme",
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
const approvedApp = () => approve(readyApplication().id);

/** Approved by the user at an earlier time (through the trigger-checked raw path). */
function approvedAt(sqliteModifier: string): Application {
  const app = readyApplication();
  t.db.prepare(
    `INSERT INTO application_events (application_id, event_type, from_status, to_status, actor)
     VALUES (?, 'status_change', 'ready_for_review', 'approved', 'user')`
  ).run(app.id);
  t.db.prepare(
    `UPDATE applications SET status = 'approved', approved_at = datetime('now', ?),
       approved_assets_sha256 = ?, approved_asset_ids = ? WHERE id = ?`
  ).run(sqliteModifier, getCurrentAssetsHash(t.db, app.id), currentAssetIdSet(t.db, app.id), app.id);
  return getApplication(t.db, app.id)!;
}

const submit = (app: Application, extra: Partial<Parameters<typeof recordManualSubmission>[2]> = {}) =>
  recordManualSubmission(t.db, app.id, { reviewedAssetsSha256: app.approvedAssetsSha256!, ...extra });

const sqlNow = (modifier = "+0 seconds") =>
  (t.db.prepare("SELECT datetime('now', ?) AS v").get(modifier) as { v: string }).v;
const eventCount = (id: number) => count(t.db, "application_events", "application_id = ?", id);
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
  return undefined;
};

describe("recordManualSubmission — recording an application the user made", () => {
  test("an approved application is recorded as applied by the user: manual, now, snapshot and content unchanged", () => {
    const app = approvedApp();
    const assetsBefore = getCurrentAssets(t.db, app.id).map((a) => [a.id, a.sha256]);
    const before = nowFloor();
    const done = submit(app);

    assert.equal(done.status, "submitted");
    assert.equal(done.submissionMethod, "manual");
    assert.equal(done.submissionReference, null);
    assert.ok(done.submittedAt! >= before && done.submittedAt! >= app.approvedAt!);
    assert.deepEqual(
      [done.approvedAt, done.approvedAssetsSha256, done.approvedAssetIds],
      [app.approvedAt, app.approvedAssetsSha256, app.approvedAssetIds]
    );
    assert.deepEqual(getCurrentAssets(t.db, app.id).map((a) => [a.id, a.sha256]), assetsBefore);

    const [begin, attempt] = listApplicationEvents(t.db, app.id).slice(-2);
    assert.deepEqual([begin.eventType, begin.fromStatus, begin.toStatus, begin.actor], ["status_change", "approved", "submitting", "user"]);
    assert.deepEqual([attempt.eventType, attempt.fromStatus, attempt.toStatus, attempt.actor], ["submission_attempt", "submitting", "submitted", "user"]);
    const payload = attempt.payload as Record<string, unknown>;
    assert.equal(payload.method, "manual");
    assert.equal(payload.submittedAt, done.submittedAt);
    assert.equal(payload.submittedContent, "as_approved");
    assert.equal(payload.externalChanges, null);
    assert.equal(typeof payload.recordedAt, "string");
  });

  test("an earlier submittedAt between approval and now is kept, as a string or a Date", () => {
    const first = approvedAt("-3 hours");
    const anHourAgo = sqlNow("-1 hour");
    assert.equal(submit(first, { submittedAt: anHourAgo }).submittedAt, anHourAgo);

    const second = approvedAt("-3 hours");
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000 + 123); // milliseconds are dropped
    assert.equal(submit(second, { submittedAt: twoHoursAgo }).submittedAt, toDbTimestamp(twoHoursAgo));
  });

  test("the approval time itself is an allowed application time", () => {
    const app = approvedAt("-1 hour");
    assert.equal(submit(app, { submittedAt: app.approvedAt }).submittedAt, app.approvedAt);
  });

  test("an optional reference (trimmed) and note are recorded; the note first", () => {
    const app = approvedApp();
    const done = submit(app, { reference: "  REF-123  ", note: "Applied via the company portal" });
    assert.equal(done.submissionReference, "REF-123");
    assert.equal(done.notes, "Applied via the company portal");
    const events = listApplicationEvents(t.db, app.id).slice(-3);
    assert.deepEqual(events.map((e) => [e.eventType, e.actor]), [["note", "user"], ["status_change", "user"], ["submission_attempt", "user"]]);
    assert.equal((events[2].payload as { reference: string }).reference, "REF-123");
  });

  test("content changed on the employer's site is recorded and kept apart from the approved content", () => {
    const app = approvedApp();
    const assetsBefore = getCurrentAssets(t.db, app.id).map((a) => a.sha256);
    submit(app, { submittedContent: "modified_externally", externalChanges: "  Shortened the cover letter  " });
    const record = getSubmissionRecord(t.db, app.id)!;
    assert.equal(record.submittedContent, "modified_externally");
    assert.equal(record.externalChanges, "Shortened the cover letter");
    // The approved Job Agent assets are exactly what was approved.
    assert.deepEqual(getCurrentAssets(t.db, app.id).map((a) => a.sha256), assetsBefore);
    assert.equal(getApplication(t.db, app.id)!.approvedAssetsSha256, app.approvedAssetsSha256);
  });

  test("the submission record describes how and when it was submitted", () => {
    const app = approvedAt("-2 hours");
    assert.equal(getSubmissionRecord(t.db, app.id), null);
    const anHourAgo = sqlNow("-1 hour");
    submit(app, { submittedAt: anHourAgo, reference: "R-1" });
    const record = getSubmissionRecord(t.db, app.id)!;
    assert.equal(record.method, "manual");
    assert.equal(record.submittedAt, anHourAgo);
    assert.equal(record.reference, "R-1");
    assert.equal(record.submittedContent, "as_approved");
    assert.equal(record.externalChanges, null);
    assert.ok(record.recordedAt >= anHourAgo); // recorded later than it happened
  });
});

describe("recordManualSubmission — refusals (nothing is written)", () => {
  test("an application that is not approved", () => {
    const ready = readyApplication();
    const rejected = rejectApplication(t.db, readyApplication().id);
    const withdrawn = transitionApplication(t.db, readyApplication().id, "withdrawn", { actor: "user" });
    for (const app of [ready, rejected, withdrawn]) {
      const events = eventCount(app.id);
      assert.equal(codeOf(() => recordManualSubmission(t.db, app.id, { reviewedAssetsSha256: getCurrentAssetsHash(t.db, app.id) })), "APPROVAL_REQUIRED");
      assert.equal(eventCount(app.id), events);
    }
  });

  test("an approval that was withdrawn by a content change", () => {
    const app = approvedApp();
    addApplicationAsset(t.db, { applicationId: app.id, kind: "cover_letter", origin: "user_edit", contentText: "Edited" });
    assert.equal(getApplication(t.db, app.id)!.status, "ready_for_review");
    assert.equal(codeOf(() => submit(app)), "APPROVAL_REQUIRED");
  });

  test("a confirmation that is not the approved content (stale or wrong hash)", () => {
    const app = approvedApp();
    const events = eventCount(app.id);
    assert.equal(codeOf(() => recordManualSubmission(t.db, app.id, { reviewedAssetsSha256: "not-the-hash" })), "STALE_REVIEW");
    assert.equal(codeOf(() => recordManualSubmission(t.db, app.id, { reviewedAssetsSha256: "" })), "STALE_REVIEW");
    assert.equal(getApplication(t.db, app.id)!.status, "approved");
    assert.equal(eventCount(app.id), events);
  });

  test("an approved snapshot whose asset IDs are no longer current rolls back completely", () => {
    // A legacy_import asset (only possible on legacy-imported applications)
    // changes the current asset set without revoking the approval (004 H1).
    const app = readyApplication();
    t.db.prepare("UPDATE applications SET legacy_batch_result_id = ? WHERE id = ?").run(9000 + app.id, app.id);
    const approved = approve(app.id);
    t.db.prepare(
      "INSERT INTO application_assets (application_id, kind, version, origin, content_json, sha256) VALUES (?, 'question_answers', 1, 'legacy_import', '[]', 'x')"
    ).run(app.id);
    assert.notEqual(currentAssetIdSet(t.db, app.id), approved.approvedAssetIds);
    const events = eventCount(app.id);
    assert.equal(codeOf(() => submit(approved, { note: "should not be kept" })), "APPROVAL_REQUIRED");
    assert.equal(eventCount(app.id), events); // the note was rolled back too
    assert.equal(getApplication(t.db, app.id)!.notes, null);
    assert.equal(getApplication(t.db, app.id)!.status, "approved");
  });

  test("an application time in the future, before the approval, or not a real time", () => {
    const app = approvedAt("-1 hour");
    for (const submittedAt of [sqlNow("+1 minute"), new Date(Date.now() + 60_000)]) {
      assert.equal(codeOf(() => submit(app, { submittedAt })), "INVALID_TIMESTAMP");
    }
    const beforeApproval = (t.db.prepare("SELECT datetime(?, '-1 second') AS v").get(app.approvedAt) as { v: string }).v;
    assert.equal(codeOf(() => submit(app, { submittedAt: beforeApproval })), "INVALID_TIMESTAMP");
    for (const submittedAt of ["2026-10-03T10:00:00Z", "yesterday", "2026-02-30 10:00:00", "2026-10-03 10:00", new Date("nope")]) {
      assert.equal(codeOf(() => submit(app, { submittedAt })), "INVALID_TIMESTAMP", String(submittedAt));
    }
    assert.equal(getApplication(t.db, app.id)!.status, "approved");
  });

  test("inconsistent content information or an over-long reference", () => {
    const app = approvedApp();
    assert.equal(codeOf(() => submit(app, { submittedContent: "modified_externally" })), "INVALID_INPUT");
    assert.equal(codeOf(() => submit(app, { submittedContent: "modified_externally", externalChanges: "   " })), "INVALID_INPUT");
    assert.equal(codeOf(() => submit(app, { externalChanges: "Changed it" })), "INVALID_INPUT");
    assert.equal(codeOf(() => submit(app, { submittedContent: "sent_by_robot" as never })), "INVALID_INPUT");
    assert.equal(codeOf(() => submit(app, { reference: "x".repeat(MAX_SUBMISSION_REFERENCE_LENGTH + 1) })), "INVALID_INPUT");
    assert.equal(submit(app, { reference: "x".repeat(MAX_SUBMISSION_REFERENCE_LENGTH) }).status, "submitted");
  });

  test("an application already submitted, or one that does not exist", () => {
    const app = approvedApp();
    submit(app);
    assert.equal(codeOf(() => submit(app)), "APPROVAL_REQUIRED");
    assert.equal(codeOf(() => recordManualSubmission(t.db, 424242, { reviewedAssetsSha256: "x" })), "NOT_FOUND");
  });

  test("a system actor still cannot submit (the repository always records the user)", () => {
    const app = approvedApp();
    assert.throws(() => beginSubmission(t.db, app.id, { method: "manual", actor: "system" }), /SUBMISSION_GATE/);
    const done = submit(app);
    assert.ok(listApplicationEvents(t.db, done.id).filter((e) => e.toStatus === "submitting" || e.toStatus === "submitted").every((e) => e.actor === "user"));
  });
});

describe("updateSubmittedStatus — later updates", () => {
  test("follows the forward path, each step recorded as the user's", () => {
    const app = approvedApp();
    submit(app);
    for (const to of ["acknowledged", "interviewing", "offer", "withdrawn"] as const) {
      assert.equal(updateSubmittedStatus(t.db, app.id, { to }).status, to);
    }
    const history = listStatusHistory(t.db, app.id).slice(-4);
    assert.deepEqual(history.map((h) => [h.fromStatus, h.toStatus, h.actor]), [
      ["submitted", "acknowledged", "user"],
      ["acknowledged", "interviewing", "user"],
      ["interviewing", "offer", "user"],
      ["offer", "withdrawn", "user"],
    ]);
    // The approval and submission record is kept throughout.
    const after = getApplication(t.db, app.id)!;
    assert.ok(after.approvedAt && after.approvedAssetIds && after.submittedAt);
  });

  test("unsuccessful is final", () => {
    const app = approvedApp();
    submit(app);
    assert.equal(updateSubmittedStatus(t.db, app.id, { to: "unsuccessful" }).status, "unsuccessful");
    for (const to of ["acknowledged", "withdrawn"] as const) {
      assert.equal(codeOf(() => updateSubmittedStatus(t.db, app.id, { to })), "INVALID_TRANSITION");
    }
  });

  test("an optional occurredAt is recorded and shown in the history", () => {
    const app = approvedAt("-3 hours");
    submit(app, { submittedAt: sqlNow("-2 hours") });
    const interview = sqlNow("-30 minutes");
    updateSubmittedStatus(t.db, app.id, { to: "interviewing", occurredAt: interview, note: "First interview" });
    const last = listStatusHistory(t.db, app.id).at(-1)!;
    assert.equal(last.toStatus, "interviewing");
    assert.equal(last.occurredAt, interview);
    assert.equal(getApplication(t.db, app.id)!.notes, "First interview");
    // Without occurredAt the entry has none (its recordedAt is when it was recorded).
    updateSubmittedStatus(t.db, app.id, { to: "offer", occurredAt: new Date(Date.now() - 60_000) });
    assert.notEqual(listStatusHistory(t.db, app.id).at(-1)!.occurredAt, null);
  });

  test("occurredAt in the future, before the submission, or not a real time is refused", () => {
    const app = approvedAt("-3 hours");
    submit(app, { submittedAt: sqlNow("-2 hours") });
    const events = eventCount(app.id);
    for (const occurredAt of [sqlNow("+1 minute"), sqlNow("-150 minutes"), "2026-10-03T10:00:00Z", "soon", "2026-13-01 10:00:00"]) {
      assert.equal(codeOf(() => updateSubmittedStatus(t.db, app.id, { to: "acknowledged", occurredAt, note: "x" })), "INVALID_TIMESTAMP", occurredAt);
    }
    assert.equal(getApplication(t.db, app.id)!.status, "submitted");
    assert.equal(eventCount(app.id), events);
  });

  test("moves outside the forward-only rules, or before submission, are refused", () => {
    const app = approvedApp();
    assert.equal(codeOf(() => updateSubmittedStatus(t.db, app.id, { to: "acknowledged" })), "INVALID_TRANSITION"); // approved, not submitted
    submit(app);
    updateSubmittedStatus(t.db, app.id, { to: "interviewing" });
    assert.equal(codeOf(() => updateSubmittedStatus(t.db, app.id, { to: "acknowledged" })), "INVALID_TRANSITION"); // backwards
    updateSubmittedStatus(t.db, app.id, { to: "offer" });
    assert.equal(codeOf(() => updateSubmittedStatus(t.db, app.id, { to: "interviewing" })), "INVALID_TRANSITION");
    assert.equal(codeOf(() => updateSubmittedStatus(t.db, app.id, { to: "unsuccessful" })), "INVALID_TRANSITION"); // offer → withdrawn only
    for (const to of ["submitted", "approved", "offer_accepted", "ready_for_review"]) {
      assert.equal(codeOf(() => updateSubmittedStatus(t.db, app.id, { to: to as never })), "INVALID_TRANSITION", to);
    }
    // Withdrawn before ever applying: not a submitted application.
    const early = transitionApplication(t.db, approvedApp().id, "withdrawn", { actor: "user" });
    assert.equal(codeOf(() => updateSubmittedStatus(t.db, early.id, { to: "withdrawn" })), "INVALID_TRANSITION");
  });

  test("a system actor still cannot make a post-submission update", () => {
    const app = approvedApp();
    submit(app);
    assert.throws(() => transitionApplication(t.db, app.id, "acknowledged", { actor: "system" }), /SUBMISSION_GATE/);
    assert.equal(getApplication(t.db, app.id)!.status, "submitted");
  });
});

describe("setSubmissionReference — the reference can be added or edited later", () => {
  test("every change is recorded as the user's external_update, including clearing it", () => {
    const app = approvedApp();
    submit(app);
    setSubmissionReference(t.db, app.id, "  APP-1  ");
    setSubmissionReference(t.db, app.id, "APP-2");
    setSubmissionReference(t.db, app.id, null);
    assert.equal(getApplication(t.db, app.id)!.submissionReference, null);
    assert.deepEqual(
      listReferenceHistory(t.db, app.id).map((c) => [c.from, c.to, c.actor]),
      [[null, "APP-1", "user"], ["APP-1", "APP-2", "user"], ["APP-2", null, "user"]]
    );
  });

  test("setting the same value again records nothing", () => {
    const app = approvedApp();
    submit(app, { reference: "R" });
    const events = eventCount(app.id);
    setSubmissionReference(t.db, app.id, " R ");
    assert.equal(eventCount(app.id), events);
  });

  test("works for closed applications too (e.g. a reference found later)", () => {
    const app = approvedApp();
    submit(app);
    updateSubmittedStatus(t.db, app.id, { to: "unsuccessful" });
    assert.equal(setSubmissionReference(t.db, app.id, "LATE-REF").submissionReference, "LATE-REF");
  });

  test("is refused before submission or when too long; a silent change is blocked by migration 005", () => {
    const app = approvedApp();
    assert.equal(codeOf(() => setSubmissionReference(t.db, app.id, "R")), "INVALID_TRANSITION");
    submit(app, { reference: "R" });
    assert.equal(codeOf(() => setSubmissionReference(t.db, app.id, "x".repeat(MAX_SUBMISSION_REFERENCE_LENGTH + 1))), "INVALID_INPUT");
    assert.throws(() => t.db.prepare("UPDATE applications SET submission_reference = 'SILENT' WHERE id = ?").run(app.id), /AUDIT/);
    assert.equal(getApplication(t.db, app.id)!.submissionReference, "R");
  });
});

describe("tracker read helpers", () => {
  test("group each application: to apply, applied, closed, or not tracked", () => {
    const ready = readyApplication();
    const approved = approvedApp();
    const applied = approvedApp();
    submit(applied);
    const interviewing = approvedApp();
    submit(interviewing);
    updateSubmittedStatus(t.db, interviewing.id, { to: "interviewing" });
    const unsuccessful = approvedApp();
    submit(unsuccessful);
    updateSubmittedStatus(t.db, unsuccessful.id, { to: "unsuccessful" });
    const withdrawnAfter = approvedApp();
    submit(withdrawnAfter);
    updateSubmittedStatus(t.db, withdrawnAfter.id, { to: "withdrawn" });
    const withdrawnBefore = transitionApplication(t.db, approvedApp().id, "withdrawn", { actor: "user" });
    const rejected = rejectApplication(t.db, readyApplication().id);

    const group = (app: Application) => trackerGroupOf(getApplication(t.db, app.id)!);
    assert.equal(group(approved), "to_apply");
    assert.equal(group(applied), "applied");
    assert.equal(group(interviewing), "applied");
    assert.equal(group(unsuccessful), "closed");
    assert.equal(group(withdrawnAfter), "closed");
    for (const app of [ready, withdrawnBefore, rejected]) assert.equal(group(app), null);

    const ids = (g: Parameters<typeof listTrackedApplications>[1]) => listTrackedApplications(t.db, g).map((a) => a.id).sort((a, b) => a - b);
    assert.deepEqual(ids("to_apply"), [approved.id]);
    assert.deepEqual(ids("applied"), [applied.id, interviewing.id].sort((a, b) => a - b));
    assert.deepEqual(ids("closed"), [unsuccessful.id, withdrawnAfter.id].sort((a, b) => a - b));
    assert.deepEqual(ids("tracked"), [approved.id, applied.id, interviewing.id, unsuccessful.id, withdrawnAfter.id].sort((a, b) => a - b));
  });

  test("the history lists every status change in order with its actor", () => {
    const app = approvedApp();
    submit(app);
    updateSubmittedStatus(t.db, app.id, { to: "acknowledged" });
    assert.deepEqual(
      listStatusHistory(t.db, app.id).map((h) => [h.toStatus, h.actor]),
      [["preparing", "system"], ["ready_for_review", "system"], ["approved", "user"], ["submitting", "user"], ["submitted", "user"], ["acknowledged", "user"]]
    );
  });
});

describe("bypassing the repository with direct SQL stays blocked (migration 005 and 004)", () => {
  test("silent status jumps, system events, silent reference changes and bad times are refused", () => {
    const app = approvedApp();
    assert.throws(() => t.db.prepare("UPDATE applications SET status = 'submitted', submitted_at = datetime('now'), submission_method = 'manual' WHERE id = ?").run(app.id), /AUDIT|APPROVAL_GATE|SUBMISSION_GATE/);
    assert.throws(
      () => t.db.prepare("INSERT INTO application_events (application_id, event_type, from_status, to_status, actor) VALUES (?, 'status_change', 'approved', 'submitting', 'system')").run(app.id),
      /SUBMISSION_GATE/
    );
    submit(app, { reference: "R" });
    assert.throws(() => t.db.prepare("UPDATE applications SET submission_reference = 'X' WHERE id = ?").run(app.id), /AUDIT/);
    assert.throws(() => t.db.prepare("UPDATE applications SET submitted_at = datetime('now', '+1 day') WHERE id = ?").run(app.id), /IMMUTABLE/);
    assert.throws(
      () => t.db.prepare("INSERT INTO application_events (application_id, event_type, from_status, to_status, actor) VALUES (?, 'status_change', 'submitted', 'acknowledged', 'scheduler')").run(app.id),
      /SUBMISSION_GATE/
    );
    assert.equal(getApplication(t.db, app.id)!.status, "submitted");
  });
});

/** "Now" in the stored format, floored to the second. */
function nowFloor(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
