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
  getCurrentAssetsHash,
  listApplicationEvents,
  recordSubmissionResult,
  transitionApplication,
} from "../lib/repositories/applications.ts";

// Migration 005: only the user can record a submission and its follow-up
// statuses; submission time, reference changes and occurredAt are validated
// by the database.

const SUBMISSION_GATE = /SUBMISSION_GATE/;

let t: TestDb;
let jobCounter = 0;
beforeEach(() => {
  t = quietly(freshDb);
});
afterEach(() => t.close());

function readyApplication(): Application {
  jobCounter++;
  const job = recordJobListing(t.db, {
    sourceId: "reed", externalId: `m${jobCounter}`, title: `Dev ${jobCounter}`, company: "Acme",
  });
  const app = createApplication(t.db, { jobId: job.jobId });
  addApplicationAsset(t.db, { applicationId: app.id, kind: "cover_letter", origin: "generated", contentText: "Dear Acme" });
  return transitionApplication(t.db, app.id, "ready_for_review", { actor: "system" });
}

const approve = (id: number) =>
  approveApplication(t.db, id, { reviewedAssetsSha256: getCurrentAssetsHash(t.db, id) });

const approvedApp = () => approve(readyApplication().id);

/** An application approved by the user at a chosen earlier time (via the raw, trigger-checked path). */
function approvedAt(sqliteModifier: string): Application {
  const app = readyApplication();
  rawEvent(app.id, "status_change", "ready_for_review", "approved", "user");
  t.db.prepare(
    `UPDATE applications SET status = 'approved', approved_at = datetime('now', ?),
       approved_assets_sha256 = ?, approved_asset_ids = ? WHERE id = ?`
  ).run(sqliteModifier, getCurrentAssetsHash(t.db, app.id), currentAssetIdSet(t.db, app.id), app.id);
  return getApplication(t.db, app.id)!;
}

function submittingApp(base: Application = approvedApp()): Application {
  return beginSubmission(t.db, base.id, { method: "manual", actor: "user" });
}

function submittedApp(): Application {
  const app = submittingApp();
  return recordSubmissionResult(t.db, app.id, { success: true, reference: "REF" }, "user");
}

function rawEvent(
  applicationId: number,
  eventType: string,
  from: string | null,
  to: string | null,
  actor: string,
  payload?: unknown
) {
  t.db.prepare(
    `INSERT INTO application_events (application_id, event_type, from_status, to_status, actor, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(applicationId, eventType, from, to, actor, payload === undefined ? null : JSON.stringify(payload));
}

const raw = (sql: string, ...params: unknown[]) => () => t.db.prepare(sql).run(...params);
const status = (id: number) => getApplication(t.db, id)!.status;
const sqlNow = (modifier = "+0 seconds") =>
  (t.db.prepare("SELECT datetime('now', ?) AS v").get(modifier) as { v: string }).v;

describe("005 — only the user records submission and post-submission statuses", () => {
  test("a manual submission recorded by the user is accepted", () => {
    const app = submittedApp();
    assert.equal(app.status, "submitted");
    assert.equal(app.submissionMethod, "manual");
    assert.equal(app.submissionReference, "REF");
    assert.notEqual(app.submittedAt, null);
    const events = listApplicationEvents(t.db, app.id).filter((e) => ["submitting", "submitted"].includes(e.toStatus ?? ""));
    assert.deepEqual(events.map((e) => [e.eventType, e.toStatus, e.actor]), [
      ["status_change", "submitting", "user"],
      ["submission_attempt", "submitted", "user"],
    ]);
  });

  test("system and scheduler cannot start a submission", () => {
    for (const actor of ["system", "scheduler"] as const) {
      const app = approvedApp();
      assert.throws(() => beginSubmission(t.db, app.id, { method: "manual", actor }), SUBMISSION_GATE);
      assert.equal(status(app.id), "approved");
      assert.equal(listApplicationEvents(t.db, app.id).some((e) => e.toStatus === "submitting"), false);
    }
  });

  test("system and scheduler cannot record a successful submission", () => {
    for (const actor of ["system", "scheduler"] as const) {
      const app = submittingApp();
      assert.throws(() => recordSubmissionResult(t.db, app.id, { success: true, reference: "X" }, actor), SUBMISSION_GATE);
      assert.equal(status(app.id), "submitting");
      assert.equal(getApplication(t.db, app.id)!.submittedAt, null);
    }
  });

  test("no non-user actor can write a submission or post-submission status event", () => {
    const app = approvedApp();
    for (const actor of ["system", "scheduler", "migration"]) {
      for (const to of ["submitting", "submitted", "acknowledged", "interviewing", "offer", "unsuccessful"]) {
        assert.throws(() => rawEvent(app.id, "status_change", "approved", to, actor), SUBMISSION_GATE, `${actor} → ${to}`);
      }
      assert.throws(() => rawEvent(app.id, "submission_attempt", "submitting", "submitted", actor), SUBMISSION_GATE);
    }
  });

  test("post-submission updates by system or scheduler are refused; by the user they work", () => {
    const app = submittedApp();
    for (const actor of ["system", "scheduler"] as const) {
      assert.throws(() => transitionApplication(t.db, app.id, "acknowledged", { actor }), SUBMISSION_GATE);
    }
    assert.equal(status(app.id), "submitted");
    assert.equal(transitionApplication(t.db, app.id, "acknowledged", { actor: "user" }).status, "acknowledged");
    assert.throws(() => transitionApplication(t.db, app.id, "interviewing", { actor: "system" }), SUBMISSION_GATE);
    assert.equal(transitionApplication(t.db, app.id, "interviewing", { actor: "user" }).status, "interviewing");
    assert.throws(() => transitionApplication(t.db, app.id, "offer", { actor: "scheduler" }), SUBMISSION_GATE);
    assert.equal(transitionApplication(t.db, app.id, "offer", { actor: "user" }).status, "offer");
  });

  test("withdrawing after submission is the user's alone; earlier withdrawals are unchanged", () => {
    for (const reach of [(id: number) => id, (id: number) => transitionApplication(t.db, id, "interviewing", { actor: "user" }).id]) {
      const app = submittedApp();
      reach(app.id);
      assert.throws(() => transitionApplication(t.db, app.id, "withdrawn", { actor: "system" }), SUBMISSION_GATE);
      assert.equal(transitionApplication(t.db, app.id, "withdrawn", { actor: "user" }).status, "withdrawn");
    }
    // Before submission, 005 does not change who may withdraw.
    assert.equal(transitionApplication(t.db, readyApplication().id, "withdrawn", { actor: "system" }).status, "withdrawn");
    assert.equal(transitionApplication(t.db, approvedApp().id, "withdrawn", { actor: "system" }).status, "withdrawn");
  });

  test("recording a failed automated attempt is unaffected", () => {
    const app = submittingApp();
    assert.equal(recordSubmissionResult(t.db, app.id, { success: false, error: "Site down" }).status, "submission_failed");
  });
});

describe("005 — submitted requires a submission method", () => {
  test("a submission without a method is refused", () => {
    const app = submittingApp();
    t.db.prepare("UPDATE applications SET submission_method = NULL WHERE id = ?").run(app.id);
    rawEvent(app.id, "submission_attempt", "submitting", "submitted", "user");
    assert.throws(
      raw("UPDATE applications SET status = 'submitted', submitted_at = datetime('now') WHERE id = ?", app.id),
      /submitted requires a submission method/
    );
    assert.equal(status(app.id), "submitting");
  });
});

describe("005 — submitted_at", () => {
  const submitAt = (id: number, value: unknown) =>
    raw("UPDATE applications SET status = 'submitted', submitted_at = ? WHERE id = ?", value, id);
  const INVALID = /submitted_at must be a valid time/;

  test("must be a real UTC 'YYYY-MM-DD HH:MM:SS' time", () => {
    const app = submittingApp();
    rawEvent(app.id, "submission_attempt", "submitting", "submitted", "user");
    for (const value of [
      "2026-10-03T10:00:00Z", "2026-10-03 10:00", "03/10/2026 10:00:00", "tampered", "",
      "2026-02-30 10:00:00", "2026-13-01 10:00:00", "2026-10-03 24:00:00", 1700000000,
    ]) {
      assert.throws(submitAt(app.id, value), INVALID, String(value));
    }
    assert.equal(status(app.id), "submitting");
  });

  test("cannot be in the future", () => {
    const app = submittingApp();
    rawEvent(app.id, "submission_attempt", "submitting", "submitted", "user");
    assert.throws(submitAt(app.id, sqlNow("+1 minute")), INVALID);
    assert.throws(submitAt(app.id, sqlNow("+1 day")), INVALID);
  });

  test("cannot be before the approval; the approval time itself is accepted", () => {
    const app = submittingApp(approvedAt("-2 hours"));
    rawEvent(app.id, "submission_attempt", "submitting", "submitted", "user");
    const approved = getApplication(t.db, app.id)!.approvedAt!;
    const minuteBefore = (t.db.prepare("SELECT datetime(?, '-1 minute') AS v").get(approved) as { v: string }).v;
    assert.throws(submitAt(app.id, minuteBefore), INVALID);
    submitAt(app.id, approved)();
    assert.equal(getApplication(t.db, app.id)!.submittedAt, approved);
  });

  test("an earlier time between approval and now is accepted", () => {
    const app = submittingApp(approvedAt("-2 hours"));
    rawEvent(app.id, "submission_attempt", "submitting", "submitted", "user");
    const anHourAgo = sqlNow("-1 hour");
    submitAt(app.id, anHourAgo)();
    const after = getApplication(t.db, app.id)!;
    assert.equal(after.status, "submitted");
    assert.equal(after.submittedAt, anHourAgo);
  });

  test("once set it stays read-only (004), even to another valid time", () => {
    const app = submittedApp();
    assert.throws(raw("UPDATE applications SET submitted_at = datetime('now', '-1 minute') WHERE id = ?", app.id), /IMMUTABLE/);
    assert.throws(raw("UPDATE applications SET submitted_at = 'tampered' WHERE id = ?", app.id), /IMMUTABLE/);
  });
});

describe("005 — submission reference", () => {
  const setReference = (id: number, value: string | null) =>
    raw("UPDATE applications SET submission_reference = ? WHERE id = ?", value, id);
  const refEvent = (id: number, from: string | null, to: string | null, actor = "user", field = "submission_reference") =>
    rawEvent(id, "external_update", null, null, actor, { field, from, to });
  const AUDIT = /AUDIT: a submission reference/;

  test("is set as part of the submission", () => {
    assert.equal(submittedApp().submissionReference, "REF");
  });

  test("changing it later requires the user's matching event, every time", () => {
    const app = submittedApp();
    assert.throws(setReference(app.id, "NEW"), AUDIT);

    refEvent(app.id, "REF", "NEW");
    setReference(app.id, "NEW")();
    assert.equal(getApplication(t.db, app.id)!.submissionReference, "NEW");

    assert.throws(setReference(app.id, "NEWER"), AUDIT); // the previous event does not cover a second change
    refEvent(app.id, "NEW", null);
    setReference(app.id, null)(); // clearing is a change too
    assert.equal(getApplication(t.db, app.id)!.submissionReference, null);
  });

  test("a mismatching, non-user or superseded event does not authorise a change", () => {
    const app = submittedApp();
    refEvent(app.id, "REF", "NEW", "system");
    assert.throws(setReference(app.id, "NEW"), AUDIT);
    refEvent(app.id, "REF", "OTHER");
    assert.throws(setReference(app.id, "NEW"), AUDIT);
    refEvent(app.id, "WRONG", "NEW");
    assert.throws(setReference(app.id, "NEW"), AUDIT);
    refEvent(app.id, "REF", "NEW", "user", "notes");
    assert.throws(setReference(app.id, "NEW"), AUDIT);
    refEvent(app.id, "REF", "NEW");
    rawEvent(app.id, "note", null, null, "user");
    assert.throws(setReference(app.id, "NEW"), AUDIT);
    assert.equal(getApplication(t.db, app.id)!.submissionReference, "REF");
  });

  test("cannot be set before submission, even with an event", () => {
    for (const app of [approvedApp(), submittingApp()]) {
      refEvent(app.id, null, "X");
      assert.throws(setReference(app.id, "X"), AUDIT);
    }
  });

  test("other columns of a submitted application are unaffected", () => {
    const app = submittedApp();
    t.db.prepare("UPDATE applications SET notes = 'Called the recruiter' WHERE id = ?").run(app.id);
    assert.equal(getApplication(t.db, app.id)!.notes, "Called the recruiter");
  });
});

describe("005 — occurredAt in event payloads", () => {
  const INVALID = /occurredAt must be a valid time/;
  const noteAt = (id: number, occurredAt: unknown) => () => rawEvent(id, "note", null, null, "user", { occurredAt });

  test("is accepted after submission when valid (from submission time up to now)", () => {
    const app = submittingApp(approvedAt("-3 hours"));
    rawEvent(app.id, "submission_attempt", "submitting", "submitted", "user");
    const twoHoursAgo = sqlNow("-2 hours");
    t.db.prepare("UPDATE applications SET status = 'submitted', submitted_at = ? WHERE id = ?").run(twoHoursAgo, app.id);
    noteAt(app.id, twoHoursAgo)();
    noteAt(app.id, sqlNow("-1 hour"))();
    noteAt(app.id, sqlNow())();
    // ...including on a status change event.
    rawEvent(app.id, "status_change", "submitted", "interviewing", "user", { occurredAt: sqlNow("-30 minutes") });
    t.db.prepare("UPDATE applications SET status = 'interviewing' WHERE id = ?").run(app.id);
    assert.equal(status(app.id), "interviewing");
  });

  test("is refused when malformed, in the future, before submission, or not text", () => {
    const app = submittingApp(approvedAt("-3 hours"));
    rawEvent(app.id, "submission_attempt", "submitting", "submitted", "user");
    const twoHoursAgo = sqlNow("-2 hours");
    t.db.prepare("UPDATE applications SET status = 'submitted', submitted_at = ? WHERE id = ?").run(twoHoursAgo, app.id);
    for (const value of ["2026-10-03T10:00:00Z", "tomorrow", "", "2026-02-30 10:00:00", 1700000000, true, { at: 1 }]) {
      assert.throws(noteAt(app.id, value), INVALID, JSON.stringify(value));
    }
    assert.throws(noteAt(app.id, sqlNow("+1 minute")), INVALID);
    assert.throws(noteAt(app.id, sqlNow("-3 hours")), INVALID); // before submitted_at
  });

  test("is refused before the application has been submitted", () => {
    for (const app of [readyApplication(), approvedApp(), submittingApp()]) {
      assert.throws(noteAt(app.id, sqlNow("-1 minute")), INVALID);
    }
  });

  test("events without occurredAt are unaffected", () => {
    const app = approvedApp();
    rawEvent(app.id, "note", null, null, "user");
    rawEvent(app.id, "note", null, null, "user", { other: "value" });
    rawEvent(app.id, "note", null, null, "user", { occurredAt: null });
    assert.equal(listApplicationEvents(t.db, app.id).filter((e) => e.eventType === "note").length, 3);
  });
});

describe("005 — the 002/004 guards still hold", () => {
  test("only the user (or the legacy import) can record an approval", () => {
    const app = readyApplication();
    assert.throws(() => rawEvent(app.id, "status_change", "ready_for_review", "approved", "system"), /CHECK constraint/);
  });

  test("content is locked from submission onward", () => {
    for (const app of [submittingApp(), submittedApp()]) {
      assert.throws(
        () => addApplicationAsset(t.db, { applicationId: app.id, kind: "cover_letter", origin: "user_edit", contentText: "Late" }),
        /ASSETS_LOCKED/
      );
    }
  });

  test("the approval snapshot cannot change after submission", () => {
    const app = submittedApp();
    for (const column of ["approved_at", "approved_assets_sha256", "approved_asset_ids"]) {
      assert.throws(raw(`UPDATE applications SET ${column} = 'tampered' WHERE id = ?`, app.id), /IMMUTABLE/);
    }
  });

  test("submission still requires a current user approval, for the user too", () => {
    const app = approvedApp();
    addApplicationAsset(t.db, { applicationId: app.id, kind: "cover_letter", origin: "user_edit", contentText: "Edited" });
    assert.equal(status(app.id), "ready_for_review"); // approval withdrawn by 002
    assert.throws(() => beginSubmission(t.db, app.id, { method: "manual", actor: "user" }), { code: "APPROVAL_REQUIRED" });
    rawEvent(app.id, "status_change", "ready_for_review", "submitting", "user");
    assert.throws(raw("UPDATE applications SET status = 'submitting' WHERE id = ?", app.id), /APPROVAL_GATE/);
  });

  test("post-submission statuses still require a real submission, for the user too", () => {
    const app = approvedApp();
    rawEvent(app.id, "status_change", "approved", "acknowledged", "user");
    assert.throws(raw("UPDATE applications SET status = 'acknowledged' WHERE id = ?", app.id), /SUBMISSION_GATE/);
    assert.equal(status(app.id), "approved");
  });
});
