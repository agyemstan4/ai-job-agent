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
