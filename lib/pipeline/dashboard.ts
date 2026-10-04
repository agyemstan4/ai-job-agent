import type { DB } from "../repositories/shared.ts";
import { fromJson } from "../repositories/shared.ts";
import { getCurrentProfile, getDefaultCandidate } from "../repositories/candidates.ts";
import type { ApplicationStatus } from "../repositories/applications.ts";
import { DEFAULT_SEARCH_TERMS, searchPlan, storedPreferences } from "./preferences.ts";
import type { SearchPreferences } from "./preferences.ts";
import { getBestDescription } from "../repositories/jobs.ts";
import { BENEFITS, benefitHighlights, detectBenefits } from "./benefits.ts";
import type { BenefitHighlight, BenefitId, BenefitPreferences, BenefitPriority, BenefitStatus } from "./benefits.ts";
import { opportunityFactors, opportunityReasons } from "./opportunity.ts";
import type { OpportunityFactors } from "./opportunity.ts";

// Phase 3 checkpoint 3c: the Command Centre data (GET /api/dashboard), read
// only. Stats and the strongest current matches for the current CV profile,
// with the job's details and any application already prepared for it.
// Everything here is existing stored data — nothing is estimated or invented.

export const STRONG_MATCH_SCORE = 70;
export const DEFAULT_TOP_MATCHES = 20;
export const MAX_TOP_MATCHES = 50;

export type MatchBreakdown = {
  technicalSkills: number | null;
  experienceLevel: number | null;
  projects: number | null;
  growthPotential: number | null;
};

export type DashboardMatch = {
  matchId: number;
  jobId: number;
  score: number | null;
  title: string;
  company: string;
  location: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryIsPredicted: boolean;
  /** Adzuna's contract time ("full_time", "part_time") when known. */
  contractTime: string | null;
  /** "permanent" or "contract" when known. */
  contractType: string | null;
  url: string | null;
  sources: string[];
  reason: string | null;
  strengths: string[];
  missingSkills: string[];
  breakdown: MatchBreakdown | null;
  postedAt: string | null;
  /** When this job was first discovered. */
  firstSeenAt: string;
  /** When this match was last scored. */
  matchedAt: string;
  promptVersion: string | null;
  application: { id: number; status: ApplicationStatus } | null;
  /** Benefits stated in the advert (confirmed), plus unclear mentions of ones you care about. */
  benefits: BenefitHighlight[];
  /** What the advert asks of you, e.g. "Own vehicle needed". */
  requirements: string[];
  /** Evidence-based reasons this job fits what you asked for (may be empty). */
  standsOut: string[];
  /** Each benefit you care about and what this advert says about it ("not_stated" is not "not provided"). */
  preferenceFit: PreferenceFit[];
  /** One plain sentence when confirmed benefits match your preferences, else null. */
  benefitSummary: string | null;
  /** Things worth checking, stated plainly (unclear benefits, missing salary, incomplete location…). */
  cautions: string[];
  /** The structured, explainable factors behind standsOut and cautions (opportunity.ts). */
  opportunity: OpportunityFactors;
};

export type PreferenceFit = {
  id: BenefitId;
  label: string;
  priority: BenefitPriority;
  status: BenefitStatus;
  evidence: string | null;
};

export type Dashboard = {
  hasProfile: boolean;
  /** The candidate's first name, for the greeting (null if unknown). */
  firstName: string | null;
  /** What job discovery searches for: saved preferences, or the defaults. */
  search: {
    usingPreferences: boolean;
    location: string;
    terms: string[];
    /** The chosen kinds of work, in plain language. */
    roles: string[];
    minSalary: number | null;
    benefits: BenefitPreferences;
  };
  /** When the agent last finished a search and a matching run. */
  agent: { lastDiscoveryAt: string | null; lastMatchingAt: string | null };
  stats: {
    discoveredJobs: number;
    scoredMatches: number;
    strongMatches: number;
    /** Strong matches scored today (server's local date). */
    strongToday: number;
    preparing: number;
    needsReview: number;
    readyToApply: number;
    submitted: number;
    /** Every application by status (the existing state machine's statuses). */
    applicationsByStatus: Partial<Record<ApplicationStatus, number>>;
  };
  strongMatchScore: number;
  topMatches: DashboardMatch[];
};

const n = (db: DB, sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;

const asStrings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .map((item) => (typeof item === "string" ? item : typeof (item as { skill?: unknown })?.skill === "string" ? (item as { skill: string }).skill : null))
        .filter((s): s is string => Boolean(s && s.trim()))
    : [];

const scoreOrNull = (value: unknown): number | null => {
  const v = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(v) ? null : Math.round(v);
};

function asBreakdown(value: unknown): MatchBreakdown | null {
  if (!value || typeof value !== "object") return null;
  const b = value as Record<string, unknown>;
  const result = {
    technicalSkills: scoreOrNull(b.technicalSkills),
    experienceLevel: scoreOrNull(b.experienceLevel),
    projects: scoreOrNull(b.projects),
    growthPotential: scoreOrNull(b.growthPotential),
  };
  return Object.values(result).some((v) => v !== null) ? result : null;
}

function lastFinished(db: DB, kind: string): string | null {
  const row = db
    .prepare("SELECT finished_at FROM pipeline_runs WHERE kind = ? AND status = 'completed' ORDER BY finished_at DESC LIMIT 1")
    .get(kind) as { finished_at: string | null } | undefined;
  return row?.finished_at ?? null;
}

export function getDashboard(db: DB, options: { limit?: unknown } = {}): Dashboard {
  const limit =
    typeof options.limit === "number" && Number.isInteger(options.limit) && options.limit > 0
      ? Math.min(options.limit, MAX_TOP_MATCHES)
      : DEFAULT_TOP_MATCHES;

  const candidate = getDefaultCandidate(db);
  const profile = candidate ? getCurrentProfile(db, candidate.id) : null;
  const preferences = storedPreferences(candidate?.preferences ?? null);
  const firstName = candidate?.fullName?.trim().split(/\s+/)[0] || null;

  const byStatus = db.prepare("SELECT status, COUNT(*) n FROM applications GROUP BY status").all() as { status: ApplicationStatus; n: number }[];

  const stats = {
    discoveredJobs: n(db, "SELECT COUNT(*) n FROM jobs"),
    scoredMatches: profile ? n(db, "SELECT COUNT(*) n FROM matches WHERE candidate_profile_id = ? AND outcome = 'scored'", profile.id) : 0,
    strongMatches: profile
      ? n(db, "SELECT COUNT(*) n FROM matches WHERE candidate_profile_id = ? AND outcome = 'scored' AND score >= ?", profile.id, STRONG_MATCH_SCORE)
      : 0,
    strongToday: profile
      ? n(
          db,
          `SELECT COUNT(*) n FROM matches WHERE candidate_profile_id = ? AND outcome = 'scored' AND score >= ?
             AND date(updated_at, 'localtime') = date('now', 'localtime')`,
          profile.id,
          STRONG_MATCH_SCORE
        )
      : 0,
    preparing: n(db, "SELECT COUNT(*) n FROM applications WHERE status = 'preparing'"),
    needsReview: n(db, "SELECT COUNT(*) n FROM applications WHERE status = 'ready_for_review'"),
    readyToApply: n(db, "SELECT COUNT(*) n FROM applications WHERE status = 'approved'"),
    submitted: n(db, "SELECT COUNT(*) n FROM applications WHERE submitted_at IS NOT NULL"),
    applicationsByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])) as Partial<Record<ApplicationStatus, number>>,
  };

  const base = {
    firstName,
    search: preferences
      ? (() => {
          const plan = searchPlan(preferences, {});
          return { usingPreferences: true, location: preferences.location, terms: plan.terms, roles: plan.roleLabels, minSalary: preferences.minSalary, benefits: preferences.benefits };
        })()
      : { usingPreferences: false, location: "London", terms: DEFAULT_SEARCH_TERMS, roles: [], minSalary: null, benefits: {} },
    agent: { lastDiscoveryAt: lastFinished(db, "discovery"), lastMatchingAt: lastFinished(db, "matching") },
    stats,
    strongMatchScore: STRONG_MATCH_SCORE,
  };

  if (!profile) return { hasProfile: false, ...base, topMatches: [] };

  const rows = db
    .prepare(
      `SELECT m.id AS match_id, m.job_id, m.score, m.reason, m.strengths_json, m.missing_skills_json, m.breakdown_json,
              m.prompt_version, m.updated_at AS matched_at,
              j.title, j.company, j.location, j.salary_min, j.salary_max, j.salary_is_predicted, j.posted_at,
              j.contract_time, j.contract_type, j.first_seen_at,
              (SELECT url FROM job_listings l WHERE l.job_id = j.id AND l.url IS NOT NULL AND l.url <> ''
                 ORDER BY l.last_seen_at DESC, l.id DESC LIMIT 1) AS url,
              (SELECT GROUP_CONCAT(DISTINCT l.source_id) FROM job_listings l WHERE l.job_id = j.id) AS sources,
              (SELECT a.id FROM applications a WHERE a.job_id = j.id ORDER BY a.id DESC LIMIT 1) AS application_id,
              (SELECT a.status FROM applications a WHERE a.job_id = j.id ORDER BY a.id DESC LIMIT 1) AS application_status
       FROM matches m JOIN jobs j ON j.id = m.job_id
       WHERE m.candidate_profile_id = ? AND m.outcome = 'scored'
       ORDER BY m.score IS NULL, m.score DESC, m.id DESC
       LIMIT ?`
    )
    .all(profile.id, limit) as Record<string, unknown>[];

  const topMatches: DashboardMatch[] = rows.map((r) => ({
    matchId: r.match_id as number,
    jobId: r.job_id as number,
    score: (r.score as number | null) ?? null,
    title: r.title as string,
    company: r.company as string,
    location: (r.location as string | null) ?? null,
    salaryMin: (r.salary_min as number | null) ?? null,
    salaryMax: (r.salary_max as number | null) ?? null,
    salaryIsPredicted: r.salary_is_predicted === 1,
    contractTime: (r.contract_time as string | null) ?? null,
    contractType: (r.contract_type as string | null) ?? null,
    url: (r.url as string | null) ?? null,
    sources: typeof r.sources === "string" ? r.sources.split(",").sort() : [],
    reason: (r.reason as string | null) ?? null,
    strengths: asStrings(fromJson(r.strengths_json as string | null)),
    missingSkills: asStrings(fromJson(r.missing_skills_json as string | null)).slice(0, 5),
    breakdown: asBreakdown(fromJson(r.breakdown_json as string | null)),
    postedAt: (r.posted_at as string | null) ?? null,
    firstSeenAt: r.first_seen_at as string,
    matchedAt: r.matched_at as string,
    promptVersion: (r.prompt_version as string | null) ?? null,
    application:
      typeof r.application_id === "number"
        ? { id: r.application_id, status: r.application_status as ApplicationStatus }
        : null,
    ...benefitView(db, r, preferences),
  }));

  return { hasProfile: true, ...base, topMatches };
}

const REQUIREMENT_LABELS = { ownVehicle: "Own vehicle needed", drivingLicence: "Driving licence needed", travel: "Travel required" } as const;

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** "A", "A and b", "A, b and c". */
function joinLabels(labels: string[]): string {
  const [first, ...rest] = labels;
  if (rest.length === 0) return first;
  const tail = rest.map(lowerFirst);
  return `${first}${tail.length > 1 ? ", " + tail.slice(0, -1).join(", ") : ""} and ${tail[tail.length - 1]}`;
}

/** The sentence for the featured job, from confirmed benefits that match your preferences only. */
export function benefitSummaryFor(fit: PreferenceFit[]): string | null {
  const important = fit.filter((p) => p.status === "confirmed" && p.priority === "important").map((p) => p.label);
  const nice = fit.filter((p) => p.status === "confirmed" && p.priority === "preferred").map((p) => p.label);
  if (important.length > 0) {
    const n = important.length;
    return `${joinLabels(important)} ${n === 1 ? "matches one" : `match ${NUMBER_WORDS[n] ?? n}`} of your important preferences.`;
  }
  if (nice.length > 0) {
    return `${joinLabels(nice)} ${nice.length === 1 ? "is" : "are"} on your nice-to-have list.`;
  }
  return null;
}

const LABELS = new Map(BENEFITS.map((b) => [b.id as BenefitId, b.label]));

/**
 * Benefits and fit reasons for one match, from the advert's own stored text
 * (deterministic, no model calls). Only what the text supports is claimed.
 */
function benefitView(
  db: DB,
  r: Record<string, unknown>,
  preferences: SearchPreferences | null
): Pick<DashboardMatch, "benefits" | "requirements" | "standsOut" | "preferenceFit" | "benefitSummary" | "cautions" | "opportunity"> {
  const title = r.title as string;
  const description = getBestDescription(db, r.job_id as number);
  const report = detectBenefits({ title, description: description?.content ?? "" });
  const benefits = benefitHighlights(report, preferences?.benefits ?? {});
  const requirements = (Object.keys(REQUIREMENT_LABELS) as (keyof typeof REQUIREMENT_LABELS)[])
    .filter((id) => report.requirements[id].present)
    .map((id) => REQUIREMENT_LABELS[id]);

  // Your benefits, important first, each with what the advert says.
  const preferenceFit: PreferenceFit[] = (Object.entries(preferences?.benefits ?? {}) as [BenefitId, BenefitPriority][])
    .sort(([, a], [, b]) => (a === b ? 0 : a === "important" ? -1 : 1))
    .map(([id, priority]) => ({ id, label: LABELS.get(id) ?? id, priority, status: report.benefits[id].status, evidence: report.benefits[id].evidence }));

  // Why this job is relevant to you, and what to check (deterministic; see opportunity.ts).
  const opportunity = opportunityFactors(
    {
      title,
      location: (r.location as string | null) ?? null,
      salaryMin: (r.salary_min as number | null) ?? null,
      salaryMax: (r.salary_max as number | null) ?? null,
      salaryIsPredicted: r.salary_is_predicted === 1,
    },
    report,
    preferences,
    description ? { kind: description.kind as "snippet" | "full", chars: description.content.length } : null
  );
  const reasons = opportunityReasons(opportunity);
  const standsOut = preferences ? reasons.filter((x) => x.kind === "positive").map((x) => x.text) : [];
  const cautions = reasons.filter((x) => x.kind === "caution").map((x) => x.text);
  return { benefits, requirements, standsOut, preferenceFit, benefitSummary: benefitSummaryFor(preferenceFit), cautions, opportunity };
}
