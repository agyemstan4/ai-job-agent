import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TestDb } from "./helpers.ts";
import { count, freshDb, quietly } from "./helpers.ts";
import type { PrepareDeps, PrepareJob } from "../lib/pipeline/prepare.ts";
import { prepareApplication } from "../lib/pipeline/prepare.ts";
import {
  enqueuePreparation,
  getPreparationStatus,
  kickQueue,
  missingParts,
  OLLAMA_CONCURRENCY,
  PDF_CONCURRENCY,
  PREPARATION_WORKERS,
  queueState,
  resetQueueState,
  Semaphore,
} from "../lib/pipeline/preparation-queue.ts";
import {
  failedParts,
  hasActiveWork,
  loadPreparationStatus,
  needsAttention,
  nextPollDelay,
  progressLine,
  queuePreparation,
  queuePreparations,
  stepsFor,
  whileYouWereAway,
} from "../lib/preparation-client.ts";
import { createCandidate, createProfileVersion } from "../lib/repositories/candidates.ts";
import { recordJobListing } from "../lib/repositories/jobs.ts";
import { recordMatch } from "../lib/repositories/matches.ts";
import { addApplicationAsset, getApplication, getCurrentAssets, listAssetVersions } from "../lib/repositories/applications.ts";

// Phase 3 checkpoint 3d: the persistent, bounded preparation queue.
// Generation is faked (no Ollama/LibreOffice/email); the database is a scratch one.

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const CV = { name: "Test Candidate", summary: "Graduate", skills: ["Java"], experience: [], education: [{ degree: "BSc" }], projects: [] };

let t: TestDb;
let profileId: number;
beforeEach(() => {
  t = quietly(freshDb);
  resetQueueState();
  const c = createCandidate(t.db, { fullName: "Test Candidate" });
  profileId = createProfileVersion(t.db, { candidateId: c.id, origin: "ai_extraction", analysis: { technicalSkills: ["Java"] }, structuredCv: CV }).id;
});
afterEach(async () => {
  await idle();
  t.close();
});

let n = 0;
function match(title?: string) {
  n++;
  const { jobId } = recordJobListing(t.db, { sourceId: "reed", externalId: `Q${n}`, title: title ?? `Role ${n}`, company: `Company ${n}` });
  return { jobId, matchId: recordMatch(t.db, { jobId, candidateProfileId: profileId, outcome: "scored", score: 80 }).id };
}

/** Waits until no worker is running and nothing is left preparing. */
async function idle(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const preparing = t?.db?.open ? count(t.db, "applications", "status = 'preparing'") : 0;
    if (queueState().active.size === 0 && preparing === 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Fake generation steps: record calls, track concurrency, optional delays and failures. */
function fakes(options: { delay?: number; fail?: Partial<Record<"tailor" | "render" | "cover" | "answers", (job: PrepareJob) => boolean>> } = {}) {
  const calls: { step: string; title: string }[] = [];
  let ollamaNow = 0, ollamaMax = 0, pdfNow = 0, pdfMax = 0;
  const wait = () => new Promise((r) => setTimeout(r, options.delay ?? 5));
  const ollama = async <T>(step: string, job: PrepareJob, fn: () => T): Promise<T> => {
    calls.push({ step, title: job.title });
    ollamaNow++; ollamaMax = Math.max(ollamaMax, ollamaNow);
    try { await wait(); return fn(); } finally { ollamaNow--; }
  };
  const deps: PrepareDeps = {
    tailorCv: (cv, job) => ollama("tailor", job, () => {
      if (options.fail?.tailor?.(job)) throw new Error("Ollama error: 500");
      return { ...cv, summary: `Tailored for ${job.title}` };
    }),
    renderCv: async (cv, job) => {
      calls.push({ step: "render", title: job.title });
      pdfNow++; pdfMax = Math.max(pdfMax, pdfNow);
      try {
        await wait();
        if (options.fail?.render?.(job)) throw new Error("LibreOffice missing");
        return { buffer: Buffer.from(`%PDF ${String(cv.summary)}`), filename: `${job.company}.pdf`, format: "pdf" as const, mimeType: "application/pdf", timings: { docxMs: 1, pdfMs: 2 } };
      } finally { pdfNow--; }
    },
    coverLetter: (_c, job) => ollama("cover", job, () => {
      if (options.fail?.cover?.(job)) throw new Error("empty");
      return `Dear ${job.company}, about ${job.title}`;
    }),
    answerQuestions: (_c, job, qs) => ollama("answers", job, () => {
      if (options.fail?.answers?.(job)) throw new Error("no answers");
      return qs.map((q) => ({ question: q, answer: `For ${job.title}` }));
    }),
  };
  return { deps, calls, peaks: () => ({ ollamaMax, pdfMax }) };
}

const assets = (applicationId: number) => Object.fromEntries(getCurrentAssets(t.db, applicationId).map((a) => [a.kind, a]));

describe("3d: limits", () => {
  test("defaults: 2 jobs at once, 2 Ollama requests at once, 1 PDF conversion at once", () => {
    assert.deepEqual([PREPARATION_WORKERS, OLLAMA_CONCURRENCY, PDF_CONCURRENCY], [2, 1, 1]);
    assert.deepEqual(getPreparationStatus(t.db).limits, { workers: 2, ollama: 1, pdf: 1 });
  });

  test("Semaphore never runs more than its limit", async () => {
    const sem = new Semaphore(2);
    let now = 0, max = 0;
    await Promise.all(Array.from({ length: 6 }, () => sem.run(async () => { now++; max = Math.max(max, now); await new Promise((r) => setTimeout(r, 5)); now--; })));
    assert.equal(max, 2);
    assert.equal(sem.inUse, 0);
  });
});

describe("3d: enqueue (fast, idempotent)", () => {
  test("queues a job as a 'preparing' application with its questions; returns at once", () => {
    const { jobId, matchId } = match();
    const start = Date.now();
    const result = enqueuePreparation(t.db, { matchId, questions: [" Why us? ", ""] });
    assert.ok(Date.now() - start < 200, "enqueue does no generation");
    assert.equal(result.status, 202);
    assert.equal(result.state, "queued");
    const app = getApplication(t.db, result.applicationId!)!;
    assert.deepEqual([app.status, app.jobId, app.matchId], ["preparing", jobId, matchId]);
    assert.deepEqual(missingParts(t.db, app.id, ["Why us?"]), { cv: true, document: true, coverLetter: true, answers: true });
  });

  test("queueing the same job again returns the same application (no duplicates)", () => {
    const { matchId } = match();
    const first = enqueuePreparation(t.db, { matchId });
    const again = [enqueuePreparation(t.db, { matchId }), enqueuePreparation(t.db, { matchId })];
    for (const r of again) assert.deepEqual([r.status, r.applicationId, r.alreadyQueued], [200, first.applicationId, true]);
    assert.equal(count(t.db, "applications"), 1);
  });

  test("validation: bad, unknown, unscored matches and bad questions", () => {
    for (const matchId of [undefined, "1", 0, 1.5]) assert.equal(enqueuePreparation(t.db, { matchId }).status, 400);
    assert.equal(enqueuePreparation(t.db, { matchId: 999 }).status, 404);
    const { jobId } = recordJobListing(t.db, { sourceId: "adzuna", externalId: "F1", title: "X", company: "Y" });
    const filtered = recordMatch(t.db, { jobId, candidateProfileId: profileId, outcome: "filtered_out", filterReason: "Senior" });
    assert.equal(enqueuePreparation(t.db, { matchId: filtered.id }).status, 409);
    const { matchId } = match();
    assert.equal(enqueuePreparation(t.db, { matchId, questions: "Why?" }).status, 400);
    assert.equal(count(t.db, "applications"), 0);
  });
});

describe("3d: workers", () => {
  test("bounded: 5 jobs → at most 2 jobs and 2 Ollama requests at once, 1 conversion at once; all finish", async () => {
    const jobs = Array.from({ length: 5 }, () => match());
    const f = fakes({ delay: 15 });
    for (const j of jobs) enqueuePreparation(t.db, { matchId: j.matchId });
    const started = kickQueue(t.db, f.deps);
    assert.equal(started.length, 2);
    const mid = getPreparationStatus(t.db);
    assert.deepEqual([mid.summary.preparing, mid.summary.queued], [2, 3]);
    assert.deepEqual(mid.items.filter((i) => i.state === "queued").map((i) => i.queuePosition), [1, 2, 3]);
    let maxActive = 0;
    const watcher = setInterval(() => { maxActive = Math.max(maxActive, queueState().active.size); }, 1);
    await idle();
    clearInterval(watcher);
    assert.ok(maxActive <= 2, `max active ${maxActive}`);
    assert.equal(f.peaks().ollamaMax, 1, "one Ollama request at a time");
    assert.equal(f.peaks().pdfMax, 1);
    assert.equal(count(t.db, "applications", "status = 'ready_for_review'"), 5);
  });

  test("with one Ollama slot, a stage waiting for it shows as pending, not running", async () => {
    const { matchId } = match();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: PrepareDeps = { ...fakes().deps, tailorCv: async (cv) => { await gate; return { ...cv }; } };
    enqueuePreparation(t.db, { matchId });
    kickQueue(t.db, slow);
    await new Promise((r) => setTimeout(r, 20));
    const stages = getPreparationStatus(t.db).items[0].stages;
    assert.equal(stages.find((x) => x.key === "cv")!.state, "running");
    assert.equal(stages.find((x) => x.key === "coverLetter")!.state, "pending");
    release();
    await idle();
  });

  test("within a job, the cover letter runs alongside the CV when the Ollama limit allows it", async () => {
    resetQueueState({ ollama: 2 }); // the default is 1 (measured); the structure still overlaps if raised
    const { matchId } = match();
    const order: string[] = [];
    const slow: PrepareDeps = {
      ...fakes().deps,
      tailorCv: async (cv) => { order.push("tailor:start"); await new Promise((r) => setTimeout(r, 30)); order.push("tailor:end"); return { ...cv }; },
      coverLetter: async () => { order.push("cover:start"); await new Promise((r) => setTimeout(r, 5)); order.push("cover:end"); return "Dear team"; },
    };
    enqueuePreparation(t.db, { matchId });
    kickQueue(t.db, slow);
    await idle();
    assert.ok(order.indexOf("cover:start") < order.indexOf("tailor:end"), order.join(" "));
  });

  test("kicking repeatedly (every poll) never starts the same job twice", async () => {
    const { matchId } = match();
    const f = fakes({ delay: 20 });
    enqueuePreparation(t.db, { matchId });
    const starts = [kickQueue(t.db, f.deps), kickQueue(t.db, f.deps), kickQueue(t.db, f.deps)].flat();
    assert.equal(starts.length, 1);
    for (let i = 0; i < 5; i++) getPreparationStatus(t.db);
    await idle();
    assert.equal(f.calls.filter((c) => c.step === "tailor").length, 1);
    assert.equal(listAssetVersions(t.db, (starts[0]), "tailored_cv_data").length, 1);
  });
});

describe("3d: data integrity across 3 jobs", () => {
  test("each job gets its own application, job_id and correct assets; nothing crosses; no duplicates", async () => {
    const jobs = [match("Android Developer"), match("Java Developer"), match("Full Stack Developer")];
    const f = fakes({ delay: 10 });
    const ids = jobs.map((j) => enqueuePreparation(t.db, { matchId: j.matchId, questions: ["Why us?"] }).applicationId!);
    kickQueue(t.db, f.deps);
    await idle();
    assert.equal(count(t.db, "applications"), 3);
    jobs.forEach((j, i) => {
      const app = getApplication(t.db, ids[i])!;
      const title = ["Android Developer", "Java Developer", "Full Stack Developer"][i];
      assert.deepEqual([app.jobId, app.matchId, app.status], [j.jobId, j.matchId, "ready_for_review"]);
      const a = assets(ids[i]);
      assert.equal((a.tailored_cv_data.contentJson as { summary: string }).summary, `Tailored for ${title}`);
      assert.match(String(a.cover_letter.contentText), new RegExp(`about ${title}$`));
      assert.match(String(a.tailored_cv_file.filename), new RegExp(`^Company ${n - 2 + i}\\.pdf$`));
      assert.equal(((a.question_answers.contentJson as { answers: { answer: string }[] }).answers[0].answer), `For ${title}`);
      for (const kind of ["tailored_cv_data", "tailored_cv_file", "cover_letter", "question_answers"] as const) {
        assert.equal(listAssetVersions(t.db, ids[i], kind).length, 1, `${title} ${kind}`);
      }
    });
    assert.equal(f.calls.filter((c) => c.step === "tailor").length, 3);
    assert.equal(count(t.db, "application_assets"), 12);
  });

  test("one failure does not affect the others; retrying regenerates only the failed part, in place", async () => {
    const jobs = [match("Android Developer"), match("Java Developer"), match("Full Stack Developer")];
    const failJava = { cover: (job: PrepareJob) => job.title === "Java Developer" };
    const first = fakes({ fail: failJava });
    const ids = jobs.map((j) => enqueuePreparation(t.db, { matchId: j.matchId }).applicationId!);
    kickQueue(t.db, first.deps);
    await idle();
    const status = getPreparationStatus(t.db);
    const byId = Object.fromEntries(status.items.map((i) => [i.applicationId, i]));
    assert.deepEqual(ids.map((id) => byId[id].state), ["ready", "ready", "ready"]);
    assert.equal(byId[ids[1]].error, "Cover letter failed: empty");
    assert.equal(failedParts(byId[ids[1]]), "Cover letter failed");
    assert.equal(needsAttention(byId[ids[1]]), true);
    assert.equal(needsAttention(byId[ids[0]]), false);
    assert.equal(status.summary.needsAttention, 1);

    const retry = fakes();
    const queued = enqueuePreparation(t.db, { matchId: jobs[1].matchId, retry: true });
    assert.deepEqual([queued.status, queued.applicationId], [202, ids[1]]);
    kickQueue(t.db, retry.deps);
    await idle();
    assert.deepEqual(retry.calls.map((c) => c.step), ["cover"], "only the cover letter is generated again");
    const after = getApplication(t.db, ids[1])!;
    assert.deepEqual([after.status, after.lastError], ["ready_for_review", null]);
    assert.equal(listAssetVersions(t.db, ids[1], "tailored_cv_data").length, 1);
    assert.equal(count(t.db, "applications"), 3);
  });

  test("a failed CV: preparation_failed; the other jobs finish; retry resumes the same application", async () => {
    const jobs = [match("Android Developer"), match("Java Developer")];
    const first = fakes({ fail: { render: (job) => job.title === "Java Developer" } });
    const ids = jobs.map((j) => enqueuePreparation(t.db, { matchId: j.matchId }).applicationId!);
    kickQueue(t.db, first.deps);
    await idle();
    assert.equal(getApplication(t.db, ids[0])!.status, "ready_for_review");
    const failed = getApplication(t.db, ids[1])!;
    assert.equal(failed.status, "preparation_failed");
    assert.match(String(failed.lastError), /CV: LibreOffice missing/);
    // The tailored CV data and the cover letter were kept.
    assert.ok(assets(ids[1]).tailored_cv_data && assets(ids[1]).cover_letter);

    const retry = fakes();
    const queued = enqueuePreparation(t.db, { matchId: jobs[1].matchId });
    assert.deepEqual([queued.status, queued.applicationId, queued.state], [202, ids[1], "queued"]);
    kickQueue(t.db, retry.deps);
    await idle();
    assert.deepEqual(retry.calls.map((c) => c.step), ["render"], "only the CV document is created again");
    assert.equal(getApplication(t.db, ids[1])!.status, "ready_for_review");
    assert.equal(count(t.db, "applications"), 2);
  });

  test("a job that is ready is not prepared again (and retry does nothing if nothing failed)", async () => {
    const { matchId } = match();
    const f = fakes();
    const id = enqueuePreparation(t.db, { matchId }).applicationId!;
    kickQueue(t.db, f.deps);
    await idle();
    for (const input of [{ matchId }, { matchId, retry: true }]) {
      const r = enqueuePreparation(t.db, input);
      assert.deepEqual([r.status, r.applicationId, r.state], [200, id, "ready"]);
    }
    assert.equal(count(t.db, "applications", "status = 'preparing'"), 0);
  });
});

describe("3d: never two generators on one application (regression)", () => {
  test("while the synchronous prepareApplication runs, queue workers do not pick that application up", async () => {
    const { matchId } = match("Android Developer");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const legacy = fakes();
    const slow: PrepareDeps = { ...legacy.deps, tailorCv: async (cv, job) => { await gate; return { ...cv, summary: job.title }; } };
    const running = prepareApplication(t.db, { matchId }, slow);
    await new Promise((r) => setTimeout(r, 10));
    const worker = fakes();
    // Polls / dashboard loads keep kicking the queue meanwhile.
    for (let i = 0; i < 3; i++) assert.deepEqual(kickQueue(t.db, worker.deps), []);
    release();
    const result = await running;
    assert.equal(result.status, 201);
    await idle();
    assert.equal(worker.calls.length, 0, "the queue generated nothing for it");
    for (const kind of ["tailored_cv_data", "tailored_cv_file", "cover_letter"] as const) {
      assert.equal(listAssetVersions(t.db, result.body.applicationId!, kind).length, 1, kind);
    }
  });

  test("a part saved meanwhile by someone else is not saved again (no second version)", async () => {
    const { matchId } = match("Java Developer");
    const id = enqueuePreparation(t.db, { matchId }).applicationId!;
    const f = fakes();
    const racing: PrepareDeps = {
      ...f.deps,
      coverLetter: async () => {
        // Another path saves a cover letter while this one is being written.
        addApplicationAsset(t.db, { applicationId: id, kind: "cover_letter", origin: "generated", contentText: "saved elsewhere", actor: "system" });
        return "late duplicate";
      },
    };
    kickQueue(t.db, racing);
    await idle();
    assert.equal(listAssetVersions(t.db, id, "cover_letter").length, 1);
    assert.equal(assets(id).cover_letter.contentText, "saved elsewhere");
    assert.equal(getApplication(t.db, id)!.status, "ready_for_review");
  });
});

describe("3d: resume after a restart", () => {
  test("a preparation interrupted mid-way resumes and generates only what is missing", async () => {
    const { matchId } = match("Android Developer");
    const id = enqueuePreparation(t.db, { matchId }).applicationId!;
    // Before the "restart": the tailored CV and cover letter were saved, then the process died.
    addApplicationAsset(t.db, { applicationId: id, kind: "tailored_cv_data", origin: "generated", contentJson: { ...CV, summary: "saved before" }, actor: "system" });
    addApplicationAsset(t.db, { applicationId: id, kind: "cover_letter", origin: "generated", contentText: "saved before", actor: "system" });
    resetQueueState(); // a new process: no workers, no memory
    const status = getPreparationStatus(t.db);
    assert.equal(status.items[0].state, "queued");
    assert.deepEqual(status.items[0].stages.map((s) => s.state), ["done", "pending", "done", "skipped"]);
    const f = fakes();
    kickQueue(t.db, f.deps);
    await idle();
    assert.deepEqual(f.calls.map((c) => c.step), ["render"]);
    assert.equal(getApplication(t.db, id)!.status, "ready_for_review");
    assert.ok(assets(id).tailored_cv_file, "the CV document was created");
    assert.equal(listAssetVersions(t.db, id, "tailored_cv_data").length, 1, "the saved CV data was reused, not regenerated");
  });
});

describe("3d: status for the UI", () => {
  test("states, stages and summary while running", async () => {
    const jobs = [match("Android Developer"), match("Java Developer"), match("Full Stack Developer")];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const f = fakes();
    const gated: PrepareDeps = { ...f.deps, tailorCv: async (cv, job) => { await gate; return { ...cv, summary: job.title }; } };
    for (const j of jobs) enqueuePreparation(t.db, { matchId: j.matchId });
    kickQueue(t.db, gated);
    await new Promise((r) => setTimeout(r, 20));
    const s = getPreparationStatus(t.db);
    assert.deepEqual([s.summary.preparing, s.summary.queued, s.summary.ready], [2, 1, 0]);
    const running = s.items.find((i) => i.state === "preparing")!;
    assert.equal(running.stages.find((x) => x.key === "cv")!.state, "running");
    assert.match(String(running.currentStage), /Tailoring CV/);
    assert.match(progressLine(running), /Tailoring CV/);
    assert.equal(progressLine(s.items.find((i) => i.state === "queued")!), "Queued · #1 in line");
    assert.deepEqual(stepsFor(running).slice(0, 3).map((x) => `${x.label}:${x.state}`), ["Job analysed:done", "Match reviewed:done", "Tailoring CV:running"]);
    assert.equal(hasActiveWork(s), true);
    release();
    await idle();
    const done = getPreparationStatus(t.db);
    assert.deepEqual([done.summary.preparing, done.summary.queued, done.summary.ready], [0, 0, 3]);
    assert.equal(hasActiveWork(done), false);
  });
});

describe("3d: browser helpers against the real handlers", () => {
  const handlerFetch = (deps: PrepareDeps) => async (url: string, init?: RequestInit) => {
    if (url === "/api/applications/preparation") {
      kickQueue(t.db, deps);
      return new Response(JSON.stringify(getPreparationStatus(t.db)), { status: 200 });
    }
    assert.equal(url, "/api/applications/prepare");
    const body = JSON.parse(String(init?.body));
    if (Array.isArray(body.matchIds)) {
      const results = body.matchIds.map((matchId: number) => enqueuePreparation(t.db, { matchId }));
      kickQueue(t.db, deps);
      return new Response(JSON.stringify({ results }), { status: 202 });
    }
    const result = enqueuePreparation(t.db, body);
    kickQueue(t.db, deps);
    return new Response(JSON.stringify(result), { status: result.status });
  };

  test("batch queue, poll until done, then everything is ready", async () => {
    const jobs = [match(), match(), match()];
    const f = fakes({ delay: 10 });
    const fetchImpl = handlerFetch(f.deps);
    const batch = await queuePreparations(jobs.map((j) => j.matchId), fetchImpl);
    assert.equal(batch.kind, "ok");
    if (batch.kind === "ok") assert.deepEqual(batch.results.map((r) => r.kind), ["queued", "queued", "queued"]);
    let polls = 0;
    let status = (await loadPreparationStatus(fetchImpl));
    while (status.kind === "loaded" && hasActiveWork(status.status) && polls < 200) {
      await new Promise((r) => setTimeout(r, 10));
      status = await loadPreparationStatus(fetchImpl);
      polls++;
    }
    assert.equal(status.kind, "loaded");
    if (status.kind === "loaded") assert.equal(status.status.summary.ready, 3);
    assert.equal(count(t.db, "applications"), 3);
    // Queueing again after polling: still no duplicates.
    const again = await queuePreparation(jobs[0].matchId, {}, fetchImpl);
    assert.equal(again.kind, "existing");
    assert.equal(count(t.db, "applications"), 3);
  });

  test("error states", async () => {
    assert.equal((await queuePreparation(1, {}, async () => { throw new TypeError("x"); })).kind, "error");
    assert.equal((await queuePreparations([1], async () => new Response(JSON.stringify({ error: "Send 1–25 matchIds" }), { status: 400 }))).kind, "error");
    assert.equal((await loadPreparationStatus(async () => new Response("nope", { status: 500 }))).kind, "error");
    const notFound = await queuePreparation(999, {}, handlerFetch(fakes().deps));
    assert.deepEqual(notFound, { kind: "error", message: "Match 999 not found" });
  });

  test("polling schedule: fast while working, slower later, stops when idle", () => {
    const busy = { summary: { preparing: 1, queued: 0, ready: 0, failed: 0, needsAttention: 0 }, items: [], limits: { workers: 2, ollama: 1, pdf: 1 } };
    const quiet = { ...busy, summary: { ...busy.summary, preparing: 0 } };
    assert.equal(nextPollDelay(busy, 0), 3000);
    assert.equal(nextPollDelay(busy, 25), 8000);
    assert.equal(nextPollDelay(quiet, 0), null);
    assert.equal(nextPollDelay(null, 0), null);
  });

  test("while you were away: only with something finished since the last visit", () => {
    const item = (state: string, updatedAt: string, error: string | null = null) => ({ applicationId: 1, matchId: 1, jobId: 1, title: "T", company: "C", state, queuePosition: null, stages: [], currentStage: null, error, updatedAt });
    const status = { summary: { preparing: 1, queued: 1, ready: 2, failed: 1, needsAttention: 1 }, items: [item("ready", "2026-10-04 10:00:00"), item("ready", "2026-10-01 10:00:00"), item("failed", "2026-10-04 11:00:00", "CV: x")], limits: { workers: 2, ollama: 1, pdf: 1 } };
    assert.deepEqual(whileYouWereAway(status, Date.parse("2026-10-03T00:00:00Z")), { finished: 1, processing: 2, attention: 1 });
    assert.equal(whileYouWereAway(status, null), null);
    assert.equal(whileYouWereAway(status, Date.parse("2026-10-05T00:00:00Z")), null);
  });
});

describe("3d: wiring and safety (source checks)", () => {
  const prepareRoute = read("app/api/applications/prepare/route.ts");
  const statusRoute = read("app/api/applications/preparation/route.ts");
  const queue = read("lib/pipeline/preparation-queue.ts");
  const component = read("app/components/CommandCentre.tsx");
  const client = read("lib/preparation-client.ts");

  test("the prepare route only enqueues and returns: no generation inside the request", () => {
    assert.match(prepareRoute, /enqueuePreparation\(db,/);
    assert.match(prepareRoute, /kickQueue\(db, deps\);/);
    assert.equal(/await (runPreparation|prepareApplication)\(/.test(prepareRoute), false);
    assert.equal(prepareRoute.includes("prepareApplication"), false);
    assert.match(prepareRoute, /body\.matchIds\.length > 25/);
  });

  test("the status route is a GET that also resumes idle workers", () => {
    assert.match(statusRoute, /export async function GET\(\)/);
    assert.match(statusRoute, /kickQueue\(db, await defaultPrepareDeps\(\)\);/);
    assert.match(read("app/api/dashboard/route.ts"), /kickQueue\(db, await defaultPrepareDeps\(\)\);/);
  });

  test("workers never approve, submit or email; workers are not awaited by requests", () => {
    for (const source of [queue, prepareRoute, statusRoute, client]) {
      assert.doesNotMatch(source, /approveApplication|beginSubmission|recordSubmissionResult|recordManualSubmission|email-copies|sendEmailCopy|resend/i);
    }
    assert.match(queue, /void runPreparation\(db, id, deps\)\.then\(\(\) => kickQueue\(db, deps\)\);/);
    assert.match(queue, /state\.ollama\.run\(\(\) => \{ mark\("cv", "running"\); return timed\("tailor_cv", \(\) => deps\.tailorCv/);
    assert.match(queue, /state\.pdf\.run\(\(\) => \{ mark\("document", "running"\); return timed\("render_cv", \(\) => deps\.renderCv/);
  });

  test("the Command Centre queues and polls (no blocking request, no 'keep this tab open')", () => {
    assert.match(component, /await queuePreparation\(match\.matchId, \{ retry \}\)/);
    assert.match(component, /await queuePreparations\(ids\)/);
    assert.match(component, /const delay = nextPollDelay\(prep, polls\.current\);/);
    assert.match(component, /if \(delay === null\) \{/);
    assert.equal(/keep this tab open/i.test(component), false);
    assert.ok(component.includes('`Prepare ${selected.size === 1 ? "selected application" : "selected applications"}`'), "batch button label");
    for (const text of ["Application preparation", "Your applications are being prepared.", "While you were away", "selected applications", "Retry", "Queued for preparation", "Preparing application"]) {
      assert.ok(component.includes(text), text);
    }
  });
});
