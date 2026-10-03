import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TestDb } from "./helpers.ts";
import { count, freshDb, quietly, seedSeenJobs } from "./helpers.ts";
import type { ReedDetailResult } from "../lib/sources/reed-details.ts";
import { fetchReedJobDetail, htmlToText, REED_DETAILS_URL } from "../lib/sources/reed-details.ts";
import type { DetailFetcher } from "../lib/pipeline/job-details.ts";
import { enrichSelectedJobs, reedListingToEnrich, scoringDescriptionFor } from "../lib/pipeline/job-details.ts";
import { createCandidate, createProfileVersion } from "../lib/repositories/candidates.ts";
import { getBestDescription, recordJobListing } from "../lib/repositories/jobs.ts";
import { recordMatch } from "../lib/repositories/matches.ts";
import { recordMatchResults } from "../lib/pipeline/matching.ts";

// Phase 3 checkpoint 3b-2: Reed job details for the jobs selected for scoring.

const SNIPPET = "Junior Java developer wanted. Kotlin a plus... ";
const FULL_HTML = "<p>Junior Java developer wanted.</p><ul><li>Java &amp; Kotlin</li><li>SQL</li></ul>";
const FULL_TEXT = "Junior Java developer wanted.\n\n- Java & Kotlin\n- SQL";

// ── htmlToText ──────────────────────────────────────────────────────────────

describe("3b-2: htmlToText", () => {
  test("keeps paragraphs, line breaks and list items", () => {
    assert.equal(htmlToText(FULL_HTML), FULL_TEXT);
    assert.equal(htmlToText("Line one<br>Line two<br/>Line three"), "Line one\nLine two\nLine three");
    assert.equal(htmlToText("<h2>Role</h2><p>Build apps</p><ol><li>One</li><li>Two</li></ol><p>End</p>"), "Role\n\nBuild apps\n\n- One\n- Two\n\nEnd");
  });

  test("removes tags, scripts, styles and comments", () => {
    assert.equal(htmlToText('<div class="x"><strong>Bold</strong> <a href="https://e.com">link</a></div>'), "Bold link");
    assert.equal(htmlToText("<style>p{color:red}</style><script>alert(1)</script><!-- note --><p>Text</p>"), "Text");
  });

  test("decodes entities and normalises whitespace", () => {
    assert.equal(htmlToText("&pound;30,000&nbsp;&ndash; &#163;35k &#x2022; &lt;tag&gt; &quot;q&quot; &apos;a&#39;"), "£30,000 – £35k • <tag> \"q\" 'a'");
    assert.equal(htmlToText("  Multiple   spaces\n\n\n  and\r\nsource   newlines  "), "Multiple spaces and source newlines");
    assert.equal(htmlToText("<p>a</p><p></p><p></p><p>b</p>"), "a\n\nb");
    assert.equal(htmlToText("&unknown; &#0;"), "&unknown; &#0;");
  });

  test("plain text and empty input", () => {
    assert.equal(htmlToText("Just text"), "Just text");
    assert.equal(htmlToText(""), "");
    assert.equal(htmlToText("<p> </p>"), "");
  });
});

// ── fetchReedJobDetail ──────────────────────────────────────────────────────

describe("3b-2: fetchReedJobDetail", () => {
  const respond = (status: number, body: unknown) => async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

  test("calls Reed's details API with Basic auth and returns the text", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const result = await fetchReedJobDetail("123", "KEY", {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ jobId: 123, jobDescription: FULL_HTML }), { status: 200 });
      },
    });
    assert.deepEqual(result, { status: "ok", description: FULL_TEXT });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${REED_DETAILS_URL}123`);
    assert.equal(calls[0].url, "https://www.reed.co.uk/api/1.0/jobs/123");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Basic ${Buffer.from("KEY:").toString("base64")}`);
    assert.ok(calls[0].init.signal instanceof AbortSignal);
  });

  test("maps HTTP statuses", async () => {
    assert.deepEqual(await fetchReedJobDetail("1", "K", { fetchImpl: respond(404, {}) }), { status: "not_found", httpStatus: 404 });
    assert.deepEqual(await fetchReedJobDetail("1", "K", { fetchImpl: respond(410, {}) }), { status: "not_found", httpStatus: 410 });
    assert.deepEqual(await fetchReedJobDetail("1", "K", { fetchImpl: respond(429, {}) }), { status: "rate_limited", httpStatus: 429 });
    assert.deepEqual(await fetchReedJobDetail("1", "K", { fetchImpl: respond(401, {}) }), { status: "auth_failed", httpStatus: 401 });
    assert.deepEqual(await fetchReedJobDetail("1", "K", { fetchImpl: respond(403, {}) }), { status: "auth_failed", httpStatus: 403 });
    assert.deepEqual(await fetchReedJobDetail("1", "K", { fetchImpl: respond(500, {}) }), { status: "error", httpStatus: 500, error: "HTTP 500" });
  });

  test("unusable responses are errors", async () => {
    const bad = async (body: unknown) => fetchReedJobDetail("7", "K", { fetchImpl: respond(200, body) });
    assert.equal((await bad("not json")).status, "error");
    assert.equal((await bad({ jobId: 7 })).status, "error");
    assert.equal((await bad({ jobId: 7, jobDescription: "<p> </p>" })).status, "error");
    assert.equal((await bad(null)).status, "error");
    assert.deepEqual(await bad({ jobId: 8, jobDescription: "x" }), { status: "error", httpStatus: 200, error: "The response was for a different job" });
    // No jobId in the response is accepted.
    assert.deepEqual(await bad({ jobDescription: "<b>ok</b>" }), { status: "ok", description: "ok" });
  });

  test("network errors and timeouts are errors without the key", async () => {
    const thrown = await fetchReedJobDetail("1", "SECRET", {
      fetchImpl: async () => {
        throw new TypeError("fetch failed for SECRET");
      },
    });
    assert.deepEqual(thrown, { status: "error", error: "Request failed (TypeError)" });

    const timedOut = await fetchReedJobDetail("1", "SECRET", {
      timeoutMs: 20,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    });
    assert.equal(timedOut.status, "error");
    assert.equal(JSON.stringify(timedOut).includes("SECRET"), false);
  });

  test("a non-numeric ID is refused without a request", async () => {
    let called = false;
    const result = await fetchReedJobDetail("12/../x", "K", {
      fetchImpl: async () => {
        called = true;
        return new Response("{}");
      },
    });
    assert.equal(result.status, "error");
    assert.equal(called, false);
  });
});

// ── enrichSelectedJobs (scratch databases) ──────────────────────────────────

let t: TestDb;
let profileId: number;
beforeEach(() => {
  t = quietly(freshDb);
  const c = createCandidate(t.db, { fullName: "A" });
  profileId = createProfileVersion(t.db, { candidateId: c.id, origin: "ai_extraction", analysis: {}, structuredCv: {} }).id;
});
afterEach(() => t.close());

const reedJob = (externalId: string, title = `Java Developer ${externalId}`, company = "Acme") =>
  recordJobListing(t.db, { sourceId: "reed", externalId, title, company, description: SNIPPET });
const adzunaJob = (externalId: string, title = `Java Developer ${externalId}`, company = "Acme") =>
  recordJobListing(t.db, { sourceId: "adzuna", externalId, title, company, description: "Adzuna snippet" });

/** A fake Reed details API: records calls, answers from a map (default: ok). */
function fakeReed(answers: Record<string, ReedDetailResult | Error> = {}) {
  const calls: string[] = [];
  const fetchDetail: DetailFetcher = async (externalId) => {
    calls.push(externalId);
    const answer = answers[externalId];
    if (answer instanceof Error) throw answer;
    return answer ?? { status: "ok", description: `Full description for ${externalId}` };
  };
  return { calls, fetchDetail };
}

const tableCounts = () => ({
  jobs: count(t.db, "jobs"),
  listings: count(t.db, "job_listings"),
  seen: count(t.db, "seen_jobs"),
  matches: count(t.db, "matches"),
});

describe("3b-2: enrichSelectedJobs", () => {
  test("a selected Reed job is fetched once and stored as its full description", async () => {
    const { jobId, listingId } = reedJob("100");
    const reed = fakeReed();
    const stats = await enrichSelectedJobs(t.db, [jobId], { fetchDetail: reed.fetchDetail });

    assert.deepEqual(reed.calls, ["100"]);
    assert.deepEqual(stats, { requested: 1, eligible: 1, fetched: 1, notFound: 0, failed: 0, skipped: 0, stoppedBy: null });
    const best = getBestDescription(t.db, jobId);
    assert.equal(best?.kind, "full");
    assert.equal(best?.content, "Full description for 100");
    assert.equal(best?.jobListingId, listingId);
    // The snippet is kept.
    assert.equal(count(t.db, "job_descriptions", "job_id = ? AND kind = 'snippet'", jobId), 1);
  });

  test("an enriched job is never fetched again", async () => {
    const { jobId } = reedJob("100");
    const reed = fakeReed();
    await enrichSelectedJobs(t.db, [jobId], { fetchDetail: reed.fetchDetail });
    const again = await enrichSelectedJobs(t.db, [jobId], { fetchDetail: reed.fetchDetail });
    // Seen again in a later search: still cached.
    reedJob("100");
    const third = await enrichSelectedJobs(t.db, [jobId], { fetchDetail: reed.fetchDetail });

    assert.deepEqual(reed.calls, ["100"]);
    assert.equal(again.eligible, 0);
    assert.equal(third.eligible, 0);
    assert.equal(count(t.db, "job_descriptions", "job_id = ? AND kind = 'full'", jobId), 1);
  });

  test("a job selected for scoring before is not fetched (one request per job)", async () => {
    const failedBefore = reedJob("201").jobId;
    const scoredBefore = reedJob("202").jobId;
    const filteredBefore = reedJob("203").jobId;
    recordMatch(t.db, { jobId: failedBefore, candidateProfileId: profileId, outcome: "failed", error: "x" });
    recordMatch(t.db, { jobId: scoredBefore, candidateProfileId: profileId, outcome: "scored", score: 50 });
    recordMatch(t.db, { jobId: filteredBefore, candidateProfileId: profileId, outcome: "filtered_out", filterReason: "x" });

    const reed = fakeReed();
    const stats = await enrichSelectedJobs(t.db, [failedBefore, scoredBefore, filteredBefore], { fetchDetail: reed.fetchDetail });
    // Filtered out earlier was never selected, so it has not been fetched yet.
    assert.deepEqual(reed.calls, ["203"]);
    assert.equal(stats.eligible, 1);
  });

  test("a failed request is not retried after the run saves its matches", async () => {
    const { jobId } = reedJob("300");
    const reed = fakeReed({ "300": { status: "error", httpStatus: 500, error: "HTTP 500" } });
    const first = await enrichSelectedJobs(t.db, [jobId], { fetchDetail: reed.fetchDetail });
    assert.equal(first.failed, 1);
    assert.equal(getBestDescription(t.db, jobId)?.kind, "snippet");

    // The same run then scores the job (or fails to), which /api/match saves.
    recordMatchResults(t.db, { candidateProfileId: profileId, runId: null, warnings: [] }, {
      scored: [], filteredOut: [], failed: [{ jobId, error: "Ollama down" }], model: "m", promptVersion: "match/v1",
    });
    const second = await enrichSelectedJobs(t.db, [jobId], { fetchDetail: reed.fetchDetail });
    assert.equal(second.eligible, 0);
    assert.deepEqual(reed.calls, ["300"]);
  });

  test("Adzuna-only jobs and unknown jobs are never fetched", async () => {
    const adzuna = adzunaJob("A1").jobId;
    const reed = fakeReed();
    const stats = await enrichSelectedJobs(t.db, [adzuna, 99999], { fetchDetail: reed.fetchDetail });
    assert.deepEqual(reed.calls, []);
    assert.deepEqual(stats, { requested: 2, eligible: 0, fetched: 0, notFound: 0, failed: 0, skipped: 0, stoppedBy: null });
    assert.equal(count(t.db, "job_descriptions", "kind = 'full'"), 0);
  });

  test("a job listed by Adzuna and Reed uses its Reed listing, once", async () => {
    const adz = adzunaJob("A2", "Android Developer", "Mobi");
    const reedListing = reedJob("400", "Android Developer", "Mobi");
    assert.equal(reedListing.jobId, adz.jobId, "merged into one job by fingerprint");

    const reed = fakeReed();
    await enrichSelectedJobs(t.db, [adz.jobId, adz.jobId], { fetchDetail: reed.fetchDetail });
    assert.deepEqual(reed.calls, ["400"]);
    assert.equal(getBestDescription(t.db, adz.jobId)?.jobListingId, reedListing.listingId);
  });

  test("a job with several Reed listings gets one request, for the latest listing", async () => {
    const first = reedJob("501", "QA Developer", "Same");
    const second = reedJob("502", "QA Developer", "Same");
    assert.equal(first.jobId, second.jobId);
    t.db.prepare("UPDATE job_listings SET last_seen_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(first.listingId);
    t.db.prepare("UPDATE job_listings SET last_seen_at = '2026-02-01T00:00:00.000Z' WHERE id = ?").run(second.listingId);

    assert.deepEqual(reedListingToEnrich(t.db, first.jobId), { listingId: second.listingId, externalId: "502" });
    const reed = fakeReed();
    await enrichSelectedJobs(t.db, [first.jobId], { fetchDetail: reed.fetchDetail });
    assert.deepEqual(reed.calls, ["502"]);
  });

  test("failures leave the snippet and never throw", async () => {
    const ids = ["601", "602", "603"].map((id) => reedJob(id).jobId);
    const reed = fakeReed({
      "601": { status: "not_found", httpStatus: 404 },
      "602": new Error("fetcher crashed"),
      "603": { status: "error", error: "Request failed (TypeError)" },
    });
    const stats = await enrichSelectedJobs(t.db, ids, { fetchDetail: reed.fetchDetail });
    assert.deepEqual(stats, { requested: 3, eligible: 3, fetched: 0, notFound: 1, failed: 2, skipped: 0, stoppedBy: null });
    for (const id of ids) assert.equal(getBestDescription(t.db, id)?.kind, "snippet");
  });

  test("a 429 or 401 stops the remaining requests", async () => {
    for (const status of ["rate_limited", "auth_failed"] as const) {
      const ids = ["1", "2", "3", "4", "5"].map((n) => reedJob(`${status === "rate_limited" ? 7 : 8}0${n}`).jobId);
      const firstId = status === "rate_limited" ? "701" : "801";
      const reed = fakeReed({ [firstId]: { status, httpStatus: status === "rate_limited" ? 429 : 401 } });
      const stats = await enrichSelectedJobs(t.db, ids, { fetchDetail: reed.fetchDetail, concurrency: 1 });
      assert.deepEqual(reed.calls, [firstId], status);
      assert.deepEqual(stats, { requested: 5, eligible: 5, fetched: 0, notFound: 0, failed: 1, skipped: 4, stoppedBy: status });
    }
  });

  test("with two requests at a time, a 429 still stops the rest", async () => {
    const ids = ["901", "902", "903", "904", "905", "906"].map((id) => reedJob(id).jobId);
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: string[] = [];
    const fetchDetail: DetailFetcher = async (externalId) => {
      calls.push(externalId);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return externalId === "901" ? { status: "rate_limited", httpStatus: 429 } : { status: "ok", description: `Full ${externalId}` };
    };
    const stats = await enrichSelectedJobs(t.db, ids, { fetchDetail });
    assert.equal(maxInFlight, 2);
    assert.deepEqual(calls, ["901", "902"]);
    assert.equal(stats.stoppedBy, "rate_limited");
    assert.equal(stats.fetched + stats.failed + stats.skipped, 6);
    assert.equal(stats.skipped, 4);
  });

  test("only description rows are written: no jobs, listings, matches or seen_jobs", async () => {
    seedSeenJobs(t.db, 6);
    const ids = ["1001", "1002"].map((id) => reedJob(id).jobId);
    ids.push(adzunaJob("A3").jobId);
    const before = tableCounts();
    const seenBefore = t.db.prepare("SELECT job_id, first_seen FROM seen_jobs ORDER BY job_id").all();

    await enrichSelectedJobs(t.db, ids, { fetchDetail: fakeReed().fetchDetail });

    assert.deepEqual(tableCounts(), before);
    assert.deepEqual(t.db.prepare("SELECT job_id, first_seen FROM seen_jobs ORDER BY job_id").all(), seenBefore);
    assert.equal(count(t.db, "job_descriptions", "kind = 'full'"), 2);
  });

  test("the same text arriving for another listing of the job is stored once", async () => {
    const first = reedJob("1101", "Same Role Developer", "Co");
    const fetchDetail: DetailFetcher = async () => ({ status: "ok", description: "Identical full text" });
    await enrichSelectedJobs(t.db, [first.jobId], { fetchDetail });
    assert.equal(count(t.db, "job_descriptions", "job_id = ? AND kind = 'full'", first.jobId), 1);
  });

  test("no jobs means no requests", async () => {
    const reed = fakeReed();
    const stats = await enrichSelectedJobs(t.db, [], { fetchDetail: reed.fetchDetail });
    assert.deepEqual(reed.calls, []);
    assert.equal(stats.requested, 0);
  });
});

// ── scoringDescriptionFor (checkpoint 3b-3) ─────────────────────────────────

describe("3b-3: scoringDescriptionFor", () => {
  test("a fetched full description is used", async () => {
    const { jobId } = reedJob("2001");
    await enrichSelectedJobs(t.db, [jobId], { fetchDetail: fakeReed().fetchDetail });
    assert.equal(scoringDescriptionFor(t.db, { jobId, description: "sent in" }), "Full description for 2001");
  });

  test("otherwise the longest stored snippet of any of the job's listings", () => {
    const adz = recordJobListing(t.db, {
      sourceId: "adzuna", externalId: "S1", title: "Snippet Developer", company: "Co", description: "A".repeat(500),
    });
    reedJob("2002", "Snippet Developer", "Co");
    assert.equal(scoringDescriptionFor(t.db, { jobId: adz.jobId, description: "short" }), "A".repeat(500));
    assert.equal(reedJob("2003").jobId > 0, true);
    assert.equal(scoringDescriptionFor(t.db, { jobId: reedJob("2003").jobId }), SNIPPET);
  });

  test("a job that was not stored, or has no description, uses the one sent in", () => {
    assert.equal(scoringDescriptionFor(t.db, { description: "sent in" }), "sent in");
    // A jobId that is not a number is ignored, even if it names a stored job.
    const stored = reedJob("2005").jobId;
    assert.equal(scoringDescriptionFor(t.db, { jobId: String(stored), description: "string id" }), "string id");
    assert.equal(scoringDescriptionFor(t.db, { jobId: 99999, description: "unknown job" }), "unknown job");
    const bare = recordJobListing(t.db, { sourceId: "adzuna", externalId: "S2", title: "No Desc", company: "Co" }).jobId;
    assert.equal(scoringDescriptionFor(t.db, { jobId: bare, description: "sent in" }), "sent in");
    assert.equal(scoringDescriptionFor(t.db, { jobId: bare }), "");
  });

  test("the saved match records the description that was scored", async () => {
    const reedOnly = reedJob("2004").jobId;
    const adzOnly = adzunaJob("S3").jobId;
    await enrichSelectedJobs(t.db, [reedOnly, adzOnly], { fetchDetail: fakeReed().fetchDetail });
    const used = new Map([reedOnly, adzOnly].map((jobId) => [jobId, scoringDescriptionFor(t.db, { jobId })]));

    const { matchIds } = recordMatchResults(t.db, { candidateProfileId: profileId, runId: null, warnings: [] }, {
      scored: [reedOnly, adzOnly].map((jobId) => ({
        jobId, score: 70, modelScore: 70, breakdownScore: 70, breakdown: {}, reason: "r", strengths: [], missingSkills: [],
      })),
      filteredOut: [], failed: [], model: "llama3.2:3b", promptVersion: "match/v2",
    });
    for (const [jobId, description] of used) {
      const row = t.db
        .prepare(
          `SELECT m.prompt_version, d.content FROM matches m JOIN job_descriptions d ON d.id = m.job_description_id
           WHERE m.id = ?`
        )
        .get(matchIds.get(jobId)) as { prompt_version: string; content: string };
      assert.equal(row.content, description);
      assert.equal(row.prompt_version, "match/v2");
    }
    assert.equal(used.get(reedOnly), "Full description for 2004");
    assert.equal(used.get(adzOnly), "Adzuna snippet");
  });
});

// ── /api/match wiring (source checks: tests never import route modules) ─────

describe("3b-2: /api/match fetches details only for selected jobs of saved runs", () => {
  const root = path.join(import.meta.dirname, "..");
  const route = fs.readFileSync(path.join(root, "app/api/match/route.ts"), "utf8");

  test("enrichment is called with the selected jobs, only with a session and a Reed key", () => {
    assert.match(route, /if \(session && reedKey\) \{\s*try \{\s*const detailStats = await enrichSelectedJobs\(\s*db,\s*selectedJobs\.flatMap/);
    assert.match(route, /fetchDetail: \(externalId\) => fetchReedJobDetail\(externalId, reedKey\)/);
    assert.equal((route.match(/enrichSelectedJobs\(/g) ?? []).length, 1);
  });

  test("it runs after the selection and before the model calls, and cannot fail the request", () => {
    const enrich = route.indexOf("await enrichSelectedJobs(");
    assert.ok(route.indexOf("selectJobsForScoring<IncomingJob>(jobs, candidate)") < enrich);
    assert.ok(route.indexOf("if (selectedJobs.length === 0)") < enrich);
    assert.ok(enrich < route.indexOf("const callOllama"));
    assert.match(route, /\} catch \(error\) \{\s*console\.error\("Reed details skipped:", describeError\(error\)\);/);
  });

  test("the prompt scores against the stored description (since match/v2; now match/v3)", () => {
    assert.match(route, /const jobPrompt = buildMatchPrompt\(candidate, job, index, scoringDescriptionFor\(db, job\)\);/);
    assert.match(route, /const MATCH_PROMPT_VERSION = "match\/v3";/);
    // Enrichment happens before any prompt is built.
    assert.ok(route.indexOf("await enrichSelectedJobs(") < route.indexOf("scoringDescriptionFor(db, job)"));
  });

  test("only the prompt reads the stored description", () => {
    assert.equal((route.match(/scoringDescriptionFor\(/g) ?? []).length, 1);
    // Pre-filter/ranking input, backend corrections and the response are unchanged.
    assert.match(route, /selectJobsForScoring<IncomingJob>\(jobs, candidate\)/);
    assert.match(route, /const jobText = `\$\{job\.title\} \$\{job\.description\}`\.toLowerCase\(\);/);
    assert.match(route, /description: job\.description \|\| "",/);
  });

  test("job discovery makes no detail requests", () => {
    const jobs = fs.readFileSync(path.join(root, "app/api/jobs/route.ts"), "utf8");
    assert.equal(/reed-details|enrichSelectedJobs|api\/1\.0\/jobs\//.test(jobs), false);
  });
});
