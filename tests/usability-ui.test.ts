import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { awayMessage, matchQuality, nextStep } from "../lib/dashboard-client.ts";
import { activeSection } from "../lib/nav.ts";

// Usability pass: guided next step, plain-language navigation, full-width
// shell, accessibility basics. Presentation only — no backend changes.

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

const base = { hasProfile: true, matches: 10, strongToExplore: 0, needsReview: 0, readyToApply: 0, preparing: 0, applied: 0, awaitingResponse: 0 };

describe("usability: the one next step", () => {
  test("no CV → upload first", () => {
    const step = nextStep({ ...base, hasProfile: false, matches: 0 });
    assert.equal(step.title, "Upload your CV to get started.");
    assert.deepEqual(step.action, { label: "Upload CV", href: "/#search" });
  });

  test("applications ready for review come first (singular and plural)", () => {
    assert.equal(nextStep({ ...base, needsReview: 7, strongToExplore: 3 }).title, "7 applications are ready for your review.");
    assert.equal(nextStep({ ...base, needsReview: 1 }).title, "1 application is ready for your review.");
    assert.deepEqual(nextStep({ ...base, needsReview: 2 }).action, { label: "Review applications", href: "/review" });
    assert.equal(nextStep({ ...base, needsReview: 2, preparing: 3 }).detail, "Your agent is preparing 3 applications in the background.");
  });

  test("approved applications, then no matches, then strong matches", () => {
    assert.deepEqual(nextStep({ ...base, readyToApply: 2 }).action, { label: "Open applications", href: "/applications" });
    assert.deepEqual(nextStep({ ...base, matches: 0 }), {
      title: "Find jobs that match you.",
      detail: "Your agent searches several job sites and ranks every job against your CV.",
      action: { label: "Find jobs", href: "/#search" },
    });
    assert.equal(nextStep({ ...base, strongToExplore: 8 }).title, "You have 8 strong matches to explore.");
    assert.deepEqual(nextStep({ ...base, strongToExplore: 1 }).action, { label: "See my matches", href: "/#jobs" });
  });

  test("up to date: applied count and responses still awaited", () => {
    const step = nextStep({ ...base, applied: 4, awaitingResponse: 2 });
    assert.equal(step.title, "You're up to date.");
    assert.equal(step.detail, "You've applied to 4 jobs. 2 are still waiting for a response.");
    assert.equal(nextStep({ ...base, applied: 1 }).detail, "You've applied to 1 job.");
  });
});

describe("usability: while you were away", () => {
  test("only real activity produces a message", () => {
    assert.equal(awayMessage({ newMatches: 0, newStrong: 0, finished: 0, processing: 0, attention: 0 }), null);
    assert.equal(awayMessage({ newMatches: 9, newStrong: 3, finished: 4, processing: 0, attention: 0 }), "Your agent found 9 new matches (3 strong) and prepared 4 applications.");
    assert.equal(awayMessage({ newMatches: 1, newStrong: 0, finished: 0, processing: 0, attention: 0 }), "Your agent found 1 new match.");
    assert.equal(awayMessage({ newMatches: 0, newStrong: 0, finished: 2, processing: 1, attention: 1 }), "Your agent prepared 2 applications. 1 still in progress, 1 needs your attention.");
  });
});

describe("usability: labels and navigation", () => {
  test("a score always comes with words, not colour alone", () => {
    assert.equal(matchQuality(85), "Excellent match");
    assert.equal(matchQuality(74), "Strong match");
    assert.equal(matchQuality(60), "Possible match");
    assert.equal(matchQuality(30), "Weak match");
    assert.equal(matchQuality(null), "Not scored");
  });

  test("/review belongs to Applications; other paths map to their section", () => {
    assert.equal(activeSection("/"), "/");
    assert.equal(activeSection("/review"), "/applications");
    assert.equal(activeSection("/applications"), "/applications");
    assert.equal(activeSection("/preferences"), "/preferences");
    assert.equal(activeSection("/elsewhere"), "");
  });

  test("Applications and Review share tabs, so review is never hidden", () => {
    const tabs = read("app/components/ApplicationsTabs.tsx");
    assert.deepEqual([...tabs.matchAll(/href: "([^"]+)"/g)].map((m) => m[1]), ["/review", "/applications"]);
    for (const page of ["app/review/page.tsx", "app/applications/page.tsx"]) {
      assert.match(read(page), /<ApplicationsTabs \/>/, page);
    }
  });

  test("every link on the redesigned pages points to an existing route", () => {
    const routes = new Set(["/", "/review", "/applications", "/preferences"]);
    for (const file of ["app/components/CommandCentre.tsx", "app/components/AppNav.tsx", "app/components/ApplicationsTabs.tsx", "app/page.tsx", "app/review/page.tsx", "app/applications/page.tsx", "app/preferences/page.tsx", "lib/dashboard-client.ts"]) {
      const source = read(file);
      const hrefs = [...source.matchAll(/href(?:=|: )"([^"]+)"/g)].map((m) => m[1]);
      for (const href of hrefs) {
        if (href.startsWith("#")) continue;
        assert.ok(routes.has(href.split("#")[0]), `${file}: ${href}`);
      }
    }
  });
});

describe("usability: full-width shell and accessibility basics", () => {
  test("navigation and every page use the shared wide shell", () => {
    assert.match(read("app/globals.css"), /@utility app-shell \{[\s\S]*max-width: 1600px;/);
    for (const file of ["app/components/AppNav.tsx", "app/page.tsx", "app/review/page.tsx", "app/applications/page.tsx", "app/preferences/page.tsx"]) {
      assert.ok(read(file).includes("app-shell"), file);
      assert.equal(read(file).includes("max-w-5xl"), false, file);
      assert.equal(read(file).includes("max-w-6xl"), false, file);
    }
  });

  test("visible focus, reduced motion, readable text sizes", () => {
    const css = read("app/globals.css");
    assert.match(css, /:focus-visible \{\s*outline: 2px solid/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    for (const file of ["app/components/AppNav.tsx", "app/components/CommandCentre.tsx"]) {
      assert.doesNotMatch(read(file), /text-\[(9|10|11)px\]/, file);
    }
  });

  test("job rows: labelled checkbox, expandable Why? with aria-expanded, View Job announces the new tab", () => {
    const component = read("app/components/CommandCentre.tsx");
    assert.match(component, /aria-label=\{`Select \$\{match\.title\}`\}/);
    assert.match(component, /aria-expanded=\{open\}/);
    assert.match(component, /aria-controls=\{detailsId\}/);
    assert.match(component, /\(opens the job advert in a new tab\)/);
  });

  test("the home page speaks to the user, not about job-source integrations", () => {
    const page = read("app/page.tsx");
    const component = read("app/components/CommandCentre.tsx");
    assert.equal(/searches Adzuna and Reed/.test(page), false);
    assert.ok(component.includes("Your agent searches several job sites for you."));
    // The existing discovery flow is unchanged underneath.
    assert.match(page, /onClick=\{analyseCV\}/);
    assert.match(page, /await fetch\("\/api\/jobs"/);
  });
});
