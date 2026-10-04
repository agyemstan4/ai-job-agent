import type { SearchPreferences } from "./pipeline/preferences.ts";
import { MAX_SEARCH_TERMS } from "./pipeline/preferences.ts";
import { labelsForRoles, termsForRoles } from "./pipeline/careers.ts";
import type { BenefitId, BenefitPreferences, BenefitPriority } from "./pipeline/benefits.ts";

// Client-side helpers for the search preferences page (/preferences).
// Framework free, so they can be tested directly (including against the real
// API handlers). They only convert between the form and the existing
// GET/PUT /api/preferences contract: the server remains the authority on
// every rule and returns field errors for anything invalid.

export type PreferencesForm = {
  /** Chosen career category ids. */
  targetRoles: string[];
  /** One search term per line (the user's own searches). */
  searchTerms: string;
  location: string;
  /** One keyword per line. */
  excludeKeywords: string;
  /** Free text such as "30000", "30,000" or "£30,000"; empty for none. */
  minSalary: string;
  /** Benefits that matter, each "preferred" (nice to have) or "important". */
  benefits: BenefitPreferences;
};

export const EMPTY_PREFERENCES_FORM: PreferencesForm = { targetRoles: [], searchTerms: "", location: "", excludeKeywords: "", minSalary: "", benefits: {} };

/** A first-time form: nothing chosen yet, with the usual location suggested. */
export const NEW_PREFERENCES_FORM: PreferencesForm = { ...EMPTY_PREFERENCES_FORM, location: "London" };

export const PREFERENCE_FIELDS = ["targetRoles", "searchTerms", "location", "excludeKeywords", "minSalary", "benefits"] as const;
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
  if (!preferences) return { ...NEW_PREFERENCES_FORM };
  return {
    targetRoles: [...(preferences.targetRoles ?? [])],
    searchTerms: preferences.searchTerms.join("\n"),
    location: preferences.location,
    excludeKeywords: preferences.excludeKeywords.join("\n"),
    minSalary: preferences.minSalary === null ? "" : String(preferences.minSalary),
    benefits: { ...(preferences.benefits ?? {}) },
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
      targetRoles: form.targetRoles,
      searchTerms: linesToList(form.searchTerms),
      location: form.location.trim(),
      excludeKeywords: linesToList(form.excludeKeywords),
      minSalary: parseMinSalary(form.minSalary),
      benefits: form.benefits,
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

// ── Flexible career search helpers (presentation; the server decides) ─────

/** Adds or removes a kind of work. */
export function toggleRole(form: PreferencesForm, id: string): PreferencesForm {
  const targetRoles = form.targetRoles.includes(id) ? form.targetRoles.filter((r) => r !== id) : [...form.targetRoles, id];
  return { ...form, targetRoles };
}

/** Sets a benefit to "preferred" or "important", or removes it (null). */
export function setBenefit(form: PreferencesForm, id: BenefitId, priority: BenefitPriority | null): PreferencesForm {
  const benefits = { ...form.benefits };
  if (priority) benefits[id] = priority;
  else delete benefits[id];
  return { ...form, benefits };
}

/** What the next search would look for, and whether it is over the limit. */
export function searchPreview(form: PreferencesForm): { terms: string[]; overLimit: boolean; limit: number } {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of [...termsForRoles(form.targetRoles), ...linesToList(form.searchTerms)]) {
    if (seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    terms.push(term);
  }
  return { terms, overLimit: terms.length > MAX_SEARCH_TERMS, limit: MAX_SEARCH_TERMS };
}

/** The role searched first when nothing is chosen (the previous default on the home page). */
export const DEFAULT_HOME_ROLE = "Junior Software Engineer";

export type HomeSearchSetup = {
  /** Sent to the CV analysis as the roles the candidate is interested in. */
  analysisRoles: string[];
  /** The "role" sent with the job search (undefined when chosen kinds of work decide the search). */
  role: string | undefined;
  /** Preferences to save before searching (null when nothing changes). */
  save: { preferences: Record<string, unknown> } | null;
};

/**
 * How "Find Suitable Jobs" on the home page searches. Kinds of work chosen
 * there are saved as preferences (the one place the search plan reads), so
 * home and /preferences never disagree. Nothing chosen and nothing saved:
 * exactly the previous default search.
 */
export function homeSearchSetup(saved: SearchPreferences | null, chosenRoles: string[]): HomeSearchSetup {
  const savedRoles = saved?.targetRoles ?? [];
  const changed = chosenRoles.length !== savedRoles.length || chosenRoles.some((id) => !savedRoles.includes(id));
  const labels = labelsForRoles(chosenRoles);
  const ownSearches = saved?.searchTerms ?? [];
  const save =
    changed && (chosenRoles.length > 0 || saved)
      ? {
          preferences: {
            targetRoles: chosenRoles,
            searchTerms: ownSearches,
            location: saved?.location ?? "London",
            excludeKeywords: saved?.excludeKeywords ?? [],
            minSalary: saved?.minSalary ?? null,
            benefits: saved?.benefits ?? {},
          },
        }
      : null;
  if (chosenRoles.length > 0) {
    return { analysisRoles: [...labels, ...ownSearches], role: undefined, save };
  }
  return { analysisRoles: [DEFAULT_HOME_ROLE, ...ownSearches], role: DEFAULT_HOME_ROLE, save };
}

/** PUT preferences as built by homeSearchSetup. */
export function saveRawPreferences(payload: { preferences: Record<string, unknown> }, fetchImpl: FetchLike = fetch): Promise<SaveResult> {
  return put(fetchImpl, payload);
}
