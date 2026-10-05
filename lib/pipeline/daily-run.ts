import type { DB } from "../repositories/shared.ts";
import { PersistenceError } from "../repositories/shared.ts";
import { getCandidate, getCurrentProfile, getDefaultCandidate } from "../repositories/candidates.ts";
import { cancelRun, completeRun, failRun, failStaleRuns, startRun } from "../repositories/runs.ts";
import { claimBrief, completeBrief, failBrief, getLatestReadyBrief, surfacedJobIds, touchBrief } from "../repositories/briefs.ts";
import { parseStoredTime } from "../dashboard-client.ts";
import { sourceWarnings } from "./source-search.ts";
import type { DiscoveryReport } from "./source-search.ts";
import { getDashboard, MAX_TOP_MATCHES } from "./dashboard.ts";
import { storedPreferences } from "./preferences.ts";
import { getPreparationStatus } from "./preparation-queue.ts";
import { buildDailyBrief } from "../daily-brief.ts";

// The daily career agent (Phase 4b): one bounded pass that finds, matches and
// prioritises opportunities and saves today's brief. It only orchestrates the
// existing pieces — discovery and matching are injected (the route wires the
// existing /api/jobs and /api/match handlers; tests inject fakes), and
// prioritisation is the existing dashboard + daily-brief logic. No new score.
//
// It never prepares, approves or submits anything, and never sends email or
// notifications.
//
// Safe to repeat:
//   • a strict run lock (pipeline_runs: one running "full" run at a time) —
//     a second trigger while one is running returns "already_running";
//   • one brief per candidate per day (daily_briefs UNIQUE) — a trigger after
//     today's brief is ready returns "already_ready";
//   • a crash leaves the run and brief "running"/"building"; after
//     DAILY_RUN_STALE_MINUTES both are treated as abandoned and the next
//     trigger retries. A failed brief is retried by the next trigger.
// Partial failures don't lose the day: if discovery or matching fails, the
// brief is still built from the matches already stored, with a warning.

export const DAILY_RUN_STALE_MINUTES = 180;

export type DiscoveredJob = Record<string, unknown> & { jobId?: number };

export type DailyRunDeps = {
  /** The existing discovery (search plan, sources, deduplication, already-processed checks). Returns the new jobs. */
  discover: (input: { candidateProfileId: number; usingPreferences: boolean }) => Promise<{ ok: true; jobs: DiscoveredJob[]; report?: DiscoveryReport | null } | { ok: false; error: string }>;
  /** The existing matching for those jobs (bounded by the matcher itself). */
  match: (input: { candidateProfileId: number; analysis: unknown; jobs: DiscoveredJob[] }) => Promise<{ ok: true; scored: number } | { ok: false; error: string }>;
  now?: () => Date;
};

export type DailyRunResult =
  | { status: "completed"; briefId: number; briefDate: string; retry: boolean; stats: Record<string, unknown> }
  | { status: "already_ready" | "already_running"; briefId: number | null; briefDate: string }
  | { status: "no_profile"; briefDate: string }
  | { status: "failed"; briefId: number | null; briefDate: string; error: string };

const localDate = (now: Date) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

export async function runDailyAgent(db: DB, deps: DailyRunDeps, options: { candidateId?: number; trigger?: "scheduler" | "ui" } = {}): Promise<DailyRunResult> {
  const now = (deps.now ?? (() => new Date()))();
  const briefDate = localDate(now);
  const candidate = options.candidateId ? getCandidate(db, options.candidateId) : getDefaultCandidate(db);
  const profile = candidate ? getCurrentProfile(db, candidate.id) : null;
  if (!candidate || !profile) {
    console.log("daily run:", { status: "no_profile" });
    return { status: "no_profile", briefDate };
  }

  // 1. Strict lock: one daily run at a time (abandoned runs are failed first).
  failStaleRuns(db, "full", DAILY_RUN_STALE_MINUTES);
  let runId: number;
  try {
    runId = startRun(db, { kind: "full", triggeredBy: options.trigger ?? "scheduler", candidateProfileId: profile.id, params: { briefDate } }).id;
  } catch (error) {
    if (error instanceof PersistenceError && error.code === "RUN_ALREADY_ACTIVE") {
      console.log("daily run:", { status: "already_running" });
      return { status: "already_running", briefId: null, briefDate };
    }
    throw error;
  }

  // 2. Claim today's brief (or find it already done / being built).
  const claim = claimBrief(db, { candidateId: candidate.id, candidateProfileId: profile.id, briefDate, origin: "scheduled_run", staleMinutes: DAILY_RUN_STALE_MINUTES });
  if (claim.kind !== "claimed") {
    cancelRun(db, runId);
    const status = claim.kind === "already_ready" ? "already_ready" : "already_running";
    console.log("daily run:", { status, briefId: claim.brief.id });
    return { status, briefId: claim.brief.id, briefDate };
  }
  const briefId = claim.brief.id;
  touchBrief(db, briefId, { runId });
  const warnings: string[] = [];

  try {
    // 3. Discover (existing search plan, sources and deduplication).
    const usingPreferences = storedPreferences(candidate.preferences) !== null;
    let jobs: DiscoveredJob[] = [];
    let report: DiscoveryReport | null = null;
    try {
      const found = await deps.discover({ candidateProfileId: profile.id, usingPreferences });
      if (found.ok) {
        jobs = found.jobs;
        report = found.report ?? null;
        // A site that was rate limited or unavailable is never reported as a success.
        if (report) warnings.push(...sourceWarnings(report.sources));
      } else warnings.push(`discovery_failed: ${found.error}`);
    } catch (error) {
      warnings.push(`discovery_failed: ${message(error)}`);
    }
    touchBrief(db, briefId);

    // 4. Match the new jobs (the matcher bounds and records each job; failed jobs are retried next run).
    let scored = 0;
    if (jobs.length > 0) {
      try {
        const matched = await deps.match({ candidateProfileId: profile.id, analysis: profile.analysis, jobs });
        if (matched.ok) scored = matched.scored;
        else warnings.push(`matching_failed: ${matched.error}`);
      } catch (error) {
        warnings.push(`matching_failed: ${message(error)}`);
      }
    }
    touchBrief(db, briefId);

    // 5. Prioritise with the existing intelligence; "new" = not in any earlier brief.
    const dashboard = getDashboard(db, { limit: MAX_TOP_MATCHES });
    // "New" = not in an earlier brief AND found since the previous brief (or, for
    // the very first brief, found by this run). Opportunities that were already
    // seen and scored before the first brief are therefore not "new".
    const surfaced = surfacedJobIds(db, candidate.id);
    const foundThisRun = new Set(jobs.map((j) => j.jobId).filter((id): id is number => typeof id === "number"));
    const previous = getLatestReadyBrief(db, candidate.id);
    const sincePrevious = previous?.generatedAt ? parseStoredTime(previous.generatedAt) : null;
    const brief = buildDailyBrief(dashboard, getPreparationStatus(db), {
      now,
      origin: "scheduled_run",
      isNew: (m) => !surfaced.has(m.jobId) && (foundThisRun.has(m.jobId) || (sincePrevious !== null && (parseStoredTime(m.firstSeenAt) ?? 0) > sincePrevious)),
    });

    // 6. Save the brief (one transaction) and finish the run.
    const stats = {
      considered: brief.considered,
      strongMatches: brief.strongMatches,
      priorityCount: brief.priorityCount,
      items: brief.items.length,
      newInBrief: brief.items.filter((i) => i.isNew).length,
      discovered: jobs.length,
      scored,
      searchedWith: usingPreferences ? "saved_preferences" : "default_search",
      searchTerms: report?.terms ?? null,
      sources: report?.sources ?? null,
      partialSources: report ? report.sources.filter((s) => s.failed > 0 || s.skipped > 0).map((s) => s.source) : [],
      warnings,
    };
    completeBrief(
      db,
      briefId,
      brief.items.map((i) => ({ jobId: i.jobId, matchId: i.matchId, rank: i.rank, tier: i.tier, whyHere: i.whyHere, headline: i.headline, reasons: i.reasons, wasNew: i.isNew })),
      stats
    );
    completeRun(db, runId, stats);
    console.log("daily run:", { status: "completed", briefId, retry: claim.retry, items: stats.items, newInBrief: stats.newInBrief, discovered: stats.discovered, scored, warnings: warnings.length });
    return { status: "completed", briefId, briefDate, retry: claim.retry, stats };
  } catch (error) {
    const text = message(error);
    failBrief(db, briefId, text, { warnings });
    failRun(db, runId, text);
    console.error("daily run:", { status: "failed", briefId });
    return { status: "failed", briefId, briefDate, error: text };
  }
}
