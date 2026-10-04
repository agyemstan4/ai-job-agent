import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TestDb } from "./helpers.ts";
import { count, freshDb, quietly } from "./helpers.ts";
import type { PrepareDeps, PrepareJob } from "../lib/pipeline/prepare.ts";
import { isStalePreparing, PREPARATION_DESCRIPTION_CHARS, prepareApplication, STALE_PREPARING_MINUTES } from "../lib/pipeline/prepare.ts";
import { createCandidate, createProfileVersion } from "../lib/repositories/candidates.ts";
import { addJobDescription, recordJobListing } from "../lib/repositories/jobs.ts";
import { recordMatch } from "../lib/repositories/matches.ts";
import { approveApplication, getApplication, getAssetFile, getCurrentAssets, getCurrentAssetsHash, listApplicationEvents } from "../lib/repositories/applications.ts";
import { getReviewItem } from "../lib/repositories/review.ts";

// Phase 3 checkpoint 3c: server-side preparation of one scored match.
// Generation is injected: these tests use fakes (no Ollama, LibreOffice or email).

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

const STRUCTURED_CV = {
  name: "Test Candidate",
  email: "test@example.com",
  summary: "Graduate engineer.",
  skills: ["Java", "Kotlin"],
  experience: [{ title: "Intern", company: "Co", dates: "2025", bullets: ["Built things"] }],
  education: [{ degree: "BSc Computer Science", institution: "Uni" }],
  projects: [{ name: "App", bullets: ["Shipped"], skillsUsed: ["Kotlin"] }],
};
const ANALYSIS = { technicalSkills: ["Java", "Kotlin"], summary: "Graduate engineer", experienceLevel: "Graduate" };

let t: TestDb;
let profileId: number;

beforeEach(() => {
  t = quietly(freshDb);
  const c = createCandidate(t.db, { fullName: "Test Candidate" });
  profileId = createProfileVersion(t.db, { candidateId: c.id, origin: "ai_extraction", analysis: ANALYSIS, structuredCv: STRUCTURED_CV }).id;
});
afterEach(() => t.close());

let jobCounter = 0;
function scoredMatch(options: { outcome?: "scored" | "filtered_out" | "failed"; description?: string; full?: string } = {}) {
  jobCounter++;
  const { jobId, listingId } = recordJobListing(t.db, {
    sourceId: "reed", externalId: String(1000 + jobCounter), title: `Java Developer ${jobCounter}`, company: "Acme",
    location: "London", url: `https://example.invalid/job/${jobCounter}`, description: options.description ?? "Java snippet",
  });
  if (options.full) addJobDescription(t.db, { jobId, jobListingId: listingId, kind: "full", content: options.full });
  const outcome = options.outcome ?? "scored";
  const match = recordMatch(t.db, {
    jobId, candidateProfileId: profileId, outcome,
    ...(outcome === "scored" ? { score: 82, reason: "Good fit", strengths: ["Java"], missingSkills: [] } : {}),
    ...(outcome === "filtered_out" ? { filterReason: "Senior title" } : {}),
    ...(outcome === "failed" ? { error: "x" } : {}),
  });
  return { jobId, matchId: match.id };
}

/** Fake generation steps that record their calls. */
function fakeDeps(overrides: Partial<PrepareDeps> = {}) {
  const calls: { step: string; args: unknown[] }[] = [];
  const deps: PrepareDeps = {
    tailorCv: async (cv, job) => { calls.push({ step: "tailor", args: [cv, job] }); return { ...STRUCTURED_CV, summary: `Tailored for ${job.title}` }; },
    renderCv: async (cv, job) => { calls.push({ step: "render", args: [cv, job] }); return { buffer: Buffer.from("%PDF-fake"), filename: "Test_Candidate_Acme_CV.pdf", format: "pdf", mimeType: "application/pdf" }; },
    coverLetter: async (candidate, job) => { calls.push({ step: "cover", args: [candidate, job] }); return `Dear ${job.company}, ...`; },
    answerQuestions: async (candidate, job, qs) => { calls.push({ step: "questions", args: [candidate, job, qs] }); return qs.map((q) => ({ question: q, answer: "An honest answer" })); },
    ...overrides,
  };
  return { deps, calls };
}

const kinds = (applicationId: number) => getCurrentAssets(t.db, applicationId).map((a) => a.kind).sort();

describe("3c: prepareApplication — the package", () => {
  test("a scored match becomes an application ready for review with CV data, CV file and cover letter", async () => {
    const { jobId, matchId } = scoredMatch();
    const { deps, calls } = fakeDeps();
    const result = await prepareApplication(t.db, { matchId }, deps);

    assert.equal(result.status, 201);
    assert.equal(result.body.alreadyPrepared, false);
    assert.deepEqual(result.body.warnings, []);
    const app = getApplication(t.db, result.body.applicationId!)!;
    assert.equal(app.status, "ready_for_review");
    assert.equal(app.jobId, jobId);
    assert.equal(app.matchId, matchId);
    assert.equal(app.candidateProfileId, profileId);
    assert.equal(app.lastError, null);
    assert.deepEqual(kinds(app.id), ["cover_letter", "tailored_cv_data", "tailored_cv_file"]);
    assert.deepEqual(calls.map((c) => c.step), ["tailor", "render", "cover"]);
  });

  test("assets record the model, prompt version and the description used; the file is stored", async () => {
    const { matchId } = scoredMatch({ full: "Full Reed description: Java and Kotlin." });
    const { deps } = fakeDeps();
    const id = (await prepareApplication(t.db, { matchId }, deps)).body.applicationId!;
    const assets = Object.fromEntries(getCurrentAssets(t.db, id).map((a) => [a.kind, a]));
    assert.equal(assets.tailored_cv_data.model, "llama3.2:3b");
    assert.equal(assets.tailored_cv_data.promptVersion, "tailor-cv/v1");
    assert.equal(assets.cover_letter.promptVersion, "cover-letter/v1");
    assert.ok(assets.tailored_cv_data.sourceJobDescriptionId);
    assert.equal(assets.tailored_cv_file.filename, "Test_Candidate_Acme_CV.pdf");
    assert.equal(assets.tailored_cv_file.mimeType, "application/pdf");
    assert.equal(getAssetFile(t.db, assets.tailored_cv_file.id)?.toString(), "%PDF-fake");
    assert.match(String(assets.cover_letter.contentText), /^Dear Acme/);
  });

  test("generation gets the stored CV, the best description (bounded) and the candidate details", async () => {
    const long = "Kotlin ".repeat(1000);
    const { matchId } = scoredMatch({ full: long });
    const { deps, calls } = fakeDeps();
    await prepareApplication(t.db, { matchId, questions: ["Why us?"] }, deps);
    const [cv, job] = calls[0].args as [Record<string, unknown>, PrepareJob];
    assert.deepEqual(cv, STRUCTURED_CV);
    assert.equal(job.company, "Acme");
    assert.equal(job.location, "London");
    assert.ok(job.description.length <= PREPARATION_DESCRIPTION_CHARS + 1 && job.description.startsWith("Kotlin"));
    const coverCandidate = calls[2].args[0] as Record<string, unknown>;
    assert.deepEqual(coverCandidate.technicalSkills, ANALYSIS.technicalSkills);
    assert.deepEqual(coverCandidate.education, STRUCTURED_CV.education);
    assert.deepEqual(coverCandidate.projects, STRUCTURED_CV.projects);
    const questionCandidate = calls[3].args[0] as Record<string, unknown>;
    assert.deepEqual(questionCandidate.experience, STRUCTURED_CV.experience);
  });

  test("with questions: answers are saved as a question_answers asset", async () => {
    const { matchId } = scoredMatch();
    const { deps } = fakeDeps();
    const id = (await prepareApplication(t.db, { matchId, questions: [" Why us? ", "", "Tell us about a project"] }, deps)).body.applicationId!;
    assert.deepEqual(kinds(id), ["cover_letter", "question_answers", "tailored_cv_data", "tailored_cv_file"]);
    const qa = getCurrentAssets(t.db, id).find((a) => a.kind === "question_answers")!;
    assert.deepEqual((qa.contentJson as { questions: string[] }).questions, ["Why us?", "Tell us about a project"]);
    assert.equal(qa.promptVersion, "application-questions/v1");
  });

  test("the review page sees the prepared package", async () => {
    const { matchId } = scoredMatch();
    const id = (await prepareApplication(t.db, { matchId }, fakeDeps().deps)).body.applicationId!;
    const item = getReviewItem(t.db, id)!;
    assert.equal(item.status, "ready_for_review");
    assert.ok(item.coverLetter && item.cvFile && item.hasTailoredCvData);
    assert.equal(item.match?.id, matchId);
  });

  test("the approval gate is untouched: nothing is approved, submitted or done as the user", async () => {
    const { matchId } = scoredMatch();
    const id = (await prepareApplication(t.db, { matchId }, fakeDeps().deps)).body.applicationId!;
    const app = getApplication(t.db, id)!;
    assert.equal(app.approvedAt, null);
    assert.equal(app.submittedAt, null);
    const events = listApplicationEvents(t.db, id);
    assert.ok(events.every((e) => e.actor === "system"));
    assert.ok(!events.some((e) => ["approved", "submitting", "submitted"].includes(String(e.toStatus))));
    assert.deepEqual(events.filter((e) => e.eventType === "status_change").map((e) => e.toStatus), ["preparing", "ready_for_review"]);
  });

  test("a preparation run is recorded and completed", async () => {
    const { matchId } = scoredMatch();
    const id = (await prepareApplication(t.db, { matchId }, fakeDeps().deps)).body.applicationId!;
    const run = t.db.prepare("SELECT kind, status FROM pipeline_runs WHERE id = (SELECT run_id FROM applications WHERE id = ?)").get(id) as { kind: string; status: string };
    assert.deepEqual(run, { kind: "preparation", status: "completed" });
  });
});

describe("3c: duplicate protection", () => {
  test("preparing the same match again returns the existing application without generating", async () => {
    const { matchId } = scoredMatch();
    const first = await prepareApplication(t.db, { matchId }, fakeDeps().deps);
    const assetsBefore = count(t.db, "application_assets");
    const runsBefore = count(t.db, "pipeline_runs");
    const { deps, calls } = fakeDeps();
    const second = await prepareApplication(t.db, { matchId }, deps);
    assert.equal(count(t.db, "pipeline_runs"), runsBefore, "no preparation run is started for a duplicate");
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { applicationId: first.body.applicationId, applicationStatus: "ready_for_review", alreadyPrepared: true });
    assert.equal(calls.length, 0);
    assert.equal(count(t.db, "applications"), 1);
    assert.equal(count(t.db, "application_assets"), assetsBefore);
  });

  test("two simultaneous requests: one prepares, the other is told it is in progress", async () => {
    const { matchId } = scoredMatch();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = fakeDeps({ tailorCv: async () => { await gate; return { ...STRUCTURED_CV }; } });
    const firstPromise = prepareApplication(t.db, { matchId }, slow.deps);
    const second = await prepareApplication(t.db, { matchId }, fakeDeps().deps);
    assert.equal(second.status, 409);
    assert.equal(second.body.applicationStatus, "preparing");
    assert.match(String(second.body.error), /already being prepared/);
    release();
    const first = await firstPromise;
    assert.equal(first.status, 201);
    assert.equal(count(t.db, "applications"), 1);
  });

  test("an approved or applied job is not prepared again", async () => {
    const { matchId } = scoredMatch();
    const id = (await prepareApplication(t.db, { matchId }, fakeDeps().deps)).body.applicationId!;
    // Approved the real way (as the user, with the reviewed content hash); a raw UPDATE is refused by the gate.
    approveApplication(t.db, id, { reviewedAssetsSha256: getCurrentAssetsHash(t.db, id) });
    const { deps, calls } = fakeDeps();
    const again = await prepareApplication(t.db, { matchId }, deps);
    assert.equal(again.status, 200);
    assert.equal(again.body.applicationStatus, "approved");
    assert.equal(calls.length, 0);
  });

  test("a stale preparation (crash/restart) is marked failed and the job is prepared again", async () => {
    const { matchId, jobId } = scoredMatch();
    t.db.prepare("INSERT INTO applications (job_id, match_id, candidate_profile_id, status, updated_at) VALUES (?, ?, ?, 'preparing', datetime('now', ?))")
      .run(jobId, matchId, profileId, `-${STALE_PREPARING_MINUTES + 5} minutes`);
    const stale = t.db.prepare("SELECT id FROM applications WHERE job_id = ?").get(jobId) as { id: number };
    const result = await prepareApplication(t.db, { matchId }, fakeDeps().deps);
    assert.equal(result.status, 201);
    assert.notEqual(result.body.applicationId, stale.id);
    assert.equal(getApplication(t.db, stale.id)?.status, "preparation_failed");
    assert.match(String(getApplication(t.db, stale.id)?.lastError), /did not finish/);
  });

  test("isStalePreparing: only 'preparing' older than the limit", () => {
    const base = { status: "preparing", updatedAt: "2026-10-04 10:00:00" } as never;
    const at = (minutes: number) => Date.parse("2026-10-04T10:00:00Z") + minutes * 60_000;
    assert.equal(isStalePreparing(base, at(STALE_PREPARING_MINUTES + 1)), true);
    assert.equal(isStalePreparing(base, at(STALE_PREPARING_MINUTES - 1)), false);
    assert.equal(isStalePreparing({ status: "ready_for_review", updatedAt: "2026-10-04 10:00:00" } as never, at(999)), false);
    assert.equal(isStalePreparing({ status: "preparing", updatedAt: "2026-10-04T10:00:00.000Z" } as never, at(STALE_PREPARING_MINUTES + 1)), true);
  });
});

describe("3c: failures", () => {
  test("the CV fails: preparation_failed with the error, a 502, and the job can be prepared again", async () => {
    const { matchId } = scoredMatch();
    const broken = fakeDeps({ tailorCv: async () => { throw new Error("Ollama error: 500"); } });
    const result = await prepareApplication(t.db, { matchId }, broken.deps);
    assert.equal(result.status, 502);
    assert.equal(result.body.applicationStatus, "preparation_failed");
    assert.match(String(result.body.error), /Ollama error: 500/);
    assert.match(String(getApplication(t.db, result.body.applicationId!)?.lastError), /CV: Ollama error: 500/);
    assert.deepEqual(broken.calls, []);
    const run = t.db.prepare("SELECT status FROM pipeline_runs WHERE kind = 'preparation' ORDER BY id DESC LIMIT 1").get() as { status: string };
    assert.equal(run.status, "failed");

    const retry = await prepareApplication(t.db, { matchId }, fakeDeps().deps);
    assert.equal(retry.status, 201);
    assert.notEqual(retry.body.applicationId, result.body.applicationId);
  });

  test("the CV file fails: also preparation_failed (the CV data is kept as history)", async () => {
    const { matchId } = scoredMatch();
    const result = await prepareApplication(t.db, { matchId }, fakeDeps({ renderCv: async () => { throw new Error("LibreOffice missing"); } }).deps);
    assert.equal(result.status, 502);
    assert.deepEqual(kinds(result.body.applicationId!), ["tailored_cv_data"]);
  });

  test("the cover letter fails: still reviewable, with the problem kept as last_error", async () => {
    const { matchId } = scoredMatch();
    const result = await prepareApplication(t.db, { matchId }, fakeDeps({ coverLetter: async () => { throw new Error("empty"); } }).deps);
    assert.equal(result.status, 201);
    assert.deepEqual(result.body.warnings, ["Cover letter failed: empty"]);
    const app = getApplication(t.db, result.body.applicationId!)!;
    assert.equal(app.status, "ready_for_review");
    assert.equal(app.lastError, "Cover letter failed: empty");
    assert.deepEqual(kinds(app.id), ["tailored_cv_data", "tailored_cv_file"]);
  });

  test("the questions fail: still reviewable, warning kept", async () => {
    const { matchId } = scoredMatch();
    const result = await prepareApplication(t.db, { matchId, questions: ["Why?"] }, fakeDeps({ answerQuestions: async () => { throw new Error("no answers"); } }).deps);
    assert.equal(result.status, 201);
    assert.match(String(getApplication(t.db, result.body.applicationId!)?.lastError), /Application questions failed: no answers/);
  });

  test("a DOCX fallback is saved with a warning but no error", async () => {
    const { matchId } = scoredMatch();
    const docx = fakeDeps({ renderCv: async () => ({ buffer: Buffer.from("PK"), filename: "cv.docx", format: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }) });
    const result = await prepareApplication(t.db, { matchId }, docx.deps);
    assert.equal(result.status, 201);
    assert.match(String(result.body.warnings?.[0]), /DOCX/);
    assert.equal(getApplication(t.db, result.body.applicationId!)?.lastError, null);
  });
});

describe("3c: input validation", () => {
  test("bad or unknown matches are refused before anything is created", async () => {
    const { deps, calls } = fakeDeps();
    for (const matchId of [undefined, "1", 0, -1, 1.5, null]) {
      assert.equal((await prepareApplication(t.db, { matchId }, deps)).status, 400, String(matchId));
    }
    assert.equal((await prepareApplication(t.db, { matchId: 999 }, deps)).status, 404);
    for (const outcome of ["filtered_out", "failed"] as const) {
      const { matchId } = scoredMatch({ outcome });
      assert.equal((await prepareApplication(t.db, { matchId }, deps)).status, 409, outcome);
    }
    assert.equal(calls.length, 0);
    assert.equal(count(t.db, "applications"), 0);
  });

  test("bad questions are refused", async () => {
    const { matchId } = scoredMatch();
    const { deps } = fakeDeps();
    for (const questions of ["Why?", [1], Array.from({ length: 11 }, (_, i) => `Q${i}`), ["x".repeat(501)]]) {
      assert.equal((await prepareApplication(t.db, { matchId, questions }, deps)).status, 400, JSON.stringify(questions).slice(0, 40));
    }
    assert.equal(count(t.db, "applications"), 0);
  });

  test("a match whose profile has no structured CV is refused", async () => {
    const c = createCandidate(t.db, { fullName: "B" });
    const empty = createProfileVersion(t.db, { candidateId: c.id, origin: "ai_extraction", analysis: {}, structuredCv: {} });
    const { jobId } = recordJobListing(t.db, { sourceId: "adzuna", externalId: "Z1", title: "Dev", company: "Co" });
    const match = recordMatch(t.db, { jobId, candidateProfileId: empty.id, outcome: "scored", score: 70 });
    assert.equal((await prepareApplication(t.db, { matchId: match.id }, fakeDeps().deps)).status, 409);
  });
});

describe("3c: wiring and safety (source checks)", () => {
  const route = read("app/api/applications/prepare/route.ts");
  const prepare = read("lib/pipeline/prepare.ts");

  test("the route is thin: it calls prepareApplication with the production steps", () => {
    assert.match(route, /export async function POST\(req: NextRequest\)/);
    assert.match(route, /await prepareApplication\(db, body \?\? \{\}, await defaultPrepareDeps\(\)\)/);
    assert.equal(/export async function (GET|PUT|PATCH|DELETE)/.test(route), false);
  });

  test("the production steps are the shared lib/generation functions", () => {
    for (const mod of ["tailor-cv", "cv-document", "cover-letter", "questions"]) assert.ok(prepare.includes(`../generation/${mod}.ts`), mod);
  });

  test("preparation never emails, approves or submits", () => {
    for (const source of [route, prepare]) {
      assert.doesNotMatch(source, /email-copies|sendEmailCopy|resend/i);
      assert.doesNotMatch(source, /approveApplication|beginSubmission|recordSubmissionResult|recordManualSubmission/);
    }
  });

  test("the generation routes are thin wrappers over lib/generation", () => {
    assert.match(read("app/api/tailor-cv/route.ts"), /await tailorCv\(structuredCV, job\)/);
    assert.match(read("app/api/cover-letter/route.ts"), /await generateCoverLetter\(candidate, job\)/);
    assert.match(read("app/api/application-questions/route.ts"), /await answerQuestions\(candidate, job, questions\)/);
    assert.match(read("app/api/generate-cv-docx/route.ts"), /await renderCvDocument\(tailoredCV, job\)/);
  });
});
