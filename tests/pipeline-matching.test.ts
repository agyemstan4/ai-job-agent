import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { TestDb } from "./helpers.ts";
import { count, freshDb, quietly } from "./helpers.ts";
import type { ScoredJob } from "../lib/pipeline/matching.ts";
import { abortMatching, beginMatching, recordMatchResults } from "../lib/pipeline/matching.ts";
import { createCandidate, createProfileVersion } from "../lib/repositories/candidates.ts";
import { addJobDescription, recordJobListing } from "../lib/repositories/jobs.ts";
import { getMatchFor } from "../lib/repositories/matches.ts";
import { getActiveRun, getRun, startRun } from "../lib/repositories/runs.ts";

let t: TestDb;
let profileId: number;
let jobs: number[];
beforeEach(() => {
  t = quietly(freshDb);
  const c = createCandidate(t.db, { fullName: "A" });
  profileId = createProfileVersion(t.db, { candidateId: c.id, origin: "ai_extraction", analysis: {}, structuredCv: {} }).id;
  jobs = ["Junior Developer", "Android Developer", "Senior Engineer", "Web Developer"].map(
    (title, i) =>
      recordJobListing(t.db, {
        sourceId: "adzuna",
        externalId: String(i),
        title,
        company: `Company ${i}`,
        description: `${title} description`,
      }).jobId
  );
});
afterEach(() => t.close());

const MODEL = { model: "llama3.2:3b", promptVersion: "match/v1" };

function scored(jobId: number, overrides: Partial<ScoredJob> = {}): ScoredJob {
  return {
    jobId,
    score: 74,
    modelScore: 80,
    breakdownScore: 65,
    breakdown: { technicalSkills: 80, experienceLevel: 55, projects: 70, growthPotential: 40 },
    reason: "Kotlin match",
    strengths: ["Kotlin"],
    missingSkills: [{ skill: "Spring Boot", importance: "medium" }],
    ...overrides,
  };
}

function begin() {
  return beginMatching(t.db, { candidateProfileId: profileId, params: { jobsReceived: 4 } })!;
}

describe("beginMatching", () => {
  test("starts a matching run for a stored profile", () => {
    const session = begin();
    const run = getRun(t.db, session.runId!)!;
    assert.equal(run.kind, "matching");
    assert.equal(run.status, "running");
    assert.equal(run.candidateProfileId, profileId);
  });

  test("records nothing without a valid profile (the scheduler's case)", () => {
    assert.equal(beginMatching(t.db, { candidateProfileId: undefined }), null);
    assert.equal(beginMatching(t.db, { candidateProfileId: 999 }), null);
    assert.equal(beginMatching(t.db, { candidateProfileId: "1" }), null);
    assert.equal(count(t.db, "pipeline_runs"), 0);
  });

  test("works unattributed while another matching run is active", () => {
    startRun(t.db, { kind: "matching", triggeredBy: "ui" });
    const session = begin();
    assert.equal(session.runId, null);
    assert.match(session.warnings[0], /in progress/);
  });
});

describe("recordMatchResults", () => {
  test("records scored, filtered-out and failed jobs and completes the run", () => {
    const session = begin();
    const description = addJobDescription(t.db, { jobId: jobs[0], kind: "full", content: "Full text" });
    const result = recordMatchResults(t.db, session, {
      scored: [scored(jobs[0]), scored(jobs[1], { modelScore: null, score: 65 })],
      filteredOut: [{ jobId: jobs[2], reason: "Senior title" }],
      failed: [{ jobId: jobs[3], error: "Ollama call failed: timeout" }],
      ...MODEL,
      stats: { jobsReceived: 4 },
    });

    const first = getMatchFor(t.db, jobs[0], profileId)!;
    assert.equal(first.outcome, "scored");
    assert.equal(first.score, 74);
    assert.equal(first.modelScore, 80);
    assert.equal(first.breakdownScore, 65);
    assert.equal(first.scoreSource, "blended");
    assert.deepEqual(first.breakdown, scored(0).breakdown);
    assert.deepEqual(first.strengths, ["Kotlin"]);
    assert.deepEqual(first.missingSkills, [{ skill: "Spring Boot", importance: "medium" }]);
    assert.equal(first.reason, "Kotlin match");
    assert.equal(first.model, "llama3.2:3b");
    assert.equal(first.promptVersion, "match/v1");
    assert.equal(first.runId, session.runId);
    assert.equal(first.jobDescriptionId, description.id); // the best (full) description

    assert.equal(getMatchFor(t.db, jobs[1], profileId)!.scoreSource, "breakdown");

    const filtered = getMatchFor(t.db, jobs[2], profileId)!;
    assert.equal(filtered.outcome, "filtered_out");
    assert.equal(filtered.filterReason, "Senior title");
    assert.equal(filtered.score, null);
    assert.equal(filtered.model, null);

    const failed = getMatchFor(t.db, jobs[3], profileId)!;
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.error, "Ollama call failed: timeout");

    assert.equal(result.written, 4);
    assert.deepEqual([...result.matchIds.keys()].sort(), [...jobs].sort());
    const run = getRun(t.db, session.runId!)!;
    assert.equal(run.status, "completed");
    assert.deepEqual(run.stats, { jobsReceived: 4, written: 4, kept: 0 });
  });

  test("a weaker outcome never replaces a stronger one; re-scoring replaces a score", () => {
    recordMatchResults(t.db, begin(), { scored: [scored(jobs[0])], filteredOut: [{ jobId: jobs[1], reason: "x" }], failed: [], ...MODEL });

    const second = recordMatchResults(t.db, begin(), {
      scored: [],
      filteredOut: [{ jobId: jobs[0], reason: "y" }],
      failed: [{ jobId: jobs[0], error: "timeout" }, { jobId: jobs[1], error: "timeout" }],
      ...MODEL,
    });
    assert.equal(second.kept, 3);
    assert.equal(getMatchFor(t.db, jobs[0], profileId)!.outcome, "scored");
    assert.equal(getMatchFor(t.db, jobs[1], profileId)!.outcome, "filtered_out");
    assert.equal(second.matchIds.get(jobs[0]), getMatchFor(t.db, jobs[0], profileId)!.id);

    recordMatchResults(t.db, begin(), { scored: [scored(jobs[0], { score: 90 })], filteredOut: [], failed: [], ...MODEL });
    assert.equal(getMatchFor(t.db, jobs[0], profileId)!.score, 90);
    assert.equal(count(t.db, "matches"), 2);
  });

  test("a failed match is retried and can become scored", () => {
    recordMatchResults(t.db, begin(), { scored: [], filteredOut: [], failed: [{ jobId: jobs[0], error: "x" }], ...MODEL });
    recordMatchResults(t.db, begin(), { scored: [scored(jobs[0])], filteredOut: [], failed: [], ...MODEL });
    const match = getMatchFor(t.db, jobs[0], profileId)!;
    assert.equal(match.outcome, "scored");
    assert.equal(match.error, null);
  });

  test("unknown job IDs are skipped with a warning, not fatal", () => {
    const result = recordMatchResults(t.db, begin(), { scored: [scored(9999), scored(jobs[0])], filteredOut: [], failed: [], ...MODEL });
    assert.match(result.warnings[0], /Unknown job 9999/);
    assert.equal(count(t.db, "matches"), 1);
  });

  test("matches are per profile version", () => {
    recordMatchResults(t.db, begin(), { scored: [scored(jobs[0])], filteredOut: [], failed: [], ...MODEL });
    const c = createCandidate(t.db, { fullName: "B" });
    const other = createProfileVersion(t.db, { candidateId: c.id, origin: "ai_extraction", analysis: {}, structuredCv: {} });
    assert.equal(getMatchFor(t.db, jobs[0], other.id), null);
  });

  test("an invalid row rolls back everything, and abortMatching fails the run", () => {
    const session = begin();
    assert.throws(() =>
      recordMatchResults(t.db, session, {
        scored: [scored(jobs[0]), scored(jobs[1], { score: 150 })],
        filteredOut: [],
        failed: [],
        ...MODEL,
      })
    );
    assert.equal(count(t.db, "matches"), 0);
    assert.equal(getActiveRun(t.db, "matching")!.id, session.runId);
    abortMatching(t.db, session, "boom");
    assert.equal(getRun(t.db, session.runId!)!.status, "failed");
    abortMatching(t.db, session, "again"); // already finished: no throw
    abortMatching(t.db, null, "no session");
  });

  test("seen_jobs is not touched (the route keeps marking it)", () => {
    recordMatchResults(t.db, begin(), { scored: [scored(jobs[0])], filteredOut: [], failed: [], ...MODEL });
    assert.equal(count(t.db, "seen_jobs"), 0);
  });
});
