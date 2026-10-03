import type { DB } from "./shared.ts";
import type { ApplicationStatus } from "./applications.ts";
import { getApplication, getCurrentAssets, getCurrentAssetsHash } from "./applications.ts";
import { getJob } from "./jobs.ts";
import { getMatch } from "./matches.ts";

// Read model for the review queue: an application with everything the
// reviewer needs, and the hash of exactly the content being shown, which an
// approval must send back (approveApplication refuses a stale hash).

export type ReviewItem = {
  id: number;
  status: ApplicationStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  notes: string | null;
  lastError: string | null;
  /** Imported from the legacy batch_results table by migration 003. */
  isLegacyImport: boolean;
  job: {
    id: number;
    title: string;
    company: string;
    location: string | null;
    salaryMin: number | null;
    salaryMax: number | null;
    contractType: string | null;
    url: string | null;
  };
  match: { id: number; score: number | null; reason: string | null } | null;
  coverLetter: { assetId: number; version: number; text: string; origin: string } | null;
  cvFile: { assetId: number; version: number; filename: string | null; mimeType: string | null } | null;
  hasTailoredCvData: boolean;
  /** Hash of all current assets; approval must confirm this exact value. */
  assetsHash: string;
};

/** The URL of the job's most recently seen listing that has one. */
function jobUrl(db: DB, jobId: number): string | null {
  const row = db
    .prepare(
      `SELECT url FROM job_listings WHERE job_id = ? AND url IS NOT NULL AND url <> ''
       ORDER BY last_seen_at DESC, id DESC LIMIT 1`
    )
    .get(jobId) as { url: string } | undefined;
  return row?.url ?? null;
}

export function getReviewItem(db: DB, applicationId: number): ReviewItem | null {
  const application = getApplication(db, applicationId);
  if (!application) return null;
  const job = getJob(db, application.jobId)!;
  const match = application.matchId === null ? null : getMatch(db, application.matchId);
  const assets = getCurrentAssets(db, application.id);
  const coverLetter = assets.find((a) => a.kind === "cover_letter");
  const cvFile = assets.find((a) => a.kind === "tailored_cv_file");

  return {
    id: application.id,
    status: application.status,
    createdAt: application.createdAt,
    updatedAt: application.updatedAt,
    approvedAt: application.approvedAt,
    notes: application.notes,
    lastError: application.lastError,
    isLegacyImport: application.legacyBatchResultId !== null,
    job: {
      id: job.id,
      title: job.title,
      company: job.company,
      location: job.location,
      salaryMin: job.salaryMin,
      salaryMax: job.salaryMax,
      contractType: job.contractType,
      url: jobUrl(db, job.id),
    },
    match: match ? { id: match.id, score: match.score, reason: match.reason } : null,
    coverLetter:
      coverLetter && coverLetter.contentText !== null
        ? {
            assetId: coverLetter.id,
            version: coverLetter.version,
            text: coverLetter.contentText,
            origin: coverLetter.origin,
          }
        : null,
    cvFile: cvFile?.hasFile
      ? { assetId: cvFile.id, version: cvFile.version, filename: cvFile.filename, mimeType: cvFile.mimeType }
      : null,
    hasTailoredCvData: assets.some((a) => a.kind === "tailored_cv_data"),
    assetsHash: getCurrentAssetsHash(db, application.id),
  };
}

/** Review items with any of these statuses (all if empty), newest first. */
export function listReviewItems(db: DB, statuses: ApplicationStatus[] = []): ReviewItem[] {
  const ids = (
    db
      .prepare(
        `SELECT id FROM applications
         ${statuses.length > 0 ? `WHERE status IN (${statuses.map(() => "?").join(", ")})` : ""}
         ORDER BY created_at DESC, id DESC`
      )
      .all(...statuses) as { id: number }[]
  ).map((row) => row.id);
  return ids.map((id) => getReviewItem(db, id)!);
}

/** The review page's filter tabs, as application statuses. */
export const REVIEW_FILTERS: Record<string, ApplicationStatus[]> = {
  pending: ["ready_for_review", "preparing"],
  approved: ["approved"],
  rejected: ["rejected"],
  failed: ["preparation_failed"],
  withdrawn: ["withdrawn"],
  all: [],
};
