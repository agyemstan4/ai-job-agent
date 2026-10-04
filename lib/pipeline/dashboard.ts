import type { DB } from "../repositories/shared.ts";
import { fromJson } from "../repositories/shared.ts";
import { getCurrentProfile, getDefaultCandidate } from "../repositories/candidates.ts";
import type { ApplicationStatus } from "../repositories/applications.ts";

// Phase 3 checkpoint 3c: the Command Centre data (GET /api/dashboard), read
// only. Stats and the strongest current matches for the current CV profile,
// with the job's details and any application already prepared for it.

export const STRONG_MATCH_SCORE = 70;
export const DEFAULT_TOP_MATCHES = 20;
export const MAX_TOP_MATCHES = 50;

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
  url: string | null;
  sources: string[];
  reason: string | null;
  strengths: string[];
  missingSkills: string[];
  postedAt: string | null;
  promptVersion: string | null;
  application: { id: number; status: ApplicationStatus } | null;
};

export type Dashboard = {
  hasProfile: boolean;
  stats: {
    discoveredJobs: number;
    scoredMatches: number;
    strongMatches: number;
    preparing: number;
    needsReview: number;
    readyToApply: number;
    submitted: number;
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

export function getDashboard(db: DB, options: { limit?: unknown } = {}): Dashboard {
  const limit =
    typeof options.limit === "number" && Number.isInteger(options.limit) && options.limit > 0
      ? Math.min(options.limit, MAX_TOP_MATCHES)
      : DEFAULT_TOP_MATCHES;

  const candidate = getDefaultCandidate(db);
  const profile = candidate ? getCurrentProfile(db, candidate.id) : null;

  const stats = {
    discoveredJobs: n(db, "SELECT COUNT(*) n FROM jobs"),
    scoredMatches: profile ? n(db, "SELECT COUNT(*) n FROM matches WHERE candidate_profile_id = ? AND outcome = 'scored'", profile.id) : 0,
    strongMatches: profile
      ? n(db, "SELECT COUNT(*) n FROM matches WHERE candidate_profile_id = ? AND outcome = 'scored' AND score >= ?", profile.id, STRONG_MATCH_SCORE)
      : 0,
    preparing: n(db, "SELECT COUNT(*) n FROM applications WHERE status = 'preparing'"),
    needsReview: n(db, "SELECT COUNT(*) n FROM applications WHERE status = 'ready_for_review'"),
    readyToApply: n(db, "SELECT COUNT(*) n FROM applications WHERE status = 'approved'"),
    submitted: n(db, "SELECT COUNT(*) n FROM applications WHERE submitted_at IS NOT NULL"),
  };

  if (!profile) return { hasProfile: false, stats, strongMatchScore: STRONG_MATCH_SCORE, topMatches: [] };

  const rows = db
    .prepare(
      `SELECT m.id AS match_id, m.job_id, m.score, m.reason, m.strengths_json, m.missing_skills_json, m.prompt_version,
              j.title, j.company, j.location, j.salary_min, j.salary_max, j.salary_is_predicted, j.posted_at,
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
    url: (r.url as string | null) ?? null,
    sources: typeof r.sources === "string" ? r.sources.split(",").sort() : [],
    reason: (r.reason as string | null) ?? null,
    strengths: asStrings(fromJson(r.strengths_json as string | null)),
    missingSkills: asStrings(fromJson(r.missing_skills_json as string | null)).slice(0, 5),
    postedAt: (r.posted_at as string | null) ?? null,
    promptVersion: (r.prompt_version as string | null) ?? null,
    application:
      typeof r.application_id === "number"
        ? { id: r.application_id, status: r.application_status as ApplicationStatus }
        : null,
  }));

  return { hasProfile: true, stats, strongMatchScore: STRONG_MATCH_SCORE, topMatches };
}
