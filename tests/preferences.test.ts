import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TestDb } from "./helpers.ts";
import { count, freshDb, quietly } from "./helpers.ts";
import type { SearchPreferences } from "../lib/pipeline/preferences.ts";
import {
  applyDiscoveryFilter,
  DEFAULT_SEARCH_TERMS,
  getPreferences,
  knownAnnualSalary,
  MAX_TOTAL_SEARCH_TERMS,
  preferencesForProfile,
  putPreferences,
  searchPlan,
  storedPreferences,
  titleHasKeyword,
  validatePreferences,
} from "../lib/pipeline/preferences.ts";
import { createCandidate, createProfileVersion, getCandidate } from "../lib/repositories/candidates.ts";

// Phase 3 checkpoint 3b-5a: search preferences for job discovery.

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

/* eslint-disable @typescript-eslint/no-explicit-any -- verbatim copy of the pre-3b-5 route code */
// The search terms as /api/jobs built them before 3b-5 (at a686544), copied verbatim.
function referenceSearchTerms(role: any) {
    const searchTerms = Array.from(
      new Set([
        role,
        "junior software engineer",
        "graduate software developer",
        "android developer",
        "java developer",
        "frontend developer",
        "full stack developer",
      ])
    );
  return searchTerms;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const prefs = (overrides: Partial<SearchPreferences> = {}): SearchPreferences => ({
  version: 1,
  searchTerms: ["kotlin developer", "react developer"],
  location: "Manchester",
  excludeKeywords: [],
  minSalary: null,
  targetRoles: [],
  benefits: {},
  ...overrides,
});

// ── With no preferences, discovery is unchanged ─────────────────────────────

describe("3b-5a: no preferences → the previous search", () => {
  const roles: unknown[] = ["Junior Software Engineer", "junior software engineer", "Java Developer", "C# Developer", "", undefined, null];

  test("the terms equal the pre-3b-5 code for every kind of role", () => {
    for (const role of roles) {
      const plan = searchPlan(null, { role, location: "London" });
      assert.deepEqual(plan.terms, referenceSearchTerms(role), String(role));
      assert.equal(plan.usedPreferences, false);
    }
  });

  test("the UI's capitalised role still gives the previous 7 terms (6 for the scheduler's lower-case role)", () => {
    assert.equal(searchPlan(null, { role: "Junior Software Engineer", location: "London" }).terms.length, 7);
    assert.equal(searchPlan(null, { role: "junior software engineer", location: "London" }).terms.length, 6);
  });

  test("the location is the one sent in, unchanged", () => {
    assert.equal(searchPlan(null, { role: "x", location: "London" }).location, "London");
    assert.equal(searchPlan(null, { role: "x", location: undefined }).location, undefined);
  });

  test("the default terms are the previous fixed list", () => {
    assert.deepEqual(referenceSearchTerms("junior software engineer"), DEFAULT_SEARCH_TERMS);
  });

  test("no preferences keeps every job", () => {
    const jobs = [{ title: "Senior Engineer" }, { title: "Developer" }];
    const result = applyDiscoveryFilter(null, jobs, (j) => j);
    assert.deepEqual(result, { kept: jobs, excludedByKeyword: 0, belowMinSalary: 0 });
  });
});

// ── Validation ──────────────────────────────────────────────────────────────

describe("3b-5a: validatePreferences", () => {
  const ok = (input: unknown) => {
    const r = validatePreferences(input);
    assert.ok(r.ok, JSON.stringify(r));
    return r.preferences;
  };
  const errors = (input: unknown) => {
    const r = validatePreferences(input);
    assert.equal(r.ok, false);
    return (r as { fieldErrors: Record<string, string> }).fieldErrors;
  };

  test("valid input is cleaned and stored with its version", () => {
    assert.deepEqual(
      ok({ searchTerms: ["  Kotlin   Developer ", "React developer"], location: " Leeds ", excludeKeywords: ["Senior", " Lead "], minSalary: 30000 }),
      { version: 1, targetRoles: [], searchTerms: ["Kotlin Developer", "React developer"], location: "Leeds", excludeKeywords: ["Senior", "Lead"], minSalary: 30000, benefits: {} }
    );
  });

  test("exclude keywords and minimum salary are optional", () => {
    assert.deepEqual(ok({ searchTerms: ["Java developer"], location: "London" }), {
      version: 1, targetRoles: [], searchTerms: ["Java developer"], location: "London", excludeKeywords: [], minSalary: null, benefits: {},
    });
    assert.equal(ok({ searchTerms: ["Java developer"], location: "London", minSalary: null }).minSalary, null);
    assert.equal(ok({ version: 1, targetRoles: [], searchTerms: ["Java developer"], location: "London" }).version, 1);
  });

  test("duplicates are removed ignoring case", () => {
    const p = ok({ searchTerms: ["Java Developer", "java developer", "JAVA DEVELOPER", "Kotlin"], location: "London", excludeKeywords: ["Senior", "senior"] });
    assert.deepEqual(p.searchTerms, ["Java Developer", "Kotlin"]);
    assert.deepEqual(p.excludeKeywords, ["Senior"]);
  });

  test("search terms: 1–6, each 2–60 characters", () => {
    assert.ok(errors({ searchTerms: [], location: "London" }).searchTerms);
    assert.ok(errors({ searchTerms: ["a", "b", "c", "d", "e", "f", "g"].map((x) => `${x}x`), location: "London" }).searchTerms);
    assert.equal(ok({ searchTerms: ["aa", "bb", "cc", "dd", "ee", "ff"], location: "London" }).searchTerms.length, 6);
    assert.ok(errors({ searchTerms: ["x"], location: "London" }).searchTerms);
    assert.ok(errors({ searchTerms: ["x".repeat(61)], location: "London" }).searchTerms);
    assert.ok(errors({ searchTerms: "Java", location: "London" }).searchTerms);
    assert.ok(errors({ searchTerms: [42], location: "London" }).searchTerms);
    assert.ok(errors({ location: "London" }).searchTerms);
  });

  test("location: required, 2–60 characters", () => {
    assert.ok(errors({ searchTerms: ["Java"] }).location);
    assert.ok(errors({ searchTerms: ["Java"], location: " L " }).location);
    assert.ok(errors({ searchTerms: ["Java"], location: "x".repeat(61) }).location);
    assert.ok(errors({ searchTerms: ["Java"], location: 7 }).location);
  });

  test("exclude keywords: 0–20, each 2–40 characters", () => {
    assert.equal(ok({ searchTerms: ["Java"], location: "London", excludeKeywords: Array.from({ length: 20 }, (_, i) => `kw${i}`) }).excludeKeywords.length, 20);
    assert.ok(errors({ searchTerms: ["Java"], location: "London", excludeKeywords: Array.from({ length: 21 }, (_, i) => `kw${i}`) }).excludeKeywords);
    assert.ok(errors({ searchTerms: ["Java"], location: "London", excludeKeywords: ["x"] }).excludeKeywords);
    assert.ok(errors({ searchTerms: ["Java"], location: "London", excludeKeywords: ["x".repeat(41)] }).excludeKeywords);
  });

  test("minimum salary: a whole number from 0 to 200,000", () => {
    assert.equal(ok({ searchTerms: ["Java"], location: "London", minSalary: 0 }).minSalary, 0);
    assert.equal(ok({ searchTerms: ["Java"], location: "London", minSalary: 200000 }).minSalary, 200000);
    for (const bad of [-1, 200001, 30000.5, "30000", Number.NaN]) {
      assert.ok(errors({ searchTerms: ["Java"], location: "London", minSalary: bad }).minSalary, String(bad));
    }
  });

  test("unknown fields, other versions and non-objects are rejected", () => {
    assert.equal(errors({ searchTerms: ["Java"], location: "London", roles: ["x"] }).roles, "Unknown field");
    assert.ok(errors({ searchTerms: ["Java"], location: "London", version: 2 }).version);
    for (const bad of [null, [], "x", 3]) assert.ok(errors(bad).preferences);
  });

  test("every problem is reported at once", () => {
    assert.deepEqual(Object.keys(errors({ searchTerms: [], location: "", minSalary: -5, extra: 1 })).sort(), ["extra", "location", "minSalary", "searchTerms"]);
  });

  test("stored values that are invalid count as no preferences", () => {
    assert.equal(storedPreferences(null), null);
    assert.equal(storedPreferences({ roles: ["Android"] }), null);
    assert.deepEqual(storedPreferences(prefs()), prefs());
  });
});

// ── Search plan with preferences ────────────────────────────────────────────

describe("3b-5a: searchPlan with preferences", () => {
  test("the selected role first, then the preferred terms, and the preferred location", () => {
    assert.deepEqual(searchPlan(prefs(), { role: "Junior Software Engineer", location: "London" }), {
      terms: ["Junior Software Engineer", "kotlin developer", "react developer"],
      location: "Manchester",
      usedPreferences: true,
      roleLabels: [],
    });
  });

  test("the role is not repeated when it is also a preferred term (ignoring case)", () => {
    assert.deepEqual(searchPlan(prefs({ searchTerms: ["junior software engineer", "Kotlin"] }), { role: "Junior Software Engineer" }).terms, [
      "Junior Software Engineer", "Kotlin",
    ]);
  });

  test("no role: only the preferred terms", () => {
    for (const role of [undefined, null, "", "   "]) {
      assert.deepEqual(searchPlan(prefs(), { role }).terms, ["kotlin developer", "react developer"]);
    }
  });

  test("at most 7 terms: the role plus up to 6 preferred terms", () => {
    const six = ["aa", "bb", "cc", "dd", "ee", "ff"];
    const plan = searchPlan(prefs({ searchTerms: six }), { role: "Android Developer" });
    assert.equal(MAX_TOTAL_SEARCH_TERMS, 7);
    assert.deepEqual(plan.terms, ["Android Developer", ...six]);
    assert.ok(plan.terms.length <= 7);
  });
});

// ── Discovery filter ────────────────────────────────────────────────────────

describe("3b-5a: exclusions and the salary floor", () => {
  test("keywords match whole words, ignoring case", () => {
    assert.equal(titleHasKeyword("Senior Java Engineer", "senior"), true);
    assert.equal(titleHasKeyword("Java Engineer (SENIOR)", "Senior"), true);
    assert.equal(titleHasKeyword("Seniority-based Graduate Scheme", "Senior"), false);
    assert.equal(titleHasKeyword("Lead Developer", "lead"), true);
    assert.equal(titleHasKeyword("Leading Edge Graduate", "lead"), false);
    assert.equal(titleHasKeyword("C# Developer", "C#"), true);
    assert.equal(titleHasKeyword("C++ Developer", "C#"), false);
    assert.equal(titleHasKeyword("Node.js Developer", "node.js"), true);
    assert.equal(titleHasKeyword("Nodexjs Developer", "node.js"), false);
    assert.equal(titleHasKeyword("Data Analyst", "data analyst"), true);
    assert.equal(titleHasKeyword("", "x"), false);
  });

  test("known annual salary: the top of the range; unknown, estimated or day/hour rates are null", () => {
    assert.equal(knownAnnualSalary({ salaryMin: 25000, salaryMax: 35000 }), 35000);
    assert.equal(knownAnnualSalary({ salaryMin: 28000, salaryMax: null }), 28000);
    assert.equal(knownAnnualSalary({}), null);
    assert.equal(knownAnnualSalary({ salaryMin: 20000, salaryMax: 22000, salaryIsPredicted: true }), null);
    assert.equal(knownAnnualSalary({ salaryMin: 400, salaryMax: 450 }), null);
    assert.equal(knownAnnualSalary({ salaryMax: Number.NaN }), null);
  });

  test("excluded titles and known salaries below the floor are left out; the rest are kept", () => {
    const jobs = [
      { id: 1, title: "Graduate Java Developer", salaryMin: 30000, salaryMax: 38000 },
      { id: 2, title: "Senior Java Developer", salaryMin: 60000, salaryMax: 70000 },
      { id: 3, title: "Junior Developer", salaryMin: 18000, salaryMax: 22000 },
      { id: 4, title: "Junior Developer (estimate)", salaryMin: 18000, salaryMax: 20000, salaryIsPredicted: true },
      { id: 5, title: "Contract Developer", salaryMin: 350, salaryMax: 400 },
      { id: 6, title: "Developer, salary not shown" },
      { id: 7, title: "Software Engineer", salaryMin: 30000, salaryMax: 30000 },
    ];
    const result = applyDiscoveryFilter(prefs({ excludeKeywords: ["Senior"], minSalary: 30000 }), jobs, (j) => j);
    assert.deepEqual(result.kept.map((j) => j.id), [1, 4, 5, 6, 7]);
    assert.equal(result.excludedByKeyword, 1);
    assert.equal(result.belowMinSalary, 1);
  });

  test("a keyword exclusion is counted once even if the salary is also too low", () => {
    const result = applyDiscoveryFilter(prefs({ excludeKeywords: ["Senior"], minSalary: 50000 }), [{ title: "Senior Dev", salaryMax: 20000 }], (j) => j);
    assert.deepEqual([result.excludedByKeyword, result.belowMinSalary, result.kept.length], [1, 0, 0]);
  });

  test("no floor and no keywords keep everything", () => {
    const jobs = [{ title: "Senior", salaryMax: 1000 }];
    assert.equal(applyDiscoveryFilter(prefs(), jobs, (j) => j).kept.length, 1);
  });
});

// ── Database and API handlers (scratch databases) ───────────────────────────

let t: TestDb;
beforeEach(() => {
  t = quietly(freshDb);
});
afterEach(() => t.close());

const ALL_TABLES = () =>
  (t.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(
    (r) => r.name
  );
const tableCounts = () => Object.fromEntries(ALL_TABLES().map((name) => [name, count(t.db, name)]));
const rawPreferences = (id: number) =>
  (t.db.prepare("SELECT preferences_json FROM candidates WHERE id = ?").get(id) as { preferences_json: string | null }).preferences_json;

describe("3b-5a: preferences for a candidate profile", () => {
  test("profile → candidate → saved preferences", () => {
    const c = createCandidate(t.db, { fullName: "A", preferences: prefs() });
    const profile = createProfileVersion(t.db, { candidateId: c.id, origin: "ai_extraction", analysis: {}, structuredCv: {} });
    assert.deepEqual(preferencesForProfile(t.db, profile.id), prefs());
  });

  test("nothing saved: no preferences", () => {
    const c = createCandidate(t.db, { fullName: "A" });
    const profile = createProfileVersion(t.db, { candidateId: c.id, origin: "ai_extraction", analysis: {}, structuredCv: {} });
    assert.equal(preferencesForProfile(t.db, profile.id), null);
  });

  test("no profile (the scheduler) or an unknown profile: no preferences, even when some are saved", () => {
    const c = createCandidate(t.db, { fullName: "A", preferences: prefs() });
    createProfileVersion(t.db, { candidateId: c.id, origin: "ai_extraction", analysis: {}, structuredCv: {} });
    for (const id of [undefined, null, "1", 999, Number.NaN]) assert.equal(preferencesForProfile(t.db, id), null, String(id));
  });

  test("invalid stored preferences are ignored, not an error", () => {
    const c = createCandidate(t.db, { fullName: "A", preferences: { roles: ["Android"] } });
    const profile = createProfileVersion(t.db, { candidateId: c.id, origin: "ai_extraction", analysis: {}, structuredCv: {} });
    assert.equal(preferencesForProfile(t.db, profile.id), null);
  });
});

describe("3b-5a: GET/PUT /api/preferences handlers", () => {
  test("with no candidate yet: 409, and nothing is created", () => {
    const before = tableCounts();
    assert.equal(getPreferences(t.db).status, 409);
    assert.equal(putPreferences(t.db, { preferences: prefs() }).status, 409);
    assert.match(String(putPreferences(t.db, { preferences: null }).body.error), /Upload your CV first/);
    assert.deepEqual(tableCounts(), before);
  });

  test("GET: null when nothing is saved", () => {
    createCandidate(t.db, { fullName: "A" });
    assert.deepEqual(getPreferences(t.db), { status: 200, body: { preferences: null } });
  });

  test("PUT saves valid preferences (cleaned), and GET returns them", () => {
    const c = createCandidate(t.db, { fullName: "A" });
    const result = putPreferences(t.db, { preferences: { searchTerms: [" Kotlin "], location: "Leeds", minSalary: 28000 } });
    const saved = { version: 1, targetRoles: [], searchTerms: ["Kotlin"], location: "Leeds", excludeKeywords: [], minSalary: 28000, benefits: {} };
    assert.deepEqual(result, { status: 200, body: { preferences: saved } });
    assert.deepEqual(getPreferences(t.db).body, { preferences: saved });
    assert.deepEqual(getCandidate(t.db, c.id)?.preferences, saved);
  });

  test("PUT with invalid preferences: 400 with field errors, nothing saved", () => {
    const c = createCandidate(t.db, { fullName: "A", preferences: prefs() });
    const result = putPreferences(t.db, { preferences: { searchTerms: [], location: "x", minSalary: -1 } });
    assert.equal(result.status, 400);
    assert.deepEqual(Object.keys(result.body.fieldErrors as object).sort(), ["location", "minSalary", "searchTerms"]);
    assert.deepEqual(getCandidate(t.db, c.id)?.preferences, prefs());
  });

  test("PUT with a malformed body: 400", () => {
    createCandidate(t.db, { fullName: "A" });
    for (const body of [null, {}, "x", { prefs: {} }]) assert.equal(putPreferences(t.db, body).status, 400, JSON.stringify(body));
  });

  test("PUT { preferences: null } clears them (SQL NULL)", () => {
    const c = createCandidate(t.db, { fullName: "A", preferences: prefs() });
    assert.deepEqual(putPreferences(t.db, { preferences: null }), { status: 200, body: { preferences: null } });
    assert.equal(rawPreferences(c.id), null);
    assert.deepEqual(getPreferences(t.db).body, { preferences: null });
  });

  test("GET warns about invalid saved preferences instead of returning them", () => {
    createCandidate(t.db, { fullName: "A", preferences: { roles: ["Android"] } });
    const result = getPreferences(t.db);
    assert.equal(result.body.preferences, null);
    assert.match(String(result.body.warning), /not valid/);
  });

  test("saving changes only the candidate's preferences (and updated_at); no other table", () => {
    const c = createCandidate(t.db, { fullName: "A", email: "a@example.com" });
    createProfileVersion(t.db, { candidateId: c.id, origin: "ai_extraction", analysis: {}, structuredCv: {} });
    const before = tableCounts();
    const candidateBefore = getCandidate(t.db, c.id)!;
    putPreferences(t.db, { preferences: prefs() });
    putPreferences(t.db, { preferences: null });
    putPreferences(t.db, { preferences: prefs({ location: "York" }) });
    assert.deepEqual(tableCounts(), before);
    const after = getCandidate(t.db, c.id)!;
    assert.deepEqual({ ...after, preferences: null, updatedAt: "" }, { ...candidateBefore, preferences: null, updatedAt: "" });
    assert.equal(after.preferences?.location, "York");
  });
});

// ── Wiring (source checks: tests never import route modules) ────────────────

/** Every console.* call in a source file, as the full call text. */
function consoleCalls(source: string): string[] {
  const calls: string[] = [];
  const re = /console\.(log|warn|error|info|debug)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")" && --depth === 0) break;
    }
    calls.push(source.slice(m.index, i + 1));
  }
  return calls;
}

describe("3b-5a: /api/jobs uses the preferences; the scheduler does not", () => {
  const jobs = read("app/api/jobs/route.ts");

  test("preferences come from the request's profile, inside a try (never breaking discovery)", () => {
    assert.match(jobs, /try \{\s*preferences = preferencesForProfile\(db, candidateProfileId\);\s*\} catch \(error\) \{/);
    assert.match(jobs, /const \{ terms: searchTerms, location: searchLocation \} = searchPlan\(preferences, \{ role, location \}\);/);
  });

  test("both searches use the planned terms and location; no fixed term list is left in the route", () => {
    assert.match(jobs, /what=\$\{encodeURIComponent\(term\)\}&where=\$\{encodeURIComponent\(searchLocation\)\}/);
    assert.match(jobs, /keywords=\$\{encodeURIComponent\(term\)\}&location=\$\{encodeURIComponent\(searchLocation\)\}/);
    assert.equal((jobs.match(/searchTerms\.map\(/g) ?? []).length, 2);
    assert.equal(jobs.includes('"graduate software developer"'), false);
    assert.equal(/encodeURIComponent\(location\)/.test(jobs), false);
  });

  test("the filter runs only with preferences, on the new jobs, with Adzuna's estimate flag", () => {
    assert.match(jobs, /if \(preferences\) \{[\s\S]*applyDiscoveryFilter\(preferences, newJobs,[\s\S]*newJobs = filtered\.kept;/);
    assert.match(jobs, /job\.source === "Adzuna" && job\.raw\?\.salary_is_predicted !== undefined/);
    assert.ok(jobs.indexOf("applyDiscoveryFilter(") > jobs.indexOf('console.log("NEW (not processed before):"'));
    assert.ok(jobs.indexOf("applyDiscoveryFilter(") < jobs.indexOf("return NextResponse.json(newJobs);"));
  });

  test("logs carry counts, never the location or keyword text", () => {
    for (const call of consoleCalls(jobs)) {
      // A value, not a count or an object key.
      assert.equal(/searchLocation|preferences\.location|excludeKeywords(?!\.length|\s*:)|searchTerms(?!\.length|\s*:)/.test(call), false, call);
    }
    for (const call of consoleCalls(read("lib/pipeline/preferences.ts"))) assert.fail(`unexpected log in preferences.ts: ${call}`);
  });

  test("the scheduler is unchanged: it sends no candidate profile, so it never uses preferences", () => {
    const scheduler = read("scripts/scheduler.mjs");
    assert.equal(scheduler.includes("candidateProfileId"), false);
    assert.match(scheduler, /role: "junior software engineer",\s*location: "London",/);
  });

  test("the preferences route is thin: GET and PUT through the handlers", () => {
    const route = read("app/api/preferences/route.ts");
    assert.match(route, /export async function GET\(\)/);
    assert.match(route, /export async function PUT\(req: NextRequest\)/);
    assert.match(route, /getPreferences\(db\)/);
    assert.match(route, /putPreferences\(db, await req\.json\(\)\.catch\(\(\) => null\)\)/);
    assert.equal(/export async function (POST|DELETE|PATCH)/.test(route), false);
  });
});
