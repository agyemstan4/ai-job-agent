import type { PreparationItem, PreparationStatus, StageState } from "./pipeline/preparation-queue.ts";
import { parseStoredTime } from "./dashboard-client.ts";

// Client-side helpers for the preparation queue (Phase 3 checkpoint 3d).
// Framework free, so they can be tested directly. They only queue jobs
// (POST /api/applications/prepare) and read progress
// (GET /api/applications/preparation): nothing here approves, submits or
// emails anything, and nothing depends on the tab staying open.

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
const UNREACHABLE = "Could not reach the Job Agent. Check that it is still running, then try again.";

export type QueueResult =
  | { kind: "queued"; applicationId: number; state: string }
  | { kind: "existing"; applicationId: number; state: string }
  | { kind: "error"; message: string };

function toQueueResult(status: number, body: { applicationId?: number; state?: string; error?: string } | null): QueueResult {
  if ((status === 202 || status === 200) && typeof body?.applicationId === "number") {
    return { kind: status === 202 ? "queued" : "existing", applicationId: body.applicationId, state: body.state ?? "" };
  }
  return { kind: "error", message: body?.error ?? `Something went wrong (HTTP ${status}). Please try again.` };
}

/** Queues one job (returns at once). retry: re-run only the parts that failed. */
export async function queuePreparation(matchId: number, options: { retry?: boolean } = {}, fetchImpl: FetchLike = fetch): Promise<QueueResult> {
  try {
    const res = await fetchImpl("/api/applications/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchId, ...(options.retry ? { retry: true } : {}) }),
    });
    return toQueueResult(res.status, await res.json().catch(() => null));
  } catch {
    return { kind: "error", message: UNREACHABLE };
  }
}

/** Queues several jobs in one request (returns at once). */
export async function queuePreparations(matchIds: number[], fetchImpl: FetchLike = fetch): Promise<{ kind: "ok"; results: QueueResult[] } | { kind: "error"; message: string }> {
  try {
    const res = await fetchImpl("/api/applications/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchIds }),
    });
    const body = (await res.json().catch(() => null)) as { results?: { status: number; applicationId?: number; state?: string; error?: string }[]; error?: string } | null;
    if (res.status !== 202 || !Array.isArray(body?.results)) {
      return { kind: "error", message: body?.error ?? `Something went wrong (HTTP ${res.status}). Please try again.` };
    }
    return { kind: "ok", results: body.results.map((r) => toQueueResult(r.status, r)) };
  } catch {
    return { kind: "error", message: UNREACHABLE };
  }
}

export async function loadPreparationStatus(fetchImpl: FetchLike = fetch): Promise<{ kind: "loaded"; status: PreparationStatus } | { kind: "error"; message: string }> {
  try {
    const res = await fetchImpl("/api/applications/preparation");
    const body = (await res.json().catch(() => null)) as (PreparationStatus & { error?: string }) | null;
    if (!res.ok || !body?.summary) return { kind: "error", message: body?.error ?? `Something went wrong (HTTP ${res.status}).` };
    return { kind: "loaded", status: body };
  } catch {
    return { kind: "error", message: UNREACHABLE };
  }
}

/** True while anything is preparing or queued. */
export function hasActiveWork(status: PreparationStatus | null): boolean {
  return Boolean(status && status.summary.preparing + status.summary.queued > 0);
}

/**
 * How long to wait before the next status poll, or null to stop polling.
 * Fast while work is running, slower after a while, never a request storm.
 */
export function nextPollDelay(status: PreparationStatus | null, pollsSoFar: number): number | null {
  if (!hasActiveWork(status)) return null;
  return pollsSoFar < 20 ? 3000 : 8000;
}

export type StepView = { label: string; state: StageState };

/** The steps shown for one job: two that are already done for any match, then the real stages. */
export function stepsFor(item: Pick<PreparationItem, "stages">): StepView[] {
  return [
    { label: "Job analysed", state: "done" as StageState },
    { label: "Match reviewed", state: "done" as StageState },
    ...item.stages.filter((s) => s.state !== "skipped").map((s) => ({ label: s.label, state: s.state })),
  ];
}

/** One short line for a job's progress. */
export function progressLine(item: PreparationItem): string {
  switch (item.state) {
    case "queued":
      return item.queuePosition ? `Queued · #${item.queuePosition} in line` : "Queued";
    case "preparing":
      return item.currentStage ? `${item.currentStage}…` : "Starting…";
    case "ready":
      return item.error ? `Ready for review · ${failedParts(item)}` : "Ready for review";
    case "failed":
      return `Needs attention · ${failedParts(item) || "preparation failed"}`;
    default:
      return item.state;
  }
}

/** "Cover letter failed", "CV failed", … from the stage states. */
export function failedParts(item: Pick<PreparationItem, "stages">): string {
  const labels: Record<string, string> = { cv: "CV", document: "CV document", coverLetter: "Cover letter", answers: "Application answers" };
  const failed = item.stages.filter((s) => s.state === "failed").map((s) => labels[s.key] ?? s.label);
  return failed.length ? `${failed.join(", ")} failed` : "";
}

export function needsAttention(item: Pick<PreparationItem, "state" | "error">): boolean {
  return item.state === "failed" || (item.state === "ready" && Boolean(item.error));
}

/** "While you were away": what finished since the last visit (null on a first visit or if nothing happened). */
export function whileYouWereAway(status: PreparationStatus | null, lastVisit: number | null): { finished: number; processing: number; attention: number } | null {
  if (!status || lastVisit === null) return null;
  const since = status.items.filter((i) => (parseStoredTime(i.updatedAt) ?? 0) > lastVisit);
  const finished = since.filter((i) => i.state === "ready").length;
  const attention = since.filter(needsAttention).length;
  const processing = status.summary.preparing + status.summary.queued;
  return finished + attention > 0 ? { finished, processing, attention } : null;
}
