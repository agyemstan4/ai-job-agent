import type { DB } from "../repositories/shared.ts";
import { PersistenceError } from "../repositories/shared.ts";
import { getProfile } from "../repositories/candidates.ts";
import { getBestDescription, getJob } from "../repositories/jobs.ts";
import { getMatch } from "../repositories/matches.ts";
import type { Application, ApplicationAsset, AssetKind } from "../repositories/applications.ts";
import {
  addApplicationAsset,
  createApplication,
  getApplication,
  getCurrentAssets,
  listApplicationEvents,
  transitionApplication,
} from "../repositories/applications.ts";
import {
  APPLICATION_QUESTIONS_PROMPT_VERSION,
  COVER_LETTER_PROMPT_VERSION,
  GENERATION_MODEL,
  TAILOR_CV_PROMPT_VERSION,
} from "../generation/versions.ts";
import { boundDescription } from "./match-scoring.ts";
import type { PrepareDeps, PrepareJob } from "./prepare.ts";
import { MAX_QUESTION_CHARS, MAX_QUESTIONS, PREPARATION_DESCRIPTION_CHARS } from "./prepare.ts";
import type { ActiveJob, StageKey, StageState } from "./preparation-registry.ts";
import { queueState } from "./preparation-registry.ts";

export type { StageKey, StageState } from "./preparation-registry.ts";
export {
  OLLAMA_CONCURRENCY,
  PDF_CONCURRENCY,
  PREPARATION_WORKERS,
  queueState,
  resetQueueState,
  Semaphore,
} from "./preparation-registry.ts";

// Phase 3 checkpoint 3d: a persistent, bounded preparation queue.
//
//   enqueue (fast, synchronous) → application "preparing" (the queue entry and
//   the duplicate lock; questions stored on its creation event)
//   → a worker (at most PREPARATION_WORKERS jobs at once) generates only the
//     MISSING parts — tailored CV → CV file, cover letter, answers — saving
//     each as soon as it is ready
//   → "ready_for_review" (or "preparation_failed", retryable in place).
//
// Queued vs preparing is derived: a "preparing" application a worker holds is
// preparing; the others are queued (oldest first). The state lives in the
// database, so a page refresh or a server restart loses nothing: any status
// call restarts idle workers, which resume where the parts left off.
// Global limits bound the load across ALL jobs: OLLAMA_CONCURRENCY generation
// requests and PDF_CONCURRENCY LibreOffice conversions at a time.
// Nothing here approves, submits or emails anything.

/** Finished preparations stay in the status list for this long. */
export const RECENT_HOURS = 24;

export const STAGE_LABELS: Record<StageKey, string> = {
  cv: "Tailoring CV",
  document: "Creating CV document",
  coverLetter: "Writing cover letter",
  answers: "Answering application questions",
};

// ── Enqueue ─────────────────────────────────────────────────────────────────

export type EnqueueResult = {
  matchId: unknown;
  status: number;
  applicationId?: number;
  /** queued | preparing | ready | failed | applied …: where this job now stands. */
  state?: string;
  alreadyQueued?: boolean;
  error?: string;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function parseQuestions(value: unknown): string[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return "questions must be a list of strings";
  const questions = value.map((q) => (typeof q === "string" ? q.trim() : null));
  if (questions.some((q) => q === null)) return "Each question must be text";
  const nonEmpty = (questions as string[]).filter((q) => q.length > 0);
  if (nonEmpty.length > MAX_QUESTIONS) return `At most ${MAX_QUESTIONS} questions`;
  if (nonEmpty.some((q) => q.length > MAX_QUESTION_CHARS)) return `Each question must be at most ${MAX_QUESTION_CHARS} characters`;
  return nonEmpty;
}

function latestApplicationForJob(db: DB, jobId: number): Application | null {
  const row = db.prepare("SELECT id FROM applications WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(jobId) as { id: number } | undefined;
  return row ? getApplication(db, row.id) : null;
}

/** Where an application stands, for the queue/status API. */
export function stateOf(application: Application): string {
  switch (application.status) {
    case "preparing":
      return queueState().active.has(application.id) ? "preparing" : "queued";
    case "ready_for_review":
      return "ready";
    case "preparation_failed":
      return "failed";
    case "approved":
      return "approved";
    case "rejected":
    case "withdrawn":
    case "unsuccessful":
      return "closed";
    default:
      return "applied";
  }
}

/** The questions stored when this application was queued. */
export function questionsFor(db: DB, applicationId: number): string[] {
  for (const event of listApplicationEvents(db, applicationId)) {
    const payload = event.payload as { questions?: unknown } | null;
    if (Array.isArray(payload?.questions)) return payload.questions.filter((q): q is string => typeof q === "string");
  }
  return [];
}

const REQUIRED_KINDS: AssetKind[] = ["tailored_cv_data", "tailored_cv_file"];

/**
 * Queues one match (synchronous and fast). Idempotent: a job that is already
 * queued, preparing or prepared is returned as it is; a failed one is retried
 * in place (only its missing parts are generated again). With retry: true, a
 * reviewable application whose cover letter or answers failed is re-queued to
 * generate just those.
 */
export function enqueuePreparation(db: DB, input: { matchId?: unknown; questions?: unknown; retry?: unknown }): EnqueueResult {
  const base = { matchId: input.matchId };
  if (typeof input.matchId !== "number" || !Number.isInteger(input.matchId) || input.matchId <= 0) {
    return { ...base, status: 400, error: "matchId must be a positive whole number" };
  }
  const questions = parseQuestions(input.questions);
  if (typeof questions === "string") return { ...base, status: 400, error: questions };
  const match = getMatch(db, input.matchId);
  if (!match) return { ...base, status: 404, error: `Match ${input.matchId} not found` };
  if (match.outcome !== "scored") return { ...base, status: 409, error: "Only scored matches can be prepared" };
  const job = getJob(db, match.jobId);
  if (!job) return { ...base, status: 404, error: `Job ${match.jobId} not found` };
  const profile = match.candidateProfileId === null ? null : getProfile(db, match.candidateProfileId);
  if (!profile || !profile.structuredCv || Object.keys(profile.structuredCv).length === 0) {
    return { ...base, status: 409, error: "This match has no stored CV profile; upload your CV again first" };
  }

  const existing = latestApplicationForJob(db, job.id);
  const reply = (app: Application, status: number, alreadyQueued: boolean): EnqueueResult => ({
    ...base, status, applicationId: app.id, state: stateOf(app), alreadyQueued,
  });

  if (existing && existing.status === "preparing") return reply(existing, 200, true);
  if (existing && existing.status === "preparation_failed") {
    return reply(transitionApplication(db, existing.id, "preparing", { actor: "system", detail: "Preparation retried" }), 202, false);
  }
  if (existing && existing.status === "ready_for_review") {
    const missing = missingParts(db, existing.id, questionsFor(db, existing.id));
    if (input.retry === true && (missing.coverLetter || missing.answers)) {
      return reply(transitionApplication(db, existing.id, "preparing", { actor: "system", detail: "Retrying the parts that failed" }), 202, false);
    }
    return reply(existing, 200, true);
  }
  if (existing && !["rejected", "withdrawn", "unsuccessful"].includes(existing.status)) return reply(existing, 200, true);

  try {
    const created = createApplication(db, {
      jobId: job.id,
      matchId: match.id,
      candidateProfileId: profile.id,
      status: "preparing",
      actor: "system",
      eventPayload: { source: "preparation_queue", matchId: match.id, questions },
    });
    return reply(created, 202, false);
  } catch (error) {
    if (error instanceof PersistenceError && error.code === "ACTIVE_APPLICATION_EXISTS") {
      const active = latestApplicationForJob(db, job.id);
      if (active) return reply(active, 200, true);
    }
    throw error;
  }
}

// ── Running one preparation ─────────────────────────────────────────────────

function currentAssetsByKind(db: DB, applicationId: number): Partial<Record<AssetKind, ApplicationAsset>> {
  return Object.fromEntries(getCurrentAssets(db, applicationId).map((a) => [a.kind, a]));
}

/** Saves a generated part unless a current version already exists (never a duplicate version). */
function saveOnce(db: DB, applicationId: number, kind: AssetKind, save: () => void): boolean {
  if (currentAssetsByKind(db, applicationId)[kind]) {
    console.warn("preparation: part already saved, not saving again", { applicationId, kind });
    return false;
  }
  save();
  return true;
}

export function missingParts(db: DB, applicationId: number, questions: string[]) {
  const assets = currentAssetsByKind(db, applicationId);
  return {
    cv: !assets.tailored_cv_data,
    document: !assets.tailored_cv_file,
    coverLetter: !assets.cover_letter,
    answers: questions.length > 0 && !assets.question_answers,
  };
}

/**
 * Generates the missing parts of one "preparing" application and moves it on.
 * The CV chain (tailor → document), the cover letter and the answers run
 * concurrently, each generation call bounded by the global Ollama limit and
 * each conversion by the PDF limit. Never throws: an unexpected error marks
 * the application failed.
 */
export async function runPreparation(db: DB, applicationId: number, deps: PrepareDeps): Promise<void> {
  const state = queueState();
  const job: ActiveJob = { applicationId, startedAt: Date.now(), stages: {}, errors: {} };
  state.active.set(applicationId, job);
  const timings: Record<string, number> = {};
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const s = Date.now();
    try {
      return await fn();
    } finally {
      timings[name] = Date.now() - s;
    }
  };

  try {
    const loadStart = Date.now();
    const app = getApplication(db, applicationId);
    if (!app || app.status !== "preparing") return;
    const match = app.matchId === null ? null : getMatch(db, app.matchId);
    const jobRow = getJob(db, app.jobId);
    const profile = app.candidateProfileId === null ? null : getProfile(db, app.candidateProfileId);
    if (!jobRow || !profile) {
      transitionApplication(db, applicationId, "preparation_failed", { actor: "system", detail: "Preparation failed", error: "The job or CV profile is missing" });
      return;
    }
    void match;
    const description = getBestDescription(db, jobRow.id);
    const prepareJob: PrepareJob = {
      title: jobRow.title,
      company: jobRow.company,
      location: jobRow.location,
      description: boundDescription(description?.content ?? "", PREPARATION_DESCRIPTION_CHARS),
    };
    const cv = profile.structuredCv;
    const candidate = { ...(profile.analysis ?? {}), education: cv.education ?? [], projects: cv.projects ?? [] };
    const sourceJobDescriptionId = description?.id ?? null;
    const questions = questionsFor(db, applicationId);
    const missing = missingParts(db, applicationId, questions);
    const assets = currentAssetsByKind(db, applicationId);
    timings.load = Date.now() - loadStart;

    for (const key of ["cv", "document", "coverLetter", "answers"] as StageKey[]) {
      job.stages[key] = key === "answers" && questions.length === 0 ? "skipped" : missing[key] ? "pending" : "done";
    }
    const mark = (key: StageKey, value: StageState, error?: string) => {
      job.stages[key] = value;
      if (error) job.errors[key] = error;
    };

    const cvChain = async () => {
      let tailored = assets.tailored_cv_data?.contentJson as Record<string, unknown> | undefined;
      if (missing.cv) {
        // Stages show as running only once they hold their slot (not while they wait for Ollama).
        tailored = await state.ollama.run(() => { mark("cv", "running"); return timed("tailor_cv", () => deps.tailorCv(cv, prepareJob)); });
        await timed("persist_cv_data", async () =>
          saveOnce(db, applicationId, "tailored_cv_data", () => addApplicationAsset(db, {
            applicationId, kind: "tailored_cv_data", origin: "generated", contentJson: tailored,
            model: GENERATION_MODEL, promptVersion: TAILOR_CV_PROMPT_VERSION, sourceJobDescriptionId, actor: "system",
          }))
        );
        mark("cv", "done");
      }
      if (missing.document) {
        const file = await state.pdf.run(() => { mark("document", "running"); return timed("render_cv", () => deps.renderCv(tailored!, prepareJob)); });
        if (file.timings) {
          timings.docx_build = file.timings.docxMs;
          timings.pdf_convert = file.timings.pdfMs;
        }
        saveOnce(db, applicationId, "tailored_cv_file", () => addApplicationAsset(db, {
          applicationId, kind: "tailored_cv_file", origin: "generated", file: file.buffer,
          filename: file.filename, mimeType: file.mimeType, actor: "system",
        }));
        mark("document", "done");
        return file.format;
      }
      return null;
    };
    const coverLetter = async () => {
      if (!missing.coverLetter) return;
      const text = await state.ollama.run(() => { mark("coverLetter", "running"); return timed("cover_letter", () => deps.coverLetter(candidate, prepareJob)); });
      saveOnce(db, applicationId, "cover_letter", () => addApplicationAsset(db, {
        applicationId, kind: "cover_letter", origin: "generated", contentText: text, mimeType: "text/plain",
        model: GENERATION_MODEL, promptVersion: COVER_LETTER_PROMPT_VERSION, sourceJobDescriptionId, actor: "system",
      }));
      mark("coverLetter", "done");
    };
    const answers = async () => {
      if (!missing.answers) return;
      const result = await state.ollama.run(() => {
        mark("answers", "running");
        return timed("application_questions", () => deps.answerQuestions({ ...candidate, experience: cv.experience ?? [] }, prepareJob, questions));
      });
      saveOnce(db, applicationId, "question_answers", () => addApplicationAsset(db, {
        applicationId, kind: "question_answers", origin: "generated", contentJson: { questions, answers: result },
        model: GENERATION_MODEL, promptVersion: APPLICATION_QUESTIONS_PROMPT_VERSION, sourceJobDescriptionId, actor: "system",
      }));
      mark("answers", "done");
    };

    const genStart = Date.now();
    const [cvResult, coverResult, answersResult] = await Promise.allSettled([cvChain(), coverLetter(), answers()]);
    timings.generation_wall = Date.now() - genStart;

    const warnings: string[] = [];
    if (cvResult.status === "rejected") {
      const stage: StageKey = job.stages.cv === "done" ? "document" : "cv";
      mark(stage, "failed", message(cvResult.reason));
    } else if (cvResult.value === "docx") {
      warnings.push("PDF conversion was unavailable; the CV was saved as DOCX");
    }
    if (coverResult.status === "rejected") mark("coverLetter", "failed", message(coverResult.reason));
    if (answersResult.status === "rejected") mark("answers", "failed", message(answersResult.reason));

    const persistStart = Date.now();
    const now = currentAssetsByKind(db, applicationId);
    const optionalErrors = [
      job.errors.coverLetter ? `Cover letter failed: ${job.errors.coverLetter}` : null,
      job.errors.answers ? `Application questions failed: ${job.errors.answers}` : null,
    ].filter(Boolean);
    if (REQUIRED_KINDS.some((kind) => !now[kind])) {
      const cvError = job.errors.cv ?? job.errors.document ?? "The CV was not created";
      transitionApplication(db, applicationId, "preparation_failed", {
        actor: "system", detail: "Preparation failed", error: [`CV: ${cvError}`, ...optionalErrors].join("; "),
      });
    } else {
      transitionApplication(db, applicationId, "ready_for_review", {
        actor: "system", detail: "Prepared on the server", error: optionalErrors.join("; ") || null,
      });
    }
    timings.persist_status = Date.now() - persistStart;
    timings.total = Date.now() - job.startedAt;
    state.lastTimings.set(applicationId, timings);
    // Durations only — never content.
    console.log("preparation done:", { applicationId, ...timings, warnings: warnings.length });
  } catch (error) {
    console.error("preparation crashed:", { applicationId, error: message(error) });
    try {
      const app = getApplication(db, applicationId);
      if (app?.status === "preparing") {
        transitionApplication(db, applicationId, "preparation_failed", { actor: "system", detail: "Preparation failed", error: message(error) });
      }
    } catch {
      // nothing more to do
    }
  } finally {
    state.active.delete(applicationId);
  }
}

// ── Workers ─────────────────────────────────────────────────────────────────

/**
 * Starts workers for queued applications, up to the worker limit. Cheap and
 * safe to call often (every status poll and enqueue): it also resumes work
 * after a restart. Returns the application ids started.
 */
export function kickQueue(db: DB, deps: PrepareDeps): number[] {
  const state = queueState();
  const started: number[] = [];
  const free = state.workers - state.active.size;
  if (free <= 0) return started;
  const waiting = (db.prepare("SELECT id FROM applications WHERE status = 'preparing' ORDER BY id").all() as { id: number }[])
    .map((r) => r.id)
    .filter((id) => !state.active.has(id))
    .slice(0, free);
  for (const id of waiting) {
    started.push(id);
    // Reserve the slot synchronously so concurrent kicks cannot double-start it.
    state.active.set(id, { applicationId: id, startedAt: Date.now(), stages: {}, errors: {} });
    void runPreparation(db, id, deps).then(() => kickQueue(db, deps));
  }
  return started;
}

// ── Status for the UI ───────────────────────────────────────────────────────

export type PreparationItem = {
  applicationId: number;
  matchId: number | null;
  jobId: number;
  title: string;
  company: string;
  state: string;
  queuePosition: number | null;
  stages: { key: StageKey; label: string; state: StageState }[];
  currentStage: string | null;
  error: string | null;
  updatedAt: string;
};

export type PreparationStatus = {
  summary: { preparing: number; queued: number; ready: number; failed: number; needsAttention: number };
  items: PreparationItem[];
  limits: { workers: number; ollama: number; pdf: number };
};

export function getPreparationStatus(db: DB): PreparationStatus {
  const state = queueState();
  const rows = db
    .prepare(
      `SELECT a.id, a.match_id, a.job_id, a.status, a.last_error, a.updated_at, j.title, j.company
       FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE a.status = 'preparing'
          OR (a.status IN ('ready_for_review', 'preparation_failed') AND a.updated_at >= datetime('now', ?))
       ORDER BY a.id`
    )
    .all(`-${RECENT_HOURS} hours`) as { id: number; match_id: number | null; job_id: number; status: string; last_error: string | null; updated_at: string; title: string; company: string }[];

  let position = 0;
  const items: PreparationItem[] = rows.map((r) => {
    const app = getApplication(db, r.id)!;
    const itemState = stateOf(app);
    const questions = questionsFor(db, r.id);
    const missing = missingParts(db, r.id, questions);
    const live = state.active.get(r.id);
    const stages = (["cv", "document", "coverLetter", "answers"] as StageKey[]).map((key) => {
      let s: StageState = key === "answers" && questions.length === 0 ? "skipped" : missing[key] ? "pending" : "done";
      if (live?.stages[key] && s !== "done") s = live.stages[key]!;
      if (itemState !== "preparing" && itemState !== "queued" && s === "pending" && (key === "coverLetter" || key === "answers") && r.last_error) s = "failed";
      if (itemState === "failed" && s === "pending") s = "failed";
      return { key, label: STAGE_LABELS[key], state: s };
    });
    const running = stages.filter((s) => s.state === "running").map((s) => s.label);
    return {
      applicationId: r.id,
      matchId: r.match_id,
      jobId: r.job_id,
      title: r.title,
      company: r.company,
      state: itemState,
      queuePosition: itemState === "queued" ? ++position : null,
      stages,
      currentStage: running.length ? running.join(" · ") : null,
      error: r.last_error,
      updatedAt: r.updated_at,
    };
  });

  const count = (s: string) => items.filter((i) => i.state === s).length;
  return {
    summary: {
      preparing: count("preparing"),
      queued: count("queued"),
      ready: count("ready"),
      failed: count("failed"),
      needsAttention: items.filter((i) => i.state === "failed" || (i.state === "ready" && i.error)).length,
    },
    items,
    limits: { workers: state.workers, ollama: state.ollama.limit, pdf: state.pdf.limit },
  };
}
