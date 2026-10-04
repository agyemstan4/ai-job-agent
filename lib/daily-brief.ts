import type { Dashboard, DashboardMatch } from "./pipeline/dashboard.ts";
import type { BenefitPriority } from "./pipeline/benefits.ts";
import type { PreparationStatus } from "./pipeline/preparation-queue.ts";
import { actionFor, matchQuality, parseStoredTime } from "./dashboard-client.ts";
import { whileYouWereAway } from "./preparation-client.ts";

// The daily brief (Phase 4a): "what's worth your time today", built from data
// the app already has — scored matches, their opportunity factors, the
// preparation queue and the time of your last visit. Framework free and
// deterministic. It is produced on demand from existing results ("origin":
// "on_demand"); a future scheduled agent run can produce the same structure
// ("scheduled_run") without changing the screens.
//
// Priority is explainable and uses NO new score: each opportunity is placed in
// a named tier from existing signals, and within a tier the existing match
// score (match/v3) decides, with genuinely new opportunities first on a tie.
//   1. Your application is ready to review
//   2. Strong match + a benefit you marked important, confirmed by the advert
//   3. Strong match for the kind of work you asked for
//   4. Strong match for your experience
//   5. Worth a look (other open opportunities)

export const LAST_VISIT_KEY = "jobAgent.lastVisit";
export const VIEWED_KEY = "jobAgent.viewedOpportunities";
export const BRIEF_SIZE = 10;
export const PRIORITY_SIZE = 3;

export type BriefTier = 1 | 2 | 3 | 4 | 5;

export const TIER_TEXT: Record<BriefTier, string> = {
  1: "Your application is ready to review",
  2: "Strong match with a benefit you marked important",
  3: "Strong match for the work you're looking for",
  4: "Strong match for your experience",
  5: "Worth a look",
};

export type BriefPreparation = "not_started" | "queued" | "preparing" | "ready_for_review" | "approved" | "applied" | "failed";

export type BriefItem = {
  matchId: number;
  jobId: number;
  rank: number;
  tier: BriefTier;
  /** Why it is this high in the list (the tier, in plain words). */
  whyHere: string;
  /** One short reason it matters to you — from the opportunity factors, never invented. */
  headline: string;
  /** All the supporting reasons (✓ lines) for the full view. */
  reasons: string[];
  title: string;
  company: string;
  location: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryIsPredicted: boolean;
  score: number | null;
  quality: string;
  /** Confirmed benefits only, yours first (at most 2 on the card). */
  benefits: { id: string; label: string; priority: BenefitPriority | null }[];
  isNew: boolean;
  viewed: boolean;
  preparation: BriefPreparation;
  applicationId: number | null;
};

export type BriefAway = {
  newOpportunities: number;
  newStrong: number;
  /** New ones where a benefit you prioritised is confirmed. */
  withPrioritisedBenefits: number;
  applicationsReady: number;
  /** Preparations that finished since your last visit. */
  prepared: number;
};

export type DailyBrief = {
  /** Local date the brief is for (YYYY-MM-DD). */
  date: string;
  generatedAt: string;
  origin: "on_demand" | "scheduled_run";
  hasProfile: boolean;
  /** Opportunities your agent has scored for you. */
  considered: number;
  strongMatches: number;
  priorityCount: number;
  /** Ranked open opportunities (no duplicates), at most BRIEF_SIZE. */
  items: BriefItem[];
  lastSearchAt: string | null;
  /** What changed since your last visit, or null (first visit / nothing new). */
  away: BriefAway | null;
  /** A saved (scheduled) brief: its id, and anything that went wrong while building it. */
  savedBriefId?: number | null;
  warnings?: string[];
};

const OPEN = new Set(["prepare", "preparing", "review", "apply"]);

export function preparationOf(match: DashboardMatch, prep: PreparationStatus | null): BriefPreparation {
  const item = match.application ? prep?.items.find((i) => i.applicationId === match.application!.id) : undefined;
  if (item?.state === "queued") return "queued";
  if (item?.state === "preparing" || match.application?.status === "preparing") return "preparing";
  switch (match.application?.status) {
    case "ready_for_review": return "ready_for_review";
    case "approved": return "approved";
    case "submitted":
    case "acknowledged":
    case "interviewing":
    case "offer": return "applied";
    case "preparation_failed": return "failed";
    default: return "not_started";
  }
}

function tierOf(match: DashboardMatch, preparation: BriefPreparation, strong: number): BriefTier {
  if (preparation === "ready_for_review") return 1;
  const isStrong = match.score !== null && match.score >= strong;
  if (isStrong && match.preferenceFit.some((p) => p.status === "confirmed" && p.priority === "important")) return 2;
  if (isStrong && match.opportunity.roleFit.status === "match") return 3;
  if (isStrong) return 4;
  return 5;
}

function headlineOf(match: DashboardMatch, tier: BriefTier): string {
  if (tier === 1) return "Your application is ready to review";
  const benefit = match.standsOut.find((r) => /matches? (an important preference|one of your nice-to-haves)$/.test(r));
  return benefit ?? match.standsOut[0] ?? (tier <= 4 ? "Strong match for your experience" : "Matches your CV");
}

const localDate = (now: Date) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/** Builds today's brief. Never invents data: every field comes from the dashboard and queue. */
export function buildDailyBrief(
  dashboard: Dashboard,
  prep: PreparationStatus | null,
  options: {
    now?: Date;
    lastVisit?: number | null;
    viewed?: ReadonlySet<number>;
    origin?: DailyBrief["origin"];
    /** Overrides "new" (a scheduled brief: not in any earlier brief). Default: found after the last visit. */
    isNew?: (match: DashboardMatch) => boolean;
  } = {}
): DailyBrief {
  const now = options.now ?? new Date();
  const lastVisit = options.lastVisit ?? null;
  const viewed = options.viewed ?? new Set<number>();
  const strong = dashboard.strongMatchScore;
  const isNew = options.isNew ?? ((m: DashboardMatch) => lastVisit !== null && (parseStoredTime(m.firstSeenAt) ?? 0) > lastVisit);

  const seenJobs = new Set<number>();
  const ranked = dashboard.topMatches
    .filter((m) => OPEN.has(actionFor(m)))
    .filter((m) => (seenJobs.has(m.jobId) ? false : (seenJobs.add(m.jobId), true)))
    .map((m) => {
      const preparation = preparationOf(m, prep);
      const tier = tierOf(m, preparation, strong);
      return { m, preparation, tier, fresh: isNew(m) };
    })
    .sort((a, b) => a.tier - b.tier || (b.m.score ?? -1) - (a.m.score ?? -1) || Number(b.fresh) - Number(a.fresh) || a.m.matchId - b.m.matchId)
    .slice(0, BRIEF_SIZE);

  const items: BriefItem[] = ranked.map(({ m, preparation, tier, fresh }, index) => ({
    matchId: m.matchId,
    jobId: m.jobId,
    rank: index + 1,
    tier,
    whyHere: TIER_TEXT[tier],
    headline: headlineOf(m, tier),
    reasons: m.standsOut,
    title: m.title,
    company: m.company,
    location: m.location,
    salaryMin: m.salaryMin,
    salaryMax: m.salaryMax,
    salaryIsPredicted: m.salaryIsPredicted,
    score: m.score,
    quality: matchQuality(m.score, strong),
    benefits: m.benefits.filter((b) => b.status === "confirmed").slice(0, 2).map((b) => ({ id: b.id, label: b.label, priority: b.priority })),
    isNew: fresh,
    viewed: viewed.has(m.matchId),
    preparation,
    applicationId: m.application?.id ?? null,
  }));

  let away: BriefAway | null = null;
  if (lastVisit !== null) {
    const fresh = dashboard.topMatches.filter(isNew);
    const prepared = whileYouWereAway(prep, lastVisit)?.finished ?? 0;
    const counts: BriefAway = {
      newOpportunities: fresh.length,
      newStrong: fresh.filter((m) => m.score !== null && m.score >= strong).length,
      withPrioritisedBenefits: fresh.filter((m) => m.preferenceFit.some((p) => p.status === "confirmed")).length,
      applicationsReady: dashboard.stats.needsReview,
      prepared,
    };
    away = counts.newOpportunities + counts.prepared > 0 ? counts : null;
  }

  return {
    date: localDate(now),
    generatedAt: now.toISOString(),
    origin: options.origin ?? "on_demand",
    hasProfile: dashboard.hasProfile,
    considered: dashboard.stats.scoredMatches,
    strongMatches: dashboard.stats.strongMatches,
    priorityCount: Math.min(PRIORITY_SIZE, items.length),
    items,
    lastSearchAt: dashboard.agent.lastDiscoveryAt,
    away,
  };
}

/** The plain sentences for "While you were away" (only non-zero facts). */
export function awayLines(away: BriefAway): string[] {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  return [
    away.newOpportunities > 0 ? n(away.newOpportunities, "new opportunity", "new opportunities") : null,
    away.newStrong > 0 ? n(away.newStrong, "strong match", "strong matches") : null,
    away.withPrioritisedBenefits > 0 ? `${away.withPrioritisedBenefits} with benefits you prioritised` : null,
    away.prepared > 0 ? n(away.prepared, "application prepared", "applications prepared") : null,
    away.applicationsReady > 0 ? `${n(away.applicationsReady, "application", "applications")} ready for review` : null,
  ].filter((x): x is string => Boolean(x));
}

/** Viewed opportunities (this device), from localStorage; any problem → none. */
export function readViewed(storage: Pick<Storage, "getItem"> | null): Set<number> {
  try {
    const raw = JSON.parse(storage?.getItem(VIEWED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is number => Number.isInteger(x)) : []);
  } catch {
    return new Set();
  }
}

export function markViewed(storage: Pick<Storage, "getItem" | "setItem"> | null, matchId: number): void {
  try {
    const ids = [...readViewed(storage), matchId].slice(-500);
    storage?.setItem(VIEWED_KEY, JSON.stringify([...new Set(ids)]));
  } catch {
    // Storage unavailable (private mode): viewing still works, it just isn't remembered.
  }
}
