import type { DB } from "../repositories/shared.ts";
import { addJobDescription } from "../repositories/jobs.ts";
import type { ReedDetailResult } from "../sources/reed-details.ts";

// Phase 3 checkpoint 3b-2: full Reed descriptions for the jobs /api/match
// has selected for scoring, stored as job_descriptions kind = 'full'.
//
// At most one detail request per job, without a schema change. A job is
// fetched only if it:
//   • has a Reed listing,
//   • has no full description yet (a success is cached here), and
//   • has never been selected for scoring before: no scored, failed or legacy
//     match for any profile. Every saved scoring run ends with one of those,
//     so an earlier one means its detail request was already made.
// The route only calls this for runs whose matches are saved (the UI), and
// only with the selected jobs, so filtered-out jobs are never fetched.
// Failures are reported in the stats and never thrown: the snippet is used.

export type DetailFetcher = (externalId: string) => Promise<ReedDetailResult>;

export type EnrichmentStats = {
  /** Distinct job IDs passed in. */
  requested: number;
  /** Jobs that needed a detail request. */
  eligible: number;
  fetched: number;
  notFound: number;
  failed: number;
  /** Eligible jobs not requested because Reed refused an earlier request. */
  skipped: number;
  /** Why requests stopped early, if they did. */
  stoppedBy: "rate_limited" | "auth_failed" | null;
};

/** The Reed listing to fetch details for, or null if the job is not eligible. */
export function reedListingToEnrich(db: DB, jobId: number): { listingId: number; externalId: string } | null {
  const hasFull = db.prepare("SELECT 1 FROM job_descriptions WHERE job_id = ? AND kind = 'full'").get(jobId);
  if (hasFull) return null;

  const selectedBefore = db
    .prepare("SELECT 1 FROM matches WHERE job_id = ? AND outcome IN ('scored', 'failed', 'legacy')")
    .get(jobId);
  if (selectedBefore) return null;

  // The most recently seen Reed listing of the job: one request per job.
  const listing = db
    .prepare(
      `SELECT id, external_id FROM job_listings
       WHERE job_id = ? AND source_id = 'reed'
       ORDER BY last_seen_at DESC, id DESC LIMIT 1`
    )
    .get(jobId) as { id: number; external_id: string } | undefined;
  return listing ? { listingId: listing.id, externalId: listing.external_id } : null;
}

export async function enrichSelectedJobs(
  db: DB,
  jobIds: number[],
  options: { fetchDetail: DetailFetcher; concurrency?: number }
): Promise<EnrichmentStats> {
  const unique = Array.from(new Set(jobIds));
  const queue = unique.flatMap((jobId) => {
    const listing = reedListingToEnrich(db, jobId);
    return listing ? [{ jobId, ...listing }] : [];
  });

  const stats: EnrichmentStats = {
    requested: unique.length,
    eligible: queue.length,
    fetched: 0,
    notFound: 0,
    failed: 0,
    skipped: 0,
    stoppedBy: null,
  };

  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      if (stats.stoppedBy) {
        stats.skipped += queue.length - next;
        next = queue.length;
        return;
      }
      const item = queue[next++];
      let result: ReedDetailResult;
      try {
        result = await options.fetchDetail(item.externalId);
      } catch (error) {
        result = { status: "error", error: error instanceof Error ? error.name : "Error" };
      }

      if (result.status === "ok") {
        try {
          addJobDescription(db, {
            jobId: item.jobId,
            jobListingId: item.listingId,
            kind: "full",
            content: result.description,
          });
          stats.fetched++;
        } catch {
          stats.failed++;
        }
      } else if (result.status === "not_found") {
        stats.notFound++;
      } else {
        stats.failed++;
        if (result.status === "rate_limited" || result.status === "auth_failed") {
          stats.stoppedBy ??= result.status;
        }
      }
    }
  };

  const workers = Math.max(1, Math.min(options.concurrency ?? 2, queue.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return stats;
}
