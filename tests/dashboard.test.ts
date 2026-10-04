import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TestDb } from "./helpers.ts";
import { freshDb, quietly } from "./helpers.ts";
import { DEFAULT_TOP_MATCHES, getDashboard, MAX_TOP_MATCHES, STRONG_MATCH_SCORE } from "../lib/pipeline/dashboard.ts";
import { actionFor, formatSalary, loadDashboard, requestPreparation, scoreBadge } from "../lib/dashboard-client.ts";
import type { PrepareDeps } from "../lib/pipeline/prepare.ts";
import { prepareApplication } from "../lib/pipeline/prepare.ts";
import { createCandidate, createProfileVersion } from "../lib/repositories/candidates.ts";
import { recordJobListing } from "../lib/repositories/jobs.ts";
import { recordMatch } from "../lib/repositories/matches.ts";
import { createApplication, transitionApplication } from "../lib/repositories/applications.ts";

// Phase 3 checkpoint 3c: the Command Centre (GET /api/dashboard + the panel on /).

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

let t: TestDb;
beforeEach(() => {
  t = quietly(freshDb);
});
afterEach(() => t.close());

function seedProfile() {
  const c = createCandidate(t.db, { fullName: "A" });
  return createProfileVersion(t.db, {
    candidateId: c.id, origin: "ai_extraction", analysis: { technicalSkills: ["Java"] },
    structuredCv: { name: "A", education: [], projects: [], experience: [] },
  }).id;
}

let n = 0;
function job(fields: Partial<{ title: string; company: string; location: string; salaryMin: number; salaryMax: number; salaryIsPredicted: boolean; url: string; source: "adzuna" | "reed" }> = {}) {
  n++;
  return recordJobListing(t.db, {
    sourceId: fields.source ?? "reed", externalId: `X${n}`, title: fields.title ?? `Developer ${n}`, company: fields.company ?? `Co ${n}`,
    location: fields.location ?? "London", url: fields.url ?? `https://example.invalid/${n}`, salaryMin: fields.salaryMin ?? null,
    salaryMax: fields.salaryMax ?? null, salaryIsPredicted: fields.salaryIsPredicted ?? null,
  }).jobId;
}

describe("3c: getDashboard", () => {
  test("no CV yet: no profile, zero counts except discovered jobs, no matches", () => {
    job();
    const d = getDashboard(t.db);
    assert.equal(d.hasProfile, false);
    assert.deepEqual(d.topMatches, []);
    assert.deepEqual(d.stats, { discoveredJobs: 1, scoredMatches: 0, strongMatches: 0, preparing: 0, needsReview: 0, readyToApply: 0, submitted: 0 });
    assert.equal(d.strongMatchScore, STRONG_MATCH_SCORE);
  });

  test("ranked scored matches with job details, strengths and missing skills; filtered-out jobs excluded", () => {
    const profileId = seedProfile();
    const a = job({ title: "Android Developer", company: "Mobi", salaryMin: 30000, salaryMax: 38000 });
    const b = job({ title: "Java Developer", company: "Acme", salaryMin: 25000, salaryMax: 28000, salaryIsPredicted: true, source: "adzuna" });
    const c = job({ title: "Senior Engineer" });
    recordMatch(t.db, { jobId: a, candidateProfileId: profileId, outcome: "scored", score: 64, reason: "Decent", strengths: ["Kotlin"], missingSkills: [{ skill: "Compose", importance: "high" }] });
    recordMatch(t.db, { jobId: b, candidateProfileId: profileId, outcome: "scored", score: 88, reason: "Great", strengths: ["Java", "SQL"], missingSkills: ["Spring"] });
    recordMatch(t.db, { jobId: c, candidateProfileId: profileId, outcome: "filtered_out", filterReason: "Senior title" });

    const d = getDashboard(t.db);
    assert.equal(d.hasProfile, true);
    assert.deepEqual(d.topMatches.map((m) => m.title), ["Java Developer", "Android Developer"]);
    const top = d.topMatches[0];
    assert.equal(top.score, 88);
    assert.equal(top.company, "Acme");
    assert.equal(top.location, "London");
    assert.deepEqual([top.salaryMin, top.salaryMax, top.salaryIsPredicted], [25000, 28000, true]);
    assert.deepEqual(top.sources, ["adzuna"]);
    assert.deepEqual(top.strengths, ["Java", "SQL"]);
    assert.deepEqual(top.missingSkills, ["Spring"]);
    assert.match(String(top.url), /^https:\/\/example\.invalid\//);
    assert.equal(top.application, null);
    assert.deepEqual(d.topMatches[1].missingSkills, ["Compose"]);
    assert.deepEqual([d.stats.discoveredJobs, d.stats.scoredMatches, d.stats.strongMatches], [3, 2, 1]);
  });

  test("only the current profile's matches count", () => {
    const old = seedProfile();
    const j = job();
    recordMatch(t.db, { jobId: j, candidateProfileId: old, outcome: "scored", score: 90 });
    const c = createCandidate(t.db, { fullName: "Other" });
    void c;
    const d = getDashboard(t.db);
    assert.equal(d.topMatches.length, 1);
    // A newer profile version for the same candidate replaces it.
    const candidateId = (t.db.prepare("SELECT candidate_id FROM candidate_profiles WHERE id = ?").get(old) as { candidate_id: number }).candidate_id;
    createProfileVersion(t.db, { candidateId, origin: "ai_extraction", analysis: {}, structuredCv: { name: "A" } });
    assert.equal(getDashboard(t.db).topMatches.length, 0);
  });

  test("application status per match and the application counts", () => {
    const profileId = seedProfile();
    const jobs = [job(), job(), job(), job()];
    const matches = jobs.map((jobId, i) => recordMatch(t.db, { jobId, candidateProfileId: profileId, outcome: "scored", score: 90 - i }));
    const review = createApplication(t.db, { jobId: jobs[0], matchId: matches[0].id, status: "ready_for_review" });
    createApplication(t.db, { jobId: jobs[1], matchId: matches[1].id, status: "preparing" });
    const failed = createApplication(t.db, { jobId: jobs[2], matchId: matches[2].id, status: "preparing" });
    transitionApplication(t.db, failed.id, "preparation_failed", { actor: "system", error: "x" });
    const d = getDashboard(t.db);
    assert.deepEqual(d.topMatches.map((m) => m.application?.status ?? null), ["ready_for_review", "preparing", "preparation_failed", null]);
    assert.equal(d.topMatches[0].application?.id, review.id);
    assert.deepEqual([d.stats.needsReview, d.stats.preparing, d.stats.readyToApply, d.stats.submitted], [1, 1, 0, 0]);
  });

  test("limit: default 20, capped at 50, invalid values ignored", () => {
    const profileId = seedProfile();
    for (let i = 0; i < 60; i++) recordMatch(t.db, { jobId: job(), candidateProfileId: profileId, outcome: "scored", score: i });
    assert.equal(getDashboard(t.db).topMatches.length, DEFAULT_TOP_MATCHES);
    assert.equal(getDashboard(t.db, { limit: 5 }).topMatches.length, 5);
    assert.equal(getDashboard(t.db, { limit: 500 }).topMatches.length, MAX_TOP_MATCHES);
    for (const limit of [0, -3, 2.5, "10"]) assert.equal(getDashboard(t.db, { limit }).topMatches.length, DEFAULT_TOP_MATCHES);
    assert.equal(getDashboard(t.db, { limit: 3 }).topMatches[0].score, 59);
  });
});

describe("3c: Command Centre helpers", () => {
  test("formatSalary", () => {
    assert.equal(formatSalary(30000, 38000), "£30,000–£38,000");
    assert.equal(formatSalary(35000, 35000), "£35,000");
    assert.equal(formatSalary(null, 40000), "£40,000");
    assert.equal(formatSalary(25000, 28000, true), "£25,000–£28,000 (estimated)");
    assert.equal(formatSalary(350, 400), "£350–£400 a day");
    assert.equal(formatSalary(null, null), null);
    assert.equal(formatSalary(0, 0), null);
  });

  test("scoreBadge", () => {
    assert.equal(scoreBadge(90).label, "Excellent");
    assert.equal(scoreBadge(70).label, "Strong");
    assert.equal(scoreBadge(55).label, "Possible");
    assert.equal(scoreBadge(20).label, "Weak");
    assert.equal(scoreBadge(null).label, "Not scored");
  });

  test("actionFor: from the latest application's status", () => {
    const at = (status: string | null) => actionFor({ application: status ? { id: 1, status: status as never } : null });
    assert.equal(at(null), "prepare");
    for (const s of ["preparation_failed", "rejected", "withdrawn", "unsuccessful"]) assert.equal(at(s), "prepare", s);
    assert.equal(at("preparing"), "preparing");
    assert.equal(at("ready_for_review"), "review");
    assert.equal(at("approved"), "apply");
    for (const s of ["submitted", "acknowledged", "interviewing", "offer", "submitting", "submission_failed"]) assert.equal(at(s), "track", s);
  });
});

describe("3c: loading and preparing against the real handlers", () => {
  const dashboardFetch = async (url: string) => {
    assert.equal(url, "/api/dashboard");
    return new Response(JSON.stringify(getDashboard(t.db)), { status: 200 });
  };
  const deps: PrepareDeps = {
    tailorCv: async (cv) => ({ ...cv }),
    renderCv: async () => ({ buffer: Buffer.from("%PDF"), filename: "cv.pdf", format: "pdf", mimeType: "application/pdf" }),
    coverLetter: async () => "Dear team",
    answerQuestions: async () => [],
  };
  const prepareFetch = async (url: string, init?: RequestInit) => {
    assert.equal(url, "/api/applications/prepare");
    assert.equal(init?.method, "POST");
    const result = await prepareApplication(t.db, JSON.parse(String(init?.body)), deps);
    return new Response(JSON.stringify(result.body), { status: result.status });
  };

  test("loadDashboard returns the data", async () => {
    const profileId = seedProfile();
    recordMatch(t.db, { jobId: job(), candidateProfileId: profileId, outcome: "scored", score: 77 });
    const result = await loadDashboard(dashboardFetch);
    assert.equal(result.kind, "loaded");
    if (result.kind === "loaded") assert.equal(result.dashboard.topMatches[0].score, 77);
  });

  test("loadDashboard error states: unreachable, server error, malformed body", async () => {
    assert.deepEqual(await loadDashboard(async () => { throw new TypeError("fetch failed"); }), {
      kind: "error", message: "Could not reach the Job Agent. Check that it is still running, then try again.",
    });
    assert.deepEqual(await loadDashboard(async () => new Response(JSON.stringify({ error: "Failed to load the dashboard" }), { status: 500 })), {
      kind: "error", message: "Failed to load the dashboard",
    });
    assert.equal((await loadDashboard(async () => new Response("not json", { status: 200 }))).kind, "error");
  });

  test("requestPreparation: prepared, then exists; the dashboard shows Review", async () => {
    const profileId = seedProfile();
    const match = recordMatch(t.db, { jobId: job(), candidateProfileId: profileId, outcome: "scored", score: 81 });
    const first = await requestPreparation(match.id, prepareFetch);
    assert.equal(first.kind, "prepared");
    const second = await requestPreparation(match.id, prepareFetch);
    assert.deepEqual(second, { kind: "exists", applicationId: first.kind === "prepared" ? first.applicationId : -1, status: "ready_for_review" });
    const d = getDashboard(t.db);
    assert.equal(actionFor(d.topMatches[0]), "review");
    assert.equal(d.stats.needsReview, 1);
  });

  test("requestPreparation error states", async () => {
    assert.equal((await requestPreparation(999, prepareFetch)).kind, "error");
    assert.equal((await requestPreparation(1, async () => { throw new TypeError("x"); })).kind, "error");
    const busy = await requestPreparation(1, async () => new Response(JSON.stringify({ applicationId: 5, error: "This job is already being prepared." }), { status: 409 }));
    assert.deepEqual(busy, { kind: "busy", applicationId: 5, message: "This job is already being prepared." });
    const failed = await requestPreparation(1, async () => new Response(JSON.stringify({ error: "Preparing the CV failed: Ollama error: 500" }), { status: 502 }));
    assert.deepEqual(failed, { kind: "error", message: "Preparing the CV failed: Ollama error: 500" });
  });
});

describe("3c: the Command Centre on / (source checks)", () => {
  const component = read("app/components/CommandCentre.tsx");
  const page = read("app/page.tsx");
  const client = read("lib/dashboard-client.ts");

  test("the home page renders the Command Centre above the existing search tools", () => {
    assert.match(page, /import CommandCentre from "\.\/components\/CommandCentre";/);
    assert.ok(page.indexOf("<CommandCentre />") > 0 && page.indexOf("<CommandCentre />") < page.indexOf("{/* CV Upload */}"));
    assert.match(page, /<Link href="\/preferences"/);
    assert.match(page, /href="\/review"/);
    assert.match(page, /href="\/applications"/);
  });

  test("loads on open; loading, empty, error and retry states; stats and ranked matches", () => {
    assert.ok(component.startsWith('"use client";'));
    assert.match(component, /useEffect\(\(\) => \{\s*let cancelled = false;\s*loadDashboard\(\)\.then/);
    for (const text of ["Loading your dashboard…", "Try again", "No CV profile yet", "No scored matches yet", "Jobs discovered", "Need your review", "Applied", "Top matches"]) {
      assert.ok(component.includes(text), text);
    }
    for (const field of ["match.title", "match.company", "match.location", "formatSalary(", "match.strengths", "match.reason", "scoreBadge("]) {
      assert.ok(component.includes(field), field);
    }
  });

  test("actions: View Job (new tab, no opener), Prepare Application (one at a time), Review, Track", () => {
    assert.match(component, /href=\{match\.url\} target="_blank" rel="noopener noreferrer"/);
    assert.match(component, /onClick=\{\(\) => prepare\(match\)\} disabled=\{busyElsewhere\}/);
    assert.match(component, /<Link href="\/review"[^>]*>Review Application<\/Link>/);
    assert.match(component, /<Link href="\/applications"[^>]*>Track<\/Link>/);
  });

  test("nothing on the Command Centre approves, submits, emails or opens windows", () => {
    for (const source of [component, client]) {
      for (const forbidden of ["window.open", "mark_submitted", "approveApplication", "resend", "sendEmail", "/api/match", "/api/jobs", "PATCH"]) {
        assert.equal(source.includes(forbidden), false, forbidden);
      }
      // No approve action is sent (the word may appear in text, e.g. "approved and ready to apply").
      assert.doesNotMatch(source, /action:\s*["']approve["']/);
    }
    assert.deepEqual([...client.matchAll(/fetchImpl\("([^"]+)"/g)].map((m) => m[1]).sort(), ["/api/applications/prepare", "/api/dashboard"]);
  });

  test("the dashboard route is thin and read-only", () => {
    const route = read("app/api/dashboard/route.ts");
    assert.match(route, /export async function GET\(req: NextRequest\)/);
    assert.match(route, /getDashboard\(db,/);
    assert.equal(/export async function (POST|PUT|PATCH|DELETE)/.test(route), false);
  });
});
