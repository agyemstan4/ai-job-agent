import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TestDb } from "./helpers.ts";
import { freshDb, quietly } from "./helpers.ts";
import { DEFAULT_TOP_MATCHES, getDashboard, MAX_TOP_MATCHES, STRONG_MATCH_SCORE } from "../lib/pipeline/dashboard.ts";
import {
  actionFor,
  filterMatches,
  formatSalary,
  greetingFor,
  loadDashboard,
  newSinceLastVisit,
  parseStoredTime,
  pickFeatured,
  progressGroups,
  requestPreparation,
  scoreBadge,
  sourceLabel,
  statusInfo,
  timeAgo,
  workArrangement,
} from "../lib/dashboard-client.ts";
import type { DashboardMatch } from "../lib/pipeline/dashboard.ts";
import { putPreferences } from "../lib/pipeline/preferences.ts";
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
    assert.deepEqual(d.stats, { discoveredJobs: 1, scoredMatches: 0, strongMatches: 0, strongToday: 0, preparing: 0, needsReview: 0, readyToApply: 0, submitted: 0, applicationsByStatus: {} });
    assert.equal(d.firstName, null);
    assert.deepEqual(d.search, { usingPreferences: false, location: "London", terms: ["junior software engineer", "graduate software developer", "android developer", "java developer", "frontend developer", "full stack developer"] });
    assert.deepEqual(d.agent, { lastDiscoveryAt: null, lastMatchingAt: null });
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

// ── Command Centre v2 (visual pass): extra existing data + presentation helpers ──

describe("3c v2: dashboard data for the redesigned Command Centre", () => {
  test("first name, saved search, agent timing, breakdown, contract and discovery dates", () => {
    const profileId = seedProfile();
    t.db.prepare("UPDATE candidates SET full_name = 'Ada Lovelace'").run();
    putPreferences(t.db, { preferences: { searchTerms: ["kotlin developer"], location: "Leeds" } });
    t.db.prepare("INSERT INTO pipeline_runs (kind, triggered_by, status, started_at, finished_at) VALUES ('discovery', 'ui', 'completed', '2026-10-01 09:00:00', '2026-10-01 09:01:00')").run();
    const j = job();
    t.db.prepare("UPDATE jobs SET contract_time = 'full_time', contract_type = 'permanent' WHERE id = ?").run(j);
    recordMatch(t.db, { jobId: j, candidateProfileId: profileId, outcome: "scored", score: 81, breakdown: { technicalSkills: 90, experienceLevel: "70", projects: null, growthPotential: 85 } });
    const d = getDashboard(t.db);
    assert.equal(d.firstName, "Ada");
    assert.deepEqual(d.search, { usingPreferences: true, location: "Leeds", terms: ["kotlin developer"] });
    assert.deepEqual(d.agent, { lastDiscoveryAt: "2026-10-01 09:01:00", lastMatchingAt: null });
    const top = d.topMatches[0];
    assert.deepEqual(top.breakdown, { technicalSkills: 90, experienceLevel: 70, projects: null, growthPotential: 85 });
    assert.equal(top.contractTime, "full_time");
    assert.equal(top.contractType, "permanent");
    assert.ok(parseStoredTime(top.firstSeenAt));
    assert.ok(parseStoredTime(top.matchedAt));
  });

  test("strong matches today and applications by status", () => {
    const profileId = seedProfile();
    recordMatch(t.db, { jobId: job(), candidateProfileId: profileId, outcome: "scored", score: 80 });
    const old = recordMatch(t.db, { jobId: job(), candidateProfileId: profileId, outcome: "scored", score: 90 });
    t.db.prepare("UPDATE matches SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(old.id);
    recordMatch(t.db, { jobId: job(), candidateProfileId: profileId, outcome: "scored", score: 40 });
    createApplication(t.db, { jobId: job(), status: "ready_for_review" });
    createApplication(t.db, { jobId: job(), status: "preparing" });
    const d = getDashboard(t.db);
    assert.equal(d.stats.strongToday, 1);
    assert.deepEqual(d.stats.applicationsByStatus, { preparing: 1, ready_for_review: 1 });
  });

  test("no breakdown stored: null (the card hides that panel)", () => {
    const profileId = seedProfile();
    recordMatch(t.db, { jobId: job(), candidateProfileId: profileId, outcome: "scored", score: 60 });
    assert.equal(getDashboard(t.db).topMatches[0].breakdown, null);
  });
});

const fake = (over: Partial<DashboardMatch>): DashboardMatch => ({
  matchId: 1, jobId: 1, score: 75, title: "Android Developer", company: "Mobi", location: "London", salaryMin: null, salaryMax: null,
  salaryIsPredicted: false, contractTime: null, contractType: null, url: null, sources: [], reason: null, strengths: ["Kotlin"],
  missingSkills: [], breakdown: null, postedAt: null, firstSeenAt: "2026-10-01 10:00:00", matchedAt: "2026-10-01 10:00:00",
  promptVersion: "match/v3", application: null, ...over,
});

describe("3c v2: presentation helpers", () => {
  test("greetingFor", () => {
    assert.equal(greetingFor(8), "Good morning");
    assert.equal(greetingFor(13), "Good afternoon");
    assert.equal(greetingFor(20), "Good evening");
    assert.equal(greetingFor(2), "Good evening");
    assert.equal(greetingFor(5), "Good morning");
    assert.equal(greetingFor(12), "Good afternoon");
    assert.equal(greetingFor(18), "Good evening");
  });

  test("statusInfo covers every status of the existing state machine", () => {
    for (const s of ["preparing", "preparation_failed", "ready_for_review", "approved", "rejected", "submitting", "submission_failed", "submitted", "acknowledged", "interviewing", "offer", "unsuccessful", "withdrawn"]) {
      const info = statusInfo(s);
      assert.ok(info && info.label && !info.label.includes("_"), s);
    }
    assert.equal(statusInfo("ready_for_review")?.label, "Ready for review");
    assert.equal(statusInfo("submitted")?.label, "Applied");
    assert.equal(statusInfo(null), null);
  });

  test("workArrangement and sourceLabel use only stored values", () => {
    assert.equal(workArrangement("full_time", "permanent"), "Full-time · Permanent");
    assert.equal(workArrangement(null, "contract"), "Contract");
    assert.equal(workArrangement("part_time", null), "Part-time");
    assert.equal(workArrangement(null, null), null);
    assert.equal(sourceLabel(["adzuna", "reed"]), "Adzuna + Reed");
    assert.equal(sourceLabel([]), null);
  });

  test("timeAgo / parseStoredTime (SQLite UTC and ISO)", () => {
    const now = Date.parse("2026-10-04T12:00:00Z");
    assert.equal(parseStoredTime("2026-10-04 11:00:00"), Date.parse("2026-10-04T11:00:00Z"));
    assert.equal(timeAgo("2026-10-04 11:59:40", now), "just now");
    assert.equal(timeAgo("2026-10-04T11:55:00.000Z", now), "5 minutes ago");
    assert.equal(timeAgo("2026-10-04 09:00:00", now), "3 hours ago");
    assert.equal(timeAgo("2026-10-03 11:00:00", now), "yesterday");
    assert.equal(timeAgo("2026-09-30 12:00:00", now), "4 days ago");
    assert.equal(timeAgo(null, now), null);
    assert.equal(timeAgo("not a date", now), null);
  });

  test("pickFeatured: the strongest match still worth acting on", () => {
    const list = [
      fake({ matchId: 1, score: 90, application: { id: 1, status: "submitted" } }),
      fake({ matchId: 2, score: 85, application: { id: 2, status: "ready_for_review" } }),
      fake({ matchId: 3, score: 80 }),
    ];
    assert.equal(pickFeatured(list)?.matchId, 2);
    assert.equal(pickFeatured([fake({ score: 90, application: { id: 1, status: "offer" } })]), null);
    assert.equal(pickFeatured([]), null);
  });

  test("filterMatches: views and free text", () => {
    const list = [
      fake({ matchId: 1, score: 85, title: "Kotlin Engineer" }),
      fake({ matchId: 2, score: 55, title: "QA", strengths: ["Selenium"], application: { id: 9, status: "ready_for_review" } }),
      fake({ matchId: 3, score: 72, company: "Acme", application: { id: 8, status: "submitted" } }),
    ];
    assert.deepEqual(filterMatches(list, "all", "").map((x) => x.matchId), [1, 2, 3]);
    assert.deepEqual(filterMatches(list, "strong", "").map((x) => x.matchId), [1, 3]);
    assert.deepEqual(filterMatches(list, "todo", "").map((x) => x.matchId), [1]);
    assert.deepEqual(filterMatches(list, "in_progress", "").map((x) => x.matchId), [2]);
    assert.deepEqual(filterMatches(list, "all", "selenium").map((x) => x.matchId), [2]);
    assert.deepEqual(filterMatches(list, "all", " ACME ").map((x) => x.matchId), [3]);
  });

  test("newSinceLastVisit: none on a first visit; only jobs first seen after the last visit", () => {
    const list = [fake({ matchId: 1, firstSeenAt: "2026-10-01 10:00:00" }), fake({ matchId: 2, firstSeenAt: "2026-10-03 10:00:00" })];
    assert.deepEqual(newSinceLastVisit(list, null), []);
    assert.deepEqual(newSinceLastVisit(list, Date.parse("2026-10-02T00:00:00Z")).map((x) => x.matchId), [2]);
  });

  test("progressGroups: only non-empty groups", () => {
    assert.deepEqual(progressGroups({}), []);
    assert.deepEqual(progressGroups({ ready_for_review: 2, submitted: 1, acknowledged: 1, rejected: 3 }).map((g) => `${g.label}:${g.count}`), ["To review:2", "Applied:2"]);
  });
});

// ── Source checks: the redesigned page, component and navigation ──

describe("3c v2: Command Centre, navigation and home page (source checks)", () => {
  const component = read("app/components/CommandCentre.tsx");
  const nav = read("app/components/AppNav.tsx");
  const layout = read("app/layout.tsx");
  const page = read("app/page.tsx");
  const client = read("lib/dashboard-client.ts");

  test("the home page renders the Command Centre above the existing search tools (#search)", () => {
    assert.match(page, /import CommandCentre from "\.\/components\/CommandCentre";/);
    const cc = page.indexOf("<CommandCentre />");
    assert.ok(cc > 0 && cc < page.indexOf('id="search"') && page.indexOf('id="search"') < page.indexOf("{/* CV Upload */}"));
    assert.match(page, /<Link href="\/preferences"/);
  });

  test("greeting, agent status, discovery control, featured opportunity, feed: from loaded data", () => {
    assert.ok(component.startsWith('"use client";'));
    // Since 3d the first load also reads the preparation queue.
    assert.match(component, /useEffect\(\(\) => \{\s*let cancelled = false;\s*Promise\.all\(\[loadDashboard\(\), loadPreparationStatus\(\)\]\)\.then/);
    for (const text of ["Let&rsquo;s find your next move.", "Find new jobs", "Edit preferences", "Recommended for you", "Why this job fits you", "Your advantage", "Potential gap", "How you match", "Your opportunities", "Your progress", "New since your last visit", "Strong matches today", "Waiting for your review", "Ready to apply", "Try again", "No CV profile yet", "No scored matches yet"]) {
      assert.ok(component.includes(text), text);
    }
    assert.match(component, /dashboard\?\.firstName \? `, \$\{dashboard\.firstName\}` : ""/);
  });

  test("retention sections only render with real data", () => {
    assert.match(component, /\{fresh\.length > 0 && \(/);
    assert.match(component, /\{stats\.strongToday > 0 && \(/);
    assert.match(component, /\{stats\.needsReview > 0 && \(/);
    assert.match(component, /\{stats\.readyToApply > 0 && \(/);
    assert.match(component, /\{progress\.length > 0 && \(/);
    assert.match(component, /window\.localStorage\.getItem\(LAST_VISIT_KEY\)/);
  });

  test("actions: one next action per job; Prepare queues (never blocks other jobs); Review/Track link to existing pages; View Job opens a new tab", () => {
    assert.match(component, /case "prepare":[\s\S]*onClick=\{onPrepare\} disabled=\{disabled\}/);
    assert.match(component, /case "queued":/);
    assert.match(component, /case "review":\s*return <Link href="\/review"[^>]*>Review Application<\/Link>/);
    assert.match(component, /case "apply":\s*return <Link href="\/applications"/);
    assert.match(component, /case "track":\s*return <Link href="\/applications"[^>]*>Track<\/Link>/);
    // Since 3d other jobs' Prepare buttons stay enabled: the server queue bounds the work.
    assert.equal(component.includes("busyElsewhere"), false);
    assert.match(component, /href=\{url\} target="_blank" rel="noopener noreferrer"/);
    assert.match(component, /await queuePreparation\(match\.matchId, \{ retry \}\)/);
  });

  test("navigation: existing routes only, top bar on desktop, bottom tab bar on mobile, in the layout", () => {
    assert.match(layout, /<AppNav \/>/);
    const hrefs = [...nav.matchAll(/href: "([^"]+)"/g)].map((x) => x[1]);
    assert.deepEqual(hrefs, ["/", "/#jobs", "/review", "/applications", "/preferences"]);
    assert.match(nav, /className="hidden items-center gap-1 md:flex"/);
    assert.match(nav, /fixed inset-x-0 bottom-0 z-40[^"]*md:hidden/);
    assert.match(layout, /pb-20 md:pb-0/);
  });

  test("nothing on the Command Centre approves, submits, emails or opens windows", () => {
    for (const source of [component, client, nav]) {
      for (const forbidden of ["window.open", "mark_submitted", "approveApplication", "resend", "sendEmail", "/api/match", "/api/jobs", "PATCH"]) {
        assert.equal(source.includes(forbidden), false, forbidden);
      }
      assert.doesNotMatch(source, /action:\s*["']approve["']/);
    }
    assert.deepEqual([...client.matchAll(/fetchImpl\("([^"]+)"/g)].map((x) => x[1]).sort(), ["/api/applications/prepare", "/api/dashboard"]);
  });

  test("the dashboard route is thin and read-only", () => {
    const route = read("app/api/dashboard/route.ts");
    assert.match(route, /export async function GET\(req: NextRequest\)/);
    assert.match(route, /getDashboard\(db,/);
    assert.equal(/export async function (POST|PUT|PATCH|DELETE)/.test(route), false);
  });
});
