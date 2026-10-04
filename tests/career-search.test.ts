import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TestDb } from "./helpers.ts";
import { freshDb, quietly } from "./helpers.ts";
import {
  applyDiscoveryFilter,
  DEFAULT_SEARCH_TERMS,
  getPreferences,
  MAX_SEARCH_TERMS,
  MAX_TOTAL_SEARCH_TERMS,
  putPreferences,
  searchPlan,
  storedPreferences,
  validatePreferences,
} from "../lib/pipeline/preferences.ts";
import type { SearchPreferences } from "../lib/pipeline/preferences.ts";
import { labelsForRoles, ROLE_CATEGORIES, roleGroups, termsForRoles } from "../lib/pipeline/careers.ts";
import { benefitHighlights, detectBenefits, PREFERABLE_BENEFITS } from "../lib/pipeline/benefits.ts";
import type { BenefitId } from "../lib/pipeline/benefits.ts";
import { DEFAULT_HOME_ROLE, homeSearchSetup, searchPreview, setBenefit, toggleRole, EMPTY_PREFERENCES_FORM } from "../lib/preferences-client.ts";
import { createCandidate, createProfileVersion, getCandidate } from "../lib/repositories/candidates.ts";
import { recordJobListing } from "../lib/repositories/jobs.ts";
import { recordMatch } from "../lib/repositories/matches.ts";
import { getDashboard } from "../lib/pipeline/dashboard.ts";

// Flexible career search (3f): target role categories, custom searches,
// benefit preferences, and evidence-based benefit detection.

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

const ok = (input: unknown) => {
  const result = validatePreferences(input);
  if (!result.ok) assert.fail(JSON.stringify(result.fieldErrors));
  return result.preferences;
};
const errors = (input: unknown) => {
  const result = validatePreferences(input);
  if (result.ok) assert.fail("expected field errors");
  return result.fieldErrors;
};

const SOFTWARE = ["software_engineering", "android", "java", "frontend", "full_stack"];

describe("3f: career categories", () => {
  test("the catalogue covers technology, driving, sales/field, technical and customer roles, with unique ids", () => {
    const ids = ROLE_CATEGORIES.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const label of ["Software Engineering", "Android Development", "Driving", "Delivery Driving", "Territory Management", "Area Management", "Field Sales", "Sales", "Account Management", "Field Service", "Technical Operations", "Construction / Technical", "Customer-facing roles"]) {
      assert.ok(ROLE_CATEGORIES.some((c) => c.label === label), label);
    }
    assert.ok(ROLE_CATEGORIES.every((c) => c.terms.length >= 1 && c.terms.length <= 2));
    assert.deepEqual(roleGroups().map((g) => g.group), ["Technology", "Driving & delivery", "Sales & field roles", "Technical & operations", "Customer service"]);
  });

  test("1. the software categories reproduce the previous default search exactly", () => {
    assert.deepEqual(termsForRoles(SOFTWARE), DEFAULT_SEARCH_TERMS);
    const plan = searchPlan(ok({ targetRoles: SOFTWARE, location: "London" }), { role: "Junior Software Engineer", location: "London" });
    assert.deepEqual(plan.terms, DEFAULT_SEARCH_TERMS);
    assert.deepEqual(plan.roleLabels, ["Software Engineering", "Android Development", "Java Development", "Frontend Development", "Full Stack Development"]);
  });

  test("terms and labels skip unknown ids and duplicates", () => {
    assert.deepEqual(termsForRoles(["driving", "driving", "nope", "delivery_driving"]), ["driver", "delivery driver"]);
    assert.deepEqual(labelsForRoles(["field_sales", "nope"]), ["Field Sales"]);
  });
});

describe("3f: preferences with categories, custom searches and benefits", () => {
  test("2. several categories can be chosen; the search plan uses their terms (no software role added)", () => {
    const p = ok({ targetRoles: ["territory_management", "field_sales", "account_management"], location: "South East" });
    assert.deepEqual(p.targetRoles, ["territory_management", "field_sales", "account_management"]);
    assert.deepEqual(p.searchTerms, []);
    const plan = searchPlan(p, { role: "Junior Software Engineer", location: "London" });
    assert.deepEqual(plan.terms, ["territory manager", "field sales", "account manager"]);
    assert.equal(plan.location, "South East");
  });

  test("3. custom searches work alone and with categories (de-duplicated, ignoring case)", () => {
    assert.deepEqual(searchPlan(ok({ searchTerms: ["Territory Manager"], location: "London" }), {}).terms, ["Territory Manager"]);
    const plan = searchPlan(ok({ targetRoles: ["territory_management", "driving"], searchTerms: ["TERRITORY MANAGER", "Technical operator"], location: "Leeds" }), {});
    assert.deepEqual(plan.terms, ["territory manager", "driver", "Technical operator"]);
  });

  test("4. no preferences: exactly the previous default search", () => {
    assert.deepEqual(searchPlan(null, { role: "Junior Software Engineer", location: "London" }), {
      terms: ["Junior Software Engineer", ...DEFAULT_SEARCH_TERMS],
      location: "London",
      usedPreferences: false,
      roleLabels: [],
    });
  });

  test("records saved before 3f stay valid and keep their behaviour (the home role first)", () => {
    const legacy = { version: 1, searchTerms: ["kotlin developer"], location: "Manchester", excludeKeywords: [], minSalary: null };
    const p = storedPreferences(legacy)!;
    assert.deepEqual(p.targetRoles, []);
    assert.deepEqual(p.benefits, {});
    assert.deepEqual(searchPlan(p, { role: "Android Developer" }).terms, ["Android Developer", "kotlin developer"]);
  });

  test("5. benefits are stored with their priority", () => {
    const p = ok({ targetRoles: ["territory_management"], location: "London", benefits: { companyCar: "important", travelExpenses: "important", fuelCard: "preferred" } });
    assert.deepEqual(p.benefits, { companyCar: "important", travelExpenses: "important", fuelCard: "preferred" });
  });

  test("6. invalid preferences are rejected with field errors", () => {
    assert.equal(errors({ targetRoles: ["astronaut"], location: "London" }).targetRoles, "Unknown kind of work");
    assert.ok(errors({ targetRoles: "driving", location: "London" }).targetRoles);
    assert.match(errors({ targetRoles: [], searchTerms: [], location: "London" }).searchTerms, /Choose at least one kind of work/);
    assert.ok(errors({ location: "London" }).searchTerms);
    // Over the request limit: 2 + 1 + 1 + 1 + 1 + 1 = 7 terms > 6.
    assert.match(errors({ targetRoles: ["software_engineering", "android", "java", "frontend", "full_stack", "backend"], location: "London" }).targetRoles, /Choose up to 6/);
    assert.match(errors({ targetRoles: ["driving"], location: "London", benefits: { jetpack: "important" } }).benefits, /Unknown benefit/);
    assert.ok(errors({ targetRoles: ["driving"], location: "London", benefits: { companyCar: "essential" } }).benefits);
    assert.ok(errors({ targetRoles: ["driving"], location: "London", benefits: ["companyCar"] }).benefits);
    assert.ok(errors({ targetRoles: ["driving"], location: "London", benefits: { bonus: "important" } }).benefits, "bonus is shown, not a preference");
    assert.ok(errors({ targetRoles: ["driving"] }).location);
  });

  test("15. the request limit holds: never more than 7 terms per search", () => {
    const six = ["a1", "b2", "c3", "d4", "e5", "f6"];
    assert.equal(searchPlan(ok({ searchTerms: six, location: "London" }), { role: "Extra role" }).terms.length, MAX_TOTAL_SEARCH_TERMS);
    assert.equal(searchPlan(ok({ targetRoles: SOFTWARE, location: "London" }), { role: "Extra role" }).terms.length, MAX_SEARCH_TERMS);
  });

  test("14. salary floor and exclusions still apply with the new fields", () => {
    const p = ok({ targetRoles: ["driving"], location: "London", minSalary: 30000, excludeKeywords: ["Night"] });
    const jobs = [
      { title: "HGV Driver", salaryMax: 28000 },
      { title: "Night Driver", salaryMax: 40000 },
      { title: "Delivery Driver", salaryMax: 32000 },
      { title: "Courier", salaryMax: null },
    ];
    const result = applyDiscoveryFilter(p, jobs, (j) => j);
    assert.deepEqual(result.kept.map((j) => j.title), ["Delivery Driver", "Courier"]);
    assert.equal(result.belowMinSalary, 1);
    assert.equal(result.excludedByKeyword, 1);
  });
});

describe("3f: benefit detection is evidence-based", () => {
  const status = (description: string, id: BenefitId, title = "") => detectBenefits({ title, description }).benefits[id].status;

  test("7. company car: provided vs allowance vs own vehicle vs licence", () => {
    assert.equal(status("Company car provided", "companyCar"), "confirmed");
    assert.equal(status("Car allowance", "companyCar"), "not_stated");
    assert.equal(status("Car allowance", "carAllowance"), "confirmed");
    assert.equal(status("Own vehicle required", "companyCar"), "not_stated");
    assert.equal(status("Full UK driving licence required", "companyCar"), "not_stated");
    assert.equal(status("Vehicle required", "companyVehicle"), "not_stated");
    assert.equal(status("Company vehicle supplied", "companyVehicle"), "confirmed");
    assert.equal(status("Company car or car allowance", "companyCar"), "unclear");
    assert.equal(status("No company car is provided with this role", "companyCar"), "not_stated");
    assert.equal(status("", "companyCar", "Field Sales Executive - Company Car"), "confirmed", "from the title");
    const r = detectBenefits({ description: "Own vehicle required. Full UK driving licence essential." });
    assert.equal(r.requirements.ownVehicle.present, true);
    assert.equal(r.requirements.drivingLicence.present, true);
  });

  test("8. travel: expenses paid vs travel required", () => {
    assert.equal(status("Travel expenses paid", "travelExpenses"), "confirmed");
    assert.equal(status("All business mileage reimbursed", "mileage"), "confirmed");
    assert.equal(status("All business mileage reimbursed", "travelExpenses"), "confirmed", "paid mileage is a travel expense");
    assert.equal(status("Travel required", "travelExpenses"), "not_stated");
    assert.equal(status("Must be willing to travel", "travelExpenses"), "not_stated");
    assert.equal(detectBenefits({ description: "Travel required across the region" }).requirements.travel.present, true);
    assert.equal(status("Fuel card provided", "fuelCard"), "confirmed");
  });

  test("9. accommodation and relocation", () => {
    assert.equal(status("Accommodation provided", "accommodation"), "confirmed");
    assert.equal(status("Staff accommodation available on site", "accommodation"), "confirmed");
    assert.equal(status("Help finding accommodation nearby", "accommodation"), "unclear");
    assert.equal(status("Accommodation not provided", "accommodation"), "not_stated");
    assert.equal(status("Relocation package available", "relocation"), "confirmed");
  });

  test("10. no benefit is fabricated from vague or unrelated text", () => {
    for (const text of ["Competitive salary and benefits", "Excellent benefits package", "Travel required", "Full UK driving licence required", "Must have own transport", "Pensions administration experience"]) {
      const confirmed = Object.entries(detectBenefits({ description: text }).benefits).filter(([, v]) => v.status === "confirmed").map(([k]) => k);
      assert.deepEqual(confirmed, [], text);
    }
  });

  test("evidence is the advert's own words", () => {
    const r = detectBenefits({ description: "Great team. Benefits include a company car and fuel card; 25 days holiday." });
    assert.equal(r.benefits.companyCar.status, "confirmed");
    assert.match(r.benefits.companyCar.evidence!, /company car/);
    assert.equal(r.benefits.fuelCard.status, "confirmed");
  });

  test("highlights: confirmed first (your priorities first), unclear only for benefits you care about", () => {
    const report = detectBenefits({ description: "Pension scheme. Company car or car allowance. Fuel card. Van driver." });
    const plain = benefitHighlights(report);
    assert.deepEqual(plain.map((h) => `${h.id}:${h.status}`), ["carAllowance:confirmed", "fuelCard:confirmed", "pension:confirmed"]);
    const mine = benefitHighlights(report, { companyCar: "important", pension: "preferred" } as never);
    assert.equal(mine[0].status, "confirmed");
    assert.ok(mine.some((h) => h.id === "companyCar" && h.status === "unclear" && h.note === "Car mentioned — provision unclear"));
    assert.ok(!plain.some((h) => h.id === "companyVehicle"), "an unclear van mention is not shown unless you care about it");
  });
});

describe("3f: preferences form helpers and the home search", () => {
  test("toggling roles and benefit levels", () => {
    let form = toggleRole(EMPTY_PREFERENCES_FORM, "driving");
    form = toggleRole(form, "delivery_driving");
    assert.deepEqual(form.targetRoles, ["driving", "delivery_driving"]);
    assert.deepEqual(toggleRole(form, "driving").targetRoles, ["delivery_driving"]);
    form = setBenefit(form, "accommodation", "important");
    assert.deepEqual(form.benefits, { accommodation: "important" });
    assert.deepEqual(setBenefit(form, "accommodation", null).benefits, {});
  });

  test("the preview shows what will be searched and flags the limit", () => {
    const preview = searchPreview({ ...EMPTY_PREFERENCES_FORM, targetRoles: ["territory_management"], searchTerms: "Territory Manager\nTechnical operator" });
    assert.deepEqual(preview, { terms: ["territory manager", "Technical operator"], overLimit: false, limit: 6 });
    assert.equal(searchPreview({ ...EMPTY_PREFERENCES_FORM, targetRoles: [...SOFTWARE, "backend"] }).overLimit, true);
  });

  test("home: nothing chosen and nothing saved → exactly the previous default request", () => {
    assert.deepEqual(homeSearchSetup(null, []), { analysisRoles: [DEFAULT_HOME_ROLE], role: DEFAULT_HOME_ROLE, save: null });
  });

  test("home: kinds of work chosen there are saved as preferences, and no software role is forced in", () => {
    const setup = homeSearchSetup(null, ["driving", "delivery_driving"]);
    assert.equal(setup.role, undefined);
    assert.deepEqual(setup.analysisRoles, ["Driving", "Delivery Driving"]);
    assert.deepEqual(setup.save, { preferences: { targetRoles: ["driving", "delivery_driving"], searchTerms: [], location: "London", excludeKeywords: [], minSalary: null, benefits: {} } });
    assert.equal(validatePreferences(setup.save!.preferences).ok, true);
  });

  test("home: saved preferences are kept (location, salary, benefits, own searches); unchanged choices are not re-saved", () => {
    const saved = ok({ targetRoles: ["territory_management"], searchTerms: ["Technical operator"], location: "Bristol", minSalary: 35000, benefits: { companyCar: "important" } });
    assert.equal(homeSearchSetup(saved, ["territory_management"]).save, null);
    const changed = homeSearchSetup(saved, ["territory_management", "field_sales"]);
    assert.deepEqual(changed.save?.preferences, { targetRoles: ["territory_management", "field_sales"], searchTerms: ["Technical operator"], location: "Bristol", excludeKeywords: [], minSalary: 35000, benefits: { companyCar: "important" } });
  });
});

// ── Against the real handlers and dashboard (scratch databases) ───────────

let t: TestDb;
beforeEach(() => {
  t = quietly(freshDb);
});
afterEach(() => t.close());

describe("3f: persistence and the dashboard (scratch DB)", () => {
  test("11. categories and benefits persist through PUT/GET", () => {
    const c = createCandidate(t.db, { fullName: "A" });
    const body = { preferences: { targetRoles: ["territory_management"], searchTerms: ["Territory Manager"], location: "London", minSalary: 35000, benefits: { companyCar: "important", travelExpenses: "important" } } };
    const saved = putPreferences(t.db, body);
    assert.equal(saved.status, 200);
    const expected: SearchPreferences = {
      version: 1, targetRoles: ["territory_management"], searchTerms: ["Territory Manager"], location: "London", excludeKeywords: [], minSalary: 35000,
      benefits: { companyCar: "important", travelExpenses: "important" },
    };
    assert.deepEqual(saved.body.preferences, expected);
    assert.deepEqual(getPreferences(t.db).body.preferences, expected);
    assert.deepEqual(getCandidate(t.db, c.id)?.preferences, expected);
    assert.equal(putPreferences(t.db, { preferences: { targetRoles: ["nope"], location: "London" } }).status, 400);
    assert.deepEqual(getPreferences(t.db).body.preferences, expected, "an invalid save changes nothing");
  });

  test("the dashboard shows chosen kinds of work, confirmed benefits and evidence-based reasons", () => {
    const c = createCandidate(t.db, { fullName: "A" });
    const profileId = createProfileVersion(t.db, { candidateId: c.id, origin: "ai_extraction", analysis: {}, structuredCv: { name: "A", education: [], projects: [], experience: [] } }).id;
    putPreferences(t.db, { preferences: { targetRoles: ["territory_management"], location: "London", minSalary: 35000, benefits: { companyCar: "important", accommodation: "preferred" } } });
    const tm = recordJobListing(t.db, {
      sourceId: "reed", externalId: "T1", title: "Territory Manager", company: "Acme", location: "London", url: "https://example.invalid/t1",
      salaryMin: 36000, salaryMax: 40000, salaryIsPredicted: false,
      description: "Company car provided. Own laptop not needed. Travel required across the South East.",
    }).jobId;
    const other = recordJobListing(t.db, {
      sourceId: "reed", externalId: "T2", title: "Sales Executive", company: "Beta", location: "London", url: "https://example.invalid/t2",
      salaryMin: null, salaryMax: null, salaryIsPredicted: null, description: "Competitive salary and benefits. Full UK driving licence required.",
    }).jobId;
    recordMatch(t.db, { jobId: tm, candidateProfileId: profileId, outcome: "scored", score: 80 });
    recordMatch(t.db, { jobId: other, candidateProfileId: profileId, outcome: "scored", score: 60 });

    const d = getDashboard(t.db);
    assert.deepEqual(d.search.roles, ["Territory Management"]);
    assert.deepEqual(d.search.terms, ["territory manager"]);
    const [first, second] = d.topMatches;
    assert.deepEqual(first.benefits.map((b) => `${b.id}:${b.status}:${b.priority}`), ["companyCar:confirmed:important"]);
    assert.deepEqual(first.requirements, ["Travel required"]);
    assert.deepEqual(first.standsOut, ["Territory Management is one of your target roles", "Salary meets your £35,000 minimum", "Company car matches an important preference"]);
    assert.deepEqual(second.benefits, [], "nothing is claimed from vague text");
    assert.deepEqual(second.requirements, ["Driving licence needed"]);
    assert.deepEqual(second.standsOut, []);
  });

  test("12/13. discovery takes its terms from the search plan; the route's safeguards are unchanged", () => {
    const route = read("app/api/jobs/route.ts");
    assert.match(route, /const \{ terms: searchTerms, location: searchLocation \} = searchPlan\(preferences, \{ role, location \}\);/);
    assert.match(route, /filterNewJobs/);
    assert.match(route, /recordDiscovery/);
    assert.match(route, /results_per_page=20/);
    assert.match(route, /resultsToTake=20/);
  });

  test("the home page reads and saves through the preferences API, not its own role list", () => {
    const page = read("app/page.tsx");
    assert.match(page, /homeSearchSetup\(savedPrefs, chosenRoles\)/);
    assert.match(page, /await saveRawPreferences\(setup\.save\)/);
    assert.match(page, /body: JSON\.stringify\(\{ role: setup\.role, location: "London", candidateProfileId: profileId \}\)/);
    assert.equal(page.includes('"C# Developer"'), false);
    assert.equal(page.includes("selectedRoles"), false);
    // Saving preferences happens after the CV analysis created the profile and before the search.
    assert.ok(page.indexOf("await saveRawPreferences(setup.save)") > page.indexOf('fetch("/api/analyse-and-extract"'));
    assert.ok(page.indexOf("await saveRawPreferences(setup.save)") < page.indexOf('fetch("/api/jobs"'));
  });

  test("the preferences page offers categories, own searches, location, salary and benefit levels", () => {
    const page = read("app/preferences/page.tsx");
    for (const text of ["What kind of work are you looking for?", "Where would you like to work?", "How much would you like to earn?", "Are there any benefits that matter to you?", "Your own searches", "Nice to have", "Important", "Your agent will search job sites for:"]) {
      assert.ok(page.includes(text), text);
    }
    assert.match(page, /aria-pressed=\{on\}/);
    assert.match(page, /type="radio"/);
    assert.equal(PREFERABLE_BENEFITS.length, 9);
  });
});
