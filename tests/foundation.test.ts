import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describeError, redactSecrets } from "../lib/log-safety.ts";
import {
  APPLICATION_QUESTIONS_PROMPT_VERSION,
  COVER_LETTER_PROMPT_VERSION,
  GENERATION_MODEL,
  TAILOR_CV_PROMPT_VERSION,
} from "../lib/generation/versions.ts";

// Phase 3 checkpoint 3a: foundation clean-up guards.

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

function sourceFiles(dir: string): string[] {
  return (fs.readdirSync(path.join(root, dir), { recursive: true }) as string[])
    .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f))
    .map((f) => path.join(dir, f).replace(/\\/g, "/"));
}

/** Every console.* call in a source file, as the full call text (balanced parentheses). */
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

describe("3a: unused routes are gone", () => {
  const removed = ["analyse-cv", "extract-cv-structured", "extract-projects"];

  test("the route files no longer exist", () => {
    for (const name of removed) assert.equal(fs.existsSync(path.join(root, "app/api", name)), false, name);
  });

  test("nothing in the code references them", () => {
    const files = [...sourceFiles("app"), ...sourceFiles("lib"), ...sourceFiles("scripts"), ...sourceFiles("tests")].filter(
      (f) => !f.endsWith("tests/foundation.test.ts")
    );
    for (const file of files) {
      const source = read(file);
      for (const name of removed) assert.equal(source.includes(name), false, `${file} mentions ${name}`);
    }
  });
});

describe("3a: /api/match uses the long-timeout client", () => {
  test("Ollama is called through undici with the long-timeout agent, not the built-in fetch", () => {
    const source = read("app/api/match/route.ts");
    assert.match(source, /import \{ fetch as undiciFetch, Agent \} from "undici";/);
    assert.match(source, /headersTimeout: 1_200_000/);
    assert.match(source, /await undiciFetch\("http:\/\/localhost:11434\/api\/generate"[\s\S]{0,200}dispatcher: longTimeoutAgent/);
    assert.doesNotMatch(source, /await fetch\("http:\/\/localhost:11434/);
  });
});

describe("3a: logs carry no personal or application content", () => {
  // Expressions that hold CV text, the candidate profile, model output with
  // CV/application content, or full job/match objects.
  const FORBIDDEN = [
    /candidateText/,
    /\bresponse\.response\b(?!\?\.length)/,
    /\bdata\.response\b/,
    /structuredCV\.name/,
    /\bcvText\b(?!\.length)/,
    /pdfData\.text/,
    /candidate\.technicalSkills\b(?!\s*\|\|\s*\[\]\)\.length)/,
    /JSON\.stringify\((candidate|responseMatches|matches|structuredCV|analysis|tailoredCV)\b/,
    /\bscoredJobs\b(?!\.length)/,
    /\b(coverLetter|tailoredCV|answers|lowerReason)\b(?!\.length)/,
    /job\.(title|company|description)/,
  ];
  const files = [...sourceFiles("app/api"), ...sourceFiles("lib")];

  test("no console call in app/api or lib prints them", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const call of consoleCalls(read(file))) {
        if (FORBIDDEN.some((re) => re.test(call))) offenders.push(`${file}: ${call.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test("raw fetch errors from job sources are logged through describeError", () => {
    const source = read("app/api/jobs/route.ts");
    assert.match(source, /Adzuna request error:", term, describeError\(error\)/);
    assert.match(source, /Reed request error:", term, describeError\(error\)/);
  });

  test("describeError keeps the type, code and message but strips URLs and keys", () => {
    const urlError = new TypeError(
      "Failed to parse URL from https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=abc123&app_key=SECRETKEY987"
    );
    const described = describeError(urlError);
    assert.match(described, /^TypeError: Failed to parse URL from \[url\]$/);
    assert.equal(described.includes("SECRETKEY987"), false);
    assert.equal(described.includes("abc123"), false);

    const network = new TypeError("fetch failed", { cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }) });
    assert.equal(describeError(network), "TypeError (ECONNREFUSED): fetch failed");

    assert.equal(redactSecrets("bad request app_key=XYZ&x=1 token=abc"), "bad request app_key=[redacted]&x=1 token=[redacted]");
    assert.equal(describeError("plain string with api_key=K1"), "plain string with api_key=[redacted]");
  });
});

describe("3a: explicit model and prompt versions for preparation", () => {
  test("the constants are defined", () => {
    assert.equal(GENERATION_MODEL, "llama3.2:3b");
    assert.equal(TAILOR_CV_PROMPT_VERSION, "tailor-cv/v1");
    assert.equal(COVER_LETTER_PROMPT_VERSION, "cover-letter/v1");
    assert.equal(APPLICATION_QUESTIONS_PROMPT_VERSION, "application-questions/v1");
  });

  test("each generator uses the shared model constant and its prompt version", () => {
    // Since 3c the generation code lives in lib/generation (the routes are thin).
    const routes: [string, string][] = [
      ["lib/generation/tailor-cv.ts", "TAILOR_CV_PROMPT_VERSION"],
      ["lib/generation/cover-letter.ts", "COVER_LETTER_PROMPT_VERSION"],
      ["lib/generation/questions.ts", "APPLICATION_QUESTIONS_PROMPT_VERSION"],
    ];
    for (const [file, version] of routes) {
      const source = read(file);
      assert.match(source, /model: GENERATION_MODEL,/, file);
      assert.ok(source.includes(`promptVersion: ${version}`), `${file} logs ${version}`);
      assert.equal(source.includes('"llama3.2:3b"'), false, `${file} has no model literal`);
    }
    assert.match(read("lib/pipeline/applications.ts"), /const ASSET_MODEL = GENERATION_MODEL;/);
  });
});
