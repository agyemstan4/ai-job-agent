import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { TestDb } from "./helpers.ts";
import { count, freshDb, quietly } from "./helpers.ts";
import {
  addCvDocument,
  createCandidate,
  createProfileVersion,
  getCurrentProfile,
  getDefaultCandidate,
  listProfiles,
  setCurrentProfile,
  updateCandidate,
} from "../lib/repositories/candidates.ts";
import { completeRun, failRun, getActiveRun, startRun } from "../lib/repositories/runs.ts";
import {
  getBestDescription,
  getJob,
  getListingsForJob,
  isJobProcessed,
  isLegacySeen,
  recordJobListing,
} from "../lib/repositories/jobs.ts";
import { getMatchFor, listMatchesForProfile, recordMatch } from "../lib/repositories/matches.ts";
import {
  addApplicationAsset,
  createApplication,
  getCurrentAssets,
  listAssetVersions,
  listApplicationEvents,
  transitionApplication,
} from "../lib/repositories/applications.ts";
import { fingerprintV1, normaliseCompanyV1, normaliseTitleV1 } from "../lib/repositories/shared.ts";

let t: TestDb;
beforeEach(() => {
  t = quietly(freshDb);
});
afterEach(() => t.close());

function makeProfile() {
  const candidate = createCandidate(t.db, { fullName: "Test Candidate" });
  return createProfileVersion(t.db, {
    candidateId: candidate.id,
    origin: "ai_extraction",
    analysis: { technicalSkills: ["Kotlin"] },
    structuredCv: { name: "Test Candidate" },
  });
}

describe("candidates, CVs and profile versions", () => {
  test("creates and updates a candidate", () => {
    const c = createCandidate(t.db, { fullName: "A", preferences: { roles: ["Android"] } });
    assert.deepEqual(getDefaultCandidate(t.db)?.preferences, { roles: ["Android"] });
    assert.equal(updateCandidate(t.db, c.id, { location: "London" }).location, "London");
  });

  test("deduplicates identical CV uploads", () => {
    const c = createCandidate(t.db, { fullName: "A" });
    const file = Buffer.from("%PDF cv");
    const first = addCvDocument(t.db, { candidateId: c.id, originalFilename: "cv.pdf", mimeType: "application/pdf", file });
    const second = addCvDocument(t.db, { candidateId: c.id, originalFilename: "cv-copy.pdf", mimeType: "application/pdf", file });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.document.id, first.document.id);
  });

  test("profile versions increment and exactly one is current", () => {
    const c = createCandidate(t.db, { fullName: "A" });
    const v1 = createProfileVersion(t.db, { candidateId: c.id, origin: "ai_extraction", analysis: {}, structuredCv: {} });
    const v2 = createProfileVersion(t.db, {
      candidateId: c.id, origin: "user_edit", parentProfileId: v1.id, analysis: { edited: true }, structuredCv: {},
    });
    assert.deepEqual([v1.version, v2.version], [1, 2]);
    assert.equal(getCurrentProfile(t.db, c.id)?.id, v2.id);
    assert.equal(listProfiles(t.db, c.id).filter((p) => p.isCurrent).length, 1);
    setCurrentProfile(t.db, v1.id);
    assert.equal(getCurrentProfile(t.db, c.id)?.id, v1.id);
  });

  test("profile versions are immutable", () => {
    const p = makeProfile();
    assert.throws(
      () => t.db.prepare("UPDATE candidate_profiles SET analysis_json = '{}' WHERE id = ?").run(p.id),
      /IMMUTABLE/
    );
  });
});

describe("runs", () => {
  test("only one run of each kind can be running", () => {
    const run = startRun(t.db, { kind: "discovery", triggeredBy: "ui" });
    assert.throws(() => startRun(t.db, { kind: "discovery", triggeredBy: "scheduler" }), { code: "RUN_ALREADY_ACTIVE" });
    startRun(t.db, { kind: "matching", triggeredBy: "ui" }); // other kinds are fine
    assert.equal(getActiveRun(t.db, "discovery")?.id, run.id);
    completeRun(t.db, run.id, { found: 3 });
    assert.equal(getActiveRun(t.db, "discovery"), null);
    const next = startRun(t.db, { kind: "discovery", triggeredBy: "scheduler" });
    assert.equal(failRun(t.db, next.id, "Adzuna down").error, "Adzuna down");
    assert.throws(() => completeRun(t.db, next.id), { code: "RUN_NOT_RUNNING" });
  });
});

describe("jobs and deduplication", () => {
  test("fingerprints ignore formatting noise but not real differences", () => {
    assert.equal(normaliseCompanyV1("QuokkaPay Ltd."), "quokkapay");
    assert.equal(normaliseTitleV1("Junior Android Developer (Hybrid) - £30,000 - £35,000"), "junior android developer");
    const a = fingerprintV1({ title: "Junior Android Developer", company: "QuokkaPay Ltd", sourceId: "adzuna", externalId: "1" });
    const b = fingerprintV1({ title: "Junior Android Developer - Remote", company: "QuokkaPay Limited", sourceId: "reed", externalId: "2" });
    const c = fingerprintV1({ title: "Senior Android Developer", company: "QuokkaPay Ltd", sourceId: "reed", externalId: "3" });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  test("merges the same vacancy across Adzuna and Reed", () => {
    const adzuna = recordJobListing(t.db, {
      sourceId: "adzuna", externalId: "5906271723", title: "Junior Developer", company: "Acme Ltd",
      salaryMin: 30000, salaryIsPredicted: true, description: "Short snippet",
    });
    const reed = recordJobListing(t.db, {
      sourceId: "reed", externalId: "57401677", title: "Junior Developer", company: "ACME LIMITED",
      salaryMin: 32000, salaryMax: 36000, salaryIsPredicted: false,
      description: "A much longer description of the Acme junior developer role.",
    });
    assert.equal(adzuna.jobCreated, true);
    assert.equal(reed.jobCreated, false);
    assert.equal(reed.jobId, adzuna.jobId);
    assert.equal(getListingsForJob(t.db, adzuna.jobId).length, 2);
    // A real salary replaces a predicted one.
    const job = getJob(t.db, adzuna.jobId)!;
    assert.deepEqual([job.salaryMin, job.salaryMax, job.salaryIsPredicted], [32000, 36000, false]);
    assert.match(getBestDescription(t.db, adzuna.jobId)!.content, /much longer/);
  });

  test("seeing the same listing again updates it instead of duplicating", () => {
    const first = recordJobListing(t.db, { sourceId: "reed", externalId: "1", title: "Dev", company: "Acme", description: "Same" });
    const again = recordJobListing(t.db, { sourceId: "reed", externalId: "1", title: "Dev", company: "Acme", description: "Same" });
    assert.equal(again.listingCreated, false);
    assert.equal(again.listingId, first.listingId);
    assert.equal(count(t.db, "job_listings"), 1);
    assert.equal(count(t.db, "job_descriptions"), 1);
  });

  test("never merges listings without a real company", () => {
    const a = recordJobListing(t.db, { sourceId: "adzuna", externalId: "1", title: "Developer", company: "Unknown" });
    const b = recordJobListing(t.db, { sourceId: "reed", externalId: "2", title: "Developer", company: "Unknown" });
    assert.notEqual(a.jobId, b.jobId);
  });

  test("a full description beats a longer snippet", () => {
    const r = recordJobListing(t.db, { sourceId: "reed", externalId: "1", title: "Dev", company: "Acme", description: "x".repeat(500) });
    recordJobListing(t.db, { sourceId: "reed", externalId: "1", title: "Dev", company: "Acme", description: "Full text", descriptionKind: "full" });
    assert.equal(getBestDescription(t.db, r.jobId)!.kind, "full");
  });

  test("legacy seen_jobs IDs keep blocking their jobs", () => {
    t.db.prepare("INSERT INTO seen_jobs (job_id) VALUES ('adzuna_123')").run();
    const profile = makeProfile();
    const seen = recordJobListing(t.db, { sourceId: "adzuna", externalId: "123", title: "Dev", company: "Acme" });
    const fresh = recordJobListing(t.db, { sourceId: "reed", externalId: "999", title: "QA", company: "Other" });
    assert.equal(isLegacySeen(t.db, ["adzuna_123"]), true);
    assert.equal(isJobProcessed(t.db, seen.jobId, profile.id), true);
    assert.equal(isJobProcessed(t.db, fresh.jobId, profile.id), false);
    // A cross-source duplicate of a legacy-seen listing is blocked too.
    const dup = recordJobListing(t.db, { sourceId: "reed", externalId: "456", title: "Dev", company: "Acme Ltd" });
    assert.equal(dup.jobId, seen.jobId);
    assert.equal(isJobProcessed(t.db, dup.jobId, profile.id), true);
  });

  test("scored and filtered jobs are processed per profile version; failed ones are retried", () => {
    const profile = makeProfile();
    const scored = recordJobListing(t.db, { sourceId: "reed", externalId: "1", title: "A", company: "X" });
    const filtered = recordJobListing(t.db, { sourceId: "reed", externalId: "2", title: "B", company: "Y" });
    const failed = recordJobListing(t.db, { sourceId: "reed", externalId: "3", title: "C", company: "Z" });
    recordMatch(t.db, { jobId: scored.jobId, candidateProfileId: profile.id, outcome: "scored", score: 80 });
    recordMatch(t.db, { jobId: filtered.jobId, candidateProfileId: profile.id, outcome: "filtered_out", filterReason: "senior" });
    recordMatch(t.db, { jobId: failed.jobId, candidateProfileId: profile.id, outcome: "failed", error: "Ollama down" });
    assert.equal(isJobProcessed(t.db, scored.jobId, profile.id), true);
    assert.equal(isJobProcessed(t.db, filtered.jobId, profile.id), true);
    assert.equal(isJobProcessed(t.db, failed.jobId, profile.id), false);

    const v2 = createProfileVersion(t.db, { candidateId: profile.candidateId, origin: "user_edit", analysis: {}, structuredCv: {} });
    assert.equal(isJobProcessed(t.db, scored.jobId, v2.id), false); // new CV → re-evaluate
  });
});

describe("matches", () => {
  test("re-scoring upserts and listing is best-first", () => {
    const profile = makeProfile();
    const a = recordJobListing(t.db, { sourceId: "reed", externalId: "1", title: "A", company: "X" });
    const b = recordJobListing(t.db, { sourceId: "reed", externalId: "2", title: "B", company: "Y" });
    recordMatch(t.db, { jobId: a.jobId, candidateProfileId: profile.id, outcome: "scored", score: 60, strengths: ["Kotlin"] });
    recordMatch(t.db, { jobId: b.jobId, candidateProfileId: profile.id, outcome: "scored", score: 70 });
    recordMatch(t.db, { jobId: a.jobId, candidateProfileId: profile.id, outcome: "scored", score: 90, scoreSource: "breakdown" });
    assert.equal(count(t.db, "matches"), 2);
    assert.deepEqual(listMatchesForProfile(t.db, profile.id).map((m) => m.score), [90, 70]);
    assert.equal(getMatchFor(t.db, a.jobId, profile.id)?.scoreSource, "breakdown");
  });

  test("rejects invalid scores", () => {
    const profile = makeProfile();
    const a = recordJobListing(t.db, { sourceId: "reed", externalId: "1", title: "A", company: "X" });
    assert.throws(() => recordMatch(t.db, { jobId: a.jobId, candidateProfileId: profile.id, outcome: "scored", score: 150 }), /CHECK/);
  });
});

describe("applications and assets", () => {
  test("one active application per job", () => {
    const job = recordJobListing(t.db, { sourceId: "reed", externalId: "1", title: "A", company: "X" });
    const app = createApplication(t.db, { jobId: job.jobId });
    assert.throws(() => createApplication(t.db, { jobId: job.jobId }), { code: "ACTIVE_APPLICATION_EXISTS" });
    transitionApplication(t.db, app.id, "preparation_failed", { actor: "system", error: "Ollama down" });
    assert.equal(createApplication(t.db, { jobId: job.jobId }).status, "preparing"); // freed
  });

  test("assets are versioned with one current version per kind", () => {
    const job = recordJobListing(t.db, { sourceId: "reed", externalId: "1", title: "A", company: "X" });
    const app = createApplication(t.db, { jobId: job.jobId });
    addApplicationAsset(t.db, { applicationId: app.id, kind: "cover_letter", origin: "generated", contentText: "v1" });
    const v2 = addApplicationAsset(t.db, { applicationId: app.id, kind: "cover_letter", origin: "user_edit", contentText: "v2" });
    addApplicationAsset(t.db, {
      applicationId: app.id, kind: "question_answers", origin: "generated",
      contentJson: [{ question: "Why?", answer: "Because" }],
    });
    assert.equal(v2.version, 2);
    assert.deepEqual(listAssetVersions(t.db, app.id, "cover_letter").map((a) => [a.version, a.isCurrent]), [[2, true], [1, false]]);
    assert.deepEqual(getCurrentAssets(t.db, app.id).map((a) => a.kind), ["cover_letter", "question_answers"]);
    assert.ok(listApplicationEvents(t.db, app.id).some((e) => e.eventType === "asset_edited" && e.actor === "user"));
    assert.throws(() => t.db.prepare("UPDATE application_assets SET content_text = 'x' WHERE id = ?").run(v2.id), /IMMUTABLE/);
  });

  test("invalid transitions are refused", () => {
    const job = recordJobListing(t.db, { sourceId: "reed", externalId: "1", title: "A", company: "X" });
    const app = createApplication(t.db, { jobId: job.jobId });
    assert.throws(() => transitionApplication(t.db, app.id, "interviewing", { actor: "user" }), { code: "INVALID_TRANSITION" });
  });
});
