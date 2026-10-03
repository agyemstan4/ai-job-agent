import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TestDb } from "./helpers.ts";
import { count, freshDb, quietly } from "./helpers.ts";
import { applyReviewAction, clientErrorMessage, httpStatusFor, parseReviewAction } from "../lib/pipeline/review.ts";
import type { ReviewItem } from "../lib/repositories/review.ts";
import { getReviewItem, isTrackerFilter, listTrackerItems, REVIEW_FILTERS, TRACKER_FILTERS } from "../lib/repositories/review.ts";
import { recordJobListing } from "../lib/repositories/jobs.ts";
import type { Application } from "../lib/repositories/applications.ts";
import {
  addApplicationAsset,
  createApplication,
  currentAssetIdSet,
  getApplication,
  getCurrentAssetsHash,
  listApplicationEvents,
  transitionApplication,
} from "../lib/repositories/applications.ts";
import { PersistenceError } from "../lib/repositories/shared.ts";

// Phase 2 checkpoint 2c: the tracking actions of PATCH /api/applications/[id]
// (parseReviewAction → applyReviewAction → httpStatusFor/clientErrorMessage,
// exactly what the route does) and the tracker read model behind
// GET /api/applications?status=to_apply|applied|closed|tracked.

let t: TestDb;
let jobCounter = 0;
beforeEach(() => {
  t = quietly(freshDb);
});
afterEach(() => t.close());

function readyApplication(): Application {
  jobCounter++;
  const job = recordJobListing(t.db, {
    sourceId: "adzuna", externalId: `api${jobCounter}`, title: `Role ${jobCounter}`, company: "Acme", url: `https://example.com/${jobCounter}`,
  });
  const app = createApplication(t.db, { jobId: job.jobId });
  addApplicationAsset(t.db, { applicationId: app.id, kind: "cover_letter", origin: "generated", contentText: "Dear Acme" });
  return transitionApplication(t.db, app.id, "ready_for_review", { actor: "system" });
}

const act = (id: number, body: unknown): ReviewItem => applyReviewAction(t.db, id, parseReviewAction(body));
const item = (id: number) => getReviewItem(t.db, id)!;

/** What the route would answer for this request: status and message. */
function answer(id: number, body: unknown): { status: number; message: string } {
  try {
    act(id, body);
    return { status: 200, message: "" };
  } catch (error) {
    return { status: httpStatusFor(error), message: clientErrorMessage(error, "Failed to update application") };
  }
}

function approvedApp(): ReviewItem {
  const app = readyApplication();
  return act(app.id, { action: "approve", reviewedAssetsSha256: item(app.id).assetsHash });
}

/** Approved by the user at an earlier time (through the trigger-checked raw path). */
function approvedAt(sqliteModifier: string): ReviewItem {
  const app = readyApplication();
  t.db.prepare(
    `INSERT INTO application_events (application_id, event_type, from_status, to_status, actor)
     VALUES (?, 'status_change', 'ready_for_review', 'approved', 'user')`
  ).run(app.id);
  t.db.prepare(
    `UPDATE applications SET status = 'approved', approved_at = datetime('now', ?),
       approved_assets_sha256 = ?, approved_asset_ids = ? WHERE id = ?`
  ).run(sqliteModifier, getCurrentAssetsHash(t.db, app.id), currentAssetIdSet(t.db, app.id), app.id);
  return item(app.id);
}

const markSubmitted = (app: ReviewItem, extra: Record<string, unknown> = {}) =>
  act(app.id, { action: "mark_submitted", confirm: true, reviewedAssetsSha256: app.assetsHash, ...extra });

function submittedApp(extra: Record<string, unknown> = {}): ReviewItem {
  return markSubmitted(approvedApp(), extra);
}

const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
const stored = (iso: string) => iso.replace("T", " ").slice(0, 19);
const eventCount = (id: number) => count(t.db, "application_events", "application_id = ?", id);

describe("PATCH mark_submitted", () => {
  test("records an approved application as applied by the user (manual)", () => {
    const app = approvedApp();
    assert.equal(app.trackerGroup, "to_apply");
    const done = markSubmitted(app);
    assert.equal(done.status, "submitted");
    assert.equal(done.trackerGroup, "applied");
    assert.equal(done.submission!.method, "manual");
    assert.equal(done.submission!.submittedContent, "as_approved");
    assert.deepEqual(done.nextStatuses, ["acknowledged", "interviewing", "offer", "unsuccessful", "withdrawn"]);
    assert.deepEqual(done.statusHistory.slice(-2).map((h) => [h.toStatus, h.actor]), [["submitting", "user"], ["submitted", "user"]]);
  });

  test("an earlier submittedAt (ISO UTC or the stored form) is kept", () => {
    const iso = isoAgo(60 * 60 * 1000);
    assert.equal(markSubmitted(approvedAt("-3 hours"), { submittedAt: iso }).submission!.submittedAt, stored(iso));
    const plain = stored(isoAgo(2 * 60 * 60 * 1000));
    assert.equal(markSubmitted(approvedAt("-3 hours"), { submittedAt: plain }).submission!.submittedAt, plain);
  });

  test("an optional reference and note, and the modified-externally marker", () => {
    const done = submittedApp({
      reference: " PORTAL-77 ",
      note: "Applied through Workday",
      submittedContent: "modified_externally",
      externalChanges: "Trimmed the cover letter to 250 words",
    });
    assert.equal(done.submission!.reference, "PORTAL-77");
    assert.equal(done.notes, "Applied through Workday");
    assert.equal(done.submission!.submittedContent, "modified_externally");
    assert.equal(done.submission!.externalChanges, "Trimmed the cover letter to 250 words");
    // The note is recorded once, by the repository.
    assert.equal(listApplicationEvents(t.db, done.id).filter((e) => e.eventType === "note").length, 1);
  });

  test("is never implicit: without confirm: true nothing is recorded (400)", () => {
    const app = approvedApp();
    const events = eventCount(app.id);
    for (const confirm of [undefined, false, "true", 1]) {
      const body = { action: "mark_submitted", reviewedAssetsSha256: app.assetsHash, ...(confirm === undefined ? {} : { confirm }) };
      assert.equal(answer(app.id, body).status, 400, String(confirm));
    }
    assert.equal(eventCount(app.id), events);
    assert.equal(item(app.id).status, "approved");
  });

  test("refusals, with nothing written", () => {
    const app = approvedAt("-2 hours");
    const events = eventCount(app.id);
    const mark = (extra: Record<string, unknown>) =>
      answer(app.id, { action: "mark_submitted", confirm: true, reviewedAssetsSha256: app.assetsHash, ...extra });

    assert.equal(answer(app.id, { action: "mark_submitted", confirm: true }).status, 400); // no hash
    const stale = mark({ reviewedAssetsSha256: "stale-hash" });
    assert.deepEqual([stale.status, /not the approved content/.test(stale.message)], [409, true]);
    assert.equal(mark({ submittedAt: new Date(Date.now() + 60_000).toISOString() }).status, 400); // future
    const beforeApproval = mark({ submittedAt: isoAgo(3 * 60 * 60 * 1000) });
    assert.deepEqual([beforeApproval.status, /before the approval/.test(beforeApproval.message)], [400, true]);
    for (const submittedAt of ["2026-10-03 10:00", "2026-10-03T10:00:00", "2026-10-03T10:00:00+01:00", "2026-02-30T10:00:00Z", "yesterday", 1700000000]) {
      assert.equal(mark({ submittedAt }).status, 400, String(submittedAt));
    }
    assert.equal(mark({ submittedContent: "sent_by_robot" }).status, 400);
    assert.equal(mark({ submittedContent: "modified_externally" }).status, 400);
    assert.equal(mark({ externalChanges: "Changed it" }).status, 400);
    assert.equal(mark({ reference: 12345 }).status, 400);
    assert.equal(mark({ reference: "x".repeat(201) }).status, 400);
    assert.equal(eventCount(app.id), events);
    assert.equal(item(app.id).status, "approved");
  });

  test("an application that is not approved, or already applied, is refused (409)", () => {
    const ready = readyApplication();
    assert.equal(answer(ready.id, { action: "mark_submitted", confirm: true, reviewedAssetsSha256: item(ready.id).assetsHash }).status, 409);

    const withdrawnApproval = approvedApp();
    act(withdrawnApproval.id, { action: "edit_cover_letter", coverLetter: "Edited after approval" }); // revokes the approval
    assert.equal(answer(withdrawnApproval.id, { action: "mark_submitted", confirm: true, reviewedAssetsSha256: withdrawnApproval.assetsHash }).status, 409);

    const done = submittedApp();
    assert.equal(answer(done.id, { action: "mark_submitted", confirm: true, reviewedAssetsSha256: done.assetsHash }).status, 409);
    assert.equal(answer(424242, { action: "mark_submitted", confirm: true, reviewedAssetsSha256: "x" }).status, 404);
  });
});

describe("PATCH update_status", () => {
  test("acknowledged → interviewing → offer → withdrawn (with a note), each the user's", () => {
    const app = submittedApp();
    assert.equal(act(app.id, { action: "update_status", to: "acknowledged" }).status, "acknowledged");
    const interviewing = act(app.id, { action: "update_status", to: "interviewing" });
    assert.deepEqual(interviewing.nextStatuses, ["offer", "unsuccessful", "withdrawn"]);
    const offer = act(app.id, { action: "update_status", to: "offer" });
    assert.deepEqual(offer.nextStatuses, ["withdrawn"]);
    const withdrawn = act(app.id, { action: "update_status", to: "withdrawn", note: "Accepted another offer" });
    assert.equal(withdrawn.status, "withdrawn");
    assert.equal(withdrawn.trackerGroup, "closed");
    assert.deepEqual(withdrawn.nextStatuses, []);
    assert.equal(withdrawn.notes, "Accepted another offer");
    assert.ok(withdrawn.statusHistory.slice(-4).every((h) => h.actor === "user"));
  });

  test("submitted → unsuccessful, which is final", () => {
    const app = submittedApp();
    const done = act(app.id, { action: "update_status", to: "unsuccessful" });
    assert.equal(done.trackerGroup, "closed");
    assert.equal(answer(app.id, { action: "update_status", to: "withdrawn", note: "x" }).status, 409);
  });

  test("an optional occurredAt is recorded; future or before submission is refused (400)", () => {
    const app = markSubmitted(approvedAt("-3 hours"), { submittedAt: isoAgo(2 * 60 * 60 * 1000) });
    const events = eventCount(app.id);
    assert.equal(answer(app.id, { action: "update_status", to: "interviewing", occurredAt: new Date(Date.now() + 60_000).toISOString() }).status, 400);
    assert.equal(answer(app.id, { action: "update_status", to: "interviewing", occurredAt: isoAgo(150 * 60 * 1000) }).status, 400);
    assert.equal(answer(app.id, { action: "update_status", to: "interviewing", occurredAt: "next Tuesday" }).status, 400);
    assert.equal(eventCount(app.id), events);
    const when = isoAgo(30 * 60 * 1000);
    const done = act(app.id, { action: "update_status", to: "interviewing", occurredAt: when });
    assert.equal(done.statusHistory.at(-1)!.occurredAt, stored(when));
  });

  test("backward moves (409), updates before submission (409) and unknown statuses (400) are refused", () => {
    const app = submittedApp();
    act(app.id, { action: "update_status", to: "interviewing" });
    assert.equal(answer(app.id, { action: "update_status", to: "acknowledged" }).status, 409);
    for (const to of ["offer_accepted", "submitted", "approved", "", undefined, 3]) {
      assert.equal(answer(app.id, { action: "update_status", to }).status, 400, String(to));
    }
    const approved = approvedApp();
    assert.equal(answer(approved.id, { action: "update_status", to: "acknowledged" }).status, 409);
  });

  test("withdrawing after applying requires a note explaining why (400 without one)", () => {
    const app = submittedApp();
    for (const note of [undefined, "", "   "]) {
      assert.equal(answer(app.id, { action: "update_status", to: "withdrawn", ...(note === undefined ? {} : { note }) }).status, 400);
    }
    assert.equal(item(app.id).status, "submitted");
    assert.equal(act(app.id, { action: "update_status", to: "withdrawn", note: "Marked as applied by mistake" }).status, "withdrawn");
    // The pre-submission review "withdraw" action is unchanged (note optional).
    assert.equal(act(readyApplication().id, { action: "withdraw" }).status, "withdrawn");
  });
});

describe("PATCH set_reference", () => {
  test("adds, edits and clears the reference, each recorded as the user's external_update", () => {
    const app = submittedApp();
    act(app.id, { action: "set_reference", reference: "REF-1" });
    act(app.id, { action: "set_reference", reference: "REF-2" });
    const cleared = act(app.id, { action: "set_reference", reference: null });
    assert.equal(cleared.submission!.reference, null);
    assert.deepEqual(cleared.referenceHistory.map((r) => [r.from, r.to, r.actor]), [[null, "REF-1", "user"], ["REF-1", "REF-2", "user"], ["REF-2", null, "user"]]);
    const updates = listApplicationEvents(t.db, app.id).filter((e) => e.eventType === "external_update");
    assert.equal(updates.length, 3);
    assert.ok(updates.every((e) => e.actor === "user"));
  });

  test("malformed requests (400), before submission (409); a silent SQL change is blocked", () => {
    const app = submittedApp({ reference: "R" });
    assert.equal(answer(app.id, { action: "set_reference" }).status, 400);
    assert.equal(answer(app.id, { action: "set_reference", reference: 42 }).status, 400);
    assert.equal(answer(app.id, { action: "set_reference", reference: "x".repeat(201) }).status, 400);
    assert.equal(answer(approvedApp().id, { action: "set_reference", reference: "R" }).status, 409);
    assert.throws(() => t.db.prepare("UPDATE applications SET submission_reference = 'SILENT' WHERE id = ?").run(app.id), /AUDIT/);
    assert.equal(item(app.id).submission!.reference, "R");
  });
});

describe("tracker read model", () => {
  function scenario() {
    const ready = readyApplication();
    const toApply = approvedApp();
    const applied = submittedApp();
    const interviewing = submittedApp();
    act(interviewing.id, { action: "update_status", to: "interviewing" });
    const unsuccessful = submittedApp();
    act(unsuccessful.id, { action: "update_status", to: "unsuccessful" });
    const withdrawnAfter = submittedApp();
    act(withdrawnAfter.id, { action: "update_status", to: "withdrawn", note: "Changed my mind" });
    const withdrawnBefore = approvedApp();
    act(withdrawnBefore.id, { action: "withdraw" });
    const rejected = readyApplication();
    act(rejected.id, { action: "reject" });
    return { ready, toApply, applied, interviewing, unsuccessful, withdrawnAfter, withdrawnBefore, rejected };
  }

  test("each section holds exactly the right applications, once each", () => {
    const s = scenario();
    const ids = (filter: (typeof TRACKER_FILTERS)[number]) => listTrackerItems(t.db, filter).map((i) => i.id);
    const sorted = (list: number[]) => [...list].sort((a, b) => a - b);
    assert.deepEqual(ids("to_apply"), [s.toApply.id]);
    assert.deepEqual(sorted(ids("applied")), sorted([s.applied.id, s.interviewing.id]));
    assert.deepEqual(sorted(ids("closed")), sorted([s.unsuccessful.id, s.withdrawnAfter.id]));
    const tracked = ids("tracked");
    assert.equal(new Set(tracked).size, tracked.length, "no duplicates");
    assert.deepEqual(sorted(tracked), sorted([s.toApply.id, s.applied.id, s.interviewing.id, s.unsuccessful.id, s.withdrawnAfter.id]));
    for (const untracked of [s.ready, s.withdrawnBefore, s.rejected]) assert.equal(tracked.includes(untracked.id), false);
  });

  test("items agree with the stored application and its events", () => {
    scenario();
    for (const filter of TRACKER_FILTERS) {
      for (const i of listTrackerItems(t.db, filter)) {
        const app = getApplication(t.db, i.id)!;
        assert.equal(i.status, app.status);
        if (filter !== "tracked") assert.equal(i.trackerGroup, filter);
        assert.equal(i.statusHistory.at(-1)!.toStatus, app.status);
        assert.equal(i.submission?.submittedAt ?? null, app.submittedAt);
      }
    }
  });

  test("listing never changes anything (opening the tracker is read-only)", () => {
    scenario();
    const snapshot = () => JSON.stringify([
      t.db.prepare("SELECT * FROM applications ORDER BY id").all(),
      t.db.prepare("SELECT * FROM application_events ORDER BY id").all(),
    ]);
    const before = snapshot();
    for (const filter of TRACKER_FILTERS) listTrackerItems(t.db, filter);
    for (const id of t.db.prepare("SELECT id FROM applications").all() as { id: number }[]) getReviewItem(t.db, id.id);
    assert.equal(snapshot(), before);
  });

  test("tracker and review filters are distinct and recognised", () => {
    for (const f of TRACKER_FILTERS) assert.equal(isTrackerFilter(f), true);
    for (const f of Object.keys(REVIEW_FILTERS)) assert.equal(isTrackerFilter(f), false);
    assert.equal(isTrackerFilter("bogus"), false);
  });
});

describe("safety of the API layer", () => {
  test("unexpected errors never reach the client; known refusals do", () => {
    assert.equal(clientErrorMessage(new Error("SQLITE_IOERR: disk I/O error at C:\\dev\\...\\jobs.db"), "Failed"), "Failed");
    assert.equal(clientErrorMessage("not even an error", "Failed"), "Failed");
    assert.equal(clientErrorMessage(new PersistenceError("STALE_REVIEW", "Review again"), "Failed"), "Review again");
    assert.equal(clientErrorMessage(new Error("SUBMISSION_GATE: only the user"), "Failed"), "SUBMISSION_GATE: only the user");
    assert.equal(httpStatusFor(new PersistenceError("INVALID_TIMESTAMP", "x")), 400);
    assert.equal(httpStatusFor(new PersistenceError("INVALID_INPUT", "x")), 400);
    assert.equal(httpStatusFor(new PersistenceError("APPROVAL_REQUIRED", "x")), 409);
  });

  test("the tracking code never contacts anything outside the database", () => {
    // Marking as applied only records what the user did; it must not submit,
    // open a website, or send anything.
    const root = path.join(import.meta.dirname, "..");
    const files = [
      "lib/pipeline/review.ts",
      "lib/repositories/applications.ts",
      "lib/repositories/review.ts",
      "app/api/applications/route.ts",
      "app/api/applications/[id]/route.ts",
    ];
    for (const file of files) {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      assert.doesNotMatch(
        source,
        /\bfetch\(|from ["']undici["']|from ["']resend["']|child_process|window\.open|XMLHttpRequest|sendEmailCopy/,
        file
      );
    }
  });
});
