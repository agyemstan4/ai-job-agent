import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TestDb } from "./helpers.ts";
import { freshDb, quietly } from "./helpers.ts";
import { runDailyAgent } from "../lib/pipeline/daily-run.ts";
import type { DailyRunDeps, DiscoveredJob } from "../lib/pipeline/daily-run.ts";
import { readDiscoveryReport, searchSource, sourceWarnings } from "../lib/pipeline/source-search.ts";
import type { DiscoveryReport, SourceStatus } from "../lib/pipeline/source-search.ts";
import { getTodaysSavedBrief } from "../lib/pipeline/saved-brief.ts";
import { getBrief, getBriefItems } from "../lib/repositories/briefs.ts";
import { beginMatching } from "../lib/pipeline/matching.ts";
import { createCandidate, createProfileVersion } from "../lib/repositories/candidates.ts";
import { recordJobListing } from "../lib/repositories/jobs.ts";
import { recordMatch } from "../lib/repositories/matches.ts";
import { putPreferences } from "../lib/pipeline/preferences.ts";
import * as scheduler from "../scripts/scheduler.mjs";

// The plain .mjs script is untyped; the tests pass fakes for fetch and the dispatcher.
const { classifyFetchError, exitCodeFor, RUN_TIMEOUT_MS } = scheduler;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const triggerDailyRun = scheduler.triggerDailyRun as (options: any) => Promise<{ status: string; exitCode: number; outcome: any }>;

// Pre-scheduling reliability pass: deterministic scratch databases and fakes
// only — no network, no email, no live database.

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

let t: TestDb;
let candidateId: number;
let profileId: number;
let n = 0;

beforeEach(() => {
  t = quietly(freshDb);
  candidateId = createCandidate(t.db, { fullName: "Sam Example" }).id;
  profileId = createProfileVersion(t.db, { candidateId, origin: "ai_extraction", analysis: { technicalSkills: ["Kotlin"] }, structuredCv: { name: "Sam", education: [], projects: [], experience: [] } }).id;
});
afterEach(() => t.close());

function job(title: string): number {
  n++;
  return recordJobListing(t.db, { sourceId: "reed", externalId: `R${n}`, title, company: `Co ${n}`, location: "London", url: `https://example.invalid/${n}`, salaryMin: 36000, salaryMax: 40000, salaryIsPredicted: false, description: "" }).jobId;
}
const score = (jobId: number, value: number) => recordMatch(t.db, { jobId, candidateProfileId: profileId, outcome: "scored", score: value });

function deps(found: { jobId: number; score: number }[], over: Partial<DailyRunDeps> = {}, day = "2026-10-05T05:30:00Z"): DailyRunDeps {
  return {
    now: () => new Date(day),
    discover: async () => ({ ok: true, jobs: found.map((f) => ({ jobId: f.jobId, title: "x" }) as DiscoveredJob) }),
    match: async () => {
      for (const f of found) score(f.jobId, f.score);
      return { ok: true, scored: found.length };
    },
    ...over,
  };
}
const run = (d: DailyRunDeps) => quietly(() => runDailyAgent(t.db, d));
const wasNew = (date: string) => Object.fromEntries(getBriefItems(t.db, getBrief(t.db, candidateId, date)!.id).map((i) => [i.jobId, i.wasNew]));

describe("1: scheduler timeout", () => {
  test("waits far longer than fetch's 5-minute default, within the task's 3-hour limit", () => {
    assert.ok(RUN_TIMEOUT_MS > 5 * 60_000);
    assert.ok(RUN_TIMEOUT_MS < 3 * 60 * 60_000);
    const src = read("scripts/scheduler.mjs");
    assert.match(src, /headersTimeout: RUN_TIMEOUT_MS/);
    assert.match(src, /bodyTimeout: RUN_TIMEOUT_MS/);
  });

  const timeoutError = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }) });
  const refused = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });

  test("errors are classified: a timeout is not 'the server is not running'", () => {
    assert.equal(classifyFetchError(timeoutError()), "timed_out");
    assert.equal(classifyFetchError(refused()), "not_running");
    assert.equal(classifyFetchError(new Error("boom")), "not_running");
    assert.deepEqual([exitCodeFor("completed"), exitCodeFor("already_ready"), exitCodeFor("not_running"), exitCodeFor("timed_out"), exitCodeFor("failed")], [0, 0, 2, 3, 1]);
  });

  test("a run that finishes (even slowly) is reported as completed, using the long-timeout dispatcher", async () => {
    const seen: unknown[] = [];
    const dispatcher = { marker: "long" };
    const r = await triggerDailyRun({
      baseUrl: "http://x",
      dispatcher,
      fetchImpl: async (_url: string, init: { dispatcher?: unknown }) => {
        seen.push(init.dispatcher);
        return { status: 200, json: async () => ({ status: "completed", briefDate: "2026-10-05", stats: { items: 3, newInBrief: 1, warnings: [], partialSources: ["Adzuna"], searchedWith: "saved_preferences" } }) };
      },
    });
    assert.equal(r.status, "completed");
    assert.equal(r.exitCode, 0);
    assert.equal(seen[0], dispatcher);
    assert.deepEqual(r.outcome.partialSources, ["Adzuna"]);
  });

  test("a timeout while the server finished the brief is completed; otherwise timed_out (not failed, not 'not running')", async () => {
    const calls: string[] = [];
    const make = (briefStatus: string | null) => async (url: string) => {
      calls.push(url);
      if (url.endsWith("/daily-run")) throw timeoutError();
      if (briefStatus === null) throw refused();
      return { json: async () => ({ status: briefStatus }) };
    };
    const done = await triggerDailyRun({ baseUrl: "http://x", dispatcher: {}, fetchImpl: make("ready") });
    assert.deepEqual([done.status, done.exitCode], ["completed", 0]);
    const still = await triggerDailyRun({ baseUrl: "http://x", dispatcher: {}, fetchImpl: make("building") });
    assert.deepEqual([still.status, still.exitCode], ["timed_out", 3]);
    assert.match(still.outcome.note, /may still be working/);
    const unknown = await triggerDailyRun({ baseUrl: "http://x", dispatcher: {}, fetchImpl: make(null) });
    assert.equal(unknown.status, "timed_out");
  });

  test("unreachable server → not_running (exit 2); a server error → failed (exit 1)", async () => {
    const down = await triggerDailyRun({ baseUrl: "http://x", dispatcher: {}, fetchImpl: async () => { throw refused(); } });
    assert.deepEqual([down.status, down.exitCode], ["not_running", 2]);
    const bad = await triggerDailyRun({ baseUrl: "http://x", dispatcher: {}, fetchImpl: async () => ({ status: 500, json: async () => ({ status: "failed", error: "boom" }) }) });
    assert.deepEqual([bad.status, bad.exitCode], ["failed", 1]);
    assert.equal(bad.outcome.error, "boom");
  });
});

describe("2: rate-limit-safe discovery and visible partial failures", () => {
  const noWait = { sleep: async () => {} };
  const ok = (results: unknown[]) => ({ status: 200, results });

  test("searches one term at a time, with a pause between requests", async () => {
    let active = 0;
    let peak = 0;
    const pauses: number[] = [];
    const out = await searchSource("Adzuna", ["a", "b", "c"], async (term) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return ok([term]);
    }, { pauseMs: 400, sleep: async (ms) => void pauses.push(ms) });
    assert.equal(peak, 1);
    assert.deepEqual(out.results, ["a", "b", "c"]);
    assert.deepEqual(pauses, [400, 400]);
    assert.deepEqual(out.status, { source: "Adzuna", planned: 3, succeeded: 3, failed: 0, rateLimited: 0, skipped: 0 });
  });

  test("an HTTP 429 is retried once; success afterwards is a success", async () => {
    const attempts: string[] = [];
    let first = true;
    const out = await searchSource("Adzuna", ["a", "b"], async (term) => {
      attempts.push(term);
      if (term === "a" && first) { first = false; return { status: 429, results: [] }; }
      return ok([term]);
    }, noWait);
    assert.deepEqual(attempts, ["a", "a", "b"]);
    assert.equal(out.status.failed, 0);
    assert.deepEqual(sourceWarnings([out.status]), []);
  });

  test("a site that keeps rate limiting is stopped and reported, not hammered", async () => {
    const attempts: string[] = [];
    const out = await searchSource("Adzuna", ["a", "b", "c", "d"], async (term) => {
      attempts.push(term);
      return term === "b" ? { status: 429, results: [] } : ok([term]);
    }, noWait);
    assert.deepEqual(attempts, ["a", "b", "b"], "c and d are never sent");
    assert.deepEqual(out.results, ["a"]);
    assert.deepEqual(out.status, { source: "Adzuna", planned: 4, succeeded: 1, failed: 1, rateLimited: 1, skipped: 2 });
    assert.deepEqual(sourceWarnings([out.status]), ["source_partial: Adzuna rate-limited — 3 of 4 searches not completed"]);
  });

  test("other failures (network, 500) are counted and the remaining searches still run; a throw counts as failed", async () => {
    const out = await searchSource("Reed", ["a", "b", "c"], async (term) => {
      if (term === "a") return { status: null, results: [] };
      if (term === "b") throw new Error("socket");
      return ok(["c"]);
    }, noWait);
    assert.deepEqual(out.results, ["c"]);
    assert.deepEqual(out.status, { source: "Reed", planned: 3, succeeded: 1, failed: 2, rateLimited: 0, skipped: 0 });
    assert.match(sourceWarnings([out.status])[0], /^source_partial: Reed unavailable — 2 of 3/);
  });

  const report = (adzuna: Partial<SourceStatus>): DiscoveryReport => ({
    usedPreferences: true,
    terms: 4,
    sources: [
      { source: "Adzuna", planned: 4, succeeded: 4, failed: 0, rateLimited: 0, skipped: 0, ...adzuna },
      { source: "Reed", planned: 4, succeeded: 4, failed: 0, rateLimited: 0, skipped: 0 },
    ],
  });

  test("a partially rate-limited run is recorded in the brief's stats and shown to the user — not presented as a full success", async () => {
    const a = job("Territory Manager");
    const limited = report({ succeeded: 1, failed: 1, rateLimited: 1, skipped: 2 });
    const r = await run(deps([{ jobId: a, score: 80 }], { discover: async () => ({ ok: true, jobs: [{ jobId: a }] as DiscoveredJob[], report: limited }) }));
    assert.equal(r.status, "completed");
    if (r.status !== "completed") return;
    assert.deepEqual(r.stats.partialSources, ["Adzuna"]);
    assert.deepEqual(r.stats.warnings, ["source_partial: Adzuna rate-limited — 3 of 4 searches not completed"]);
    assert.equal(r.stats.searchTerms, 4);
    const view = getTodaysSavedBrief(t.db, new Date("2026-10-05T09:00:00Z"));
    assert.deepEqual(view.brief?.warnings, ["Adzuna was rate-limited during the last run, so 3 of 4 searches didn't finish — results may be incomplete."]);
  });

  test("a clean run has no partial sources", async () => {
    const a = job("Driver");
    const r = await run(deps([{ jobId: a, score: 70 }], { discover: async () => ({ ok: true, jobs: [{ jobId: a }] as DiscoveredJob[], report: report({}) }) }));
    assert.equal(r.status === "completed" && r.stats.partialSources instanceof Array && r.stats.partialSources.length, 0);
    assert.deepEqual(r.status === "completed" && r.stats.warnings, []);
  });

  test("the discovery report header round-trips and bad values are ignored", () => {
    const rep = report({});
    assert.deepEqual(readDiscoveryReport(JSON.stringify(rep)), rep);
    assert.equal(readDiscoveryReport(null), null);
    assert.equal(readDiscoveryReport("{nope"), null);
    assert.equal(readDiscoveryReport(JSON.stringify({ sources: [] })), null);
  });

  test("/api/jobs searches through the sequential helper and reports it; no more Promise.all over terms", () => {
    const src = read("app/api/jobs/route.ts");
    assert.match(src, /searchSource\("Adzuna"/);
    assert.match(src, /searchSource\("Reed"/);
    assert.doesNotMatch(src, /searchTerms\.map\(async/);
    assert.match(src, /DISCOVERY_REPORT_HEADER/);
  });
});

describe("3: 'new' in the first brief", () => {
  test("opportunities already scored before the first brief are not new; ones this run found are", async () => {
    const before = job("Territory Manager");
    score(before, 85); // seen and scored earlier (e.g. from the UI)
    const found = job("Field Sales Executive");
    const r = await run(deps([{ jobId: found, score: 80 }]));
    assert.equal(r.status, "completed");
    assert.deepEqual(wasNew("2026-10-05"), { [before]: false, [found]: true });
    if (r.status === "completed") assert.equal(r.stats.newInBrief, 1);
  });

  test("a first brief with nothing found by the run marks nothing new", async () => {
    const a = job("Driver");
    score(a, 70);
    await run(deps([]));
    assert.deepEqual(wasNew("2026-10-05"), { [a]: false });
  });

  test("later briefs: found by the run, or first seen after the previous brief, is new; surfaced jobs never again", async () => {
    const a = job("Driver");
    await run(deps([{ jobId: a, score: 70 }], {}, "2026-10-05T05:30:00Z"));
    // Found by the user's own search after the first brief (not by the run).
    const manual = job("Courier");
    score(manual, 65);
    t.db.prepare("UPDATE jobs SET first_seen_at = '2999-01-01 00:00:00' WHERE id = ?").run(manual);
    // Scored long ago, never in a brief: not new.
    const old = job("Cleaner");
    score(old, 60);
    t.db.prepare("UPDATE jobs SET first_seen_at = '2000-01-01 00:00:00' WHERE id = ?").run(old);
    const fresh = job("Porter");
    await run(deps([{ jobId: fresh, score: 75 }], {}, "2026-10-06T05:30:00Z"));
    assert.deepEqual(wasNew("2026-10-06"), { [a]: false, [manual]: true, [old]: false, [fresh]: true });
  });
});

describe("4: saved preferences drive the scheduled search", () => {
  test("the daily run tells discovery whether saved preferences exist, and records what was searched", async () => {
    const asked: boolean[] = [];
    const d = deps([], { discover: async ({ usingPreferences }) => (asked.push(usingPreferences), { ok: true, jobs: [] }) });
    const r1 = await run(d);
    putPreferences(t.db, { preferences: { targetRoles: ["territory_management"], location: "Leeds" } });
    const r2 = await run(deps([], { discover: async ({ usingPreferences }) => (asked.push(usingPreferences), { ok: true, jobs: [] }) }, "2026-10-06T05:30:00Z"));
    assert.deepEqual(asked, [false, true]);
    assert.equal(r1.status === "completed" && r1.stats.searchedWith, "default_search");
    assert.equal(r2.status === "completed" && r2.stats.searchedWith, "saved_preferences");
  });

  test("if saved preferences cannot be applied, discovery stops (no silent default search) and the brief says so", async () => {
    putPreferences(t.db, { preferences: { targetRoles: ["territory_management"], location: "Leeds" } });
    const r = await run(deps([], { discover: async () => ({ ok: false, error: "discovery HTTP 409" }) }));
    assert.equal(r.status, "completed");
    if (r.status === "completed") assert.deepEqual(r.stats.warnings, ["discovery_failed: discovery HTTP 409"]);
  });

  test("the daily route requires saved preferences when they exist; /api/jobs refuses before any request", () => {
    const route = read("app/api/agent/daily-run/route.ts");
    assert.match(route, /requirePreferences: usingPreferences/);
    const jobs = read("app/api/jobs/route.ts");
    const guard = jobs.indexOf("requirePreferences === true && !preferences");
    assert.ok(guard > 0);
    assert.ok(guard < jobs.indexOf("fetchAdzuna"), "the check comes before any search");
    assert.match(jobs.slice(guard, guard + 300), /status: 409/);
  });
});

describe("5: scheduler metadata and production runtime", () => {
  test("matching can be attributed to the scheduler; the default stays ui", () => {
    const scheduled = beginMatching(t.db, { candidateProfileId: profileId, triggeredBy: "scheduler" })!;
    const row = t.db.prepare("SELECT triggered_by, kind FROM pipeline_runs WHERE id = ?").get(scheduled.runId) as { triggered_by: string; kind: string };
    assert.deepEqual([row.kind, row.triggered_by], ["matching", "scheduler"]);
    t.db.prepare("UPDATE pipeline_runs SET status = 'completed' WHERE id = ?").run(scheduled.runId);
    const manual = beginMatching(t.db, { candidateProfileId: profileId })!;
    assert.equal((t.db.prepare("SELECT triggered_by FROM pipeline_runs WHERE id = ?").get(manual.runId) as { triggered_by: string }).triggered_by, "ui");
  });

  test("the daily route marks its matching as scheduler, and /api/match passes only 'scheduler' or 'ui' through", () => {
    assert.match(read("app/api/agent/daily-run/route.ts"), /candidate: analysis, jobs, candidateProfileId, triggeredBy: "scheduler"/);
    assert.match(read("app/api/match/route.ts"), /triggeredBy: triggeredBy === "scheduler" \? "scheduler" : "ui"/);
  });

  test("the Windows tasks run the production server (npm start) after a build, never the dev server", () => {
    const ps = read("scripts/register-daily-task.ps1");
    assert.match(ps, /-Argument "start"/);
    assert.match(ps, /npm\.cmd/);
    assert.match(ps, /BUILD_ID/);
    assert.doesNotMatch(ps.replace(/^#.*$/gm, ""), /run dev|next dev/);
    assert.match(ps, /scripts\\scheduler\.mjs/);
    assert.match(ps, /-At "06:30"/);
  });
});
