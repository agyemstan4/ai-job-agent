import type { ReviewItem } from "./repositories/review.ts";

// Client-side helpers for the application tracker (/applications). Framework
// free, so they can be tested directly. They only build requests for the
// existing API (PATCH /api/applications/[id]) and format data for display:
// the server (repository + database) remains the authority on every rule.
//
// "Apply Now" is a plain link to the employer's site. Nothing here is called
// when it is clicked; only an explicit, confirmed "Mark as applied" builds a
// mark_submitted request.

export const TRACKER_TABS = [
  { key: "to_apply", label: "Ready to apply" },
  { key: "applied", label: "Applied / in progress" },
  { key: "closed", label: "Closed" },
  { key: "tracked", label: "All tracked" },
] as const;

export type TrackerTab = (typeof TRACKER_TABS)[number]["key"];

const STATUS_LABELS: Record<string, string> = {
  approved: "Ready to apply",
  submitted: "Applied",
  acknowledged: "Acknowledged",
  interviewing: "Interviewing",
  offer: "Offer",
  unsuccessful: "Unsuccessful",
  withdrawn: "Withdrawn",
};

export const statusLabel = (status: string): string => STATUS_LABELS[status] ?? status;

export const MAX_REFERENCE_LENGTH = 200;

// ── Times ────────────────────────────────────────────────────────────────────
// The API stores UTC "YYYY-MM-DD HH:MM:SS"; <input type="datetime-local">
// works in local "YYYY-MM-DDTHH:MM"; requests send ISO UTC ("...Z").

/** A stored UTC time as a Date. */
export function storedToDate(stored: string): Date {
  return new Date(`${stored.replace(" ", "T")}Z`);
}

/** A stored UTC time in the user's local format, for display. */
export function formatStored(stored: string | null | undefined): string {
  return stored ? storedToDate(stored).toLocaleString() : "—";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A Date as a datetime-local input value (local time, minutes). */
export function toLocalInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A datetime-local input value (local time) as a Date, or null if it is not one. */
export function localInputToDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(value); // no zone: interpreted as local time
  return Number.isNaN(date.getTime()) || toLocalInputValue(date) !== value ? null : date;
}

/**
 * The earliest value the date input may offer: the stored time rounded UP to
 * the next whole minute (the input has minute precision, and the server
 * refuses anything before that time).
 */
export function minInputValue(stored: string): string {
  const date = storedToDate(stored);
  if (date.getSeconds() > 0 || date.getMilliseconds() > 0) {
    date.setSeconds(0, 0);
    date.setMinutes(date.getMinutes() + 1);
  }
  return toLocalInputValue(date);
}

type Built = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

/** Parses an optional date input against [notBefore, now]. */
function checkInputTime(
  value: string,
  label: string,
  notBefore: { stored: string | null; what: string },
  now: Date
): { date: Date } | { error: string } {
  const date = localInputToDate(value);
  if (!date) return { error: `Enter a valid ${label}.` };
  if (date.getTime() > now.getTime()) return { error: `The ${label} cannot be in the future.` };
  if (notBefore.stored && date.getTime() < storedToDate(notBefore.stored).getTime()) {
    return { error: `The ${label} cannot be before ${notBefore.what} (${formatStored(notBefore.stored)}).` };
  }
  return { date };
}

// ── Mark as applied ──────────────────────────────────────────────────────────

export type MarkAppliedForm = {
  /** "I have submitted this application on the employer's site." */
  confirmed: boolean;
  /** False until the user changes the date: then "now" is sent by the server. */
  dateEdited: boolean;
  appliedAtInput: string;
  reference: string;
  note: string;
  modifiedExternally: boolean;
  externalChanges: string;
};

export function initialMarkAppliedForm(now: Date = new Date()): MarkAppliedForm {
  return {
    confirmed: false,
    dateEdited: false,
    appliedAtInput: toLocalInputValue(now),
    reference: "",
    note: "",
    modifiedExternally: false,
    externalChanges: "",
  };
}

/** The mark_submitted request for a confirmed form, or why it cannot be sent yet. */
export function buildMarkSubmittedRequest(item: ReviewItem, form: MarkAppliedForm, now: Date = new Date()): Built {
  if (item.status !== "approved") {
    return { ok: false, error: "Only an approved application can be marked as applied." };
  }
  if (!form.confirmed) {
    return { ok: false, error: "Tick the box to confirm you have submitted this application on the employer's site." };
  }
  const body: Record<string, unknown> = {
    action: "mark_submitted",
    confirm: true,
    reviewedAssetsSha256: item.assetsHash,
    submittedContent: form.modifiedExternally ? "modified_externally" : "as_approved",
  };
  if (form.dateEdited) {
    const checked = checkInputTime(form.appliedAtInput, "application date", { stored: item.approvedAt, what: "the approval" }, now);
    if ("error" in checked) return { ok: false, error: checked.error };
    body.submittedAt = checked.date.toISOString();
  }
  const reference = form.reference.trim();
  if (reference.length > MAX_REFERENCE_LENGTH) {
    return { ok: false, error: `The reference can be at most ${MAX_REFERENCE_LENGTH} characters.` };
  }
  if (reference) body.reference = reference;
  if (form.note.trim()) body.note = form.note.trim();
  if (form.modifiedExternally) {
    if (!form.externalChanges.trim()) {
      return { ok: false, error: "Describe what you changed on the employer's site." };
    }
    body.externalChanges = form.externalChanges.trim();
  }
  return { ok: true, body };
}

// ── Status updates ───────────────────────────────────────────────────────────

export type StatusUpdateForm = { to: string; occurredAtInput: string; note: string };

export const initialStatusUpdateForm = (): StatusUpdateForm => ({ to: "", occurredAtInput: "", note: "" });

/** The update_status request, or why it cannot be sent. Allowed moves come from the server (nextStatuses). */
export function buildStatusUpdateRequest(item: ReviewItem, form: StatusUpdateForm, now: Date = new Date()): Built {
  if (!form.to) return { ok: false, error: "Choose the new status." };
  if (!(item.nextStatuses as string[]).includes(form.to)) {
    return { ok: false, error: `This application cannot move to "${statusLabel(form.to)}".` };
  }
  const note = form.note.trim();
  if (form.to === "withdrawn" && !note) {
    return { ok: false, error: "Withdrawing needs a note explaining why (for example, if it was marked as applied by mistake)." };
  }
  const body: Record<string, unknown> = { action: "update_status", to: form.to };
  if (form.occurredAtInput) {
    const checked = checkInputTime(form.occurredAtInput, "date of this update", { stored: item.submission?.submittedAt ?? null, what: "the application date" }, now);
    if ("error" in checked) return { ok: false, error: checked.error };
    body.occurredAt = checked.date.toISOString();
  }
  if (note) body.note = note;
  return { ok: true, body };
}

// ── Submission reference ─────────────────────────────────────────────────────

/** The set_reference request (an empty value clears the reference). */
export function buildReferenceRequest(value: string): Built {
  const reference = value.trim();
  if (reference.length > MAX_REFERENCE_LENGTH) {
    return { ok: false, error: `The reference can be at most ${MAX_REFERENCE_LENGTH} characters.` };
  }
  return { ok: true, body: { action: "set_reference", reference: reference || null } };
}

// ── API calls ────────────────────────────────────────────────────────────────

/**
 * Calls the Job Agent API. On failure throws an Error whose message is safe
 * to show: the server's own explanation for 4xx refusals (validation, stale
 * approval, already applied, not found), a generic message otherwise.
 */
export async function callApi<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error("Could not reach the Job Agent. Check that it is still running, then try again.");
  }
  const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (!response.ok) {
    const serverMessage = typeof data?.error === "string" ? data.error : null;
    if (response.status === 404) {
      throw new Error(serverMessage ?? "This application could not be found. Refresh the page.");
    }
    if (response.status >= 400 && response.status < 500 && serverMessage) throw new Error(serverMessage);
    throw new Error(`Something went wrong (HTTP ${response.status}). Please try again.`);
  }
  return data as T;
}

/** Sends one action for an application and returns the updated item. */
export function patchApplication(id: number, body: Record<string, unknown>): Promise<ReviewItem> {
  if (!Number.isInteger(id) || id <= 0) return Promise.reject(new Error("Invalid application."));
  return callApi<ReviewItem>(`/api/applications/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
