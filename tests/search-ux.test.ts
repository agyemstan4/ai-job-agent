import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { intentItems, intentToPreferences, parseSearchIntent, savedPreferenceItems } from "../lib/pipeline/search-intent.ts";
import { validatePreferences } from "../lib/pipeline/preferences.ts";
import type { SearchPreferences } from "../lib/pipeline/preferences.ts";

// Natural-language search UX polish (3j): what you asked for vs your saved
// preferences, natural language first, manual choices secondary.

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

const saved = (input: Record<string, unknown>): SearchPreferences => {
  const r = validatePreferences({ location: "London", ...input });
  if (!r.ok) assert.fail(JSON.stringify(r.fieldErrors));
  return r.preferences;
};
// The scratch profile: Territory Management, £35k minimum, three benefits.
const SCRATCH = saved({ targetRoles: ["territory_management"], minSalary: 35000, benefits: { companyCar: "important", travelExpenses: "important", accommodation: "preferred" } });
const A = "Find me Territory Manager jobs around London with a company car and travel expenses.";
const values = (items: { label: string; value: string }[]) => items.map((i) => `${i.label}: ${i.value}`);

describe("3j: what you asked for vs your saved preferences", () => {
  test("A: the request's items and the saved ones are separate, with no duplicates", () => {
    const intent = parseSearchIntent(A);
    assert.deepEqual(intentItems(intent).map((i) => i.text), ["Territory Management", "London", "Company car — Important", "Travel expenses paid — Important"]);
    // Saved: only what the request didn't mention — the £35k minimum and accommodation.
    assert.deepEqual(values(savedPreferenceItems(intent, SCRATCH)), ["Minimum salary: £35,000", "Benefit: Accommodation provided — Nice to have"]);
  });

  test("E: a request that mentions only pay and a benefit uses the saved kinds of work and location — listed as saved", () => {
    const intent = parseSearchIntent("Something paying at least £30k with travel expenses");
    assert.deepEqual(intentItems(intent).map((i) => i.text), ["At least £30,000", "Travel expenses paid — Important"]);
    assert.deepEqual(values(savedPreferenceItems(intent, SCRATCH)), [
      "Kinds of work: Territory Management",
      "Location: London",
      "Benefit: Company car — Important",
      "Benefit: Accommodation provided — Nice to have",
    ]);
  });

  test("B, C, D: each request's own items; nothing saved is shown as if it were asked for", () => {
    for (const [text, expected] of [
      ["Show me driving jobs where they provide the van.", ["Driving", "Company vehicle / van — Important"]],
      ["Find graduate software jobs in London.", ["Software Engineering", "Graduate Software Engineering", "London"]],
      ["I’m open to sales, territory manager or driving jobs.", ["Territory Management", "Driving", "Sales"]],
    ] as const) {
      const intent = parseSearchIntent(text);
      assert.deepEqual(intentItems(intent).map((i) => i.text), expected, text);
      for (const item of savedPreferenceItems(intent, SCRATCH)) assert.ok(item.key.startsWith("saved:"), text);
    }
  });

  test("a saved salary or benefit can be left out of this search (the saved preferences are not changed)", () => {
    const intent = parseSearchIntent(A);
    const removed = new Set(["saved:salary", "saved:benefit:accommodation"]);
    assert.deepEqual(savedPreferenceItems(intent, SCRATCH, removed), []);
    const r = intentToPreferences(intent, SCRATCH, removed);
    assert.equal(r.preferences.minSalary, null);
    assert.deepEqual(r.preferences.benefits, { companyCar: "important", travelExpenses: "important" });
    assert.equal(SCRATCH.minSalary, 35000, "the saved preferences object is untouched");
    // Without removals everything saved is still used.
    assert.equal(intentToPreferences(intent, SCRATCH).preferences.minSalary, 35000);
  });

  test("with nothing saved, only the usual London default is shown (and labelled as such)", () => {
    assert.deepEqual(values(savedPreferenceItems(parseSearchIntent("driving jobs"), null)), ["Location: London (the usual default)"]);
    assert.deepEqual(savedPreferenceItems(parseSearchIntent("driving jobs in Leeds"), null), []);
  });

  test("a benefit you asked for is not repeated under saved preferences, even with a different priority", () => {
    const intent = parseSearchIntent("driving jobs, ideally with accommodation");
    assert.ok(!values(savedPreferenceItems(intent, SCRATCH)).some((v) => v.includes("Accommodation")));
    assert.equal(intentToPreferences(intent, SCRATCH).preferences.benefits.accommodation, "preferred");
  });
});

describe("3j: natural language first, manual choices secondary (source checks)", () => {
  const page = read("app/page.tsx");
  const component = read("app/components/DescribeSearch.tsx");

  test("the request box comes first; CV and search support it; the career list is folded away", () => {
    const describe = page.indexOf("<DescribeSearch");
    assert.ok(describe > page.indexOf('id="search"'));
    assert.ok(describe < page.indexOf("{/* CV Upload */}"));
    assert.ok(page.indexOf("{/* CV Upload */}") < page.indexOf("{/* Find Jobs Button */}"));
    assert.ok(page.indexOf("{/* Find Jobs Button */}") < page.indexOf("{/* Target Roles */}"));
    assert.match(page, /<details className="group mt-4[^"]*">\s*<summary/);
    assert.ok(page.includes("Prefer to choose manually?"));
    assert.match(page, /roleGroups\(\)\.map/, "every career option is still offered");
  });

  test("the component separates the two groups in plain words", () => {
    for (const text of ["Understand my request", "What you asked for", "Your saved preferences", "Also used, because your request didn&rsquo;t mention them.", "Don&rsquo;t use", "Your agent will look for:"]) {
      assert.ok(component.includes(text), text);
    }
  });

  test("status messages describe what is really happening", () => {
    for (const text of ['setLoadingStep("Analysing your CV…")', 'setLoadingStep("Searching job sites…")', 'setLoadingStep("Matching your experience to the jobs found…")']) {
      assert.ok(page.includes(text), text);
    }
    assert.equal(page.includes("Understanding your experience"), false);
    // "Searching job sites" is set only right before the job-sites request.
    const searching = page.indexOf('setLoadingStep("Searching job sites…")');
    assert.ok(searching < page.indexOf('fetch("/api/jobs"') && page.indexOf('fetch("/api/jobs"') - searching < 400);
  });

  test("still no automatic search: applying a request only updates the page; Find Suitable Jobs is the one trigger", () => {
    assert.equal((page.match(/fetch\("\/api\/jobs"/g) ?? []).length, 1);
    assert.equal((page.match(/onClick=\{analyseCV\}/g) ?? []).length, 1);
    assert.doesNotMatch(component, /\bfetch\(|\/api\/|analyseCV|savePreferences|saveRawPreferences/);
  });
});
