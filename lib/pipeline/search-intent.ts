import type { BenefitId, BenefitPriority } from "./benefits.ts";
import { BENEFITS } from "./benefits.ts";
import { roleCategory } from "./careers.ts";
import type { SearchPreferences } from "./preferences.ts";
import { MAX_MIN_SALARY } from "./preferences.ts";

// Natural-language career search: turns "Territory manager jobs around London
// with a company car" into the structures the app already understands (career
// categories, your own searches, a location, a minimum salary and benefit
// priorities). Deterministic and local — no model call, no network request.
// It only interprets: nothing is saved or searched until the user reviews the
// interpretation and presses Find Suitable Jobs (or Save on /preferences).
//
// Conservative by design: only what the user actually said is used. Distinct
// ideas stay distinct — "car allowance" is not "company car", "own vehicle"
// and "travel required" are not benefits — and anything the job sites can't
// do (distances, remote work) is noted rather than faked.

export type IntentRole = { id: string; label: string; phrase: string };
export type IntentBenefit = { id: BenefitId; label: string; priority: BenefitPriority; phrase: string };
export type IntentNote = { kind: "requirement" | "unsupported" | "info"; text: string };

export type SearchIntent = {
  roles: IntentRole[];
  /** Job titles the user named that no career category covers — used as their own searches. */
  ownSearches: string[];
  location: { value: string; phrase: string } | null;
  salary: { min: number; max: number | null; phrase: string } | null;
  benefits: IntentBenefit[];
  /** Understood but not used for searching (requirements, unsupported ideas). */
  notes: IntentNote[];
  /** Questions when something important is missing or ambiguous. */
  clarifications: string[];
};

// ── Phrase tables (longest phrases are matched first) ──────────────────────

const ROLE_PHRASES: [RegExp, string[]][] = [
  [/\b(?:graduate|junior|entry[- ]level|trainee)\s+(?:software|developer|developers|programmer|engineer|engineering)\b(?:\s+(?:developers?|engineers?|engineering|development))?/i, ["software_engineering", "graduate_software"]],
  [/\b(?:graduate|junior)\s+(?:software\s+)?(?:developers?|engineers?)\b/i, ["software_engineering", "graduate_software"]],
  [/\bfield\s+territory\s+managers?\b|\bterritory\s+sales(?:\s+managers?)?\b|\bterritory\s+managers?\b|\bterritory\s+management\b/i, ["territory_management"]],
  [/\barea\s+sales\s+managers?\b|\barea\s+managers?\b|\barea\s+management\b/i, ["area_management"]],
  [/\bfield\s+sales\b/i, ["field_sales"]],
  [/\baccount\s+managers?\b|\baccount\s+management\b/i, ["account_management"]],
  [/\bdelivery\s+drivers?\b|\bdelivery\s+driving\b|\bmulti[- ]drop\b|\bcouriers?\b/i, ["delivery_driving"]],
  [/\b(?:van|lgv|hgv|class\s*[12]|lorry|bus|coach)\s+drivers?\b|\bdrivers?\b|\bdriving\b/i, ["driving"]],
  [/\bfield\s+service(?:\s+engineers?)?\b|\bservice\s+engineers?\b/i, ["field_service"]],
  [/\btechnical\s+operat(?:ors?|ions)\b|\bmachine\s+operators?\b/i, ["technical_operations"]],
  [/\bconstruction\b|\bsite\s+technicians?\b/i, ["construction_technical"]],
  [/\bcustomer\s+service\b|\bcustomer[- ]facing\b|\bcall\s+cent(?:re|er)s?\b/i, ["customer_facing"]],
  [/\bandroid\b/i, ["android"]],
  [/\bjava\b(?!\s*script)/i, ["java"]],
  [/\bfront[- ]?end\b/i, ["frontend"]],
  [/\bback[- ]?end\b/i, ["backend"]],
  [/\bfull[- ]?stack\b/i, ["full_stack"]],
  [/\bsoftware(?:\s+(?:developers?|engineers?|engineering|development))?\b|\bdevelopers?\b|\bprogrammers?\b/i, ["software_engineering"]],
  [/\bsales\s+(?:executives?|reps?|representatives?|advisors?)\b|\bsales\b/i, ["sales"]],
];

// Requirements first, so their words can't be read as benefits.
const REQUIREMENT_PHRASES: [RegExp, string][] = [
  [/\btravel\s+(?:is\s+)?(?:required|needed|involved)\b|\b(?:where|when)\s+travel\s+is\s+required\b|\bwilling\s+to\s+travel\b|\bhappy\s+to\s+travel\b|\bjobs?\s+(?:with|involving)\s+travel\b/i,
    "Travel being part of the job is a requirement, not a benefit — it isn't used for searching (paid travel would be “travel expenses”)."],
  [/\b(?:my|your|their|an?)\s+own\s+(?:car|vehicle|van|transport)\b|\bown\s+(?:car|vehicle|van|transport)\b/i, "Having your own vehicle is noted, but it isn't a benefit and isn't used for searching."],
  [/\bdriving\s+licen[cs]e\b|\bfull\s+(?:uk\s+)?licen[cs]e\b/i, "A driving licence is noted, but it isn't used for searching."],
];

const BENEFIT_PHRASES: [RegExp, BenefitId][] = [
  [/\b(?:car|vehicle|car\s+cash)\s+allowance\b/i, "carAllowance"],
  [/\bcompany\s+(?:vans?|vehicles?)\b|\b(?:vans?|vehicles?)\s+(?:is\s+|are\s+)?(?:provided|supplied|included)\b|\bprovides?\s+(?:a\s+|the\s+)?(?:van|vehicle)\b|\bwork\s+vans?\b/i, "companyVehicle"],
  [/\bcompany\s+cars?\b|\bfully[- ]expensed\s+car\b|\bcars?\s+(?:is\s+)?(?:provided|supplied|included)\b|\bprovides?\s+(?:a\s+|the\s+)?car\b/i, "companyCar"],
  [/\bfuel\s+cards?\b/i, "fuelCard"],
  [/\bpaid\s+mileage\b|\bmileage(?:\s+(?:paid|allowance|covered))?\b/i, "mileage"],
  [/\btravel\s+expenses\b|\bexpenses\s+(?:paid|covered)\b|\bpaid\s+travel\b|\btravel\s+(?:is\s+)?(?:paid|covered)\b|\btravel\s+costs\s+(?:paid|covered)\b/i, "travelExpenses"],
  [/\b(?:staff|free|on[- ]site)\s+accommodation\b|\baccommodation(?:\s+(?:provided|included|supplied))?\b|\blive[- ]in\b/i, "accommodation"],
  [/\brelocation(?:\s+(?:package|support|assistance))?\b/i, "relocation"],
  [/\b(?:paid|funded)\s+training\b|\btraining\s+(?:provided|paid)\b/i, "training"],
];
const PREFERRED_CUE = /\b(?:preferably|ideally|nice\s+to\s+have|would\s+be\s+nice|if\s+possible|bonus\s+if|optional(?:ly)?|maybe)\b/i;

const PLACES = [
  "Greater London", "Central London", "North London", "South London", "East London", "West London", "London",
  "South East", "South West", "North West", "North East", "East Midlands", "West Midlands", "Midlands", "East Anglia",
  "Yorkshire", "Home Counties", "Northern Ireland", "Scotland", "Wales", "England", "UK",
  "Manchester", "Birmingham", "Leeds", "Bristol", "Liverpool", "Glasgow", "Edinburgh", "Cardiff", "Newcastle", "Sheffield",
  "Nottingham", "Leicester", "Reading", "Oxford", "Cambridge", "Brighton", "Southampton", "Portsmouth", "Milton Keynes",
  "Coventry", "Belfast", "Aberdeen", "Norwich", "Exeter", "Plymouth", "York", "Hull", "Derby", "Luton", "Swindon",
  "Kent", "Surrey", "Essex", "Sussex", "Hertfordshire", "Berkshire", "Hampshire", "Croydon", "Watford", "Slough",
];
const VAGUE_PLACE = /\b(?:near\s+me|nearby|close\s+to\s+(?:me|home)|around\s+here|local(?:ly)?|in\s+my\s+area|up\s+north|down\s+south)\b/i;

const clean = (text: string) => text.replace(/\s+/g, " ").trim();
const BENEFIT_LABEL = new Map(BENEFITS.map((b) => [b.id as BenefitId, b.label]));

/** Masks matched text so later phrases can't reuse it. */
function take(state: { text: string }, re: RegExp): RegExpExecArray | null {
  const m = re.exec(state.text);
  if (m) state.text = state.text.slice(0, m.index) + " ".repeat(m[0].length) + state.text.slice(m.index + m[0].length);
  return m;
}

function amount(raw: string, k: string | undefined): number | null {
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const value = k ? Math.round(n * 1000) : n;
  return value >= 1000 && value <= MAX_MIN_SALARY ? value : null;
}
const MONEY = String.raw`£?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k)?`;

/** Reads a request in normal language. Never searches or saves anything. */
export function parseSearchIntent(input: string): SearchIntent {
  const original = clean(input ?? "");
  const state = { text: original };
  const intent: SearchIntent = { roles: [], ownSearches: [], location: null, salary: null, benefits: [], notes: [], clarifications: [] };

  // 1. Requirements (kept apart from benefits).
  for (const [re, text] of REQUIREMENT_PHRASES) {
    if (take(state, new RegExp(re.source, "i"))) intent.notes.push({ kind: "requirement", text });
  }

  // 2. Salary: a range, a minimum, or an approximate figure (asked about, not assumed).
  const range = take(state, new RegExp(String.raw`\bbetween\s+${MONEY}\s*(?:and|to|-|–)\s*${MONEY}`, "i"));
  if (range) {
    const min = amount(range[1], range[2] ?? range[4]);
    const max = amount(range[3], range[4]);
    if (min !== null) intent.salary = { min, max: max !== null && max > min ? max : null, phrase: clean(range[0]) };
  }
  if (!intent.salary) {
    const min =
      take(state, new RegExp(String.raw`\b(?:at\s+least|minimum(?:\s+of)?|min\.?|no\s+less\s+than|over|above|more\s+than|starting\s+(?:at|from))\s+${MONEY}`, "i")) ??
      take(state, new RegExp(String.raw`(?:\b(?:around|about|roughly|circa)\s+)?${MONEY}\s*(?:\+|or\s+(?:more|above|higher)|and\s+(?:above|up|over)|plus\b|minimum\b)`, "i"));
    if (min) {
      const value = amount(min[1], min[2]);
      if (value !== null) intent.salary = { min: value, max: null, phrase: clean(min[0]) };
    }
  }
  if (!intent.salary) {
    const approx = take(state, new RegExp(String.raw`\b(?:around|about|roughly|circa)\s+${MONEY}`, "i"));
    const value = approx ? amount(approx[1], approx[2]) : null;
    if (value !== null) intent.clarifications.push(`Should £${value.toLocaleString("en-GB")} be your minimum salary? Say “at least £${Math.round(value / 1000)}k” to use it.`);
  }
  if (take(state, /\b£?\s*\d+(?:\.\d+)?\s*(?:an?|per)\s+(?:hour|day)\b|\b(?:hourly|daily)\s+rate\b/i)) {
    intent.notes.push({ kind: "unsupported", text: "Hourly or daily rates can't be used as a minimum yet — only annual salaries." });
  }

  // 3. Benefits (allowance before car; van/vehicle before car).
  for (const [re, id] of BENEFIT_PHRASES) {
    const m = take(state, new RegExp(re.source, "i"));
    if (!m || intent.benefits.some((b) => b.id === id)) continue;
    const before = original.slice(Math.max(0, original.slice(0, m.index).search(/[^.;!?]*$/)), m.index);
    intent.benefits.push({ id, label: BENEFIT_LABEL.get(id) ?? id, priority: PREFERRED_CUE.test(before) ? "preferred" : "important", phrase: clean(m[0]) });
  }

  // 4. Location: a known place (any case), or a capitalised place after "in/around/near".
  const vague = take(state, VAGUE_PLACE);
  const radius = /\bwithin\s+\d+\s*(?:miles?|mi|km|kilometres?)\s+of\b/i.test(original);
  for (const place of PLACES) {
    const m = new RegExp(String.raw`\b${place.replace(/ /g, "\\s+")}\b`, "i").exec(state.text);
    if (m) {
      take(state, new RegExp(String.raw`\b${place.replace(/ /g, "\\s+")}\b`, "i"));
      intent.location = { value: place, phrase: m[0] };
      break;
    }
  }
  if (!intent.location) {
    const m = /\b(?:in|around|near|based\s+in)\s+([A-Z][a-z'-]+(?:[ -][A-Z][a-z'-]+){0,2})\b/.exec(state.text);
    if (m) {
      take(state, new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      intent.location = { value: m[1], phrase: m[0] };
    }
  }
  if (radius && intent.location) intent.notes.push({ kind: "unsupported", text: `Distances can't be searched yet — your agent will search “${intent.location.value}”.` });
  if (vague && !intent.location) intent.clarifications.push("Where should your agent search? Add a town, city or region (for example “around Leeds”).");
  if (/\b(?:remote(?:ly)?|work\s+from\s+home|wfh|hybrid)\b/i.test(original)) {
    take(state, /\b(?:remote(?:ly)?|work\s+from\s+home|wfh|hybrid)\b/i);
    intent.notes.push({ kind: "unsupported", text: "Remote or hybrid working can't be filtered yet — the job sites don't say it reliably." });
  }

  // 5. Career directions (longest phrases first; each phrase used once).
  for (const [re, ids] of ROLE_PHRASES) {
    const global = new RegExp(re.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = global.exec(state.text))) {
      const phrase = clean(m[0]);
      if (!phrase) continue;
      for (const id of ids) {
        if (!intent.roles.some((r) => r.id === id)) intent.roles.push({ id, label: roleCategory(id)?.label ?? id, phrase });
      }
    }
    state.text = state.text.replace(global, (x) => " ".repeat(x.length));
  }

  // 6. Other job titles the user named ("marine biologist jobs") become their own searches.
  const STOP = /^(?:find|show|get|search|look(?:ing)?|for|me|i|i'm|im|am|want|would|like|some|any|good|new|the|a|an|open|to|or|and|jobs?|roles?|work|positions?|vacancies)$/i;
  const titles = state.text.match(/\b([a-z][a-z' -]{1,58}?)\s+(?:jobs?|roles?|positions?|vacancies)\b/gi) ?? [];
  for (const raw of titles) {
    for (const part of raw.replace(/\s+(?:jobs?|roles?|positions?|vacancies)$/i, "").split(/,|\bor\b|\band\b/i)) {
      const words = part.trim().split(/\s+/).filter((w) => w && !STOP.test(w));
      const title = words.join(" ");
      if (title.length >= 3 && title.length <= 60 && !intent.ownSearches.some((s) => s.toLowerCase() === title.toLowerCase())) intent.ownSearches.push(title);
    }
  }

  // 7. Ask when the most important part — what kind of work — is missing.
  if (intent.roles.length === 0 && intent.ownSearches.length === 0) {
    intent.clarifications.unshift(
      original.length === 0
        ? "Tell your agent what kind of work you want — for example “territory manager jobs around London with a company car”."
        : "What kind of work should your agent look for? Add a job title or type of work (for example “driving” or “territory manager”)."
    );
  }
  return intent;
}

// ── From an interpretation to the existing preferences ─────────────────────

export type IntentItemKey = `role:${string}` | `own:${string}` | "location" | "salary" | `benefit:${string}`;

/** The plain-language items shown under "I understood", each removable by its key. */
export function intentItems(intent: SearchIntent): { key: IntentItemKey; text: string; kind: "role" | "own" | "location" | "salary" | "benefit" }[] {
  const gbp = (n: number) => `£${n.toLocaleString("en-GB")}`;
  return [
    ...intent.roles.map((r) => ({ key: `role:${r.id}` as IntentItemKey, text: r.label, kind: "role" as const })),
    ...intent.ownSearches.map((s) => ({ key: `own:${s}` as IntentItemKey, text: `“${s}”`, kind: "own" as const })),
    ...(intent.location ? [{ key: "location" as IntentItemKey, text: intent.location.value, kind: "location" as const }] : []),
    ...(intent.salary
      ? [{ key: "salary" as IntentItemKey, text: intent.salary.max ? `${gbp(intent.salary.min)}–${gbp(intent.salary.max)} (searching from ${gbp(intent.salary.min)})` : `At least ${gbp(intent.salary.min)}`, kind: "salary" as const }]
      : []),
    ...intent.benefits.map((b) => ({ key: `benefit:${b.id}` as IntentItemKey, text: `${b.label} — ${b.priority === "important" ? "Important" : "Nice to have"}`, kind: "benefit" as const })),
  ];
}

export type IntentPreferences = {
  preferences: {
    targetRoles: string[];
    searchTerms: string[];
    location: string;
    excludeKeywords: string[];
    minSalary: number | null;
    benefits: Partial<Record<BenefitId, BenefitPriority>>;
  };
  /** What came from the saved preferences because the request didn't mention it. */
  kept: string[];
};

/**
 * The preferences to save for an interpretation (minus anything the user
 * removed). What the request says replaces the saved value; what it doesn't
 * mention is kept from the saved preferences and listed in `kept`, so the
 * user sees everything that will be used. Nothing is invented: with no saved
 * preferences, unmentioned fields stay empty (location falls back to the
 * usual London, as before).
 */
export function intentToPreferences(intent: SearchIntent, saved: SearchPreferences | null, removed: ReadonlySet<string> = new Set()): IntentPreferences {
  const kept: string[] = [];
  const roles = intent.roles.filter((r) => !removed.has(`role:${r.id}`)).map((r) => r.id);
  const own = intent.ownSearches.filter((s) => !removed.has(`own:${s}`));
  let targetRoles = roles;
  let searchTerms = own;
  if (roles.length === 0 && own.length === 0 && saved && (saved.targetRoles.length || saved.searchTerms.length)) {
    targetRoles = [...saved.targetRoles];
    searchTerms = [...saved.searchTerms];
    kept.push("the kinds of work you saved");
  }

  const location = intent.location && !removed.has("location") ? intent.location.value : saved?.location ?? "London";
  if (!(intent.location && !removed.has("location"))) kept.push(saved ? `your location (${saved.location})` : "the usual location (London)");

  const salary = intent.salary && !removed.has("salary") ? intent.salary.min : saved?.minSalary ?? null;
  if (!(intent.salary && !removed.has("salary")) && saved?.minSalary != null) kept.push(`your £${saved.minSalary.toLocaleString("en-GB")} minimum salary`);

  const benefits: Partial<Record<BenefitId, BenefitPriority>> = { ...(saved?.benefits ?? {}) };
  if (Object.keys(benefits).length > 0) kept.push("your saved benefit preferences");
  for (const b of intent.benefits) if (!removed.has(`benefit:${b.id}`)) benefits[b.id] = b.priority;

  return {
    preferences: { targetRoles, searchTerms, location, excludeKeywords: saved?.excludeKeywords ?? [], minSalary: salary, benefits },
    kept,
  };
}
