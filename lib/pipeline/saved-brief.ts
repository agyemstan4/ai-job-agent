import type { DB } from "../repositories/shared.ts";
import { getDefaultCandidate } from "../repositories/candidates.ts";
import { getBrief, getBriefItems, getOpportunityStates, recordOpportunityEvent } from "../repositories/briefs.ts";
import type { SavedBrief } from "../repositories/briefs.ts";
import { getDashboard, MAX_TOP_MATCHES } from "./dashboard.ts";
import { getPreparationStatus } from "./preparation-queue.ts";
import { matchQuality } from "../dashboard-client.ts";
import { preparationOf, PRIORITY_SIZE } from "../daily-brief.ts";
import type { BriefItem, BriefTier, DailyBrief } from "../daily-brief.ts";

// Reading a saved daily brief for Today (Phase 4b). The saved items keep the
// ranking snapshot (rank, tier, why, headline, was it new); everything else —
// title, salary, confirmed benefits, application status — is read live, so a
// job you prepared or applied for since the run shows its current state.
// Read only, apart from the explicit seen/reviewed events below.

export type SavedBriefView = { brief: DailyBrief | null; status: SavedBrief["status"] | null; briefDate: string };

const localDate = (now: Date) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/** Today's saved brief for the default candidate, composed with live data (null when none is ready). */
export function getTodaysSavedBrief(db: DB, now: Date = new Date()): SavedBriefView {
  const briefDate = localDate(now);
  const candidate = getDefaultCandidate(db);
  const saved = candidate ? getBrief(db, candidate.id, briefDate) : null;
  if (!candidate || !saved || saved.status !== "ready") return { brief: null, status: saved?.status ?? null, briefDate };

  const dashboard = getDashboard(db, { limit: MAX_TOP_MATCHES });
  const prep = getPreparationStatus(db);
  const byMatch = new Map(dashboard.topMatches.map((m) => [m.matchId, m]));
  const savedItems = getBriefItems(db, saved.id);
  const states = getOpportunityStates(db, candidate.id, savedItems.map((i) => i.jobId));

  const items: BriefItem[] = [];
  for (const s of savedItems) {
    const m = s.matchId !== null ? byMatch.get(s.matchId) : undefined;
    if (!m) continue; // no longer among your current matches (e.g. a new CV profile)
    items.push({
      matchId: m.matchId,
      jobId: m.jobId,
      rank: items.length + 1,
      tier: s.tier as BriefTier,
      whyHere: s.whyHere,
      headline: s.headline,
      reasons: s.reasons,
      title: m.title,
      company: m.company,
      location: m.location,
      salaryMin: m.salaryMin,
      salaryMax: m.salaryMax,
      salaryIsPredicted: m.salaryIsPredicted,
      score: m.score,
      quality: matchQuality(m.score, dashboard.strongMatchScore),
      benefits: m.benefits.filter((b) => b.status === "confirmed").slice(0, 2).map((b) => ({ id: b.id, label: b.label, priority: b.priority })),
      isNew: s.wasNew,
      viewed: Boolean(states.get(m.jobId)?.seenAt),
      preparation: preparationOf(m, prep),
      applicationId: m.application?.id ?? null,
    });
  }

  const stats = (saved.stats ?? {}) as { considered?: number; strongMatches?: number; warnings?: string[] };
  const fresh = items.filter((i) => i.isNew);
  const away = {
    newOpportunities: fresh.length,
    newStrong: fresh.filter((i) => i.score !== null && i.score >= dashboard.strongMatchScore).length,
    withPrioritisedBenefits: fresh.filter((i) => byMatch.get(i.matchId)?.preferenceFit.some((p) => p.status === "confirmed")).length,
    applicationsReady: dashboard.stats.needsReview,
    prepared: 0,
  };
  return {
    status: saved.status,
    briefDate,
    brief: {
      date: saved.briefDate,
      generatedAt: `${(saved.generatedAt ?? saved.updatedAt).replace(" ", "T")}Z`,
      origin: saved.origin,
      hasProfile: dashboard.hasProfile,
      considered: stats.considered ?? dashboard.stats.scoredMatches,
      strongMatches: stats.strongMatches ?? dashboard.stats.strongMatches,
      priorityCount: Math.min(PRIORITY_SIZE, items.length),
      items,
      lastSearchAt: dashboard.agent.lastDiscoveryAt,
      away: away.newOpportunities + away.applicationsReady > 0 ? away : null,
      savedBriefId: saved.id,
      warnings: (stats.warnings ?? []).map((w) => (w.startsWith("discovery_failed") ? "Some job sites couldn't be reached during the last run." : "Some new jobs couldn't be checked yet — your agent will try again.")),
    },
  };
}

/** Seen / reviewed for the default candidate (from the opportunity view). */
export function recordDefaultCandidateEvent(db: DB, jobId: number, event: "seen" | "reviewed"): boolean {
  const candidate = getDefaultCandidate(db);
  if (!candidate || !Number.isInteger(jobId) || jobId <= 0) return false;
  const exists = db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(jobId);
  if (!exists) return false;
  recordOpportunityEvent(db, candidate.id, jobId, event);
  return true;
}
