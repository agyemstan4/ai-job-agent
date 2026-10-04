import { describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { intentItems, intentToPreferences, parseSearchIntent } from "../lib/pipeline/search-intent.ts";
import type { SearchIntent } from "../lib/pipeline/search-intent.ts";
import { searchPlan, validatePreferences } from "../lib/pipeline/preferences.ts";
import type { SearchPreferences } from "../lib/pipeline/preferences.ts";
import { homeSearchSetup } from "../lib/preferences-client.ts";

// Natural-language career search (3i): a request is interpreted locally into
// the existing preferences, reviewed, and only then saved/searched.

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

const roles = (i: SearchIntent) => i.roles.map((r) => r.id);
const benefits = (i: SearchIntent) => Object.fromEntries(i.benefits.map((b) => [b.id, b.priority]));
const saved = (input: Record<string, unknown>): SearchPreferences => {
  const r = validatePreferences({ location: "London", ...input });
  if (!r.ok) assert.fail(JSON.stringify(r.fieldErrors));
  return r.preferences;
};
/** Interpretation → saved preferences (server rules) → the existing search plan. */
function planFor(text: string, current: SearchPreferences | null = null) {
  const { preferences } = intentToPreferences(parseSearchIntent(text), current);
  const valid = validatePreferences(preferences);
  if (!valid.ok) assert.fail(`${text}: ${JSON.stringify(valid.fieldErrors)}`);
  return { preferences: valid.preferences, plan: searchPlan(valid.preferences, {}) };
}

describe("3i: acceptance scenarios A–H", () => {
  test("A. Territory Manager around London with a company car and travel expenses", () => {
    const i = parseSearchIntent("Find me Territory Manager jobs around London with a company car and travel expenses.");
    assert.deepEqual(roles(i), ["territory_management"]);
    assert.equal(i.location?.value, "London");
    assert.deepEqual(benefits(i), { companyCar: "important", travelExpenses: "important" });
    assert.equal(i.salary, null, "no salary invented");
    assert.deepEqual(i.clarifications, []);
    assert.deepEqual(intentItems(i).map((x) => x.text), ["Territory Management", "London", "Company car — Important", "Travel expenses paid — Important"]);
  });

  test("B. driving jobs where they provide the van → company vehicle, not a company car", () => {
    const i = parseSearchIntent("Show me driving jobs where they provide the van.");
    assert.deepEqual(roles(i), ["driving"]);
    assert.deepEqual(benefits(i), { companyVehicle: "important" });
  });

  test("C. graduate software jobs in London → Software Engineering + the graduate category", () => {
    const i = parseSearchIntent("Find graduate software jobs in London.");
    assert.deepEqual(roles(i), ["software_engineering", "graduate_software"]);
    assert.equal(i.location?.value, "London");
    assert.deepEqual(planFor("Find graduate software jobs in London.").plan.terms, ["junior software engineer", "graduate software developer", "graduate software engineer"]);
  });

  test("D. several directions are all kept", () => {
    assert.deepEqual(roles(parseSearchIntent("I’m open to sales, territory manager or driving jobs.")).sort(), ["driving", "sales", "territory_management"]);
  });

  test("E. around £35k or more with travel expenses → a £35,000 minimum, no invented role", () => {
    const i = parseSearchIntent("I want something around £35k or more with travel expenses.");
    assert.deepEqual(i.salary, { min: 35000, max: null, phrase: "around £35k or more" });
    assert.deepEqual(benefits(i), { travelExpenses: "important" });
    assert.deepEqual(roles(i), []);
    assert.match(i.clarifications[0], /What kind of work/);
    // With saved kinds of work, those are used (and said so) rather than asking.
    const r = intentToPreferences(i, saved({ targetRoles: ["territory_management"] }));
    assert.deepEqual(r.preferences.targetRoles, ["territory_management"]);
    assert.ok(r.kept.includes("the kinds of work you saved"));
  });

  test("F. a car allowance is not a company car", () => {
    const i = parseSearchIntent("Find me territory manager jobs with a car allowance.");
    assert.deepEqual(benefits(i), { carAllowance: "important" });
    assert.ok(!("companyCar" in benefits(i)));
  });

  test("G. travel being required is a requirement, not travel expenses", () => {
    const i = parseSearchIntent("Find jobs where travel is required.");
    assert.deepEqual(benefits(i), {});
    assert.equal(i.notes[0].kind, "requirement");
    assert.match(i.notes[0].text, /requirement, not a benefit/);
  });

  test("H. an ambiguous request invents nothing and asks", () => {
    const i = parseSearchIntent("something good near me");
    assert.deepEqual([i.roles, i.ownSearches, i.location, i.salary, i.benefits], [[], [], null, null, []]);
    assert.equal(i.clarifications.length, 2);
    assert.ok(i.clarifications.some((q) => /Where should your agent search/.test(q)));
  });
});

describe("3i: interpretation details", () => {
  test("role synonyms map onto the existing categories; longest phrase wins", () => {
    assert.deepEqual(roles(parseSearchIntent("software engineer roles")), ["software_engineering"]);
    assert.deepEqual(roles(parseSearchIntent("Android developer")), ["android", "software_engineering"]);
    assert.deepEqual(roles(parseSearchIntent("territory sales jobs")), ["territory_management"], "not also ‘sales’");
    assert.deepEqual(roles(parseSearchIntent("field territory manager")), ["territory_management"]);
    assert.deepEqual(roles(parseSearchIntent("delivery driver")), ["delivery_driving"], "not also ‘driving’");
    assert.deepEqual(roles(parseSearchIntent("LGV driver or van driver")), ["driving"]);
    assert.deepEqual(roles(parseSearchIntent("JavaScript developer")), ["software_engineering"], "JavaScript is not Java");
  });

  test("job titles no category covers become the user's own searches", () => {
    const i = parseSearchIntent("Find me marine biologist jobs");
    assert.deepEqual(i.ownSearches, ["marine biologist"]);
    assert.deepEqual(i.clarifications, []);
    assert.deepEqual(planFor("Find me marine biologist jobs").plan.terms, ["marine biologist"]);
  });

  test("benefits: priorities from the wording; accommodation; distinct ideas stay distinct", () => {
    assert.deepEqual(benefits(parseSearchIntent("territory sales jobs, preferably with a company car")), { companyCar: "preferred" });
    assert.deepEqual(benefits(parseSearchIntent("staff accommodation provided")), { accommodation: "important" });
    assert.deepEqual(benefits(parseSearchIntent("with a fuel card and mileage paid")), { fuelCard: "important", mileage: "important" });
    const own = parseSearchIntent("driving jobs, I have my own car");
    assert.deepEqual(benefits(own), {});
    assert.equal(own.notes[0].kind, "requirement");
  });

  test("salary: minimum, range, approximate (asked, not assumed), day rates noted", () => {
    for (const [text, min] of [["at least £35,000", 35000], ["minimum 40k", 40000], ["£32k+", 32000], ["over 30k", 30000]] as const) {
      assert.equal(parseSearchIntent(`driver jobs ${text}`).salary?.min, min, text);
    }
    assert.deepEqual(parseSearchIntent("between £30k and £40k").salary, { min: 30000, max: 40000, phrase: "between £30k and £40k" });
    const approx = parseSearchIntent("driving jobs around £30k");
    assert.equal(approx.salary, null);
    assert.ok(approx.clarifications.some((q) => q.includes("£30,000")));
    assert.equal(parseSearchIntent("class 1 driver within 20 miles of Leeds").salary, null, "numbers that aren't money are ignored");
    assert.equal(parseSearchIntent("driving £12 an hour").notes.some((n) => n.kind === "unsupported"), true);
  });

  test("location: known places in any case, capitalised places, radius noted, vague places asked about", () => {
    assert.equal(parseSearchIntent("sales jobs in the south east").location?.value, "South East");
    assert.equal(parseSearchIntent("driver jobs around Wolverhampton").location?.value, "Wolverhampton");
    const radius = parseSearchIntent("driver jobs within 20 miles of London");
    assert.equal(radius.location?.value, "London");
    assert.ok(radius.notes.some((n) => /Distances can't be searched/.test(n.text)));
    const vague = parseSearchIntent("driving jobs nearby");
    assert.equal(vague.location, null);
    assert.ok(vague.clarifications.some((q) => /Where should your agent search/.test(q)));
    assert.ok(parseSearchIntent("remote software jobs").notes.some((n) => /Remote or hybrid/.test(n.text)));
  });

  test("several constraints at once", () => {
    const i = parseSearchIntent("between £30k and £40k delivery driver jobs in Leeds, ideally with staff accommodation");
    assert.deepEqual(roles(i), ["delivery_driving"]);
    assert.equal(i.location?.value, "Leeds");
    assert.deepEqual(i.salary, { min: 30000, max: 40000, phrase: "between £30k and £40k" });
    assert.deepEqual(benefits(i), { accommodation: "preferred" });
  });

  test("empty, minimal and unknown wording", () => {
    assert.match(parseSearchIntent("").clarifications[0], /Tell your agent what kind of work/);
    assert.match(parseSearchIntent("jobs").clarifications[0], /What kind of work/);
    const odd = parseSearchIntent("asdfgh qwerty");
    assert.deepEqual([odd.roles, odd.ownSearches, odd.benefits], [[], [], []]);
    assert.equal(odd.clarifications.length, 1);
  });
});

describe("3i: conversion into the existing preferences and search plan", () => {
  test("scenario A becomes valid preferences and the existing search plan", () => {
    const { preferences, plan } = planFor("Find me Territory Manager jobs around London with a company car and travel expenses.");
    assert.deepEqual(preferences.targetRoles, ["territory_management"]);
    assert.deepEqual(preferences.benefits, { companyCar: "important", travelExpenses: "important" });
    assert.equal(preferences.minSalary, null);
    assert.deepEqual(plan.terms, ["territory manager"]);
    assert.equal(plan.location, "London");
  });

  test("what the request says replaces; what it doesn't mention is kept (and listed); removed items are dropped", () => {
    const current = saved({ targetRoles: ["software_engineering"], location: "Leeds", minSalary: 30000, benefits: { accommodation: "preferred" } });
    const r = intentToPreferences(parseSearchIntent("territory manager jobs with a company car"), current);
    assert.deepEqual(r.preferences.targetRoles, ["territory_management"]);
    assert.equal(r.preferences.location, "Leeds");
    assert.equal(r.preferences.minSalary, 30000);
    assert.deepEqual(r.preferences.benefits, { accommodation: "preferred", companyCar: "important" });
    assert.deepEqual(r.kept, ["your location (Leeds)", "your £30,000 minimum salary", "your saved benefit preferences"]);
    const withoutCar = intentToPreferences(parseSearchIntent("territory manager jobs with a company car"), current, new Set(["benefit:companyCar"]));
    assert.deepEqual(withoutCar.preferences.benefits, { accommodation: "preferred" });
  });

  test("nothing saved and nothing said: no invented fields (London stays the usual default)", () => {
    const r = intentToPreferences(parseSearchIntent("driving jobs"), null);
    assert.deepEqual(r.preferences, { targetRoles: ["driving"], searchTerms: [], location: "London", excludeKeywords: [], minSalary: null, benefits: {} });
  });

  test("the home search saves the reviewed request before searching, with no software role forced in", () => {
    const { preferences } = intentToPreferences(parseSearchIntent("marine biologist jobs in Bristol, at least £30k"), null);
    const setup = homeSearchSetup(null, preferences.targetRoles, { searchTerms: preferences.searchTerms, location: preferences.location, minSalary: preferences.minSalary, benefits: preferences.benefits });
    assert.equal(setup.role, undefined);
    assert.deepEqual(setup.save?.preferences, { targetRoles: [], searchTerms: ["marine biologist"], location: "Bristol", excludeKeywords: [], minSalary: 30000, benefits: {} });
    assert.equal(validatePreferences(setup.save!.preferences).ok, true);
    assert.deepEqual(homeSearchSetup(null, []), { analysisRoles: ["Junior Software Engineer"], role: "Junior Software Engineer", save: null }, "unchanged without a request");
  });
});

describe("3i: confirmation before any external search (source checks)", () => {
  const component = read("app/components/DescribeSearch.tsx");
  const intent = read("lib/pipeline/search-intent.ts");
  const page = read("app/page.tsx");

  test("interpreting makes no request at all and never searches or saves", () => {
    for (const source of [component, intent]) {
      assert.doesNotMatch(source, /\bfetch\(|XMLHttpRequest|\/api\/|saveRawPreferences|savePreferences|analyseCV/);
    }
  });

  test("the only job search on the home page is still the Find Suitable Jobs button", () => {
    assert.equal((page.match(/fetch\("\/api\/jobs"/g) ?? []).length, 1);
    assert.match(page, /onClick=\{analyseCV\}/);
    assert.match(page, /applyLabel="Use this search"/);
    // Applying the interpretation only updates the page's state.
    const apply = page.slice(page.indexOf("<DescribeSearch"), page.indexOf("/>", page.indexOf("<DescribeSearch")));
    assert.doesNotMatch(apply, /analyseCV|fetch\(|saveRawPreferences|savePreferences/);
  });

  test("the preferences page fills the form; Save stays the user's action", () => {
    const prefs = read("app/preferences/page.tsx");
    assert.match(prefs, /applyLabel="Fill in the form"/);
    const apply = prefs.slice(prefs.indexOf("<DescribeSearch"), prefs.indexOf("/>", prefs.indexOf("<DescribeSearch")));
    assert.doesNotMatch(apply, /savePreferences|fetch/);
  });
});

describe("3i: downstream systems unchanged", () => {
  const h = (file: string) => crypto.createHash("sha256").update(read(file).replace(/\r\n/g, "\n")).digest("hex");

  test("match/v3, opportunity intelligence, benefit detection, the search plan and discovery are byte-identical to 353761e", () => {
    assert.equal(h("app/api/match/route.ts"), "ef112d155048614c24e9a4cbb5d3af2d79536891b6891af64e3899d14107e8b2");
    assert.equal(h("lib/pipeline/match-scoring.ts"), "be378063794df4bd46d250822f0602ec4a4daa0e79046cb964928a38195a7790");
    assert.equal(h("lib/pipeline/opportunity.ts"), "be06f22dd5b159b6b713591057a46720816e1796fc6fa0333893af54a4193f89");
    assert.equal(h("lib/pipeline/benefits.ts"), "0ae0c6bbd0481753d5701b16653ced78f8d5ffe1edf32f5eaab9ab32813d0766");
    assert.equal(h("lib/pipeline/preferences.ts"), "289992084026b51e2f75818df69b71ff5b03788e6bedbda081c8231249ad1756");
    assert.equal(h("app/api/jobs/route.ts"), "d8f1e9018619fd947e85483ec9ca58112dcd94e1942ee4569930ec775c8fd1e4");
  });
});
