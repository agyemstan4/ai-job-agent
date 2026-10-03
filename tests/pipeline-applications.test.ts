import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { TestDb } from "./helpers.ts";
import { count, freshDb, quietly } from "./helpers.ts";
import type { BatchResultInput } from "../lib/pipeline/applications.ts";
import { saveBatchApplications } from "../lib/pipeline/applications.ts";
import { createCandidate, createProfileVersion } from "../lib/repositories/candidates.ts";
import { recordJobListing } from "../lib/repositories/jobs.ts";
import { recordMatch } from "../lib/repositories/matches.ts";
import {
  getApplication,
  getAssetFile,
  getCurrentAssets,
  listApplicationEvents,
  rejectApplication,
} from "../lib/repositories/applications.ts";

let t: TestDb;
let profileId: number;
let jobId: number;
let otherJobId: number;
let matchId: number;
beforeEach(() => {
  t = quietly(freshDb);
  const c = createCandidate(t.db, { fullName: "A" });
  profileId = createProfileVersion(t.db, { candidateId: c.id, origin: "ai_extraction", analysis: {}, structuredCv: {} }).id;
  jobId = recordJobListing(t.db, { sourceId: "adzuna", externalId: "1", title: "Junior Dev", company: "Acme" }).jobId;
  otherJobId = recordJobListing(t.db, { sourceId: "reed", externalId: "2", title: "Android Dev", company: "Beta" }).jobId;
  matchId = recordMatch(t.db, { jobId, candidateProfileId: profileId, outcome: "scored", score: 70 }).id;
});
afterEach(() => t.close());

const CV = Buffer.from("%PDF-1.4 tailored");

function result(overrides: Partial<BatchResultInput> = {}): BatchResultInput {
  return {
    batchResultId: 11,
    jobId,
    matchId,
    success: true,
    coverLetter: "Dear Hiring Manager",
    cvFile: CV,
    cvFilename: "CV_Acme.pdf",
    tailoredCv: { name: "A", summary: "Tailored" },
    ...overrides,
  };
}

const save = (results: BatchResultInput[], candidateProfileId: unknown = profileId) =>
  saveBatchApplications(t.db, { candidateProfileId, results });

describe("saveBatchApplications", () => {
  test("a successful result becomes an application ready for review, with its assets", () => {
    const { saved, warnings } = save([result()]);
    assert.deepEqual(warnings, []);
    assert.equal(saved[0].status, "ready_for_review");
    assert.equal(saved[0].batchResultId, 11);

    const app = getApplication(t.db, saved[0].applicationId!)!;
    assert.equal(app.jobId, jobId);
    assert.equal(app.matchId, matchId);
    assert.equal(app.candidateProfileId, profileId);
    assert.equal(app.legacyBatchResultId, null); // never marked as a legacy import
    assert.equal(app.approvedAt, null);
    assert.equal(app.lastError, null);

    const assets = getCurrentAssets(t.db, app.id);
    assert.deepEqual(assets.map((a) => a.kind).sort(), ["cover_letter", "tailored_cv_data", "tailored_cv_file"]);
    const file = assets.find((a) => a.kind === "tailored_cv_file")!;
    assert.deepEqual(getAssetFile(t.db, file.id), CV);
    assert.equal(file.filename, "CV_Acme.pdf");
    assert.equal(file.mimeType, "application/pdf");
    assert.deepEqual(assets.find((a) => a.kind === "tailored_cv_data")!.contentJson, { name: "A", summary: "Tailored" });
    assert.equal(assets.find((a) => a.kind === "cover_letter")!.contentText, "Dear Hiring Manager");
    assert.ok(assets.every((a) => a.origin === "generated" && a.version === 1));

    const events = listApplicationEvents(t.db, app.id);
    assert.deepEqual(
      events.map((e) => [e.eventType, e.toStatus, e.actor]),
      [
        ["status_change", "preparing", "system"],
        ["asset_generated", null, "system"],
        ["asset_generated", null, "system"],
        ["asset_generated", null, "system"],
        ["status_change", "ready_for_review", "system"],
      ]
    );
    assert.deepEqual(events[0].payload, { source: "batch", batchResultId: 11 });
  });

  test("nothing is ever approved or submitted by saving", () => {
    const { saved } = save([result(), result({ jobId: otherJobId, matchId: null })]);
    for (const s of saved) {
      const app = getApplication(t.db, s.applicationId!)!;
      assert.equal(app.status, "ready_for_review");
      assert.equal(app.submittedAt, null);
      assert.ok(listApplicationEvents(t.db, app.id).every((e) => e.actor !== "user"));
    }
  });

  test("a failed result is recorded as preparation_failed with its error", () => {
    const { saved } = save([result({ success: false, error: "Tailoring failed.", cvFile: null, coverLetter: null, tailoredCv: null })]);
    const app = getApplication(t.db, saved[0].applicationId!)!;
    assert.equal(app.status, "preparation_failed");
    assert.equal(app.lastError, "Tailoring failed.");
    assert.equal(getCurrentAssets(t.db, app.id).length, 0);
  });

  test("a successful result with a cover-letter error is reviewable and keeps the error", () => {
    const { saved } = save([result({ coverLetter: "", error: "Cover letter failed: 500" })]);
    const app = getApplication(t.db, saved[0].applicationId!)!;
    assert.equal(app.status, "ready_for_review");
    assert.equal(app.lastError, "Cover letter failed: 500");
    assert.equal(getCurrentAssets(t.db, app.id).some((a) => a.kind === "cover_letter"), false);
  });

  test("a .docx fallback CV is stored with the Word MIME type", () => {
    const { saved } = save([result({ cvFilename: "CV_Acme.docx" })]);
    const file = getCurrentAssets(t.db, saved[0].applicationId!).find((a) => a.kind === "tailored_cv_file")!;
    assert.equal(file.mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  test("results without a stored job are skipped with a warning", () => {
    const { saved, warnings } = save([result({ jobId: undefined }), result({ jobId: 9999 })]);
    assert.deepEqual(saved.map((s) => s.applicationId), [null, null]);
    assert.equal(warnings.length, 2);
    assert.equal(count(t.db, "applications"), 0);
  });

  test("a match belonging to another job is not linked", () => {
    const { saved } = save([result({ jobId: otherJobId })]);
    assert.equal(getApplication(t.db, saved[0].applicationId!)!.matchId, null);
  });

  test("a job that already has an active application is not duplicated", () => {
    const first = save([result()]);
    const second = save([result({ batchResultId: 12 })]);
    assert.equal(second.saved[0].applicationId, null);
    assert.match(second.warnings[0], /already has application/);
    assert.equal(count(t.db, "applications"), 1);

    // Once rejected, the job can be prepared again.
    rejectApplication(t.db, first.saved[0].applicationId!);
    assert.notEqual(save([result({ batchResultId: 13 })]).saved[0].applicationId, null);
    assert.equal(count(t.db, "applications"), 2);
  });

  test("an unknown profile is reported and the application is saved without it", () => {
    const { saved, warnings } = save([result()], 999);
    assert.match(warnings[0], /Unknown candidate profile 999/);
    assert.equal(getApplication(t.db, saved[0].applicationId!)!.candidateProfileId, null);
  });

  test("one result that cannot be saved does not affect the others, and leaves nothing behind", () => {
    const { saved, warnings } = save([
      result({ tailoredCv: { bad: BigInt(1) } }),
      result({ jobId: otherJobId, matchId: null }),
    ]);
    assert.equal(saved[0].applicationId, null);
    assert.match(warnings[0], /Application not saved/);
    assert.notEqual(saved[1].applicationId, null);
    assert.equal(count(t.db, "applications"), 1);
    assert.equal(count(t.db, "application_events", "application_id <> ?", saved[1].applicationId), 0);
  });
});
