import type { BenefitId, BenefitPriority, BenefitReport } from "./benefits.ts";
import { BENEFITS } from "./benefits.ts";
import { roleCategory } from "./careers.ts";
import type { SearchPreferences } from "./preferences.ts";
import { ANNUAL_SALARY_THRESHOLD, knownAnnualSalary, titleHasKeyword } from "./preferences.ts";

// Opportunity intelligence: WHY a job is relevant to this user, as plain,
// checkable facts. Deterministic and fast (no model calls), built only from
// stored data — the job's title, location, salary fields and advert text
// (through the existing benefit detector) — and the user's preferences.
//
// There is no hidden weighting and no score: each factor has a small set of
// named states, and every sentence shown is derived from one of them. It sits
// alongside match/v3; it never changes a score or the order of jobs.

export type RoleFit =
  | { status: "match"; via: "category"; direction: string }
  | { status: "match"; via: "own_search"; direction: string }
  | { status: "no_match" | "not_applicable"; via: null; direction: null };

export type LocationFit = {
  /** "elsewhere" makes no claim that the job is unsuitable — only that it doesn't name your area. */
  status: "match" | "elsewhere" | "incomplete" | "not_applicable";
  jobLocation: string | null;
  preferred: string | null;
};

export type Compensation = {
  status: "stated" | "estimated" | "day_rate" | "unavailable";
  /** Compared only with a stated annual salary; null when it can't be compared. */
  meetsMinimum: boolean | null;
  minimum: number | null;
};

export type BenefitFitItem = {
  id: BenefitId;
  label: string;
  priority: BenefitPriority;
  /** "match" = confirmed by the advert; "not_stated" makes no claim about the employer. */
  status: "match" | "unclear" | "not_stated";
};

export type BenefitFit = {
  items: BenefitFitItem[];
  /** Evidence-based "not what you asked for" notes, e.g. a car allowance instead of a company car. */
  distinctions: string[];
};

export type Evidence = {
  source: "full_advert" | "advert_summary" | "none";
  chars: number;
  /** A short summary may leave out benefits and details. */
  limited: boolean;
};

export type OpportunityFactors = {
  roleFit: RoleFit;
  locationFit: LocationFit;
  compensation: Compensation;
  benefitFit: BenefitFit;
  evidence: Evidence;
};

export type OpportunityReason = { kind: "positive" | "caution"; factor: keyof OpportunityFactors; text: string };

export type OpportunityJob = {
  title: string;
  location: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryIsPredicted: boolean;
};

/** Short names for sentences, and whether they read as plural ("Travel expenses match"). */
const SHORT: Partial<Record<BenefitId, [string, boolean]>> = {
  companyCar: ["Company car", false],
  companyVehicle: ["Company vehicle", false],
  carAllowance: ["Car allowance", false],
  fuelCard: ["Fuel card", false],
  travelExpenses: ["Travel expenses", true],
  mileage: ["Paid mileage", false],
  accommodation: ["Accommodation", false],
  relocation: ["Relocation support", false],
  training: ["Paid training", false],
};
const shortName = (id: BenefitId) => SHORT[id] ?? [BENEFITS.find((b) => b.id === id)?.label ?? id, false];
const LABELS = new Map(BENEFITS.map((b) => [b.id as BenefitId, b.label]));

/** A missing location, "Unknown", or only a UK postcode. */
function locationIncomplete(location: string | null): boolean {
  const text = (location ?? "").trim();
  if (text.length < 2 || /^unknown$/i.test(text)) return true;
  return /^[A-Z]{1,2}\d[A-Z\d]?\s*\d?[A-Z]{0,2}$/i.test(text);
}

function roleFitFor(title: string, preferences: SearchPreferences | null): RoleFit {
  if (!preferences) return { status: "not_applicable", via: null, direction: null };
  for (const id of preferences.targetRoles) {
    const category = roleCategory(id);
    if (category && category.terms.some((term) => titleHasKeyword(title, term))) return { status: "match", via: "category", direction: category.label };
  }
  const own = preferences.searchTerms.find((term) => titleHasKeyword(title, term));
  if (own) return { status: "match", via: "own_search", direction: own };
  return preferences.targetRoles.length || preferences.searchTerms.length ? { status: "no_match", via: null, direction: null } : { status: "not_applicable", via: null, direction: null };
}

function locationFitFor(location: string | null, preferences: SearchPreferences | null): LocationFit {
  const preferred = preferences?.location ?? null;
  if (locationIncomplete(location)) return { status: "incomplete", jobLocation: location, preferred };
  if (!preferred) return { status: "not_applicable", jobLocation: location, preferred };
  const matches = titleHasKeyword(location ?? "", preferred);
  return { status: matches ? "match" : "elsewhere", jobLocation: location, preferred };
}

function compensationFor(job: OpportunityJob, preferences: SearchPreferences | null): Compensation {
  const minimum = preferences?.minSalary ?? null;
  const values = [job.salaryMin, job.salaryMax].filter((v): v is number => typeof v === "number" && v > 0);
  if (values.length === 0) return { status: "unavailable", meetsMinimum: null, minimum };
  if (Math.max(...values) < ANNUAL_SALARY_THRESHOLD) return { status: "day_rate", meetsMinimum: null, minimum };
  if (job.salaryIsPredicted) return { status: "estimated", meetsMinimum: null, minimum };
  const annual = knownAnnualSalary(job);
  return { status: "stated", meetsMinimum: minimum === null || annual === null ? null : annual >= minimum, minimum };
}

function benefitFitFor(report: BenefitReport, preferences: SearchPreferences | null): BenefitFit {
  const wanted = (Object.entries(preferences?.benefits ?? {}) as [BenefitId, BenefitPriority][]).sort(([, a], [, b]) => (a === b ? 0 : a === "important" ? -1 : 1));
  const items: BenefitFitItem[] = wanted.map(([id, priority]) => {
    const status = report.benefits[id].status;
    return { id, label: LABELS.get(id) ?? id, priority, status: status === "confirmed" ? "match" : status };
  });
  const confirmed = (id: BenefitId) => report.benefits[id].status === "confirmed";
  const wants = (id: BenefitId) => Boolean(preferences?.benefits?.[id]);
  const distinctions: string[] = [];
  // Only when no company car is mentioned at all ("company car or allowance" is already "unclear").
  if (wants("companyCar") && report.benefits.companyCar.status === "not_stated" && confirmed("carAllowance")) distinctions.push("A car allowance is offered, not a company car");
  if ((wants("companyCar") || wants("companyVehicle")) && !confirmed("companyCar") && !confirmed("companyVehicle") && report.requirements.ownVehicle.present) {
    distinctions.push("The advert asks for your own vehicle");
  }
  if (wants("travelExpenses") && !confirmed("travelExpenses") && report.requirements.travel.present) distinctions.push("Travel is required, but paid travel isn't stated");
  return { items, distinctions };
}

/** All five factors for one job. */
export function opportunityFactors(
  job: OpportunityJob,
  report: BenefitReport,
  preferences: SearchPreferences | null,
  description: { kind: "snippet" | "full"; chars: number } | null
): OpportunityFactors {
  return {
    roleFit: roleFitFor(job.title, preferences),
    locationFit: locationFitFor(job.location, preferences),
    compensation: compensationFor(job, preferences),
    benefitFit: benefitFitFor(report, preferences),
    evidence: description
      ? { source: description.kind === "full" ? "full_advert" : "advert_summary", chars: description.chars, limited: description.kind !== "full" || description.chars < 600 }
      : { source: "none", chars: 0, limited: true },
  };
}

const gbp = (n: number) => `£${n.toLocaleString("en-GB")}`;

/** The plain sentences for the factors: what speaks for the job, then what to check. */
export function opportunityReasons(f: OpportunityFactors): OpportunityReason[] {
  const out: OpportunityReason[] = [];
  const positive = (factor: keyof OpportunityFactors, text: string) => out.push({ kind: "positive", factor, text });
  const caution = (factor: keyof OpportunityFactors, text: string) => out.push({ kind: "caution", factor, text });

  if (f.roleFit.status === "match") {
    positive("roleFit", f.roleFit.via === "category" ? `Matches your ${f.roleFit.direction} career direction` : `Matches your “${f.roleFit.direction}” search`);
  }
  if (f.locationFit.status === "match") positive("locationFit", `In your preferred location (${f.locationFit.preferred})`);

  const c = f.compensation;
  if (c.status === "stated") {
    if (c.meetsMinimum === true) positive("compensation", `Salary meets your ${gbp(c.minimum!)} minimum`);
    else if (c.meetsMinimum === false) caution("compensation", `Salary is below your ${gbp(c.minimum!)} minimum`);
    else positive("compensation", "Salary information is available");
  } else if (c.status === "day_rate") {
    positive("compensation", "Pay is stated (a day rate)");
  }

  for (const item of f.benefitFit.items) {
    const [name, plural] = shortName(item.id);
    if (item.status === "match") positive("benefitFit", `${name} ${plural ? "match" : "matches"} ${item.priority === "important" ? "an important preference" : "one of your nice-to-haves"}`);
  }
  for (const item of f.benefitFit.items) {
    const [name, plural] = shortName(item.id);
    if (item.status === "unclear") caution("benefitFit", `${name} ${plural ? "are" : "is"} unclear — the advert mentions it but doesn't confirm it`);
  }
  for (const text of f.benefitFit.distinctions) caution("benefitFit", text);

  if (c.status === "unavailable") caution("compensation", "Salary is not stated in the advert");
  else if (c.status === "estimated") caution("compensation", "The salary shown is an estimate, not from the advert");
  if (f.locationFit.status === "incomplete") caution("locationFit", "Location details are incomplete");
  return out;
}
