import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_TAILOR_VARIANT, mergeTailoredParts } from "../lib/generation/tailor-cv.ts";
import { TAILOR_CV_PROMPT_VERSION } from "../lib/generation/versions.ts";

// Phase 3 checkpoint 3d: tailor-cv/v2 — the model writes only the summary and
// the experience bullets; everything else is merged from the stored CV.

const CV = {
  name: "Test Candidate",
  email: "test@example.com",
  phone: "07000 000000",
  location: "London",
  summary: "Original summary.",
  experience: [
    { title: "Intern", company: "Acme", dates: "2025", bullets: ["Built A", "Built B", "Built C", "Built D"] },
    { title: "Assistant", company: "Shop", dates: "2023", bullets: ["Helped"] },
  ],
  education: [{ degree: "BSc", institution: "Uni", dates: "2025", notes: "First" }],
  skills: ["Java", "Kotlin"],
  projects: [{ name: "App", date: "2024", bullets: ["Shipped"], skillsUsed: ["Kotlin"] }],
};

describe("3d: tailor-cv v2 merge", () => {
  test("only the summary and experience bullets come from the model; everything else is the stored CV", () => {
    const merged = mergeTailoredParts(CV, {
      summary: "  Tailored summary.  ",
      experience: [
        { title: "Changed title", company: "Changed", dates: "Changed", bullets: ["Built A for this role", "Built C"] },
        { title: "Assistant", bullets: ["Helped customers"] },
      ],
      name: "Someone Else",
      skills: ["Invented"],
    });
    assert.equal(merged.summary, "Tailored summary.");
    assert.deepEqual(merged.experience, [
      { title: "Intern", company: "Acme", dates: "2025", bullets: ["Built A for this role", "Built C"] },
      { title: "Assistant", company: "Shop", dates: "2023", bullets: ["Helped customers"] },
    ]);
    for (const key of ["name", "email", "phone", "location", "education", "skills", "projects"] as const) {
      assert.deepEqual(merged[key], CV[key], key);
    }
  });

  test("missing or unusable model output keeps the original", () => {
    assert.deepEqual(mergeTailoredParts(CV, {}), { ...CV });
    assert.deepEqual(mergeTailoredParts(CV, null), { ...CV });
    const bad = mergeTailoredParts(CV, { summary: "   ", experience: [{ bullets: [] }, { bullets: ["", 3] }] });
    assert.equal(bad.summary, CV.summary);
    assert.deepEqual(bad.experience, CV.experience);
  });

  test("extra model roles are ignored; fewer roles keep the rest unchanged", () => {
    const merged = mergeTailoredParts(CV, { experience: [{ bullets: ["Only first", "And second"] }] });
    assert.deepEqual((merged.experience as { bullets: string[] }[]).map((e) => e.bullets), [["Only first", "And second"], ["Helped"]]);
    const extra = mergeTailoredParts(CV, { experience: [{ bullets: ["a"] }, { bullets: ["b"] }, { bullets: ["c"] }] });
    assert.equal((extra.experience as unknown[]).length, 2);
  });

  test("a CV without experience stays without experience", () => {
    assert.deepEqual(mergeTailoredParts({ ...CV, experience: undefined }, { experience: [{ bullets: ["x"] }] }).experience, []);
  });

  test("the default variant follows the prompt version constant", () => {
    assert.equal(DEFAULT_TAILOR_VARIANT, (TAILOR_CV_PROMPT_VERSION as string) === "tailor-cv/v2" ? "v2" : "v1");
  });

  test("the bullet rule is enforced: a role that kept too few bullets keeps its original ones", () => {
    const merged = mergeTailoredParts(CV, {
      experience: [
        { bullets: ["Only one"] }, // the original has 4: at least 2 are required → the original bullets
        { bullets: ["Helped customers"] }, // the original has 1: 1 is enough
      ],
    });
    assert.deepEqual((merged.experience as { bullets: string[] }[]).map((e) => e.bullets), [["Built A", "Built B", "Built C", "Built D"], ["Helped customers"]]);
    const twoOfTwo = mergeTailoredParts({ ...CV, experience: [{ title: "T", company: "C", dates: "D", bullets: ["x", "y"] }] }, { experience: [{ bullets: ["x only"] }] });
    assert.deepEqual((twoOfTwo.experience as { bullets: string[] }[])[0].bullets, ["x", "y"], "fewer than 3: keep all");
  });

  test("v2 lists the CV's project names for the summary rule", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "..", "lib/generation/tailor-cv.ts"), "utf8");
    assert.ok(source.includes("PROJECTS IN THIS CV (name at least two of them in the summary):"));
  });

  test("the v1 prompt is still present unchanged and v2 asks only for summary + experience", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "..", "lib/generation/tailor-cv.ts"), "utf8");
    assert.ok(source.includes(`- "name", "email", "phone", "location", "education", "skills", "projects": copy these EXACTLY as given in the input CV`));
    assert.ok(source.includes("Return ONLY valid JSON with exactly these two fields (everything else in the CV is kept as it is automatically)"));
    assert.match(source, /prompt: variant === "v2" \? promptV2 : prompt,/);
    assert.match(source, /variant === "v2" \? mergeTailoredParts\(structuredCV, parsed\) : parsed/);
  });
});
