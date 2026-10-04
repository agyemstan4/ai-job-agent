import type { Dashboard, DashboardMatch } from "./pipeline/dashboard.ts";

// Client-side helpers for the Command Centre on / (Phase 3 checkpoint 3c).
// Framework free, so they can be tested directly. They only read
// GET /api/dashboard and ask POST /api/applications/prepare to prepare ONE
// job: nothing here approves, submits or emails anything.

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const UNREACHABLE = "Could not reach the Job Agent. Check that it is still running, then try again.";
const gbp = (value: number) => `£${Math.round(value).toLocaleString("en-GB")}`;

/** "£30,000–£38,000", "£35,000 (estimated)", "£350–£400 a day", or null when unknown. */
export function formatSalary(min: number | null, max: number | null, predicted = false): string | null {
  const values = [min, max].filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
  if (values.length === 0) return null;
  const lo = Math.min(...values), hi = Math.max(...values);
  const range = lo === hi ? gbp(lo) : `${gbp(lo)}–${gbp(hi)}`;
  if (hi < 1000) return `${range} a day`;
  return predicted ? `${range} (estimated)` : range;
}

export type ScoreBadge = { label: string; className: string };

export function scoreBadge(score: number | null, strong = 70): ScoreBadge {
  if (score === null) return { label: "Not scored", className: "bg-gray-100 text-gray-600" };
  if (score >= 85) return { label: "Excellent", className: "bg-emerald-100 text-emerald-800" };
  if (score >= strong) return { label: "Strong", className: "bg-green-100 text-green-800" };
  if (score >= 50) return { label: "Possible", className: "bg-amber-100 text-amber-800" };
  return { label: "Weak", className: "bg-red-100 text-red-700" };
}

export type MatchAction = "prepare" | "preparing" | "review" | "apply" | "track";

const FREE_AGAIN = new Set(["preparation_failed", "rejected", "withdrawn", "unsuccessful"]);

/** What the match card offers, from the job's latest application. */
export function actionFor(match: Pick<DashboardMatch, "application">): MatchAction {
  const status = match.application?.status;
  if (!status || FREE_AGAIN.has(status)) return "prepare";
  if (status === "preparing") return "preparing";
  if (status === "ready_for_review") return "review";
  if (status === "approved") return "apply";
  return "track";
}

export type LoadResult = { kind: "loaded"; dashboard: Dashboard } | { kind: "error"; message: string };

export async function loadDashboard(fetchImpl: FetchLike = fetch): Promise<LoadResult> {
  let response: Response;
  try {
    response = await fetchImpl("/api/dashboard");
  } catch {
    return { kind: "error", message: UNREACHABLE };
  }
  const body = (await response.json().catch(() => null)) as (Dashboard & { error?: string }) | null;
  if (!response.ok || !body || !body.stats) {
    return { kind: "error", message: body?.error ?? `Something went wrong (HTTP ${response.status}). Please try again.` };
  }
  return { kind: "loaded", dashboard: body };
}

export type PrepareResult =
  | { kind: "prepared"; applicationId: number; warnings: string[] }
  | { kind: "exists"; applicationId: number; status: string }
  | { kind: "busy"; applicationId: number | null; message: string }
  | { kind: "error"; message: string };

/** Asks the server to prepare one match (several minutes on CPU). */
export async function requestPreparation(matchId: number, fetchImpl: FetchLike = fetch): Promise<PrepareResult> {
  let response: Response;
  try {
    response = await fetchImpl("/api/applications/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchId }),
    });
  } catch {
    return { kind: "error", message: UNREACHABLE };
  }
  const body = (await response.json().catch(() => null)) as {
    applicationId?: number; applicationStatus?: string; alreadyPrepared?: boolean; warnings?: string[]; error?: string;
  } | null;
  if (response.status === 201 && typeof body?.applicationId === "number") {
    return { kind: "prepared", applicationId: body.applicationId, warnings: body.warnings ?? [] };
  }
  if (response.status === 200 && typeof body?.applicationId === "number") {
    return { kind: "exists", applicationId: body.applicationId, status: body.applicationStatus ?? "" };
  }
  if (response.status === 409) {
    return { kind: "busy", applicationId: body?.applicationId ?? null, message: body?.error ?? "This job can't be prepared right now." };
  }
  return { kind: "error", message: body?.error ?? `Something went wrong (HTTP ${response.status}). Please try again.` };
}

// ── Command Centre v2 helpers (presentation only; existing data, nothing invented) ──

/** "Good morning" / "Good afternoon" / "Good evening" for a local hour (0–23). */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}

export type Tone = "green" | "blue" | "amber" | "red" | "gray" | "violet";

/** The application's state from the existing state machine, as a label and a colour tone. */
export function statusInfo(status: string | null | undefined): { label: string; tone: Tone } | null {
  switch (status) {
    case undefined:
    case null:
      return null;
    case "preparing": return { label: "Preparing", tone: "blue" };
    case "preparation_failed": return { label: "Preparation failed", tone: "red" };
    case "ready_for_review": return { label: "Ready for review", tone: "violet" };
    case "approved": return { label: "Approved · ready to apply", tone: "green" };
    case "rejected": return { label: "Rejected by you", tone: "gray" };
    case "submitting": return { label: "Submitting", tone: "blue" };
    case "submission_failed": return { label: "Submission failed", tone: "red" };
    case "submitted": return { label: "Applied", tone: "green" };
    case "acknowledged": return { label: "Acknowledged", tone: "green" };
    case "interviewing": return { label: "Interviewing", tone: "violet" };
    case "offer": return { label: "Offer", tone: "green" };
    case "unsuccessful": return { label: "Unsuccessful", tone: "gray" };
    case "withdrawn": return { label: "Withdrawn", tone: "gray" };
    default: return { label: status.replace(/_/g, " "), tone: "gray" };
  }
}

/** "Full-time · Permanent", "Contract", or null when the job doesn't say. */
export function workArrangement(contractTime: string | null, contractType: string | null): string | null {
  const time = contractTime === "full_time" ? "Full-time" : contractTime === "part_time" ? "Part-time" : null;
  const type = contractType === "permanent" ? "Permanent" : contractType === "contract" ? "Contract" : null;
  const parts = [time, type].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export function sourceLabel(sources: string[]): string | null {
  const names = sources.map((s) => (s === "adzuna" ? "Adzuna" : s === "reed" ? "Reed" : s));
  return names.length ? names.join(" + ") : null;
}

/** Parses SQLite ("2026-10-03 02:24:07", UTC) and ISO timestamps. */
export function parseStoredTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago". */
export function timeAgo(value: string | null | undefined, now = Date.now()): string | null {
  const t = parseStoredTime(value);
  if (t === null) return null;
  const minutes = Math.max(0, Math.round((now - t) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** The featured opportunity: the strongest match still worth acting on (not applied or closed). */
export function pickFeatured<T extends Pick<DashboardMatch, "score" | "application">>(matches: T[]): T | null {
  const open = matches.find((m) => m.score !== null && ["prepare", "preparing", "review", "apply"].includes(actionFor(m)));
  return open ?? null;
}

export type FeedView = "all" | "strong" | "todo" | "in_progress";

export const FEED_VIEWS: { key: FeedView; label: string }[] = [
  { key: "all", label: "All matches" },
  { key: "strong", label: "Strong" },
  { key: "todo", label: "Not started" },
  { key: "in_progress", label: "In progress" },
];

/** Client-side feed filter: a view plus free text over title, company, location and skills. */
export function filterMatches<T extends DashboardMatch>(matches: T[], view: FeedView, query: string, strong = 70): T[] {
  const q = query.trim().toLowerCase();
  return matches.filter((m) => {
    const action = actionFor(m);
    if (view === "strong" && !(m.score !== null && m.score >= strong)) return false;
    if (view === "todo" && action !== "prepare") return false;
    if (view === "in_progress" && !["preparing", "review", "apply"].includes(action)) return false;
    if (!q) return true;
    return [m.title, m.company, m.location ?? "", ...m.strengths, ...m.missingSkills].some((text) => text.toLowerCase().includes(q));
  });
}

/** Matches whose job was first discovered after the previous visit (none on a first visit). */
export function newSinceLastVisit<T extends Pick<DashboardMatch, "firstSeenAt">>(matches: T[], lastVisit: number | null): T[] {
  if (lastVisit === null) return [];
  return matches.filter((m) => (parseStoredTime(m.firstSeenAt) ?? 0) > lastVisit);
}

/** Application progress groups (only non-zero ones are shown). */
export function progressGroups(byStatus: Partial<Record<string, number>>): { key: string; label: string; count: number; tone: Tone }[] {
  const sum = (...keys: string[]) => keys.reduce((total, k) => total + (byStatus[k] ?? 0), 0);
  return [
    { key: "preparing", label: "Preparing", count: sum("preparing"), tone: "blue" as Tone },
    { key: "review", label: "To review", count: sum("ready_for_review"), tone: "violet" as Tone },
    { key: "approved", label: "Ready to apply", count: sum("approved"), tone: "green" as Tone },
    { key: "applied", label: "Applied", count: sum("submitted", "acknowledged"), tone: "green" as Tone },
    { key: "interviewing", label: "Interviewing", count: sum("interviewing"), tone: "violet" as Tone },
    { key: "offer", label: "Offers", count: sum("offer"), tone: "green" as Tone },
  ].filter((g) => g.count > 0);
}

// ── Guidance helpers (usability pass): built only from loaded data ──

/** "85% · Excellent match" style label text (never colour alone). */
export function matchQuality(score: number | null, strong = 70): string {
  const { label } = scoreBadge(score, strong);
  return score === null ? label : `${label} match`;
}

export type NextStep = {
  title: string;
  detail: string | null;
  action: { label: string; href: string };
};

type StepInput = {
  hasProfile: boolean;
  matches: number;
  /** Strong matches not yet acted on. */
  strongToExplore: number;
  needsReview: number;
  readyToApply: number;
  preparing: number;
  applied: number;
  awaitingResponse: number;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The one most useful next action for the user, in plain language. */
export function nextStep(input: StepInput): NextStep {
  const working = input.preparing > 0 ? `Your agent is preparing ${plural(input.preparing, "application", "applications")} in the background.` : null;
  if (!input.hasProfile) {
    return { title: "Upload your CV to get started.", detail: "Your agent uses it to find and rank jobs that fit you.", action: { label: "Upload CV", href: "/#search" } };
  }
  if (input.needsReview > 0) {
    return {
      title: `${plural(input.needsReview, "application is", "applications are")} ready for your review.`,
      detail: working ?? "Check each one, then apply yourself when you're happy.",
      action: { label: "Review applications", href: "/review" },
    };
  }
  if (input.readyToApply > 0) {
    return {
      title: `${plural(input.readyToApply, "application is", "applications are")} approved and ready to send.`,
      detail: "Open the job and apply on the employer's site, then mark it as applied.",
      action: { label: "Open applications", href: "/applications" },
    };
  }
  if (input.matches === 0) {
    return { title: "Find jobs that match you.", detail: working ?? "Your agent searches several job sites and ranks every job against your CV.", action: { label: "Find jobs", href: "/#search" } };
  }
  if (input.strongToExplore > 0) {
    return {
      title: `You have ${plural(input.strongToExplore, "strong match", "strong matches")} to explore.`,
      detail: working ?? "Prepare an application for the ones you like — your agent does the writing.",
      action: { label: "See my matches", href: "/#jobs" },
    };
  }
  if (input.applied > 0) {
    return {
      title: "You're up to date.",
      detail: `You've applied to ${plural(input.applied, "job", "jobs")}.${input.awaitingResponse > 0 ? ` ${plural(input.awaitingResponse, "is", "are")} still waiting for a response.` : ""}`,
      action: { label: "View applications", href: "/applications" },
    };
  }
  return { title: "Explore your matches.", detail: working ?? "Prepare an application for any job you like.", action: { label: "See my matches", href: "/#jobs" } };
}

/** One sentence about what the agent did since the last visit, or null when nothing (never invented). */
export function awayMessage(input: { newMatches: number; newStrong: number; finished: number; processing: number; attention: number }): string | null {
  const found = input.newMatches > 0
    ? `found ${plural(input.newMatches, "new match", "new matches")}${input.newStrong > 0 ? ` (${input.newStrong} strong)` : ""}`
    : null;
  const prepared = input.finished > 0 ? `prepared ${plural(input.finished, "application", "applications")}` : null;
  const parts = [found, prepared].filter(Boolean);
  const extra = [
    input.processing > 0 ? `${input.processing} still in progress` : null,
    input.attention > 0 ? `${input.attention} ${input.attention === 1 ? "needs" : "need"} your attention` : null,
  ].filter(Boolean);
  if (parts.length === 0 && extra.length === 0) return null;
  const main = parts.length ? `Your agent ${parts.join(" and ")}.` : "";
  return [main, extra.length ? `${extra.join(", ")}.`.replace(/^./, (c) => c.toUpperCase()) : ""].filter(Boolean).join(" ");
}
