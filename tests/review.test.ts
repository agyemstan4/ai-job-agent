import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { TestDb } from "./helpers.ts";
import { createLegacyDbFile, freshDb, makeTempDir, quietly, removeTempDir } from "./helpers.ts";
import { saveBatchApplications } from "../lib/pipeline/applications.ts";
import { applyReviewAction, httpStatusFor, parseReviewAction } from "../lib/pipeline/review.ts";
import { getReviewItem, listReviewItems, REVIEW_FILTERS } from "../lib/repositories/review.ts";
import { createCandidate, createProfileVersion } from "../lib/repositories/candidates.ts";
import { recordJobListing } from "../lib/repositories/jobs.ts";
import { recordMatch } from "../lib/repositories/matches.ts";
import {
  beginSubmission,
  getApplication,
  getCurrentAssetsHash,
  listApplicationEvents,
  listAssetVersions,
} from "../lib/repositories/applications.ts";
import { PersistenceError } from "../lib/repositories/shared.ts";
import { openDatabase } from "../lib/database.ts";

let t: TestDb;
let appId: number;
let secondAppId: number;
beforeEach(() => {
  t = quietly(freshDb);
  const c = createCandidate(t.db, { fullName: "A" });
  const profileId = createProfileVersion(t.db, { candidateId: c.id, origin: "ai_extraction", analysis: {}, structuredCv: {} }).id;
  const job = recordJobListing(t.db, {
    sourceId: "adzuna", externalId: "1", title: "Junior Dev", company: "Acme", location: "London",
    url: "https://example.com/job/1", salaryMin: 30000, salaryMax: 35000,
  }).jobId;
  const other = recordJobListing(t.db, { sourceId: "reed", externalId: "2", title: "Android Dev", company: "Beta" }).jobId;
  const matchId = recordMatch(t.db, { jobId: job, candidateProfileId: profileId, outcome: "scored", score: 74, reason: "Kotlin" }).id;
  const { saved } = saveBatchApplications(t.db, {
    candidateProfileId: profileId,
    results: [
      { jobId: job, matchId, success: true, coverLetter: "Dear Acme", cvFile: Buffer.from("%PDF"), cvFilename: "CV_Acme.pdf", tailoredCv: { a: 1 } },
      { jobId: other, success: true, coverLetter: "Dear Beta" },
    ],
  });
  appId = saved[0].applicationId!;
  secondAppId = saved[1].applicationId!;
});
afterEach(() => t.close());

const act = (id: number, body: unknown) => applyReviewAction(t.db, id, parseReviewAction(body));

function refusal(fn: () => unknown): { status: number; message: string } {
  try {
    fn();
  } catch (error) {
    return { status: httpStatusFor(error), message: error instanceof Error ? error.message : String(error) };
  }
  throw new Error("expected a refusal");
}

describe("review read model", () => {
  test("a review item has the job, match, current content and its hash", () => {
    const item = getReviewItem(t.db, appId)!;
    assert.equal(item.status, "ready_for_review");
    assert.equal(item.job.title, "Junior Dev");
    assert.equal(item.job.company, "Acme");
    assert.equal(item.job.location, "London");
    assert.equal(item.job.salaryMin, 30000);
    assert.equal(item.job.url, "https://example.com/job/1");
    assert.deepEqual(item.match && { score: item.match.score, reason: item.match.reason }, { score: 74, reason: "Kotlin" });
    assert.equal(item.coverLetter!.text, "Dear Acme");
    assert.equal(item.cvFile!.filename, "CV_Acme.pdf");
    assert.equal(item.hasTailoredCvData, true);
    assert.equal(item.assetsHash, getCurrentAssetsHash(t.db, appId));
    assert.equal(item.isLegacyImport, false);

    const second = getReviewItem(t.db, secondAppId)!;
    assert.equal(second.match, null);
    assert.equal(second.cvFile, null);
    assert.equal(second.job.url, null);
  });

  test("filters map to application statuses", () => {
    assert.equal(listReviewItems(t.db, REVIEW_FILTERS.pending).length, 2);
    act(appId, { action: "reject" });
    assert.deepEqual(listReviewItems(t.db, REVIEW_FILTERS.pending).map((i) => i.id), [secondAppId]);
    assert.deepEqual(listReviewItems(t.db, REVIEW_FILTERS.rejected).map((i) => i.id), [appId]);
    assert.equal(listReviewItems(t.db, REVIEW_FILTERS.all).length, 2);
    assert.equal(listReviewItems(t.db, REVIEW_FILTERS.approved).length, 0);
  });
});

describe("review actions and the approval gate", () => {
  test("approving the content that was shown records an explicit user approval — and submits nothing", () => {
    const shown = getReviewItem(t.db, appId)!;
    const item = act(appId, { action: "approve", reviewedAssetsSha256: shown.assetsHash, note: "Looks good" });
    assert.equal(item.status, "approved");
    assert.equal(item.notes, "Looks good");

    const app = getApplication(t.db, appId)!;
    assert.equal(app.approvedAssetsSha256, shown.assetsHash);
    assert.notEqual(app.approvedAssetIds, null);
    assert.equal(app.submittedAt, null);
    const events = listApplicationEvents(t.db, appId);
    const approval = events.at(-1)!;
    assert.deepEqual([approval.eventType, approval.toStatus, approval.actor], ["status_change", "approved", "user"]);
    assert.equal(events.at(-2)!.eventType, "note");
  });

  test("approval with a stale or missing hash is refused (409/400)", () => {
    const stale = refusal(() => act(appId, { action: "approve", reviewedAssetsSha256: "not-the-hash" }));
    assert.equal(stale.status, 409);
    assert.match(stale.message, /changed after it was reviewed/);
    assert.equal(refusal(() => act(appId, { action: "approve" })).status, 400);
    assert.equal(getApplication(t.db, appId)!.status, "ready_for_review");
  });

  test("content edited after the reviewer loaded it cannot be approved with the old hash", () => {
    const shown = getReviewItem(t.db, appId)!;
    act(appId, { action: "edit_cover_letter", coverLetter: "Dear Acme, edited" });
    assert.equal(refusal(() => act(appId, { action: "approve", reviewedAssetsSha256: shown.assetsHash })).status, 409);
    const fresh = getReviewItem(t.db, appId)!;
    assert.equal(act(appId, { action: "approve", reviewedAssetsSha256: fresh.assetsHash }).status, "approved");
  });

  test("editing the cover letter adds a new version; after approval it withdraws the approval", () => {
    const shown = getReviewItem(t.db, appId)!;
    act(appId, { action: "approve", reviewedAssetsSha256: shown.assetsHash });
    const edited = act(appId, { action: "edit_cover_letter", coverLetter: "Dear Acme, v2" });

    assert.equal(edited.status, "ready_for_review");
    assert.equal(edited.coverLetter!.text, "Dear Acme, v2");
    assert.equal(edited.coverLetter!.version, 2);
    assert.equal(edited.coverLetter!.origin, "user_edit");
    assert.equal(getApplication(t.db, appId)!.approvedAt, null);
    assert.deepEqual(listAssetVersions(t.db, appId, "cover_letter").map((a) => a.contentText), ["Dear Acme, v2", "Dear Acme"]);
  });

  test("reject and withdraw, including from approved", () => {
    const shown = getReviewItem(t.db, appId)!;
    act(appId, { action: "approve", reviewedAssetsSha256: shown.assetsHash });
    const rejected = act(appId, { action: "reject", note: "Changed my mind" });
    assert.equal(rejected.status, "rejected");
    assert.equal(getApplication(t.db, appId)!.approvedAt, null);

    assert.equal(act(secondAppId, { action: "withdraw" }).status, "withdrawn");
  });

  test("invalid transitions, unknown actions and unknown applications are refused", () => {
    act(appId, { action: "reject" });
    assert.equal(refusal(() => act(appId, { action: "reject" })).status, 409);
    assert.equal(refusal(() => act(appId, { action: "approve", reviewedAssetsSha256: "x" })).status, 409);
    assert.equal(refusal(() => act(appId, { action: "submit" })).status, 400);
    assert.equal(refusal(() => act(appId, { action: "note", note: "  " })).status, 400);
    assert.equal(refusal(() => act(appId, { action: "edit_cover_letter", coverLetter: "" })).status, 400);
    assert.equal(refusal(() => act(424242, { action: "reject" })).status, 404);
  });

  test("the database's own gate refusals map to 409", () => {
    assert.equal(httpStatusFor(new Error("APPROVAL_GATE: approval must be recorded by the user")), 409);
    assert.equal(httpStatusFor(new Error("ASSETS_LOCKED: …")), 409);
    assert.equal(httpStatusFor(new PersistenceError("STALE_REVIEW", "x")), 409);
    assert.equal(httpStatusFor(new Error("disk I/O error")), 500);
  });

  test("submission still requires the explicit approval (the review flow never submits)", () => {
    assert.throws(() => beginSubmission(t.db, appId, { method: "manual", actor: "user" }), /APPROVAL_REQUIRED|approved/);
    const shown = getReviewItem(t.db, appId)!;
    act(appId, { action: "approve", reviewedAssetsSha256: shown.assetsHash });
    assert.equal(getApplication(t.db, appId)!.status, "approved");
  });

  test("a note on its own is saved as an event", () => {
    const item = act(secondAppId, { action: "note", note: "Call recruiter" });
    assert.equal(item.notes, "Call recruiter");
    assert.equal(listApplicationEvents(t.db, secondAppId).at(-1)!.eventType, "note");
  });
});

describe("legacy-imported applications", () => {
  test("rows imported from batch_results appear in the review queue", () => {
    const dir = makeTempDir();
    try {
      const file = createLegacyDbFile(dir, (db) => {
        db.prepare("INSERT INTO batch_runs (job_count) VALUES (1)").run();
        db.prepare(
          `INSERT INTO batch_results (batch_run_id, job_title, job_company, job_url, match_score, cover_letter, status)
           VALUES (1, 'Old Role', 'Old Co', 'https://example.com/old', 61, 'Old letter', 'approved')`
        ).run();
      });
      const db = quietly(() => openDatabase(file));
      try {
        const [item] = listReviewItems(db, REVIEW_FILTERS.approved);
        assert.equal(item.isLegacyImport, true);
        assert.equal(item.job.title, "Old Role");
        assert.equal(item.job.url, "https://example.com/old");
        assert.equal(item.match!.score, 61);
        assert.equal(item.coverLetter!.text, "Old letter");
        // Moving an imported approval to rejected works like any other.
        assert.equal(applyReviewAction(db, item.id, { action: "reject" }).status, "rejected");
      } finally {
        db.close();
      }
    } finally {
      removeTempDir(dir);
    }
  });
});
