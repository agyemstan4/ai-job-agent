import type { DB } from "../repositories/shared.ts";
import { mimeTypeForFilename } from "../repositories/shared.ts";
import { getProfile } from "../repositories/candidates.ts";
import { getJob, recordJobListing } from "../repositories/jobs.ts";
import { getMatch } from "../repositories/matches.ts";
import {
  addApplicationAsset,
  createApplication,
  getActiveApplicationForJob,
  transitionApplication,
} from "../repositories/applications.ts";

// Step 8: turns the results of a batch run (prepared in the browser:
// tailored CV, CV file, cover letter) into applications awaiting review.
// Nothing is submitted anywhere: a prepared application stops at
// ready_for_review, and only an explicit user approval moves it on.

/** The job as the browser has it (a /api/match result). */
export type BatchJobInput = {
  id?: unknown;
  source?: unknown;
  title?: unknown;
  company?: unknown;
  location?: unknown;
  url?: unknown;
  salaryMin?: unknown;
  salaryMax?: unknown;
  contractType?: unknown;
};

export type BatchResultInput = {
  /** The legacy batch_results row written for the same result, if any. */
  batchResultId?: number | null;
  jobId?: unknown;
  matchId?: unknown;
  /** Used to record the job when jobId is missing or unknown. */
  job?: BatchJobInput | null;
  success: boolean;
  error?: string | null;
  coverLetter?: string | null;
  cvFile?: Buffer | null;
  cvFilename?: string | null;
  tailoredCv?: unknown;
};

export type SavedBatchResult = {
  batchResultId: number | null;
  applicationId: number | null;
  status: string | null;
  warning: string | null;
};

const ASSET_MODEL = "llama3.2:3b";

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * The stored job for a result: its jobId if known, otherwise the job is
 * recorded from the result's own listing data ("adzuna_123" + title +
 * company), merged by the usual deduplication. Null if neither is possible.
 */
function resolveJob(db: DB, result: BatchResultInput): number | null {
  if (typeof result.jobId === "number" && getJob(db, result.jobId)) return result.jobId;
  const job = result.job ?? {};
  const id = str(job.id);
  const sourceId = id?.startsWith("adzuna_") ? "adzuna" : id?.startsWith("reed_") ? "reed" : null;
  const title = str(job.title);
  const company = str(job.company);
  if (!id || !sourceId || !title || !company) return null;
  return recordJobListing(db, {
    sourceId,
    externalId: id.slice(sourceId.length + 1),
    title,
    company,
    location: str(job.location),
    url: str(job.url),
    salaryMin: num(job.salaryMin),
    salaryMax: num(job.salaryMax),
    contractType: str(job.contractType),
  }).jobId;
}

function saveOne(db: DB, candidateProfileId: number | null, result: BatchResultInput): SavedBatchResult {
  const base = { batchResultId: result.batchResultId ?? null, applicationId: null, status: null };

  return db.transaction((): SavedBatchResult => {
    const jobId = resolveJob(db, result);
    if (jobId === null) {
      return { ...base, warning: "This result has no job details, so it could not be saved" };
    }
    const active = getActiveApplicationForJob(db, jobId);
    if (active) {
      return {
        ...base,
        warning: `Job ${jobId} already has application ${active.id} (${active.status}); no new application created`,
      };
    }
    const match = typeof result.matchId === "number" ? getMatch(db, result.matchId) : null;

    const application = createApplication(db, {
      jobId,
      matchId: match && match.jobId === jobId ? match.id : null,
      candidateProfileId,
      status: "preparing",
      actor: "system",
      eventPayload: { source: "batch", batchResultId: result.batchResultId ?? null },
    });
    const id = application.id;

    if (result.tailoredCv && typeof result.tailoredCv === "object") {
      addApplicationAsset(db, {
        applicationId: id,
        kind: "tailored_cv_data",
        origin: "generated",
        contentJson: result.tailoredCv,
        model: ASSET_MODEL,
      });
    }
    if (result.cvFile && result.cvFile.length > 0) {
      addApplicationAsset(db, {
        applicationId: id,
        kind: "tailored_cv_file",
        origin: "generated",
        file: result.cvFile,
        filename: result.cvFilename ?? null,
        mimeType: mimeTypeForFilename(result.cvFilename),
      });
    }
    if (result.coverLetter && result.coverLetter.trim()) {
      addApplicationAsset(db, {
        applicationId: id,
        kind: "cover_letter",
        origin: "generated",
        contentText: result.coverLetter,
        mimeType: "text/plain",
        model: ASSET_MODEL,
      });
    }

    // A successful result is reviewable even if a part of it failed (e.g.
    // the cover letter); the problem is kept as last_error.
    const final = result.success
      ? transitionApplication(db, id, "ready_for_review", {
          actor: "system",
          detail: "Prepared by batch run",
          error: result.error ?? null,
        })
      : transitionApplication(db, id, "preparation_failed", {
          actor: "system",
          detail: "Batch preparation failed",
          error: result.error ?? "Preparation failed",
        });
    return { ...base, applicationId: id, status: final.status, warning: null };
  })();
}

/**
 * Saves each batch result as an application. Results are independent: one
 * that cannot be saved is reported and does not affect the others.
 */
export function saveBatchApplications(
  db: DB,
  input: { candidateProfileId?: unknown; results: BatchResultInput[] }
): { saved: SavedBatchResult[]; warnings: string[] } {
  const warnings: string[] = [];
  let candidateProfileId: number | null = null;
  if (typeof input.candidateProfileId === "number") {
    if (getProfile(db, input.candidateProfileId)) candidateProfileId = input.candidateProfileId;
    else warnings.push(`Unknown candidate profile ${input.candidateProfileId}; applications are saved without it`);
  }

  const saved = input.results.map((result) => {
    try {
      return saveOne(db, candidateProfileId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        batchResultId: result.batchResultId ?? null,
        applicationId: null,
        status: null,
        warning: `Application not saved: ${message}`,
      };
    }
  });
  for (const result of saved) if (result.warning) warnings.push(result.warning);
  return { saved, warnings };
}

/**
 * The batch save request sent by the main page (POST /api/applications, and
 * the legacy alias POST /api/batch-results): { results, candidateProfileId }
 * where each result is { job, coverLetter, cvBase64, cvFilename,
 * tailoredCV, success, error }. Only the new tables are written.
 */
export function saveBatchRequest(
  db: DB,
  body: unknown
): { saved: SavedBatchResult[]; warnings: string[] } | null {
  const { results, candidateProfileId } = (body ?? {}) as { results?: unknown; candidateProfileId?: unknown };
  if (!Array.isArray(results) || results.length === 0) return null;
  return saveBatchApplications(db, {
    candidateProfileId,
    results: results.map((raw): BatchResultInput => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const job = (r.job ?? null) as (BatchJobInput & { jobId?: unknown; matchId?: unknown }) | null;
      return {
        jobId: job?.jobId,
        matchId: job?.matchId,
        job,
        success: Boolean(r.success),
        error: str(r.error),
        coverLetter: str(r.coverLetter),
        cvFile: typeof r.cvBase64 === "string" && r.cvBase64 ? Buffer.from(r.cvBase64, "base64") : null,
        cvFilename: str(r.cvFilename),
        tailoredCv: r.tailoredCV,
      };
    }),
  });
}
