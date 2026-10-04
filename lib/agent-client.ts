import type { DailyBrief } from "./daily-brief.ts";

// Browser helpers for the daily agent (Phase 4b): read today's saved brief and
// record seen / reviewed. Framework free so they can be tested directly. They
// only talk to /api/agent/brief and /api/agent/opportunity-state — never to
// discovery, matching, preparation or email.

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type SavedBriefResult = { kind: "ready"; brief: DailyBrief } | { kind: "none"; status: string | null } | { kind: "error" };

/** Today's saved brief, if the daily run has produced one. */
export async function loadSavedBrief(fetchImpl: FetchLike = fetch): Promise<SavedBriefResult> {
  try {
    const res = await fetchImpl("/api/agent/brief");
    const body = (await res.json().catch(() => null)) as { brief?: DailyBrief | null; status?: string | null } | null;
    if (!res.ok || !body) return { kind: "error" };
    return body.brief ? { kind: "ready", brief: body.brief } : { kind: "none", status: body.status ?? null };
  } catch {
    return { kind: "error" };
  }
}

/** Remembers that you opened ("seen") or acted on ("reviewed") an opportunity. Never throws. */
export async function sendOpportunityEvent(jobId: number, event: "seen" | "reviewed", fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl("/api/agent/opportunity-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, event }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** True when a scheduled brief was made after your last visit ("your agent worked while you were away"). */
export function workedWhileAway(brief: DailyBrief, lastVisit: number | null): boolean {
  if (brief.origin !== "scheduled_run") return false;
  const generated = Date.parse(brief.generatedAt);
  return Number.isFinite(generated) && (lastVisit === null || generated > lastVisit);
}
