import type { DB } from "../repositories/shared.ts";
import { legacySeenKey } from "../repositories/shared.ts";
import { getProfile } from "../repositories/candidates.ts";
import { completeRun } from "../repositories/runs.ts";
import { getListingsForJob, isJobProcessed, isLegacySeen, recordJobListing } from "../repositories/jobs.ts";
import { startRunIfFree } from "./runs.ts";

// Step 6: records the listings fetched by /api/jobs (jobs, listings,
// descriptions), deduplicates them into canonical jobs, and decides which
// jobs are new.
//
// "Already processed" means:
//   • with a candidate profile: scored or filtered out for that profile
//     version, or any of the job's listings is in the legacy seen_jobs table;
//   • without one (the scheduler): any of the job's listings is in seen_jobs.
// seen_jobs keeps being written by /api/match, so scored jobs stay blocked
// across profile versions.

export type DiscoveredListing = {
  sourceId: "adzuna" | "reed";
  externalId: string;
  title: string;
  company: string;
  location?: string | null;
  url?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryIsPredicted?: boolean | null;
  contractType?: string | null;
  contractTime?: string | null;
  postedAt?: string | null;
  description?: string | null;
  raw?: unknown;
};

export type DiscoveredJob = {
  jobId: number;
  /** Indexes into the input listings, in input order. */
  listingIndexes: number[];
  /** The listing shown for this job: the last one, as /api/jobs always did. */
  representativeIndex: number;
  /** Legacy-format IDs ("adzuna_123") of this batch's listings for the job. */
  sourceIds: string[];
  processed: boolean;
};

export type DiscoveryResult = {
  runId: number | null;
  jobs: DiscoveredJob[];
  newJobs: DiscoveredJob[];
  stats: {
    rawListings: number;
    uniqueJobs: number;
    newJobs: number;
    jobsCreated: number;
    listingsCreated: number;
  };
  warnings: string[];
};

/** "dd/mm/yyyy" (Reed) becomes "yyyy-mm-dd"; anything else is kept as given. */
export function normalisePostedAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const ddmmyyyy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  return ddmmyyyy ? `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}` : value;
}

export function recordDiscovery(
  db: DB,
  input: {
    listings: DiscoveredListing[];
    candidateProfileId?: number | null;
    triggeredBy: "ui" | "scheduler";
    params?: Record<string, unknown> | null;
  }
): DiscoveryResult {
  return db
    .transaction((): DiscoveryResult => {
      const warnings: string[] = [];
      let profileId = input.candidateProfileId ?? null;
      if (profileId !== null && !getProfile(db, profileId)) {
        warnings.push(`Unknown candidate profile ${profileId}; using the legacy seen check only`);
        profileId = null;
      }

      const run = startRunIfFree(db, {
        kind: "discovery",
        triggeredBy: input.triggeredBy,
        candidateProfileId: profileId,
        params: input.params ?? null,
      });
      if (!run) warnings.push("Another discovery run is in progress; this one is not attributed to a run");

      // Group by canonical job, in order of first appearance.
      const groups = new Map<number, DiscoveredJob>();
      let jobsCreated = 0;
      let listingsCreated = 0;
      input.listings.forEach((listing, index) => {
        const recorded = recordJobListing(db, {
          ...listing,
          postedAt: normalisePostedAt(listing.postedAt),
          descriptionKind: "snippet",
          runId: run?.id ?? null,
        });
        if (recorded.jobCreated) jobsCreated++;
        if (recorded.listingCreated) listingsCreated++;

        const key = legacySeenKey(listing.sourceId, listing.externalId);
        const group = groups.get(recorded.jobId);
        if (group) {
          group.listingIndexes.push(index);
          group.representativeIndex = index;
          if (!group.sourceIds.includes(key)) group.sourceIds.push(key);
        } else {
          groups.set(recorded.jobId, {
            jobId: recorded.jobId,
            listingIndexes: [index],
            representativeIndex: index,
            sourceIds: [key],
            processed: false,
          });
        }
      });

      const jobs = Array.from(groups.values());
      for (const job of jobs) {
        job.processed =
          profileId !== null
            ? isJobProcessed(db, job.jobId, profileId)
            : isLegacySeen(
                db,
                getListingsForJob(db, job.jobId).map((l) => legacySeenKey(l.sourceId, l.externalId))
              );
      }
      const newJobs = jobs.filter((job) => !job.processed);

      const stats = {
        rawListings: input.listings.length,
        uniqueJobs: jobs.length,
        newJobs: newJobs.length,
        jobsCreated,
        listingsCreated,
      };
      if (run) completeRun(db, run.id, stats);
      return { runId: run?.id ?? null, jobs, newJobs, stats, warnings };
    })
    .immediate();
}
