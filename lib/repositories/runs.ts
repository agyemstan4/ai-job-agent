import type { DB } from "./shared.ts";
import { fromJson, nowIso, PersistenceError, toJson } from "./shared.ts";

export type RunKind = "discovery" | "matching" | "preparation" | "full" | "legacy_batch";
export type RunTrigger = "ui" | "scheduler" | "migration";
export type RunStatus = "running" | "completed" | "failed" | "cancelled";

export type PipelineRun = {
  id: number;
  kind: RunKind;
  triggeredBy: RunTrigger;
  status: RunStatus;
  candidateProfileId: number | null;
  params: Record<string, unknown> | null;
  stats: Record<string, unknown> | null;
  error: string | null;
  legacyBatchRunId: number | null;
  startedAt: string;
  finishedAt: string | null;
};

type RunRow = {
  id: number;
  kind: RunKind;
  triggered_by: RunTrigger;
  status: RunStatus;
  candidate_profile_id: number | null;
  params_json: string | null;
  stats_json: string | null;
  error: string | null;
  legacy_batch_run_id: number | null;
  started_at: string;
  finished_at: string | null;
};

function toRun(row: RunRow): PipelineRun {
  return {
    id: row.id,
    kind: row.kind,
    triggeredBy: row.triggered_by,
    status: row.status,
    candidateProfileId: row.candidate_profile_id,
    params: fromJson<Record<string, unknown>>(row.params_json),
    stats: fromJson<Record<string, unknown>>(row.stats_json),
    error: row.error,
    legacyBatchRunId: row.legacy_batch_run_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** Starts a run. Only one run of each kind may be running at a time. */
export function startRun(
  db: DB,
  input: {
    kind: Exclude<RunKind, "legacy_batch">;
    triggeredBy: Exclude<RunTrigger, "migration">;
    candidateProfileId?: number | null;
    params?: Record<string, unknown> | null;
  }
): PipelineRun {
  try {
    const result = db
      .prepare(
        `INSERT INTO pipeline_runs (kind, triggered_by, status, candidate_profile_id, params_json)
         VALUES (?, ?, 'running', ?, ?)`
      )
      .run(input.kind, input.triggeredBy, input.candidateProfileId ?? null, toJson(input.params));
    return getRun(db, Number(result.lastInsertRowid))!;
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      throw new PersistenceError("RUN_ALREADY_ACTIVE", `A ${input.kind} run is already running`);
    }
    throw error;
  }
}

function finishRun(
  db: DB,
  id: number,
  status: Exclude<RunStatus, "running">,
  stats?: Record<string, unknown> | null,
  error?: string | null
): PipelineRun {
  const result = db
    .prepare(
      `UPDATE pipeline_runs
       SET status = ?, stats_json = COALESCE(?, stats_json), error = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`
    )
    .run(status, toJson(stats), error ?? null, nowIso(), id);
  if (result.changes === 0) {
    throw new PersistenceError("RUN_NOT_RUNNING", `Run ${id} is not running`);
  }
  return getRun(db, id)!;
}

export const completeRun = (db: DB, id: number, stats?: Record<string, unknown> | null) =>
  finishRun(db, id, "completed", stats);

export const failRun = (db: DB, id: number, error: string, stats?: Record<string, unknown> | null) =>
  finishRun(db, id, "failed", stats, error);

export const cancelRun = (db: DB, id: number) => finishRun(db, id, "cancelled");

/**
 * Marks runs of this kind that have been "running" for longer than
 * olderThanMinutes as failed. A process that crashed or was restarted
 * mid-run would otherwise block every later run of that kind.
 * Returns how many runs were failed.
 */
export function failStaleRuns(db: DB, kind: RunKind, olderThanMinutes: number): number {
  return db
    .prepare(
      `UPDATE pipeline_runs
       SET status = 'failed', error = 'Abandoned: still running after ' || ? || ' minutes', finished_at = ?
       WHERE kind = ? AND status = 'running' AND started_at < datetime('now', ?)`
    )
    .run(olderThanMinutes, nowIso(), kind, `-${olderThanMinutes} minutes`).changes;
}

export function getRun(db: DB, id: number): PipelineRun | null {
  const row = db.prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(id) as RunRow | undefined;
  return row ? toRun(row) : null;
}

export function getActiveRun(db: DB, kind: RunKind): PipelineRun | null {
  const row = db
    .prepare("SELECT * FROM pipeline_runs WHERE kind = ? AND status = 'running'")
    .get(kind) as RunRow | undefined;
  return row ? toRun(row) : null;
}
