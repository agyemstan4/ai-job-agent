import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TestDb } from "./helpers.ts";
import { count, freshDb, quietly } from "./helpers.ts";
import {
  buildSaveRequest,
  CLEAR_REQUEST,
  clearPreferences,
  EMPTY_PREFERENCES_FORM,
  formFromPreferences,
  linesToList,
  loadPreferences,
  otherFieldErrors,
  parseMinSalary,
  savePreferences,
} from "../lib/preferences-client.ts";
import { getPreferences, putPreferences } from "../lib/pipeline/preferences.ts";
import { createCandidate, getCandidate } from "../lib/repositories/candidates.ts";

// Phase 3 checkpoint 3b-5b: the /preferences page. The project has no
// browser/component test framework, so the page's behaviour lives in
// lib/preferences-client.ts (tested here, including against the real API
// handlers) and its structure is checked from the page source.

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

// ── Form helpers ────────────────────────────────────────────────────────────

describe("3b-5b: form helpers", () => {
  test("lines become a trimmed list without blanks", () => {
    assert.deepEqual(linesToList("  kotlin developer \n\n react developer\r\n   \n"), ["kotlin developer", "react developer"]);
    assert.deepEqual(linesToList(""), []);
  });

  test("saved preferences fill the form; none gives a new form (London suggested)", () => {
    // Since 3f a first-time form suggests the usual location.
    assert.deepEqual(formFromPreferences(null), { ...EMPTY_PREFERENCES_FORM, location: "London" });
    assert.deepEqual(
      formFromPreferences({ version: 1, targetRoles: [], benefits: {}, searchTerms: ["Kotlin", "React"], location: "Leeds", excludeKeywords: ["Senior"], minSalary: 30000 }),
      { targetRoles: [], benefits: {}, searchTerms: "Kotlin\nReact", location: "Leeds", excludeKeywords: "Senior", minSalary: "30000" }
    );
    assert.equal(formFromPreferences({ version: 1, targetRoles: [], benefits: {}, searchTerms: ["x y"], location: "York", excludeKeywords: [], minSalary: null }).minSalary, "");
  });

  test("minimum salary: empty is none; common formats become a number; anything else goes to the server", () => {
    assert.equal(parseMinSalary(""), null);
    assert.equal(parseMinSalary("   "), null);
    assert.equal(parseMinSalary("30000"), 30000);
    assert.equal(parseMinSalary("30,000"), 30000);
    assert.equal(parseMinSalary("£30,000"), 30000);
    assert.equal(parseMinSalary(" 30 000 "), 30000);
    assert.equal(parseMinSalary("thirty"), "thirty");
    assert.equal(parseMinSalary("-5"), "-5");
    assert.equal(parseMinSalary("30k"), "30k");
  });

  test("the save request has the API's shape", () => {
    assert.deepEqual(
      buildSaveRequest({ targetRoles: [], benefits: {}, searchTerms: "Kotlin\n\nReact ", location: " Leeds ", excludeKeywords: "", minSalary: "" }),
      { preferences: { targetRoles: [], benefits: {}, searchTerms: ["Kotlin", "React"], location: "Leeds", excludeKeywords: [], minSalary: null } }
    );
    assert.deepEqual(CLEAR_REQUEST, { preferences: null });
  });

  test("field errors without a form field are listed separately", () => {
    assert.deepEqual(otherFieldErrors({ location: "x", roles: "Unknown field" }), ["roles: Unknown field"]);
    assert.deepEqual(otherFieldErrors({ targetRoles: "x", benefits: "x", searchTerms: "x", minSalary: "y" }), []);
  });
});

// ── Against the real API handlers (scratch databases) ───────────────────────

let t: TestDb;
const calls: { url: string; method: string; body: unknown }[] = [];

/** A fetch that serves /api/preferences with the real handlers, like the route. */
const apiFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ url, method, body });
  assert.equal(url, "/api/preferences");
  const result = method === "PUT" ? putPreferences(t.db, body ?? null) : getPreferences(t.db);
  return new Response(JSON.stringify(result.body), { status: result.status });
};

beforeEach(() => {
  t = quietly(freshDb);
  calls.length = 0;
});
afterEach(() => t.close());

const storedRaw = (id: number) =>
  (t.db.prepare("SELECT preferences_json FROM candidates WHERE id = ?").get(id) as { preferences_json: string | null }).preferences_json;

describe("3b-5b: the page's load/save/clear against the real handlers", () => {
  test("before a CV is uploaded: load and save explain that, and nothing is created", async () => {
    const load = await loadPreferences(apiFetch);
    assert.equal(load.kind, "no_candidate");
    assert.match((load as { message: string }).message, /Upload your CV first/);
    const save = await savePreferences({ targetRoles: [], benefits: {}, searchTerms: "Kotlin", location: "Leeds", excludeKeywords: "", minSalary: "" }, apiFetch);
    assert.equal(save.kind, "no_candidate");
    assert.equal(count(t.db, "candidates"), 0);
  });

  test("load with nothing saved: an empty form", async () => {
    createCandidate(t.db, { fullName: "A" });
    const load = await loadPreferences(apiFetch);
    assert.deepEqual(load, { kind: "loaded", preferences: null, warning: null });
  });

  test("save, then load again: the cleaned preferences fill the form", async () => {
    const c = createCandidate(t.db, { fullName: "A" });
    const form = { targetRoles: [], benefits: {}, searchTerms: " kotlin developer \nReact Native\nreact native\n", location: " Manchester ", excludeKeywords: "Senior\nLead", minSalary: "£30,000" };
    const save = await savePreferences(form, apiFetch);
    assert.equal(save.kind, "saved");
    const expected = { version: 1, targetRoles: [], benefits: {}, searchTerms: ["kotlin developer", "React Native"], location: "Manchester", excludeKeywords: ["Senior", "Lead"], minSalary: 30000 };
    assert.deepEqual((save as { preferences: unknown }).preferences, expected);
    assert.deepEqual(getCandidate(t.db, c.id)?.preferences, expected);

    const load = await loadPreferences(apiFetch);
    if (load.kind !== "loaded") assert.fail(`expected loaded, got ${load.kind}`);
    assert.deepEqual(formFromPreferences(load.preferences), {
      targetRoles: [], benefits: {}, searchTerms: "kotlin developer\nReact Native", location: "Manchester", excludeKeywords: "Senior\nLead", minSalary: "30000",
    });
    assert.deepEqual(calls.map((c) => c.method), ["PUT", "GET"]);
  });

  test("invalid input: field errors for each field, a summary message, and nothing saved", async () => {
    const c = createCandidate(t.db, { fullName: "A" });
    const save = await savePreferences({ targetRoles: [], benefits: {}, searchTerms: "", location: "x", excludeKeywords: "y", minSalary: "thirty" }, apiFetch);
    assert.equal(save.kind, "invalid");
    const { fieldErrors, message } = save as { fieldErrors: Record<string, string>; message: string };
    assert.deepEqual(Object.keys(fieldErrors).sort(), ["excludeKeywords", "location", "minSalary", "searchTerms"]);
    assert.equal(message, "Please fix the highlighted fields.");
    assert.equal(storedRaw(c.id), null);
  });

  test("clear: saved preferences are removed (SQL NULL) and the form empties", async () => {
    const c = createCandidate(t.db, { fullName: "A", preferences: { version: 1, targetRoles: [], benefits: {}, searchTerms: ["Kotlin"], location: "Leeds", excludeKeywords: [], minSalary: null } });
    const result = await clearPreferences(apiFetch);
    assert.deepEqual(result, { kind: "saved", preferences: null });
    assert.equal(storedRaw(c.id), null);
    assert.deepEqual(calls, [{ url: "/api/preferences", method: "PUT", body: { preferences: null } }]);
    assert.deepEqual(formFromPreferences(null), { ...EMPTY_PREFERENCES_FORM, location: "London" });
  });

  test("invalid saved preferences: loaded as none, with the server's warning", async () => {
    createCandidate(t.db, { fullName: "A", preferences: { roles: ["Android"] } });
    const load = await loadPreferences(apiFetch);
    assert.equal(load.kind, "loaded");
    assert.equal((load as { preferences: unknown }).preferences, null);
    assert.match(String((load as { warning: string }).warning), /not valid/);
  });

  test("saving changes only the candidate's preferences", async () => {
    createCandidate(t.db, { fullName: "A" });
    const tables = (t.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
    const before = tables.map((n) => count(t.db, n));
    await savePreferences({ targetRoles: [], benefits: {}, searchTerms: "Kotlin", location: "Leeds", excludeKeywords: "", minSalary: "" }, apiFetch);
    await clearPreferences(apiFetch);
    assert.deepEqual(tables.map((n) => count(t.db, n)), before);
  });
});

describe("3b-5b: network and server failures", () => {
  test("the Job Agent is unreachable", async () => {
    const down = async () => { throw new TypeError("fetch failed"); };
    assert.equal((await loadPreferences(down)).kind, "error");
    const save = await savePreferences(EMPTY_PREFERENCES_FORM, down);
    assert.deepEqual(save, { kind: "error", message: "Could not reach the Job Agent. Check that it is still running, then try again." });
  });

  test("a server error shows the server's message, or the status", async () => {
    const fail = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
    assert.deepEqual(await loadPreferences(fail(500, { error: "Failed to load preferences" })), { kind: "error", message: "Failed to load preferences" });
    assert.deepEqual(await clearPreferences(fail(502, null)), { kind: "error", message: "Something went wrong (HTTP 502). Please try again." });
    assert.deepEqual(await savePreferences(EMPTY_PREFERENCES_FORM, fail(400, { error: "Send { preferences: {...} }" })), {
      kind: "invalid", message: "Send { preferences: {...} }", fieldErrors: {},
    });
  });
});

// ── Page structure (source checks) ──────────────────────────────────────────

describe("3b-5b: the /preferences page and the link from /", () => {
  const page = read("app/preferences/page.tsx");
  const client = read("lib/preferences-client.ts");
  const home = read("app/page.tsx");

  test("a client page that loads on open and saves/clears through the helpers", () => {
    assert.ok(page.startsWith('"use client";'));
    assert.match(page, /export default function PreferencesPage\(\)/);
    assert.match(page, /useEffect\(\(\) => \{\s*let cancelled = false;\s*loadPreferences\(\)\.then/);
    assert.match(page, /await savePreferences\(form\)/);
    assert.match(page, /await clearPreferences\(\)/);
    assert.equal(page.includes("eslint-disable"), false);
  });

  test("every field has a labelled input and an error slot", () => {
    for (const field of ["searchTerms", "location", "excludeKeywords", "minSalary"]) {
      assert.match(page, new RegExp(`htmlFor="${field}"`), field);
      assert.match(page, new RegExp(`id="${field}"`), field);
      assert.match(page, new RegExp(`errorFor\\("${field}"\\)`), field);
    }
  });

  test("loading, saving, clearing, success, error and no-CV states are shown", () => {
    for (const text of ["Loading preferences…", "Saving…", "Clearing…", "Preferences saved.", "Preferences cleared.", "Try again", "Upload your CV"]) {
      assert.ok(page.includes(text), text);
    }
    assert.match(page, /role=\{message\.kind === "error" \? "alert" : "status"\}/);
    assert.match(page, /disabled=\{disabled \|\| saved === null\}/);
  });

  test("clearing asks for confirmation first", () => {
    assert.match(page, /async function clear\(\) \{\s*if \(!window\.confirm\(/);
  });

  test("the page and helpers only talk to /api/preferences: no search, application, submission or email", () => {
    for (const source of [page, client]) {
      for (const forbidden of ["/api/jobs", "/api/match", "/api/applications", "/api/cover-letter", "mark_submitted", "window.open", "resend", "sendEmail"]) {
        assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
      }
    }
    assert.equal((client.match(/fetchImpl\(/g) ?? []).length, 1);
    assert.match(client, /fetchImpl\("\/api\/preferences", init\)/);
    assert.equal(/\bfetch\(/.test(page), false);
  });

  test("Preferences is reachable from every page (app navigation) and from the home page", () => {
    // Since the Command Centre v2 pass, navigation lives in the app layout.
    const nav = read("app/components/AppNav.tsx");
    const layout = read("app/layout.tsx");
    assert.match(layout, /import AppNav from "\.\/components\/AppNav";/);
    assert.match(layout, /<AppNav \/>/);
    assert.match(nav, /\{ href: "\/preferences", label: "Preferences"/);
    assert.ok(nav.indexOf('href: "/applications"') < nav.indexOf('href: "/preferences"'));
    assert.match(home, /import Link from "next\/link";/);
    assert.match(home, /<Link href="\/preferences"/);
  });

  test("the page links back to /", () => {
    assert.match(page, /<Link\s+href="\/"/);
  });
});
