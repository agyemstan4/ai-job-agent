import type { DB } from "./shared.ts";
import { fromJson, nowIso, toJson } from "./shared.ts";

export type MatchOutcome = "scored" | "filtered_out" | "failed" | "legacy";
export type ScoreSource = "blended" | "breakdown" | "legacy";

export type Match = {
  id: number;
  jobId: number;
  candidateProfileId: number | null;
  runId: number | null;
  jobDescriptionId: number | null;
  outcome: MatchOutcome;
  filterReason: string | null;
  score: number | null;
  modelScore: number | null;
  breakdownScore: number | null;
  scoreSource: ScoreSource | null;
  breakdown: Record<string, unknown> | null;
  reason: string | null;
  strengths: unknown[] | null;
  missingSkills: unknown[] | null;
  model: string | null;
  promptVersion: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type MatchRow = {
  id: number;
  job_id: number;
  candidate_profile_id: number | null;
  run_id: number | null;
  job_description_id: number | null;
  outcome: MatchOutcome;
  filter_reason: string | null;
  score: number | null;
  model_score: number | null;
  breakdown_score: number | null;
  score_source: ScoreSource | null;
  breakdown_json: string | null;
  reason: string | null;
  strengths_json: string | null;
  missing_skills_json: string | null;
  model: string | null;
  prompt_version: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

function toMatch(row: MatchRow): Match {
  return {
    id: row.id,
    jobId: row.job_id,
    candidateProfileId: row.candidate_profile_id,
    runId: row.run_id,
    jobDescriptionId: row.job_description_id,
    outcome: row.outcome,
    filterReason: row.filter_reason,
    score: row.score,
    modelScore: row.model_score,
    breakdownScore: row.breakdown_score,
    scoreSource: row.score_source,
    breakdown: fromJson<Record<string, unknown>>(row.breakdown_json),
    reason: row.reason,
    strengths: fromJson<unknown[]>(row.strengths_json),
    missingSkills: fromJson<unknown[]>(row.missing_skills_json),
    model: row.model,
    promptVersion: row.prompt_version,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type MatchInput = {
  jobId: number;
  candidateProfileId: number;
  outcome: Exclude<MatchOutcome, "legacy">;
  runId?: number | null;
  jobDescriptionId?: number | null;
  filterReason?: string | null;
  score?: number | null;
  modelScore?: number | null;
  breakdownScore?: number | null;
  scoreSource?: Exclude<ScoreSource, "legacy"> | null;
  breakdown?: Record<string, unknown> | null;
  reason?: string | null;
  strengths?: unknown[] | null;
  missingSkills?: unknown[] | null;
  model?: string | null;
  promptVersion?: string | null;
  error?: string | null;
};

/** One match per job × profile version; re-scoring replaces it. */
export function recordMatch(db: DB, input: MatchInput): Match {
  const now = nowIso();
  db.prepare(
    `INSERT INTO matches
       (job_id, candidate_profile_id, run_id, job_description_id, outcome, filter_reason,
        score, model_score, breakdown_score, score_source, breakdown_json, reason,
        strengths_json, missing_skills_json, model, prompt_version, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (job_id, candidate_profile_id) DO UPDATE SET
       run_id = excluded.run_id,
       job_description_id = excluded.job_description_id,
       outcome = excluded.outcome,
       filter_reason = excluded.filter_reason,
       score = excluded.score,
       model_score = excluded.model_score,
       breakdown_score = excluded.breakdown_score,
       score_source = excluded.score_source,
       breakdown_json = excluded.breakdown_json,
       reason = excluded.reason,
       strengths_json = excluded.strengths_json,
       missing_skills_json = excluded.missing_skills_json,
       model = excluded.model,
       prompt_version = excluded.prompt_version,
       error = excluded.error,
       updated_at = excluded.updated_at`
  ).run(
    input.jobId,
    input.candidateProfileId,
    input.runId ?? null,
    input.jobDescriptionId ?? null,
    input.outcome,
    input.filterReason ?? null,
    input.score ?? null,
    input.modelScore ?? null,
    input.breakdownScore ?? null,
    input.scoreSource ?? null,
    toJson(input.breakdown),
    input.reason ?? null,
    toJson(input.strengths),
    toJson(input.missingSkills),
    input.model ?? null,
    input.promptVersion ?? null,
    input.error ?? null,
    now,
    now
  );
  return getMatchFor(db, input.jobId, input.candidateProfileId)!;
}

export function getMatch(db: DB, id: number): Match | null {
  const row = db.prepare("SELECT * FROM matches WHERE id = ?").get(id) as MatchRow | undefined;
  return row ? toMatch(row) : null;
}

export function getMatchFor(db: DB, jobId: number, candidateProfileId: number): Match | null {
  const row = db
    .prepare("SELECT * FROM matches WHERE job_id = ? AND candidate_profile_id = ?")
    .get(jobId, candidateProfileId) as MatchRow | undefined;
  return row ? toMatch(row) : null;
}

/** Matches for a profile version, best score first. */
export function listMatchesForProfile(
  db: DB,
  candidateProfileId: number,
  options: { outcome?: MatchOutcome; limit?: number } = {}
): Match[] {
  const rows = db
    .prepare(
      `SELECT * FROM matches
       WHERE candidate_profile_id = ? AND (? IS NULL OR outcome = ?)
       ORDER BY score IS NULL, score DESC, id
       LIMIT ?`
    )
    .all(
      candidateProfileId,
      options.outcome ?? null,
      options.outcome ?? null,
      options.limit ?? -1
    ) as MatchRow[];
  return rows.map(toMatch);
}
