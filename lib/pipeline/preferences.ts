import type { DB } from "../repositories/shared.ts";
import { getCandidate, getDefaultCandidate, getProfile, updateCandidate } from "../repositories/candidates.ts";
import { labelsForRoles, roleCategory, termsForRoles } from "./careers.ts";
import { PREFERABLE_BENEFITS } from "./benefits.ts";
import type { BenefitId, BenefitPreferences } from "./benefits.ts";

// Phase 3 checkpoint 3b-5a: search preferences, stored in
// candidates.preferences_json (existing column, no migration).
// Flexible career search (3f) adds, as optional fields of the same object:
//   • targetRoles — career categories (lib/pipeline/careers.ts) whose
//     plain-language labels stand for job-site search terms;
//   • benefits — employer benefits the user cares about, each "preferred" or
//     "important" (shown against the evidence found in adverts; not used for
//     searching or scoring yet).
// Records saved before 3f (no targetRoles/benefits) stay valid and behave as before.
//
// With no preferences saved, job discovery behaves exactly as before (the
// fixed term list, the location sent by the caller). With preferences:
//   • the chosen categories' terms, then the user's own search terms (at
//     most 6, and at most 7 terms per search — no more requests than before);
//     the role selected on / is searched first only for preferences without
//     categories (as before 3f);
//   • the preferred location replaces the one sent by the caller;
//   • jobs whose title contains an excluded keyword, or whose known annual
//     salary is below the floor, are left out of the new jobs returned.
//     Nothing is recorded for them, so changing the preferences takes effect
//     on the next search.
// The scheduler sends no candidate profile, so it never uses preferences.

export const PREFERENCES_VERSION = 1;
export const MAX_SEARCH_TERMS = 6; // plus the selected role: at most 7 terms
export const MAX_TOTAL_SEARCH_TERMS = 7;
export const MAX_EXCLUDE_KEYWORDS = 20;
export const MAX_MIN_SALARY = 200_000;
/** Salary figures below this are day or hour rates, not annual salaries. */
export const ANNUAL_SALARY_THRESHOLD = 1_000;

export type SearchPreferences = {
  version: typeof PREFERENCES_VERSION;
  /** Career category ids (careers.ts). */
  targetRoles: string[];
  /** The user's own searches, e.g. "Territory Manager". */
  searchTerms: string[];
  location: string;
  excludeKeywords: string[];
  minSalary: number | null;
  benefits: BenefitPreferences;
};

export type PreferencesValidation =
  | { ok: true; preferences: SearchPreferences }
  | { ok: false; fieldErrors: Record<string, string> };

const ALLOWED_FIELDS = new Set(["version", "targetRoles", "searchTerms", "location", "excludeKeywords", "minSalary", "benefits"]);
const BENEFIT_PRIORITIES = new Set(["preferred", "important"]);

const clean = (value: string) => value.replace(/\s+/g, " ").trim();

/** Trimmed, de-duplicated (ignoring case) strings, or an error message. */
function cleanList(
  value: unknown,
  { label, min, max, minChars, maxChars }: { label: string; min: number; max: number; minChars: number; maxChars: number }
): string[] | string {
  if (!Array.isArray(value)) return `${label} must be a list`;
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return `Each ${label.toLowerCase()} entry must be text`;
    const text = clean(item);
    if (text.length < minChars || text.length > maxChars) {
      return `Each ${label.toLowerCase()} entry must be ${minChars}–${maxChars} characters`;
    }
    if (seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    items.push(text);
  }
  if (items.length < min || items.length > max) {
    return min === max ? `${label} needs exactly ${min} entries` : `${label} needs ${min}–${max} entries`;
  }
  return items;
}

/** Validates preferences from the user (or as stored). Unknown fields are rejected. */
export function validatePreferences(input: unknown): PreferencesValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, fieldErrors: { preferences: "Preferences must be an object" } };
  }
  const raw = input as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_FIELDS.has(key)) fieldErrors[key] = "Unknown field";
  }
  if (raw.version !== undefined && raw.version !== PREFERENCES_VERSION) {
    fieldErrors.version = `Unsupported version (expected ${PREFERENCES_VERSION})`;
  }

  // Career categories: known ids only, without duplicates.
  let targetRoles: string[] = [];
  if (raw.targetRoles !== undefined) {
    if (!Array.isArray(raw.targetRoles)) {
      fieldErrors.targetRoles = "Kinds of work must be a list";
    } else if (raw.targetRoles.some((id) => typeof id !== "string" || !roleCategory(id))) {
      fieldErrors.targetRoles = "Unknown kind of work";
    } else {
      targetRoles = [...new Set(raw.targetRoles as string[])];
    }
  }

  const searchTerms =
    raw.searchTerms === undefined && targetRoles.length > 0
      ? []
      : cleanList(raw.searchTerms, { label: "Search terms", min: targetRoles.length > 0 ? 0 : 1, max: MAX_SEARCH_TERMS, minChars: 2, maxChars: 60 });
  if (typeof searchTerms === "string") {
    fieldErrors.searchTerms =
      targetRoles.length === 0 && Array.isArray(raw.searchTerms) && raw.searchTerms.length === 0
        ? "Choose at least one kind of work, or add a search of your own"
        : searchTerms;
  } else if (!fieldErrors.targetRoles) {
    // Every term is two requests (one per job site): keep the existing limit.
    const total = new Set([...termsForRoles(targetRoles), ...searchTerms].map((t) => t.toLowerCase())).size;
    if (total > MAX_SEARCH_TERMS) {
      fieldErrors.targetRoles = `That is ${total} searches. Choose up to ${MAX_SEARCH_TERMS} in total (some kinds of work search for 2 job titles).`;
    }
  }

  // Benefits: known ids, each "preferred" or "important".
  const benefits: BenefitPreferences = {};
  if (raw.benefits !== undefined) {
    if (typeof raw.benefits !== "object" || raw.benefits === null || Array.isArray(raw.benefits)) {
      fieldErrors.benefits = "Benefits must be an object";
    } else {
      for (const [id, priority] of Object.entries(raw.benefits as Record<string, unknown>)) {
        if (!(PREFERABLE_BENEFITS as string[]).includes(id)) {
          fieldErrors.benefits = `Unknown benefit: ${id}`;
        } else if (typeof priority !== "string" || !BENEFIT_PRIORITIES.has(priority)) {
          fieldErrors.benefits = "Each benefit must be \"preferred\" or \"important\"";
        } else {
          benefits[id as BenefitId] = priority as "preferred" | "important";
        }
      }
    }
  }

  let location = "";
  if (typeof raw.location !== "string") {
    fieldErrors.location = "Location is required";
  } else {
    location = clean(raw.location);
    if (location.length < 2 || location.length > 60) fieldErrors.location = "Location must be 2–60 characters";
  }

  const excludeKeywords =
    raw.excludeKeywords === undefined
      ? []
      : cleanList(raw.excludeKeywords, { label: "Exclude keywords", min: 0, max: MAX_EXCLUDE_KEYWORDS, minChars: 2, maxChars: 40 });
  if (typeof excludeKeywords === "string") fieldErrors.excludeKeywords = excludeKeywords;

  let minSalary: number | null = null;
  if (raw.minSalary !== undefined && raw.minSalary !== null) {
    if (typeof raw.minSalary !== "number" || !Number.isInteger(raw.minSalary) || raw.minSalary < 0 || raw.minSalary > MAX_MIN_SALARY) {
      fieldErrors.minSalary = `Minimum salary must be a whole number from 0 to ${MAX_MIN_SALARY.toLocaleString("en-GB")}`;
    } else {
      minSalary = raw.minSalary;
    }
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return {
    ok: true,
    preferences: {
      version: PREFERENCES_VERSION,
      targetRoles,
      searchTerms: searchTerms as string[],
      location,
      excludeKeywords: excludeKeywords as string[],
      minSalary,
      benefits,
    },
  };
}

/** The stored preferences if they are valid; anything else counts as none. */
export function storedPreferences(value: unknown): SearchPreferences | null {
  if (value === null || value === undefined) return null;
  const result = validatePreferences(value);
  return result.ok ? result.preferences : null;
}

/** The preferences of the candidate behind a profile, or null (no profile, unknown profile, none saved). */
export function preferencesForProfile(db: DB, candidateProfileId: unknown): SearchPreferences | null {
  if (typeof candidateProfileId !== "number") return null;
  const profile = getProfile(db, candidateProfileId);
  if (!profile) return null;
  return storedPreferences(getCandidate(db, profile.candidateId)?.preferences);
}

// The search terms /api/jobs used before 3b-5 (still used with no preferences).
export const DEFAULT_SEARCH_TERMS = [
  "junior software engineer",
  "graduate software developer",
  "android developer",
  "java developer",
  "frontend developer",
  "full stack developer",
];

export type SearchPlan = {
  terms: string[];
  location: string;
  usedPreferences: boolean;
  /** Plain-language names of the chosen kinds of work (empty without categories). */
  roleLabels: string[];
};

/**
 * The search terms and location for one discovery run. With no preferences
 * this is exactly the previous behaviour (including its case-sensitive
 * de-duplication of the selected role against the fixed terms). With
 * categories, they decide what is searched (the role chosen on / is not
 * added); without categories, saved preferences behave exactly as before 3f.
 */
export function searchPlan(
  preferences: SearchPreferences | null,
  request: { role?: unknown; location?: unknown }
): SearchPlan {
  if (!preferences) {
    return {
      terms: Array.from(new Set([request.role as string, ...DEFAULT_SEARCH_TERMS])),
      location: request.location as string,
      usedPreferences: false,
      roleLabels: [],
    };
  }
  const targetRoles = preferences.targetRoles ?? [];
  const terms: string[] = [];
  const seen = new Set<string>();
  const role = targetRoles.length === 0 && typeof request.role === "string" ? clean(request.role) : "";
  for (const term of [role, ...termsForRoles(targetRoles), ...preferences.searchTerms]) {
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    terms.push(term);
  }
  return {
    terms: terms.slice(0, MAX_TOTAL_SEARCH_TERMS),
    location: preferences.location,
    usedPreferences: true,
    roleLabels: labelsForRoles(targetRoles),
  };
}

export type FilterableJob = {
  title?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryIsPredicted?: boolean | null;
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case-insensitive; works for keywords such as "C#" or "Node.js". */
export function titleHasKeyword(title: string, keyword: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(keyword)}($|[^\\p{L}\\p{N}])`, "iu").test(title);
}

/**
 * The job's known annual salary (the top of its range), or null when it is
 * unknown, estimated by Adzuna, or a day/hour rate — those jobs are kept.
 */
export function knownAnnualSalary(job: FilterableJob): number | null {
  if (job.salaryIsPredicted) return null;
  const salary = job.salaryMax ?? job.salaryMin ?? null;
  if (typeof salary !== "number" || !Number.isFinite(salary) || salary < ANNUAL_SALARY_THRESHOLD) return null;
  return salary;
}

export type DiscoveryFilterResult<T> = { kept: T[]; excludedByKeyword: number; belowMinSalary: number };

/** Leaves out jobs excluded by keyword or below the salary floor. No preferences: everything is kept. */
export function applyDiscoveryFilter<T>(
  preferences: SearchPreferences | null,
  jobs: T[],
  toFilterable: (job: T) => FilterableJob
): DiscoveryFilterResult<T> {
  const result: DiscoveryFilterResult<T> = { kept: [], excludedByKeyword: 0, belowMinSalary: 0 };
  for (const job of jobs) {
    if (!preferences) {
      result.kept.push(job);
      continue;
    }
    const info = toFilterable(job);
    const title = info.title ?? "";
    if (preferences.excludeKeywords.some((keyword) => titleHasKeyword(title, keyword))) {
      result.excludedByKeyword++;
      continue;
    }
    const salary = knownAnnualSalary(info);
    if (preferences.minSalary !== null && salary !== null && salary < preferences.minSalary) {
      result.belowMinSalary++;
      continue;
    }
    result.kept.push(job);
  }
  return result;
}

// ── /api/preferences handlers (the route stays thin) ────────────────────────

export type HandlerResult = { status: number; body: Record<string, unknown> };

const NO_CANDIDATE: HandlerResult = {
  status: 409,
  body: { error: "Upload your CV first: preferences are saved with your candidate record." },
};

/** GET: the saved preferences, or null. */
export function getPreferences(db: DB): HandlerResult {
  const candidate = getDefaultCandidate(db);
  if (!candidate) return NO_CANDIDATE;
  const preferences = storedPreferences(candidate.preferences);
  const invalid = candidate.preferences !== null && preferences === null;
  return {
    status: 200,
    body: invalid
      ? { preferences: null, warning: "The saved preferences are not valid and are being ignored. Save new ones to replace them." }
      : { preferences },
  };
}

/** PUT { preferences: {...} } saves them; { preferences: null } clears them. */
export function putPreferences(db: DB, body: unknown): HandlerResult {
  const candidate = getDefaultCandidate(db);
  if (!candidate) return NO_CANDIDATE;
  if (typeof body !== "object" || body === null || !("preferences" in body)) {
    return { status: 400, body: { error: "Send { preferences: {...} }, or { preferences: null } to clear them." } };
  }
  const input = (body as { preferences: unknown }).preferences;
  if (input === null) {
    updateCandidate(db, candidate.id, { preferences: null });
    return { status: 200, body: { preferences: null } };
  }
  const result = validatePreferences(input);
  if (!result.ok) return { status: 400, body: { error: "Invalid preferences", fieldErrors: result.fieldErrors } };
  updateCandidate(db, candidate.id, { preferences: result.preferences });
  return { status: 200, body: { preferences: result.preferences } };
}
