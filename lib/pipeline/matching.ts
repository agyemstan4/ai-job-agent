import type { DB } from "../repositories/shared.ts";
import type { MatchInput, MatchOutcome } from "../repositories/matches.ts";
import { getMatchFor, recordMatch } from "../repositories/matches.ts";
import { getProfile } from "../repositories/candidates.ts";
import { getBestDescription, getJob } from "../repositories/jobs.ts";
import { completeRun, failRun } from "../repositories/runs.ts";
import { startRunIfFree } from "./runs.ts";

// Step 7: records what /api/match decided for each job, for one candidate
// profile version. Scoring itself is unchanged and stays in the route; the
// legacy seen_jobs marking also stays there.
//
// Only jobs with a definite outcome get a row:
//   scored        — the model returned a usable score
//   filtered_out  — removed by the keyword/seniority pre-filter
//   failed        — selected for scoring but the model call or its output failed
// Jobs that passed the filter but were not among the top N, or were dropped
// as duplicates, get no row and stay eligible for later runs.

export type ScoredJob = {
  jobId: number;
  score: number;
  modelScore: number | null;
  breakdownScore: number;
  breakdown: Record<string, unknown>;
  reason: string | null;
  strengths: unknown[];
  missingSkills: unknown[];
};

export type MatchingSession = {
  candidateProfileId: number;
  runId: number | null;
  warnings: string[];
};

/**
 * Validates the profile and starts a matching run. Returns null when there is
 * no valid profile: nothing is recorded (the scheduler's case).
 */
export function beginMatching(
  db: DB,
  input: { candidateProfileId: unknown; triggeredBy?: "ui" | "scheduler"; params?: Record<string, unknown> | null }
): MatchingSession | null {
  if (typeof input.candidateProfileId !== "number" || !getProfile(db, input.candidateProfileId)) {
    return null;
  }
  const warnings: string[] = [];
  const run = startRunIfFree(db, {
    kind: "matching",
    triggeredBy: input.triggeredBy ?? "ui",
    candidateProfileId: input.candidateProfileId,
    params: input.params ?? null,
  });
  if (!run) warnings.push("Another matching run is in progress; this one is not attributed to a run");
  return { candidateProfileId: input.candidateProfileId, runId: run?.id ?? null, warnings };
}

// A weaker outcome never replaces a stronger one for the same job and profile
// (e.g. a transient failure must not erase an earlier score).
const OUTCOME_RANK: Record<Exclude<MatchOutcome, "legacy">, number> = {
  failed: 1,
  filtered_out: 2,
  scored: 3,
};

export type RecordMatchesResult = {
  /** jobId → match ID, for every job that has a match row for this profile. */
  matchIds: Map<number, number>;
  written: number;
  kept: number;
  warnings: string[];
};

export function recordMatchResults(
  db: DB,
  session: MatchingSession,
  input: {
    scored: ScoredJob[];
    filteredOut: { jobId: number; reason: string }[];
    failed: { jobId: number; error: string }[];
    model: string;
    promptVersion: string;
    stats?: Record<string, unknown>;
  }
): RecordMatchesResult {
  return db
    .transaction((): RecordMatchesResult => {
      const matchIds = new Map<number, number>();
      const warnings: string[] = [];
      let written = 0;
      let kept = 0;

      const write = (
        jobId: number,
        outcome: Exclude<MatchOutcome, "legacy">,
        fields: Partial<MatchInput>
      ) => {
        if (!getJob(db, jobId)) {
          warnings.push(`Unknown job ${jobId}; no match recorded`);
          return;
        }
        const existing = getMatchFor(db, jobId, session.candidateProfileId);
        if (
          existing &&
          existing.outcome !== "legacy" &&
          OUTCOME_RANK[existing.outcome] > OUTCOME_RANK[outcome]
        ) {
          matchIds.set(jobId, existing.id);
          kept++;
          return;
        }
        const match = recordMatch(db, {
          ...fields,
          jobId,
          candidateProfileId: session.candidateProfileId,
          outcome,
          runId: session.runId,
          jobDescriptionId: getBestDescription(db, jobId)?.id ?? null,
          model: outcome === "filtered_out" ? null : input.model,
          promptVersion: outcome === "filtered_out" ? null : input.promptVersion,
        });
        matchIds.set(jobId, match.id);
        written++;
      };

      for (const job of input.filteredOut) {
        write(job.jobId, "filtered_out", { filterReason: job.reason });
      }
      for (const job of input.failed) {
        write(job.jobId, "failed", { error: job.error });
      }
      for (const job of input.scored) {
        write(job.jobId, "scored", {
          score: job.score,
          modelScore: job.modelScore,
          breakdownScore: job.breakdownScore,
          scoreSource: job.modelScore === null ? "breakdown" : "blended",
          breakdown: job.breakdown,
          reason: job.reason,
          strengths: job.strengths,
          missingSkills: job.missingSkills,
        });
      }

      if (session.runId !== null) {
        completeRun(db, session.runId, { ...input.stats, written, kept });
      }
      return { matchIds, written, kept, warnings };
    })
    .immediate();
}

/** Marks the session's run as failed (e.g. the route threw). Never throws. */
export function abortMatching(db: DB, session: MatchingSession | null, error: string): void {
  if (session?.runId == null) return;
  try {
    failRun(db, session.runId, error);
  } catch {
    // Already finished, or the database is unavailable; nothing more to do.
  }
}
