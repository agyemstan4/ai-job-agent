import type { DB } from "../repositories/shared.ts";
import { PersistenceError } from "../repositories/shared.ts";
import type { PipelineRun, RunKind, RunTrigger } from "../repositories/runs.ts";
import { failStaleRuns, startRun } from "../repositories/runs.ts";

/** A run still "running" after this long is treated as abandoned. */
export const STALE_RUN_MINUTES = 60;

/**
 * Starts a run, first failing any abandoned run of the same kind. If another
 * run of this kind is genuinely in progress, returns null instead of throwing:
 * the work still goes ahead, it just isn't attributed to a run.
 */
export function startRunIfFree(
  db: DB,
  input: {
    kind: Exclude<RunKind, "legacy_batch">;
    triggeredBy: Exclude<RunTrigger, "migration">;
    candidateProfileId?: number | null;
    params?: Record<string, unknown> | null;
  }
): PipelineRun | null {
  failStaleRuns(db, input.kind, STALE_RUN_MINUTES);
  try {
    return startRun(db, input);
  } catch (error) {
    if (error instanceof PersistenceError && error.code === "RUN_ALREADY_ACTIVE") return null;
    throw error;
  }
}
