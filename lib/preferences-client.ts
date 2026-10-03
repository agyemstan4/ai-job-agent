import type { SearchPreferences } from "./pipeline/preferences.ts";

// Client-side helpers for the search preferences page (/preferences).
// Framework free, so they can be tested directly (including against the real
// API handlers). They only convert between the form and the existing
// GET/PUT /api/preferences contract: the server remains the authority on
// every rule and returns field errors for anything invalid.

export type PreferencesForm = {
  /** One search term per line. */
  searchTerms: string;
  location: string;
  /** One keyword per line. */
  excludeKeywords: string;
  /** Free text such as "30000", "30,000" or "£30,000"; empty for none. */
  minSalary: string;
};

export const EMPTY_PREFERENCES_FORM: PreferencesForm = { searchTerms: "", location: "", excludeKeywords: "", minSalary: "" };

export const PREFERENCE_FIELDS = ["searchTerms", "location", "excludeKeywords", "minSalary"] as const;
export type PreferenceField = (typeof PREFERENCE_FIELDS)[number];

/** Non-empty, trimmed lines. */
export function linesToList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The form for saved preferences (or an empty form when there are none). */
export function formFromPreferences(preferences: SearchPreferences | null): PreferencesForm {
  if (!preferences) return { ...EMPTY_PREFERENCES_FORM };
  return {
    searchTerms: preferences.searchTerms.join("\n"),
    location: preferences.location,
    excludeKeywords: preferences.excludeKeywords.join("\n"),
    minSalary: preferences.minSalary === null ? "" : String(preferences.minSalary),
  };
}

/**
 * Empty → null; "30000", "30,000", "£30,000" or "30 000" → 30000. Anything
 * else is passed through unchanged so the server rejects it with its own
 * field error.
 */
export function parseMinSalary(text: string): number | null | string {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const digits = trimmed.replace(/^£/, "").replace(/[,\s]/g, "");
  return /^\d+$/.test(digits) ? Number(digits) : trimmed;
}

/** The PUT body for the form. */
export function buildSaveRequest(form: PreferencesForm): { preferences: Record<string, unknown> } {
  return {
    preferences: {
      searchTerms: linesToList(form.searchTerms),
      location: form.location.trim(),
      excludeKeywords: linesToList(form.excludeKeywords),
      minSalary: parseMinSalary(form.minSalary),
    },
  };
}

/** The PUT body that clears all preferences. */
export const CLEAR_REQUEST = { preferences: null } as const;

export type LoadResult =
  | { kind: "loaded"; preferences: SearchPreferences | null; warning: string | null }
  | { kind: "no_candidate"; message: string }
  | { kind: "error"; message: string };

export type SaveResult =
  | { kind: "saved"; preferences: SearchPreferences | null }
  | { kind: "invalid"; message: string; fieldErrors: Partial<Record<PreferenceField | string, string>> }
  | { kind: "no_candidate"; message: string }
  | { kind: "error"; message: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const UNREACHABLE = "Could not reach the Job Agent. Check that it is still running, then try again.";

async function request(fetchImpl: FetchLike, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> | null } | null> {
  try {
    const response = await fetchImpl("/api/preferences", init);
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: response.status, body };
  } catch {
    return null;
  }
}

const errorText = (body: Record<string, unknown> | null, status: number) =>
  typeof body?.error === "string" ? body.error : `Something went wrong (HTTP ${status}). Please try again.`;

/** GET /api/preferences. */
export async function loadPreferences(fetchImpl: FetchLike = fetch): Promise<LoadResult> {
  const result = await request(fetchImpl);
  if (!result) return { kind: "error", message: UNREACHABLE };
  const { status, body } = result;
  if (status === 409) return { kind: "no_candidate", message: errorText(body, status) };
  if (status !== 200 || !body) return { kind: "error", message: errorText(body, status) };
  return {
    kind: "loaded",
    preferences: (body.preferences as SearchPreferences | null) ?? null,
    warning: typeof body.warning === "string" ? body.warning : null,
  };
}

async function put(fetchImpl: FetchLike, payload: unknown): Promise<SaveResult> {
  const result = await request(fetchImpl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!result) return { kind: "error", message: UNREACHABLE };
  const { status, body } = result;
  if (status === 200) return { kind: "saved", preferences: (body?.preferences as SearchPreferences | null) ?? null };
  if (status === 409) return { kind: "no_candidate", message: errorText(body, status) };
  if (status === 400) {
    const fieldErrors = (body?.fieldErrors ?? {}) as Record<string, string>;
    return {
      kind: "invalid",
      message: Object.keys(fieldErrors).length > 0 ? "Please fix the highlighted fields." : errorText(body, status),
      fieldErrors,
    };
  }
  return { kind: "error", message: errorText(body, status) };
}

/** PUT the form's preferences (the server validates them). */
export function savePreferences(form: PreferencesForm, fetchImpl: FetchLike = fetch): Promise<SaveResult> {
  return put(fetchImpl, buildSaveRequest(form));
}

/** PUT { preferences: null }: back to the default search. */
export function clearPreferences(fetchImpl: FetchLike = fetch): Promise<SaveResult> {
  return put(fetchImpl, CLEAR_REQUEST);
}

/** Field errors the form has no input for (e.g. an unknown field), shown as one message. */
export function otherFieldErrors(fieldErrors: Record<string, string>): string[] {
  return Object.entries(fieldErrors)
    .filter(([field]) => !(PREFERENCE_FIELDS as readonly string[]).includes(field))
    .map(([field, message]) => `${field}: ${message}`);
}
