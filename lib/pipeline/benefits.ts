// Employer benefits found in a job advert's own text (flexible career search).
// Deterministic and conservative — no model calls:
//   • "confirmed" only when the advert says the employer provides it;
//   • "unclear" when it is mentioned but provision is ambiguous
//     ("company car or allowance", "van driver", "expenses");
//   • "not_stated" otherwise — including when it is negated ("no company car").
// Requirements are kept apart from benefits: "own vehicle required", "full UK
// driving licence" or "travel required" never become a provided car or paid
// travel. Framework free: used by the dashboard and in tests.

export type BenefitStatus = "confirmed" | "unclear" | "not_stated";
export type BenefitSignal = { status: BenefitStatus; evidence: string | null };

export const BENEFITS = [
  { id: "companyCar", label: "Company car", unclearNote: "Car mentioned — provision unclear", preference: true },
  { id: "companyVehicle", label: "Company vehicle / van", unclearNote: "Vehicle mentioned — provision unclear", preference: true },
  { id: "carAllowance", label: "Car allowance", unclearNote: "Allowance mentioned — details unclear", preference: true },
  { id: "fuelCard", label: "Fuel card", unclearNote: "Fuel mentioned — details unclear", preference: true },
  { id: "travelExpenses", label: "Travel expenses paid", unclearNote: "Expenses mentioned — what is covered is unclear", preference: true },
  { id: "mileage", label: "Mileage paid", unclearNote: "Mileage mentioned — payment unclear", preference: true },
  { id: "accommodation", label: "Accommodation provided", unclearNote: "Accommodation mentioned — provision unclear", preference: true },
  { id: "relocation", label: "Relocation support", unclearNote: "Relocation mentioned — support unclear", preference: true },
  { id: "training", label: "Paid training", unclearNote: "Training mentioned", preference: true },
  { id: "bonus", label: "Bonus", unclearNote: "Bonus mentioned", preference: false },
  { id: "commission", label: "Commission", unclearNote: "Commission mentioned", preference: false },
  { id: "pension", label: "Pension", unclearNote: "Pension mentioned", preference: false },
  { id: "healthcare", label: "Private healthcare", unclearNote: "Healthcare mentioned", preference: false },
] as const;

export type BenefitId = (typeof BENEFITS)[number]["id"];
export const BENEFIT_IDS = BENEFITS.map((b) => b.id) as BenefitId[];
/** The benefits a user can mark as important to them. */
export const PREFERABLE_BENEFITS = BENEFITS.filter((b) => b.preference).map((b) => b.id) as BenefitId[];

export type RequirementId = "ownVehicle" | "drivingLicence" | "travel";
export type BenefitReport = {
  benefits: Record<BenefitId, BenefitSignal>;
  /** Things the advert asks of the candidate (never benefits). */
  requirements: Record<RequirementId, { present: boolean; evidence: string | null }>;
};

type Rule = {
  confirmed: RegExp[];
  /** Mentions that are not a clear provision. */
  unclear?: RegExp[];
  /** In the same clause, these turn a confirmed match into "unclear". */
  hedges?: RegExp[];
  /** Also look in the job title (e.g. "Field Sales Executive — Company Car"). */
  inTitle?: boolean;
};

const HEDGES = /\b(may|might|potential(ly)?|possible|possibly|depending|subject to|after (your )?probation|eligible after)\b/i;

const RULES: Record<BenefitId, Rule> = {
  companyCar: {
    confirmed: [/\bcompany car\b/i, /\b(fully[- ])?expensed car\b/i, /\bcar (is |will be )?(provided|supplied|included|given)\b/i, /\b(provided|supplied) with a (company )?car\b/i],
    hedges: [HEDGES, /\bor (a )?(car|cash) allowance\b/i, /\bcar or (cash|car)? ?allowance\b/i, /\bor allowance\b/i],
    inTitle: true,
  },
  companyVehicle: {
    confirmed: [/\bcompany (van|vehicle)\b/i, /\b(van|vehicle) (is |will be )?(provided|supplied|included|given)\b/i, /\b(provided|supplied) with a (company |work )?(van|vehicle)\b/i],
    unclear: [/\b(works? van|van driver|van|vehicle)\b/i],
    hedges: [HEDGES],
    inTitle: true,
  },
  carAllowance: {
    confirmed: [/\b(car|vehicle|car cash) allowance\b/i, /\bcar cash\b/i],
    hedges: [HEDGES],
    inTitle: true,
  },
  fuelCard: {
    confirmed: [/\bfuel card\b/i, /\bfuel (is |will be )?(paid|covered|provided|included)\b/i],
    unclear: [/\bfuel\b/i],
    hedges: [HEDGES],
    inTitle: true,
  },
  travelExpenses: {
    confirmed: [
      /\btravel(ling)? expenses\b/i,
      /\bexpenses (are |will be )?(paid|covered|reimbursed|refunded)\b/i,
      /\ball expenses paid\b/i,
      /\bpaid travel\b/i,
      /\btravel (is |will be )?(paid|covered|reimbursed|funded)\b/i,
      /\btravel allowance\b/i,
      /\b(rail|train) (travel|fares?) (is |are |will be )?(paid|covered|provided)\b/i,
      /\bflights? (is |are |will be )?(paid|covered|provided|included)\b/i,
    ],
    unclear: [/\bexpenses\b/i],
    hedges: [HEDGES],
    inTitle: true,
  },
  mileage: {
    confirmed: [/\b(business )?mileage (is |will be )?(paid|reimbursed|covered|allowance)\b/i, /\bpaid (business )?mileage\b/i, /\b\d{1,2}p (per|a) mile\b/i, /\bmileage claims?\b/i],
    unclear: [/\bmileage\b/i],
    hedges: [HEDGES],
  },
  accommodation: {
    confirmed: [
      /\baccommodation (is |will be )?(provided|included|supplied|paid|covered|available)\b/i,
      /\b(staff|free|paid|on-?site|temporary) accommodation\b/i,
      /\baccommodation during\b/i,
      /\b(provided|includes?|including|with) (free )?accommodation\b/i,
    ],
    unclear: [/\baccommodation\b/i, /\blive[- ]in\b/i],
    hedges: [HEDGES],
    inTitle: true,
  },
  relocation: {
    confirmed: [/\breloc(ation)? (package|support|assistance|allowance|bonus)\b/i, /\brelocation (is |will be )?(provided|available|offered|paid|covered)\b/i],
    unclear: [/\breloca(tion|te)\b/i],
    hedges: [HEDGES],
    inTitle: true,
  },
  training: {
    confirmed: [/\b(paid|funded|fully funded|company[- ]paid|free) (training|qualifications?|courses?|certifications?)\b/i, /\b(full )?training (is |will be )?(provided|paid|funded|given)\b/i],
    unclear: [/\btraining\b/i],
    hedges: [HEDGES],
  },
  bonus: { confirmed: [/\bbonus(es)?\b/i], hedges: [HEDGES] },
  commission: { confirmed: [/\bcommission\b/i, /\bOTE\b/] },
  pension: { confirmed: [/\b(company|workplace|contributory|matched|employer) pension\b/i, /\bpension (scheme|contributions?|plan)\b/i] },
  healthcare: { confirmed: [/\b(private medical|private health(care)?|health insurance|medical insurance|healthcare (plan|scheme|cover))\b/i] },
};

const REQUIREMENTS: Record<RequirementId, RegExp> = {
  ownVehicle: /\b(own|your own|a) (car|vehicle|transport|van)\b(?=[^.;]*\b(required|essential|needed|necessary|must)\b)|\bmust have (your own |a )?(car|vehicle|transport)\b|\bown (car|vehicle|transport)\b|\b(car|vehicle|transport) (is )?(required|essential|needed)\b/i,
  drivingLicence: /\bdriving licen[cs]e\b|\bfull (uk )?licen[cs]e\b/i,
  travel: /\btravel (is )?(required|essential)\b|\bwilling(ness)? to travel\b|\bextensive travel\b|\btravel(ling)? (across|around|throughout)\b|\bable to travel\b/i,
};

// A negation just before the match in the same clause ("no company car",
// "without a fuel card", "your own vehicle"), or just after ("… not provided").
const NEGATION_BEFORE = /\b(no|not|without|non|own|excluding)\b[^,]{0,25}$/i;
const NEGATION_AFTER = /^[^,]{0,12}\b(not|n't)\b/i;

/** Sentences / list items: benefits are usually listed with these separators. */
function clauses(text: string): string[] {
  return text
    .replace(/<[^>]+>/g, " ")
    .split(/[.;!?\n\r•|·]+|\s[-–—]\s/)
    .map((c) => c.replace(/\s+/g, " ").trim())
    .filter((c) => c.length > 1);
}

function evidenceOf(clause: string, index: number): string {
  if (clause.length <= 140) return clause;
  const start = Math.max(0, index - 50);
  return `${start > 0 ? "…" : ""}${clause.slice(start, start + 140).trim()}…`;
}

function firstMatch(clause: string, patterns: RegExp[]): RegExpExecArray | null {
  for (const pattern of patterns) {
    const m = pattern.exec(clause);
    if (m) return m;
  }
  return null;
}

function negated(clause: string, m: RegExpExecArray): boolean {
  return NEGATION_BEFORE.test(clause.slice(0, m.index)) || NEGATION_AFTER.test(clause.slice(m.index + m[0].length));
}

function detectOne(rule: Rule, titleClauses: string[], bodyClauses: string[]): BenefitSignal {
  let unclear: BenefitSignal | null = null;
  const all = rule.inTitle ? [...titleClauses, ...bodyClauses] : bodyClauses;
  for (const clause of all) {
    const m = firstMatch(clause, rule.confirmed);
    if (m && !negated(clause, m)) {
      if (rule.hedges?.some((h) => h.test(clause))) {
        unclear ??= { status: "unclear", evidence: evidenceOf(clause, m.index) };
        continue;
      }
      return { status: "confirmed", evidence: evidenceOf(clause, m.index) };
    }
    if (!m && rule.unclear && !unclear) {
      const u = firstMatch(clause, rule.unclear);
      // "own vehicle", "vehicle required" or a licence requirement is not a vague benefit mention.
      if (u && !negated(clause, u) && !/\b(required|essential|must|licen[cs]e|own)\b/i.test(clause)) {
        unclear = { status: "unclear", evidence: evidenceOf(clause, u.index) };
      }
    }
  }
  return unclear ?? { status: "not_stated", evidence: null };
}

/** The benefits and requirements stated in a job's title and description. */
export function detectBenefits(input: { title?: string | null; description?: string | null }): BenefitReport {
  const titleClauses = clauses(input.title ?? "");
  const bodyClauses = clauses(input.description ?? "");
  const benefits = {} as Record<BenefitId, BenefitSignal>;
  for (const id of BENEFIT_IDS) benefits[id] = detectOne(RULES[id], titleClauses, bodyClauses);
  // Paid mileage is a travel expense the employer covers.
  if (benefits.travelExpenses.status !== "confirmed" && benefits.mileage.status === "confirmed") benefits.travelExpenses = { ...benefits.mileage };
  const requirements = {} as BenefitReport["requirements"];
  for (const id of Object.keys(REQUIREMENTS) as RequirementId[]) {
    const clause = [...titleClauses, ...bodyClauses].find((c) => REQUIREMENTS[id].test(c));
    requirements[id] = { present: Boolean(clause), evidence: clause ? evidenceOf(clause, 0) : null };
  }
  return { benefits, requirements };
}

export type BenefitPriority = "preferred" | "important";
export type BenefitPreferences = Partial<Record<BenefitId, BenefitPriority>>;

export type BenefitHighlight = {
  id: BenefitId;
  label: string;
  status: BenefitStatus;
  evidence: string | null;
  /** The user's priority for it, if they chose one. */
  priority: BenefitPriority | null;
  note: string | null;
};

const LABEL = new Map(BENEFITS.map((b) => [b.id as BenefitId, b]));

/**
 * What to show for a job: confirmed benefits (the ones the user cares about
 * first), plus unclear mentions of benefits the user cares about, so they
 * know to check. Never a positive claim without evidence.
 */
export function benefitHighlights(report: BenefitReport, preferences: BenefitPreferences = {}): BenefitHighlight[] {
  const rank = (id: BenefitId) => (preferences[id] === "important" ? 0 : preferences[id] === "preferred" ? 1 : 2);
  const items: BenefitHighlight[] = [];
  for (const id of BENEFIT_IDS) {
    const signal = report.benefits[id];
    const priority = preferences[id] ?? null;
    if (signal.status === "confirmed" || (signal.status === "unclear" && priority)) {
      items.push({
        id,
        label: LABEL.get(id)!.label,
        status: signal.status,
        evidence: signal.evidence,
        priority,
        note: signal.status === "unclear" ? LABEL.get(id)!.unclearNote : null,
      });
    }
  }
  return items.sort((a, b) => (a.status === b.status ? 0 : a.status === "confirmed" ? -1 : 1) || rank(a.id) - rank(b.id));
}
