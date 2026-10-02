import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { TestDb } from "./helpers.ts";
import { count, createLegacyDbFile, freshDb, makeTempDir, quietly, removeTempDir, seedSeenJobs } from "./helpers.ts";
import type { DiscoveredListing } from "../lib/pipeline/discovery.ts";
import { normalisePostedAt, recordDiscovery } from "../lib/pipeline/discovery.ts";
import { openDatabase } from "../lib/database.ts";
import { createCandidate, createProfileVersion } from "../lib/repositories/candidates.ts";
import { failStaleRuns, getActiveRun, getRun, startRun } from "../lib/repositories/runs.ts";
import { getJob, getListingBySourceId } from "../lib/repositories/jobs.ts";
import { recordMatch } from "../lib/repositories/matches.ts";

let t: TestDb;
beforeEach(() => {
  t = quietly(freshDb);
});
afterEach(() => t.close());

function listing(overrides: Partial<DiscoveredListing> = {}): DiscoveredListing {
  return {
    sourceId: "adzuna",
    externalId: "100",
    title: "Junior Software Engineer",
    company: "Acme Ltd",
    location: "London",
    url: "https://example.com/adzuna/100",
    description: "Kotlin and Java role",
    ...overrides,
  };
}

function discover(listings: DiscoveredListing[], candidateProfileId: number | null = null) {
  return recordDiscovery(t.db, { listings, candidateProfileId, triggeredBy: "ui", params: { role: "x" } });
}

function makeProfile(): number {
  const c = createCandidate(t.db, { fullName: "A" });
  return createProfileVersion(t.db, { candidateId: c.id, origin: "ai_extraction", analysis: {}, structuredCv: {} }).id;
}

describe("recordDiscovery: persistence", () => {
  test("records jobs, listings and snippet descriptions with the source data", () => {
    const result = discover([
      listing({
        salaryMin: 30000,
        salaryMax: 35000,
        salaryIsPredicted: true,
        contractType: "permanent",
        contractTime: "full_time",
        postedAt: "2026-09-30T10:00:00Z",
        raw: { id: "100", extra: true },
      }),
    ]);
    const stored = getListingBySourceId(t.db, "adzuna", "100")!;
    const job = getJob(t.db, stored.jobId)!;

    assert.equal(result.stats.jobsCreated, 1);
    assert.equal(result.stats.listingsCreated, 1);
    assert.equal(job.title, "Junior Software Engineer");
    assert.equal(job.salaryIsPredicted, true);
    assert.equal(job.contractTime, "full_time");
    assert.equal(job.postedAt, "2026-09-30T10:00:00Z");
    assert.equal(stored.url, "https://example.com/adzuna/100");
    assert.equal(
      (t.db.prepare("SELECT raw_json FROM job_listings WHERE id = ?").get(stored.id) as { raw_json: string }).raw_json,
      JSON.stringify({ id: "100", extra: true })
    );
    const description = t.db.prepare("SELECT kind, content FROM job_descriptions").get() as { kind: string; content: string };
    assert.deepEqual(description, { kind: "snippet", content: "Kotlin and Java role" });
  });

  test("Reed dates are normalised; other values are kept", () => {
    assert.equal(normalisePostedAt("30/09/2026"), "2026-09-30");
    assert.equal(normalisePostedAt("2026-09-30T10:00:00Z"), "2026-09-30T10:00:00Z");
    assert.equal(normalisePostedAt(null), null);
  });

  test("records a completed discovery run with its stats", () => {
    const result = discover([listing(), listing({ externalId: "101", title: "Android Developer" })]);
    const run = getRun(t.db, result.runId!)!;
    assert.equal(run.kind, "discovery");
    assert.equal(run.status, "completed");
    assert.deepEqual(run.params, { role: "x" });
    assert.deepEqual(run.stats, { rawListings: 2, uniqueJobs: 2, newJobs: 2, jobsCreated: 2, listingsCreated: 2 });
    assert.equal(getListingBySourceId(t.db, "adzuna", "101")!.lastSeenAt !== null, true);
  });

  test("fetching the same listings again creates no duplicates", () => {
    const batch = [listing(), listing({ sourceId: "reed", externalId: "9", url: "https://example.com/reed/9" })];
    discover(batch);
    const second = discover(batch);
    assert.equal(second.stats.jobsCreated, 0);
    assert.equal(second.stats.listingsCreated, 0);
    assert.equal(count(t.db, "jobs"), 1);
    assert.equal(count(t.db, "job_listings"), 2);
    assert.equal(count(t.db, "job_descriptions"), 1);
  });
});

describe("recordDiscovery: deduplication", () => {
  test("the same vacancy from Adzuna and Reed is one job, shown as the last listing, with both IDs", () => {
    const result = discover([
      listing(),
      listing({ externalId: "200", title: "Android Developer" }),
      listing({ sourceId: "reed", externalId: "9", company: "ACME Limited", title: "Junior Software Engineer (Hybrid)" }),
    ]);
    assert.equal(result.jobs.length, 2);
    const merged = result.jobs[0];
    assert.deepEqual(merged.listingIndexes, [0, 2]);
    assert.equal(merged.representativeIndex, 2);
    assert.deepEqual(merged.sourceIds, ["adzuna_100", "reed_9"]);
  });

  test("the same listing repeated across search terms is listed once", () => {
    const result = discover([listing(), listing(), listing()]);
    assert.equal(result.jobs.length, 1);
    assert.deepEqual(result.jobs[0].sourceIds, ["adzuna_100"]);
    assert.equal(result.jobs[0].representativeIndex, 2);
  });

  test("listings without a real company are never merged", () => {
    const result = discover([
      listing({ company: "Unknown" }),
      listing({ externalId: "101", company: "Unknown" }),
    ]);
    assert.equal(result.jobs.length, 2);
  });

  test("Adzuna listings keyed by URL keep the legacy seen key format", () => {
    const result = discover([listing({ externalId: "https://example.com/x" })]);
    assert.deepEqual(result.jobs[0].sourceIds, ["adzuna_https://example.com/x"]);
  });
});

describe("recordDiscovery: which jobs are new", () => {
  test("a job is not new if any of its listings — even from an earlier run — is in seen_jobs", () => {
    discover([listing({ sourceId: "reed", externalId: "9" })]);
    t.db.prepare("INSERT INTO seen_jobs (job_id) VALUES ('reed_9')").run();
    // Today only the Adzuna listing of the same vacancy is fetched.
    const result = discover([listing()]);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.newJobs.length, 0);
    assert.equal(result.jobs[0].processed, true);
  });

  test("with a profile, jobs scored or filtered out for that profile are not new; failed ones are", () => {
    const profileId = makeProfile();
    const first = discover(
      [listing(), listing({ externalId: "2", title: "Android Developer" }), listing({ externalId: "3", title: "Web Developer" })],
      profileId
    );
    const [scored, filtered, failed] = first.jobs.map((job) => job.jobId);
    recordMatch(t.db, { jobId: scored, candidateProfileId: profileId, outcome: "scored", score: 70 });
    recordMatch(t.db, { jobId: filtered, candidateProfileId: profileId, outcome: "filtered_out", filterReason: "x" });
    recordMatch(t.db, { jobId: failed, candidateProfileId: profileId, outcome: "failed", error: "x" });

    const again = discover(
      [listing(), listing({ externalId: "2", title: "Android Developer" }), listing({ externalId: "3", title: "Web Developer" })],
      profileId
    );
    assert.deepEqual(again.newJobs.map((job) => job.jobId), [failed]);
  });

  test("without a profile (the scheduler) only seen_jobs blocks a job", () => {
    const profileId = makeProfile();
    const first = discover([listing()], profileId);
    recordMatch(t.db, { jobId: first.jobs[0].jobId, candidateProfileId: profileId, outcome: "filtered_out", filterReason: "x" });
    assert.equal(discover([listing()]).newJobs.length, 1);
  });

  test("an unknown profile falls back to the seen_jobs check with a warning", () => {
    const result = discover([listing()], 999);
    assert.equal(result.newJobs.length, 1);
    assert.match(result.warnings[0], /Unknown candidate profile 999/);
    assert.equal(getRun(t.db, result.runId!)!.candidateProfileId, null);
  });

  test("the 167 legacy seen IDs keep blocking their jobs on a migrated legacy database", () => {
    const dir = makeTempDir();
    try {
      let seen: string[] = [];
      const file = createLegacyDbFile(dir, (db) => {
        seen = seedSeenJobs(db, 167);
      });
      const db = quietly(() => openDatabase(file));
      try {
        const before = db.prepare("SELECT * FROM seen_jobs ORDER BY job_id").all();
        const listings: DiscoveredListing[] = seen.map((id, i) => {
          const [sourceId, externalId] = id.split("_") as ["adzuna" | "reed", string];
          return listing({ sourceId, externalId, title: `Role ${i}`, company: `Company ${i}` });
        });
        listings.push(listing({ externalId: "brand-new", title: "New Role", company: "New Co" }));
        const result = recordDiscovery(db, { listings, triggeredBy: "scheduler" });
        assert.equal(result.jobs.length, 168);
        assert.deepEqual(result.newJobs.map((job) => job.sourceIds), [["adzuna_brand-new"]]);
        assert.deepEqual(db.prepare("SELECT * FROM seen_jobs ORDER BY job_id").all(), before);
        assert.deepEqual(db.pragma("foreign_key_check"), []);
      } finally {
        db.close();
      }
    } finally {
      removeTempDir(dir);
    }
  });
});

describe("runs: abandoned and concurrent runs", () => {
  test("a run still 'running' after an hour is failed so a new run can start", () => {
    const stale = startRun(t.db, { kind: "discovery", triggeredBy: "ui" });
    t.db.prepare("UPDATE pipeline_runs SET started_at = datetime('now', '-2 hours') WHERE id = ?").run(stale.id);

    const result = discover([listing()]);
    assert.notEqual(result.runId, null);
    assert.equal(getRun(t.db, stale.id)!.status, "failed");
    assert.match(getRun(t.db, stale.id)!.error!, /Abandoned/);
  });

  test("a genuinely active run is left alone; this discovery still works, unattributed", () => {
    const active = startRun(t.db, { kind: "discovery", triggeredBy: "scheduler" });
    const result = discover([listing()]);
    assert.equal(result.runId, null);
    assert.equal(result.newJobs.length, 1);
    assert.match(result.warnings.join(" "), /in progress/);
    assert.equal(getActiveRun(t.db, "discovery")!.id, active.id);
    assert.equal(getListingBySourceId(t.db, "adzuna", "100")!.jobId, result.jobs[0].jobId);
  });

  test("failStaleRuns only touches old running runs of that kind", () => {
    const fresh = startRun(t.db, { kind: "discovery", triggeredBy: "ui" });
    const oldMatching = startRun(t.db, { kind: "matching", triggeredBy: "ui" });
    t.db.prepare("UPDATE pipeline_runs SET started_at = datetime('now', '-2 hours') WHERE id = ?").run(oldMatching.id);
    assert.equal(failStaleRuns(t.db, "discovery", 60), 0);
    assert.equal(getRun(t.db, fresh.id)!.status, "running");
    assert.equal(failStaleRuns(t.db, "matching", 60), 1);
  });

  test("a failure while recording leaves nothing behind", () => {
    assert.throws(() => discover([listing(), listing({ externalId: "2", raw: { bad: BigInt(1) } })]));
    assert.equal(count(t.db, "jobs"), 0);
    assert.equal(count(t.db, "job_listings"), 0);
    assert.equal(count(t.db, "pipeline_runs"), 0);
  });
});
