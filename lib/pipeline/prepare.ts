import type { DB } from "../repositories/shared.ts";
import { PersistenceError } from "../repositories/shared.ts";
import { getProfile } from "../repositories/candidates.ts";
import { getBestDescription, getJob } from "../repositories/jobs.ts";
import { getMatch } from "../repositories/matches.ts";
import { completeRun, failRun } from "../repositories/runs.ts";
import type { Application } from "../repositories/applications.ts";
import {
  addApplicationAsset,
  createApplication,
  getActiveApplicationForJob,
  transitionApplication,
} from "../repositories/applications.ts";
import {
  APPLICATION_QUESTIONS_PROMPT_VERSION,
  COVER_LETTER_PROMPT_VERSION,
  GENERATION_MODEL,
  TAILOR_CV_PROMPT_VERSION,
} from "../generation/versions.ts";
import { boundDescription } from "./match-scoring.ts";
import { startRunIfFree } from "./runs.ts";

// Phase 3 checkpoint 3c: server-side preparation of ONE scored match.
//
//   POST /api/applications/prepare { matchId, questions? }
//     → application created as "preparing" (this is also the duplicate lock)
//     → tailored CV data, CV file, cover letter (and answers if questions
//       were given), each saved as soon as it is generated
//     → "ready_for_review" — never further: approval and submission stay
//       with the user (the existing gate is unchanged).
//
// Idempotent: a job that already has an active application is not prepared
// again — the existing application is returned. A preparation that has been
// "preparing" for longer than STALE_PREPARING_MINUTES (a crash or restart)
// is marked failed so the job can be prepared again.
// No email is sent and nothing is submitted anywhere.

export const STALE_PREPARING_MINUTES = 30;
/** How much of the job description tailoring sees (the cover letter and answers use their own 300). */
export const PREPARATION_DESCRIPTION_CHARS = 3000;
export const MAX_QUESTIONS = 10;
export const MAX_QUESTION_CHARS = 500;

export type PrepareJob = { title: string; company: string; location: string | null; description: string };
export type CvFile = { buffer: Buffer; filename: string; format: "pdf" | "docx"; mimeType: string };

/** The generation steps (lib/generation in production; fakes in tests). */
export type PrepareDeps = {
  tailorCv: (structuredCv: Record<string, unknown>, job: PrepareJob) => Promise<Record<string, unknown>>;
  renderCv: (tailoredCv: Record<string, unknown>, job: PrepareJob) => Promise<CvFile>;
  coverLetter: (candidate: Record<string, unknown>, job: PrepareJob) => Promise<string>;
  answerQuestions: (candidate: Record<string, unknown>, job: PrepareJob, questions: string[]) => Promise<unknown[]>;
};

export type PrepareOutcome = {
  status: number;
  body: {
    applicationId?: number;
    applicationStatus?: string;
    alreadyPrepared?: boolean;
    warnings?: string[];
    error?: string;
  };
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const fail = (status: number, error: string): PrepareOutcome => ({ status, body: { error } });

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

/** True when an application has been "preparing" for longer than the stale limit. */
export function isStalePreparing(application: Application, now = Date.now()): boolean {
  if (application.status !== "preparing") return false;
  const updated = Date.parse(application.updatedAt.includes("T") ? application.updatedAt : `${application.updatedAt.replace(" ", "T")}Z`);
  return Number.isFinite(updated) && now - updated > STALE_PREPARING_MINUTES * 60_000;
}

const existing = (application: Application, status: number, extra: Partial<PrepareOutcome["body"]> = {}): PrepareOutcome => ({
  status,
  body: { applicationId: application.id, applicationStatus: application.status, alreadyPrepared: true, ...extra },
});

export async function prepareApplication(
  db: DB,
  input: { matchId?: unknown; questions?: unknown },
  deps: PrepareDeps
): Promise<PrepareOutcome> {
  // ── Validate ─────────────────────────────────────────────────────────────
  if (typeof input.matchId !== "number" || !Number.isInteger(input.matchId) || input.matchId <= 0) {
    return fail(400, "matchId must be a positive whole number");
  }
  const questions = parseQuestions(input.questions);
  if (typeof questions === "string") return fail(400, questions);

  const match = getMatch(db, input.matchId);
  if (!match) return fail(404, `Match ${input.matchId} not found`);
  if (match.outcome !== "scored") return fail(409, "Only scored matches can be prepared");
  const job = getJob(db, match.jobId);
  if (!job) return fail(404, `Job ${match.jobId} not found`);
  const profile = match.candidateProfileId === null ? null : getProfile(db, match.candidateProfileId);
  if (!profile || !profile.structuredCv || Object.keys(profile.structuredCv).length === 0) {
    return fail(409, "This match has no stored CV profile; upload your CV again first");
  }

  // ── Duplicate protection (synchronous, before any generation) ───────────
  let application: Application;
  let runId: number | null = null;
  try {
    const active = getActiveApplicationForJob(db, job.id);
    if (active && isStalePreparing(active)) {
      transitionApplication(db, active.id, "preparation_failed", {
        actor: "system",
        detail: "Abandoned: still preparing after the time limit",
        error: `Preparation did not finish within ${STALE_PREPARING_MINUTES} minutes`,
      });
    } else if (active?.status === "preparing") {
      return existing(active, 409, { error: "This job is already being prepared. It takes several minutes; check back shortly." });
    } else if (active) {
      return existing(active, 200);
    }
    const run = startRunIfFree(db, {
      kind: "preparation",
      triggeredBy: "ui",
      candidateProfileId: profile.id,
      params: { matchId: match.id, jobId: job.id, questions: questions.length },
    });
    runId = run?.id ?? null;
    application = createApplication(db, {
      jobId: job.id,
      matchId: match.id,
      candidateProfileId: profile.id,
      runId,
      status: "preparing",
      actor: "system",
      eventPayload: { source: "server_preparation", matchId: match.id },
    });
  } catch (error) {
    if (runId !== null) failRun(db, runId, message(error));
    // A concurrent request created the application first.
    if (error instanceof PersistenceError && error.code === "ACTIVE_APPLICATION_EXISTS") {
      const active = getActiveApplicationForJob(db, job.id);
      if (active) return existing(active, active.status === "preparing" ? 409 : 200);
    }
    throw error;
  }

  // ── Generate and save each part as it finishes ──────────────────────────
  const description = getBestDescription(db, job.id);
  const prepareJob: PrepareJob = {
    title: job.title,
    company: job.company,
    location: job.location,
    description: boundDescription(description?.content ?? "", PREPARATION_DESCRIPTION_CHARS),
  };
  const analysis = profile.analysis ?? {};
  const cv = profile.structuredCv;
  const candidate = { ...analysis, education: cv.education ?? [], projects: cv.projects ?? [] };
  const sourceJobDescriptionId = description?.id ?? null;
  const warnings: string[] = [];
  const id = application.id;

  try {
    const tailoredCv = await deps.tailorCv(cv, prepareJob);
    addApplicationAsset(db, {
      applicationId: id, kind: "tailored_cv_data", origin: "generated", contentJson: tailoredCv,
      model: GENERATION_MODEL, promptVersion: TAILOR_CV_PROMPT_VERSION, sourceJobDescriptionId, actor: "system",
    });

    const file = await deps.renderCv(tailoredCv, prepareJob);
    addApplicationAsset(db, {
      applicationId: id, kind: "tailored_cv_file", origin: "generated", file: file.buffer,
      filename: file.filename, mimeType: file.mimeType, actor: "system",
    });
    if (file.format === "docx") warnings.push("PDF conversion was unavailable; the CV was saved as DOCX");
  } catch (error) {
    // Without a CV the package is not usable: the job can be prepared again.
    const failed = transitionApplication(db, id, "preparation_failed", {
      actor: "system", detail: "Server preparation failed", error: `CV: ${message(error)}`,
    });
    if (runId !== null) failRun(db, runId, `CV: ${message(error)}`);
    return { status: 502, body: { applicationId: id, applicationStatus: failed.status, error: `Preparing the CV failed: ${message(error)}` } };
  }

  try {
    const coverLetter = await deps.coverLetter(candidate, prepareJob);
    addApplicationAsset(db, {
      applicationId: id, kind: "cover_letter", origin: "generated", contentText: coverLetter, mimeType: "text/plain",
      model: GENERATION_MODEL, promptVersion: COVER_LETTER_PROMPT_VERSION, sourceJobDescriptionId, actor: "system",
    });
  } catch (error) {
    warnings.push(`Cover letter failed: ${message(error)}`);
  }

  if (questions.length > 0) {
    try {
      const answers = await deps.answerQuestions({ ...candidate, experience: cv.experience ?? [] }, prepareJob, questions);
      addApplicationAsset(db, {
        applicationId: id, kind: "question_answers", origin: "generated", contentJson: { questions, answers },
        model: GENERATION_MODEL, promptVersion: APPLICATION_QUESTIONS_PROMPT_VERSION, sourceJobDescriptionId, actor: "system",
      });
    } catch (error) {
      warnings.push(`Application questions failed: ${message(error)}`);
    }
  }

  // A reviewable package even if an optional part failed; the problem is kept as last_error.
  const ready = transitionApplication(db, id, "ready_for_review", {
    actor: "system",
    detail: "Prepared on the server",
    error: warnings.filter((w) => !w.startsWith("PDF")).join("; ") || null,
  });
  if (runId !== null) completeRun(db, runId, { applicationId: id, warnings: warnings.length });
  return { status: 201, body: { applicationId: id, applicationStatus: ready.status, alreadyPrepared: false, warnings } };
}

/** The production generation steps (lib/generation), loaded only when used. */
export async function defaultPrepareDeps(): Promise<PrepareDeps> {
  const [{ tailorCv }, { renderCvDocument }, { generateCoverLetter }, { answerQuestions }] = await Promise.all([
    import("../generation/tailor-cv.ts"),
    import("../generation/cv-document.ts"),
    import("../generation/cover-letter.ts"),
    import("../generation/questions.ts"),
  ]);
  return {
    tailorCv: (cv, job) => tailorCv(cv, job),
    renderCv: (tailored, job) => renderCvDocument(tailored, job),
    coverLetter: (candidate, job) => generateCoverLetter(candidate, job),
    answerQuestions: (candidate, job, qs) => answerQuestions(candidate, job, qs),
  };
}
