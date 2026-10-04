import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TestDb } from "./helpers.ts";
import { freshDb, quietly } from "./helpers.ts";
import { putPreferences } from "../lib/pipeline/preferences.ts";
import { benefitSummaryFor, getDashboard } from "../lib/pipeline/dashboard.ts";
import type { DashboardMatch, PreferenceFit } from "../lib/pipeline/dashboard.ts";
import { createCandidate, createProfileVersion } from "../lib/repositories/candidates.ts";
import { recordJobListing } from "../lib/repositories/jobs.ts";
import { recordMatch } from "../lib/repositories/matches.ts";

// 3g: benefit-aware job presentation. Presentation only — built from the
// 3f detector and saved preferences; scores are untouched.

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

let t: TestDb;
let profileId: number;
let n = 0;

beforeEach(() => {
  t = quietly(freshDb);
  const c = createCandidate(t.db, { fullName: "A" });
  profileId = createProfileVersion(t.db, { candidateId: c.id, origin: "ai_extraction", analysis: {}, structuredCv: { name: "A", education: [], projects: [], experience: [] } }).id;
});
afterEach(() => t.close());

function job(title: string, description: string, score: number, salary: [number, number] | null = null): number {
  n++;
  const { jobId } = recordJobListing(t.db, {
    sourceId: "reed", externalId: `B${n}`, title, company: `Co ${n}`, location: "London", url: `https://example.invalid/${n}`,
    salaryMin: salary?.[0] ?? null, salaryMax: salary?.[1] ?? null, salaryIsPredicted: false, description,
  });
  recordMatch(t.db, { jobId, candidateProfileId: profileId, outcome: "scored", score });
  return jobId;
}

const prefer = (benefits: Record<string, string>, extra: Record<string, unknown> = {}) =>
  putPreferences(t.db, { preferences: { targetRoles: ["territory_management"], location: "London", benefits, ...extra } });

const byTitle = (title: string): DashboardMatch => {
  const m = getDashboard(t.db).topMatches.find((x) => x.title === title);
  if (!m) assert.fail(`no match ${title}`);
  return m;
};
const confirmedChips = (m: DashboardMatch) => m.benefits.filter((b) => b.status === "confirmed").map((b) => b.id);
const fit = (m: DashboardMatch) => Object.fromEntries(m.preferenceFit.map((p) => [p.id, p.status]));

describe("3g: what the job cards show (confirmed only)", () => {
  test("1–4. company car: shown only when the advert provides one", () => {
    prefer({ companyCar: "important" });
    job("Car Provided", "Company car provided.", 80);
    job("Allowance Only", "Car allowance of £5,000.", 79);
    job("Own Vehicle", "Own vehicle required.", 78);
    job("Licence Only", "Full UK driving licence required.", 77);
    assert.deepEqual(confirmedChips(byTitle("Car Provided")), ["companyCar"]);
    assert.deepEqual(confirmedChips(byTitle("Allowance Only")), ["carAllowance"], "an allowance is not a company car");
    assert.deepEqual(confirmedChips(byTitle("Own Vehicle")), []);
    assert.deepEqual(byTitle("Own Vehicle").requirements, ["Own vehicle needed"]);
    assert.deepEqual(confirmedChips(byTitle("Licence Only")), []);
    assert.deepEqual(byTitle("Licence Only").requirements, ["Driving licence needed"]);
    for (const title of ["Allowance Only", "Own Vehicle", "Licence Only"]) assert.equal(fit(byTitle(title)).companyCar, "not_stated", title);
  });

  test("5–6. travel: expenses paid is shown; travel required is a requirement, not a benefit", () => {
    prefer({ travelExpenses: "important" });
    job("Paid Travel", "All travel expenses paid.", 80);
    job("Travel Needed", "Travel required across the region.", 79);
    assert.deepEqual(confirmedChips(byTitle("Paid Travel")), ["travelExpenses"]);
    assert.deepEqual(confirmedChips(byTitle("Travel Needed")), []);
    assert.deepEqual(byTitle("Travel Needed").requirements, ["Travel required"]);
    assert.equal(fit(byTitle("Travel Needed")).travelExpenses, "not_stated");
  });

  test("7. accommodation provided is shown; 'relocation may be required' is not accommodation", () => {
    prefer({ accommodation: "important" });
    job("Live Away", "Accommodation provided during assignments.", 80);
    job("May Relocate", "Relocation may be required.", 79);
    assert.deepEqual(confirmedChips(byTitle("Live Away")), ["accommodation"]);
    assert.equal(fit(byTitle("May Relocate")).accommodation, "not_stated");
    assert.ok(!confirmedChips(byTitle("May Relocate")).includes("accommodation"));
  });

  test("8. an unclear benefit is never a confirmed badge", () => {
    prefer({ companyCar: "important" });
    job("Car Or Cash", "Company car or car allowance.", 80);
    const m = byTitle("Car Or Cash");
    assert.ok(!confirmedChips(m).includes("companyCar"));
    const car = m.benefits.find((b) => b.id === "companyCar")!;
    assert.equal(car.status, "unclear");
    assert.equal(car.note, "Car mentioned — provision unclear");
    assert.equal(fit(m).companyCar, "unclear");
    assert.ok(!m.standsOut.some((s) => s.startsWith("Company car")), "unclear is not a reason it stands out");
  });

  test("9. not stated is reported as 'not stated', never as a negative claim", () => {
    prefer({ companyCar: "important", accommodation: "important", travelExpenses: "preferred" });
    job("Silent Advert", "Great team, competitive salary and benefits.", 80);
    const m = byTitle("Silent Advert");
    assert.deepEqual(m.preferenceFit.map((p) => p.status), ["not_stated", "not_stated", "not_stated"]);
    assert.deepEqual(m.benefits, []);
    assert.equal(m.benefitSummary, null);
    const ui = read("app/components/CommandCentre.tsx");
    assert.ok(ui.includes('"Not stated in the advert"'));
    assert.doesNotMatch(ui, /not provided|doesn['’]t provide|does not provide/i);
  });

  test("10. benefits you marked come first; important before nice-to-have", () => {
    prefer({ travelExpenses: "preferred", accommodation: "important" });
    job("Job A", "Pension scheme. Company car provided. Travel expenses paid. Accommodation provided.", 80);
    const m = byTitle("Job A");
    assert.deepEqual(m.benefits.map((b) => `${b.id}:${b.priority ?? "-"}`), ["accommodation:important", "travelExpenses:preferred", "companyCar:-", "pension:-"]);
    assert.deepEqual(m.preferenceFit.map((p) => p.id), ["accommodation", "travelExpenses"]);
  });

  test("11. a job without benefits renders cleanly (no empty claims, no reasons invented)", () => {
    job("Bare Snippet", "Junior role.", 70);
    const m = byTitle("Bare Snippet");
    assert.deepEqual([m.benefits, m.requirements, m.standsOut, m.preferenceFit], [[], [], [], []]);
    assert.equal(m.benefitSummary, null);
  });
});

describe("3g: why this job stands out (deterministic, evidence-based)", () => {
  test("the featured Territory Manager: target role, salary floor and two important benefits", () => {
    prefer({ companyCar: "important", travelExpenses: "important", accommodation: "preferred" }, { minSalary: 35000 });
    job("Territory Manager", "Company car provided and a fuel card. All travel expenses paid.", 88, [36000, 40000]);
    const m = byTitle("Territory Manager");
    // Wording since 3h (opportunity intelligence).
    assert.deepEqual(m.standsOut, [
      "Matches your Territory Management career direction",
      "In your preferred location (London)",
      "Salary meets your £35,000 minimum",
      "Company car matches an important preference",
      "Travel expenses match an important preference",
    ]);
    assert.equal(m.benefitSummary, "Company car and travel expenses paid match two of your important preferences.");
    assert.deepEqual(fit(m), { companyCar: "confirmed", travelExpenses: "confirmed", accommodation: "not_stated" });
  });

  test("summary sentences", () => {
    const p = (id: string, priority: "important" | "preferred", status: "confirmed" | "unclear" | "not_stated"): PreferenceFit =>
      ({ id: id as PreferenceFit["id"], label: id === "companyCar" ? "Company car" : id === "fuelCard" ? "Fuel card" : "Accommodation provided", priority, status, evidence: null });
    assert.equal(benefitSummaryFor([p("companyCar", "important", "confirmed")]), "Company car matches one of your important preferences.");
    assert.equal(benefitSummaryFor([p("companyCar", "important", "confirmed"), p("fuelCard", "important", "confirmed"), p("accommodation", "important", "confirmed")]), "Company car, fuel card and accommodation provided match three of your important preferences.");
    assert.equal(benefitSummaryFor([p("fuelCard", "preferred", "confirmed")]), "Fuel card is on your nice-to-have list.");
    assert.equal(benefitSummaryFor([p("companyCar", "important", "unclear"), p("fuelCard", "preferred", "not_stated")]), null);
    assert.equal(benefitSummaryFor([]), null);
  });

  test("scores are never changed by benefits", () => {
    prefer({ companyCar: "important" });
    job("With Car", "Company car provided.", 61);
    job("Without", "Nothing here.", 90);
    const d = getDashboard(t.db);
    assert.deepEqual(d.topMatches.map((m) => [m.title, m.score]), [["Without", 90], ["With Car", 61]]);
  });
});

describe("3g: every kind of career", () => {
  test("15–17. software, territory and driving jobs each show their own benefits", () => {
    prefer({ companyCar: "important" });
    job("Graduate Software Engineer", "Private medical insurance, a company pension scheme and funded training courses.", 80);
    job("Territory Manager", "Company car provided. Fuel card. Mileage paid at 45p per mile.", 79);
    job("Delivery Driver", "Van provided. Accommodation provided during multi-day routes.", 78);
    job("Field Sales Executive - Company Car", "Base salary plus commission.", 77);
    assert.deepEqual(confirmedChips(byTitle("Graduate Software Engineer")).sort(), ["healthcare", "pension", "training"]);
    assert.deepEqual(confirmedChips(byTitle("Territory Manager")).sort(), ["companyCar", "fuelCard", "mileage", "travelExpenses"]);
    assert.deepEqual(confirmedChips(byTitle("Delivery Driver")).sort(), ["accommodation", "companyVehicle"]);
    assert.deepEqual(confirmedChips(byTitle("Field Sales Executive - Company Car")).sort(), ["commission", "companyCar"]);
  });
});

describe("3g: presentation (source checks)", () => {
  const ui = read("app/components/CommandCentre.tsx");

  test("cards show confirmed benefits only, at most 3 in the list and 5 on the featured job", () => {
    assert.match(ui, /const confirmed = match\.benefits\.filter\(\(b\) => b\.status === "confirmed"\)\.slice\(0, max\);/);
    assert.match(ui, /<BenefitChips match=\{match\} max=\{3\} \/>/);
    assert.match(ui, /<BenefitChips match=\{match\} max=\{5\} large \/>/);
  });

  test("'confirmed' and 'important to you' are separate words and symbols (not colour alone)", () => {
    for (const text of ['"Confirmed by the job advert"', '"Mentioned, but not clearly confirmed"', '"Important to you"', "Why we say this", "Employer benefits", "Your benefit preferences", "Why this job stands out", "stated in the job advert", "a benefit you marked as important or nice to have"]) {
      assert.ok(ui.includes(text), text);
    }
    assert.match(ui, /<span className="sr-only"> — confirmed by the job advert<\/span>/);
    assert.match(ui, /<span aria-hidden="true">★<\/span>/);
  });

  test("limited data: a short, plain sentence instead of an empty section", () => {
    assert.ok(ui.includes("Not enough information in the advert to tell which benefits the employer provides."));
    assert.match(ui, /if \(shown\.length === 0 && match\.requirements\.length === 0 && !showPrefs\) return null;/);
  });

  test("12–14. cards, Prepare Application and the Review/Application links are unchanged", () => {
    assert.match(ui, /case "prepare":[\s\S]*onClick=\{onPrepare\} disabled=\{disabled\}/);
    assert.match(ui, /case "review":\s*return <Link href="\/review"[^>]*>Review Application<\/Link>/);
    assert.match(ui, /case "apply":\s*return <Link href="\/applications"/);
    assert.match(ui, /await queuePreparation\(match\.matchId, \{ retry \}\)/);
  });

  test("no model call, no new request: the view is computed from stored text on the server", () => {
    const dashboard = read("lib/pipeline/dashboard.ts");
    assert.match(dashboard, /const description = getBestDescription\(db, r\.job_id as number\);\s*const report = detectBenefits\(\{ title, description: description\?\.content \?\? "" \}\);/);
    for (const source of [dashboard, ui]) {
      assert.equal(/ollama|localhost:11434|generate\(/i.test(source), false);
    }
  });
});
