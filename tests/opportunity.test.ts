import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TestDb } from "./helpers.ts";
import { freshDb, quietly } from "./helpers.ts";
import { detectBenefits } from "../lib/pipeline/benefits.ts";
import { opportunityFactors, opportunityReasons } from "../lib/pipeline/opportunity.ts";
import type { OpportunityJob } from "../lib/pipeline/opportunity.ts";
import { validatePreferences } from "../lib/pipeline/preferences.ts";
import type { SearchPreferences } from "../lib/pipeline/preferences.ts";
import { buildMatchPrompt } from "../lib/pipeline/match-scoring.ts";
import { getDashboard } from "../lib/pipeline/dashboard.ts";
import { putPreferences } from "../lib/pipeline/preferences.ts";
import { createCandidate, createProfileVersion } from "../lib/repositories/candidates.ts";
import { recordJobListing } from "../lib/repositories/jobs.ts";
import { recordMatch } from "../lib/repositories/matches.ts";

// Opportunity intelligence (3h): why a job is relevant to this user, as
// deterministic, explainable factors. It sits alongside match/v3.

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

const prefs = (input: Record<string, unknown>): SearchPreferences => {
  const result = validatePreferences({ location: "London", ...input });
  if (!result.ok) assert.fail(JSON.stringify(result.fieldErrors));
  return result.preferences;
};
// The scratch preferences from the brief.
const TERRITORY = prefs({ targetRoles: ["territory_management"], benefits: { companyCar: "important", travelExpenses: "important", accommodation: "preferred" } });

const job = (over: Partial<OpportunityJob> = {}): OpportunityJob => ({ title: "Territory Manager", location: "London", salaryMin: 35000, salaryMax: 40000, salaryIsPredicted: false, ...over });

function explain(description: string, p: SearchPreferences | null = TERRITORY, j: Partial<OpportunityJob> = {}) {
  const factors = opportunityFactors(job(j), detectBenefits({ title: job(j).title, description }), p, { kind: "snippet", chars: description.length });
  const reasons = opportunityReasons(factors);
  return {
    factors,
    positive: reasons.filter((r) => r.kind === "positive").map((r) => r.text),
    cautions: reasons.filter((r) => r.kind === "caution").map((r) => r.text),
  };
}
const benefit = (r: ReturnType<typeof explain>, id: string) => r.factors.benefitFit.items.find((i) => i.id === id)?.status;

describe("3h: the brief's example", () => {
  test("Territory Manager, car + travel confirmed, accommodation unclear", () => {
    const r = explain("Company car provided. Travel expenses paid. Help finding accommodation if you relocate.");
    assert.deepEqual(r.positive, [
      "Matches your Territory Management career direction",
      "In your preferred location (London)",
      "Salary information is available",
      "Company car matches an important preference",
      "Travel expenses match an important preference",
    ]);
    assert.deepEqual(r.cautions, ["Accommodation is unclear — the advert mentions it but doesn't confirm it"]);
  });
});

describe("3h: role / career-direction fit", () => {
  test("category, own search, no match and no preferences", () => {
    assert.deepEqual(explain("", TERRITORY).factors.roleFit, { status: "match", via: "category", direction: "Territory Management" });
    const own = prefs({ searchTerms: ["Technical operator"] });
    assert.equal(explain("", own, { title: "Senior Technical Operator" }).positive[0], "Matches your “Technical operator” search");
    assert.equal(explain("", TERRITORY, { title: "Delivery Driver" }).factors.roleFit.status, "no_match");
    assert.equal(explain("", null).factors.roleFit.status, "not_applicable");
    assert.ok(!explain("", TERRITORY, { title: "Delivery Driver" }).cautions.some((c) => /career|role/i.test(c)), "no negative claim about role fit");
  });

  test("A. Software Engineering, B. Territory Management, C. Driving", () => {
    const software = prefs({ targetRoles: ["software_engineering", "android"] });
    assert.equal(explain("Private medical insurance. Funded training courses.", software, { title: "Junior Software Engineer" }).positive[0], "Matches your Software Engineering career direction");
    assert.equal(explain("", TERRITORY).positive[0], "Matches your Territory Management career direction");
    const driving = prefs({ targetRoles: ["driving", "delivery_driving"], benefits: { accommodation: "important", companyVehicle: "important" } });
    const d = explain("Van provided. Accommodation provided during multi-day routes.", driving, { title: "Delivery Driver" });
    assert.equal(d.positive[0], "Matches your Driving career direction");
    assert.ok(d.positive.includes("Accommodation matches an important preference"));
    assert.ok(d.positive.includes("Company vehicle matches an important preference"));
  });
});

describe("3h: benefit preference fit (evidence only)", () => {
  test("company car: confirmed → match; allowance → not a match (and said so); own vehicle → not a match", () => {
    assert.equal(benefit(explain("Company car provided."), "companyCar"), "match");
    const allowance = explain("£5,000 car allowance.");
    assert.equal(benefit(allowance, "companyCar"), "not_stated");
    assert.ok(allowance.cautions.includes("A car allowance is offered, not a company car"));
    assert.ok(!allowance.positive.some((p) => p.startsWith("Company car")));
    const own = explain("Own vehicle required.");
    assert.equal(benefit(own, "companyCar"), "not_stated");
    assert.ok(own.cautions.includes("The advert asks for your own vehicle"));
    const licence = explain("Full UK driving licence required.");
    assert.equal(benefit(licence, "companyCar"), "not_stated");
    assert.deepEqual(licence.cautions, [], "a licence requirement says nothing about a car");
  });

  test("travel: mileage/expenses → match; travel required → not enough evidence", () => {
    assert.equal(benefit(explain("All business mileage reimbursed."), "travelExpenses"), "match");
    assert.equal(benefit(explain("Travel expenses paid."), "travelExpenses"), "match");
    const required = explain("Travel required across the region.");
    assert.equal(benefit(required, "travelExpenses"), "not_stated");
    assert.ok(required.cautions.includes("Travel is required, but paid travel isn't stated"));
  });

  test("accommodation: staff accommodation → match; generic benefits → not stated; mention → unclear", () => {
    assert.equal(benefit(explain("Staff accommodation provided."), "accommodation"), "match");
    assert.equal(benefit(explain("Excellent benefits package."), "accommodation"), "not_stated");
    assert.equal(benefit(explain("Help finding accommodation nearby."), "accommodation"), "unclear");
  });

  test("silent advert: nothing claimed, nothing to warn about beyond what is missing", () => {
    const silent = explain("Join our friendly team.");
    assert.deepEqual(silent.factors.benefitFit.items.map((i) => i.status), ["not_stated", "not_stated", "not_stated"]);
    assert.ok(!silent.positive.some((p) => /\b(car|travel|accommodation|vehicle)\b/i.test(p)));
    assert.deepEqual(silent.cautions, []);
  });

  test("'company car or allowance' is unclear, not also an allowance warning", () => {
    const r = explain("Company car or car allowance.");
    assert.equal(benefit(r, "companyCar"), "unclear");
    assert.deepEqual(r.cautions, ["Company car is unclear — the advert mentions it but doesn't confirm it"]);
  });
});

describe("3h: salary and location", () => {
  test("salary stated / below minimum / estimated / day rate / unavailable — never inferred from the title", () => {
    assert.ok(explain("", TERRITORY).positive.includes("Salary information is available"));
    const withMin = prefs({ targetRoles: ["territory_management"], minSalary: 35000 });
    assert.ok(explain("", withMin).positive.includes("Salary meets your £35,000 minimum"));
    assert.ok(explain("", withMin, { salaryMin: 28000, salaryMax: 30000 }).cautions.includes("Salary is below your £35,000 minimum"));
    assert.ok(explain("", withMin, { salaryIsPredicted: true }).cautions.includes("The salary shown is an estimate, not from the advert"));
    assert.ok(explain("", TERRITORY, { salaryMin: 350, salaryMax: 400 }).positive.includes("Pay is stated (a day rate)"));
    const none = explain("", TERRITORY, { title: "Senior Territory Manager", salaryMin: null, salaryMax: null });
    assert.equal(none.factors.compensation.status, "unavailable");
    assert.ok(none.cautions.includes("Salary is not stated in the advert"));
    assert.ok(!none.positive.some((p) => /salary|pay/i.test(p)), "seniority never implies a salary");
  });

  test("location: your area named → match; elsewhere → no claim; missing / Unknown / postcode only → incomplete", () => {
    assert.equal(explain("", TERRITORY, { location: "Central London" }).factors.locationFit.status, "match");
    const elsewhere = explain("", TERRITORY, { location: "Croydon" });
    assert.equal(elsewhere.factors.locationFit.status, "elsewhere");
    assert.ok(!elsewhere.positive.some((p) => /location/i.test(p)) && !elsewhere.cautions.some((c) => /location/i.test(c)), "no claim either way");
    for (const location of [null, "", "Unknown", "SE19 6SG", "S11DA"]) {
      const r = explain("", TERRITORY, { location });
      assert.equal(r.factors.locationFit.status, "incomplete", String(location));
      assert.ok(r.cautions.includes("Location details are incomplete"));
    }
  });
});

describe("3h: evidence and transparency", () => {
  test("every sentence comes from a named factor; a short summary is flagged as limited", () => {
    const factors = opportunityFactors(job(), detectBenefits({ description: "Company car provided." }), TERRITORY, { kind: "snippet", chars: 22 });
    for (const r of opportunityReasons(factors)) assert.ok(["roleFit", "locationFit", "compensation", "benefitFit", "evidence"].includes(r.factor));
    assert.deepEqual(factors.evidence, { source: "advert_summary", chars: 22, limited: true });
    assert.equal(opportunityFactors(job(), detectBenefits({}), null, { kind: "full", chars: 4000 }).evidence.limited, false);
    assert.equal(opportunityFactors(job(), detectBenefits({}), null, null).evidence.source, "none");
  });

  test("no hidden score: the factors contain no numeric weighting", () => {
    const code = read("lib/pipeline/opportunity.ts")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    assert.doesNotMatch(code, /\bweight|\* 0\.\d|score\s*[+=]/i);
  });

  test("no false positives across a set of tricky adverts", () => {
    for (const text of ["Full UK driving licence required", "Travel required", "Must be willing to travel", "Competitive salary and benefits", "Excellent benefits package", "Own vehicle essential", "Relocation may be required"]) {
      assert.deepEqual(explain(text).positive.filter((p) => /\b(car|travel|accommodation|vehicle)\b/i.test(p)), [], text);
    }
  });
});

// ── match/v3 must be untouched ──────────────────────────────────────────────

describe("3h: match/v3 scoring is unchanged", () => {
  const h = (s: string) => crypto.createHash("sha256").update(s.replace(/\r\n/g, "\n")).digest("hex");

  test("the match route and scoring module are byte-identical to 7264447 (bump MATCH_PROMPT_VERSION and these pins together on purpose)", () => {
    assert.equal(h(read("app/api/match/route.ts")), "ef112d155048614c24e9a4cbb5d3af2d79536891b6891af64e3899d14107e8b2");
    assert.equal(h(read("lib/pipeline/match-scoring.ts")), "be378063794df4bd46d250822f0602ec4a4daa0e79046cb964928a38195a7790");
    const route = read("app/api/match/route.ts");
    assert.match(route, /const MATCH_PROMPT_VERSION = "match\/v3";/);
    assert.match(route, /: Math\.round\(modelScore \* 0\.6 \+ breakdownScore \* 0\.4\);/);
  });

  test("the scoring prompt for a fixed input is unchanged", () => {
    const prompt = buildMatchPrompt(
      { technicalSkills: ["Kotlin", "Java"], summary: "Graduate developer", experienceLevel: "Junior" },
      { jobId: 1, title: "Territory Manager", company: "Sample Co", description: "Company car provided. Travel expenses paid." },
      0
    );
    assert.equal(h(prompt), "7e2a3ecddc894c4f71e96205a2a90d8a8989a5a507e7d5e033b089d19c084bf4");
  });

  let t: TestDb;
  beforeEach(() => {
    t = quietly(freshDb);
  });
  afterEach(() => t.close());

  test("stored scores and their order are exactly what the dashboard shows, whatever the opportunity factors say", () => {
    const c = createCandidate(t.db, { fullName: "A" });
    const profileId = createProfileVersion(t.db, { candidateId: c.id, origin: "ai_extraction", analysis: {}, structuredCv: { name: "A", education: [], projects: [], experience: [] } }).id;
    putPreferences(t.db, { preferences: { targetRoles: ["territory_management"], location: "London", benefits: { companyCar: "important" } } });
    const add = (title: string, description: string, score: number, n: number) =>
      recordMatch(t.db, {
        jobId: recordJobListing(t.db, { sourceId: "reed", externalId: `O${n}`, title, company: `Co ${n}`, location: "London", url: null, salaryMin: 36000, salaryMax: 40000, salaryIsPredicted: false, description }).jobId,
        candidateProfileId: profileId, outcome: "scored", score,
      });
    add("Territory Manager", "Company car provided. Travel expenses paid.", 55, 1); // every factor positive, low score
    add("Java Developer", "Nothing here.", 91, 2);
    add("Delivery Driver", "Own vehicle required.", 73, 3);
    const d = getDashboard(t.db);
    assert.deepEqual(d.topMatches.map((m) => [m.title, m.score]), [["Java Developer", 91], ["Delivery Driver", 73], ["Territory Manager", 55]]);
    assert.ok(d.topMatches[2].standsOut.length >= 3, "the low-scored job still explains why it fits — without being moved");
  });
});
