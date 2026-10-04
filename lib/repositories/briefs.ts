import type { DB } from "./shared.ts";
import { fromJson, nowIso, toJson } from "./shared.ts";

// Daily briefs and opportunity state (migration 007, Phase 4b).

export type BriefStatus = "building" | "ready" | "failed";
export type BriefOrigin = "scheduled_run" | "on_demand";

export type SavedBrief = {
  id: number;
  candidateId: number;
  candidateProfileId: number | null;
  briefDate: string;
  origin: BriefOrigin;
  status: BriefStatus;
  runId: number | null;
  stats: Record<string, unknown> | null;
  error: string | null;
  startedAt: string;
  generatedAt: string | null;
  updatedAt: string;
};

export type SavedBriefItem = {
  briefId: number;
  jobId: number;
  matchId: number | null;
  rank: number;
  tier: number;
  whyHere: string;
  headline: string;
  reasons: string[];
  wasNew: boolean;
};

/** Database timestamps are UTC ("YYYY-MM-DD HH:MM:SS"). */
const utc = (value: string) => Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);

type BriefRow = {
  id: number; candidate_id: number; candidate_profile_id: number | null; brief_date: string; origin: BriefOrigin;
  status: BriefStatus; run_id: number | null; stats_json: string | null; error: string | null;
  started_at: string; generated_at: string | null; updated_at: string;
};
const toBrief = (r: BriefRow): SavedBrief => ({
  id: r.id, candidateId: r.candidate_id, candidateProfileId: r.candidate_profile_id, briefDate: r.brief_date, origin: r.origin,
  status: r.status, runId: r.run_id, stats: fromJson<Record<string, unknown>>(r.stats_json), error: r.error,
  startedAt: r.started_at, generatedAt: r.generated_at, updatedAt: r.updated_at,
});

export function getBrief(db: DB, candidateId: number, briefDate: string): SavedBrief | null {
  const row = db.prepare("SELECT * FROM daily_briefs WHERE candidate_id = ? AND brief_date = ?").get(candidateId, briefDate) as BriefRow | undefined;
  return row ? toBrief(row) : null;
}

/** The most recent ready brief for a candidate (any date), or null. */
export function getLatestReadyBrief(db: DB, candidateId: number): SavedBrief | null {
  const row = db
    .prepare("SELECT * FROM daily_briefs WHERE candidate_id = ? AND status = 'ready' ORDER BY brief_date DESC LIMIT 1")
    .get(candidateId) as BriefRow | undefined;
  return row ? toBrief(row) : null;
}

export type ClaimResult =
  | { kind: "claimed"; brief: SavedBrief; retry: boolean }
  | { kind: "already_ready"; brief: SavedBrief }
  | { kind: "in_progress"; brief: SavedBrief };

/**
 * Claims today's brief for building. One brief per candidate per day (UNIQUE):
 *   • none yet → a new "building" row;
 *   • ready → nothing to do (a repeated or duplicate run is a no-op);
 *   • failed, or "building" for longer than staleMinutes (a crash) → reclaimed;
 *   • building recently → another run is working on it.
 * Done in one transaction so two callers can't both claim it.
 */
export function claimBrief(
  db: DB,
  input: { candidateId: number; candidateProfileId: number | null; briefDate: string; origin: BriefOrigin; staleMinutes: number; now?: string }
): ClaimResult {
  const now = input.now ?? nowIso();
  return db.transaction((): ClaimResult => {
    const existing = getBrief(db, input.candidateId, input.briefDate);
    if (!existing) {
      const id = Number(
        db
          .prepare(
            `INSERT INTO daily_briefs (candidate_id, candidate_profile_id, brief_date, origin, status, started_at, updated_at)
             VALUES (?, ?, ?, ?, 'building', ?, ?)`
          )
          .run(input.candidateId, input.candidateProfileId, input.briefDate, input.origin, now, now).lastInsertRowid
      );
      return { kind: "claimed", brief: getBriefById(db, id)!, retry: false };
    }
    if (existing.status === "ready") return { kind: "already_ready", brief: existing };
    const stale = existing.status === "building" && utc(existing.updatedAt) < utc(now) - input.staleMinutes * 60_000;
    if (existing.status === "failed" || stale) {
      db.prepare(
        `UPDATE daily_briefs SET status = 'building', error = NULL, candidate_profile_id = ?, origin = ?, started_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(input.candidateProfileId, input.origin, now, now, existing.id);
      return { kind: "claimed", brief: getBriefById(db, existing.id)!, retry: true };
    }
    return { kind: "in_progress", brief: existing };
  }).immediate();
}

export function getBriefById(db: DB, id: number): SavedBrief | null {
  const row = db.prepare("SELECT * FROM daily_briefs WHERE id = ?").get(id) as BriefRow | undefined;
  return row ? toBrief(row) : null;
}

/** Keeps a building brief fresh (so a long run isn't mistaken for a crashed one). */
export function touchBrief(db: DB, id: number, patch: { runId?: number | null } = {}): void {
  db.prepare("UPDATE daily_briefs SET updated_at = ?, run_id = COALESCE(?, run_id) WHERE id = ?").run(nowIso(), patch.runId ?? null, id);
}

export type NewBriefItem = Omit<SavedBriefItem, "briefId">;

/**
 * Replaces a brief's items and marks it ready — in one transaction, so a
 * brief is never half-written. Also records, per job, when it first
 * appeared in any brief (opportunity_states.first_surfaced_at).
 */
export function completeBrief(db: DB, briefId: number, items: NewBriefItem[], stats: Record<string, unknown>): void {
  db.transaction(() => {
    const brief = getBriefById(db, briefId);
    if (!brief) throw new Error(`No brief ${briefId}`);
    const now = nowIso();
    db.prepare("DELETE FROM daily_brief_items WHERE brief_id = ?").run(briefId);
    const insert = db.prepare(
      `INSERT INTO daily_brief_items (brief_id, job_id, match_id, rank, tier, why_here, headline, reasons_json, was_new)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const surfaced = db.prepare(
      `INSERT OR IGNORE INTO opportunity_states (candidate_id, job_id, first_surfaced_at, first_brief_id) VALUES (?, ?, ?, ?)`
    );
    for (const item of items) {
      insert.run(briefId, item.jobId, item.matchId, item.rank, item.tier, item.whyHere, item.headline, toJson(item.reasons), item.wasNew ? 1 : 0);
      surfaced.run(brief.candidateId, item.jobId, now, briefId);
    }
    db.prepare("UPDATE daily_briefs SET status = 'ready', stats_json = ?, error = NULL, generated_at = ?, updated_at = ? WHERE id = ?").run(
      toJson(stats),
      now,
      now,
      briefId
    );
  })();
}

export function failBrief(db: DB, briefId: number, error: string, stats?: Record<string, unknown> | null): void {
  db.prepare("UPDATE daily_briefs SET status = 'failed', error = ?, stats_json = COALESCE(?, stats_json), updated_at = ? WHERE id = ?").run(
    error.slice(0, 500),
    stats ? toJson(stats) : null,
    nowIso(),
    briefId
  );
}

type ItemRow = { brief_id: number; job_id: number; match_id: number | null; rank: number; tier: number; why_here: string; headline: string; reasons_json: string | null; was_new: number };

export function getBriefItems(db: DB, briefId: number): SavedBriefItem[] {
  return (db.prepare("SELECT * FROM daily_brief_items WHERE brief_id = ? ORDER BY rank").all(briefId) as ItemRow[]).map((r) => ({
    briefId: r.brief_id, jobId: r.job_id, matchId: r.match_id, rank: r.rank, tier: r.tier, whyHere: r.why_here, headline: r.headline,
    reasons: fromJson<string[]>(r.reasons_json) ?? [], wasNew: r.was_new === 1,
  }));
}

// ── Opportunity state ──────────────────────────────────────────────────────

export type OpportunityState = { jobId: number; firstSurfacedAt: string; seenAt: string | null; reviewedAt: string | null };

/** Jobs that have already appeared in one of this candidate's briefs. */
export function surfacedJobIds(db: DB, candidateId: number): Set<number> {
  return new Set((db.prepare("SELECT job_id FROM opportunity_states WHERE candidate_id = ?").all(candidateId) as { job_id: number }[]).map((r) => r.job_id));
}

export function getOpportunityStates(db: DB, candidateId: number, jobIds: number[]): Map<number, OpportunityState> {
  const map = new Map<number, OpportunityState>();
  const get = db.prepare("SELECT job_id, first_surfaced_at, seen_at, reviewed_at FROM opportunity_states WHERE candidate_id = ? AND job_id = ?");
  for (const jobId of jobIds) {
    const r = get.get(candidateId, jobId) as { job_id: number; first_surfaced_at: string; seen_at: string | null; reviewed_at: string | null } | undefined;
    if (r) map.set(jobId, { jobId: r.job_id, firstSurfacedAt: r.first_surfaced_at, seenAt: r.seen_at, reviewedAt: r.reviewed_at });
  }
  return map;
}

/** Records that the user opened ("seen") or acted on ("reviewed") an opportunity. Keeps the first time. */
export function recordOpportunityEvent(db: DB, candidateId: number, jobId: number, event: "seen" | "reviewed"): void {
  const now = nowIso();
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO opportunity_states (candidate_id, job_id, first_surfaced_at) VALUES (?, ?, ?)").run(candidateId, jobId, now);
    if (event === "seen") {
      db.prepare("UPDATE opportunity_states SET seen_at = COALESCE(seen_at, ?) WHERE candidate_id = ? AND job_id = ?").run(now, candidateId, jobId);
    } else {
      db.prepare(
        "UPDATE opportunity_states SET seen_at = COALESCE(seen_at, ?), reviewed_at = COALESCE(reviewed_at, ?) WHERE candidate_id = ? AND job_id = ?"
      ).run(now, now, candidateId, jobId);
    }
  })();
}
