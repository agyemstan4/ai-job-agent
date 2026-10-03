import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { MatchCandidate, MatchJob } from "../lib/pipeline/match-scoring.ts";
import {
  buildMatchPrompt,
  filterReasonFor,
  jobIdOf,
  MAX_JOBS_TO_SCORE,
  SCORING_DESCRIPTION_CHARS,
  selectJobsForScoring,
  skillKeywordsFor,
} from "../lib/pipeline/match-scoring.ts";

// Phase 3 checkpoint 3b-1: the pre-filter, selection and scoring prompt were
// moved out of app/api/match/route.ts unchanged. The reference below is the
// match/v1 code as it was in the route at f9cd6ac, copied verbatim (only
// wrapped in functions); the extracted code must produce identical output.

/* eslint-disable @typescript-eslint/no-explicit-any -- verbatim copy of the v1 route code */
function referenceSelectionV1(candidate: any, jobs: any[]) {
    const roleKeywords = [
      "software engineer", "software developer", "developer", "engineer",
      "frontend", "backend", "full stack", "full-stack", "android",
      "mobile", "graduate", "junior", "web developer",
    ];

    const skillKeywords = (candidate.technicalSkills || []).map(
      (skill: string) => skill.toLowerCase()
    );

    const seniorTitlePattern =
      /\b(senior|lead|principal|staff|architect|manager|director)\b/i;

    type IncomingJob = { jobId?: unknown; title?: string; description?: string };
    const filterReasonFor = (job: IncomingJob): string | null => {
      const text = `${job.title} ${job.description}`.toLowerCase();
      const hasDeveloperRole = roleKeywords.some(kw => text.includes(kw));
      const hasRelevantSkill = skillKeywords.some((skill: string) => text.includes(skill));
      const isSenior = seniorTitlePattern.test(job.title || "");
      if (!hasDeveloperRole) return "No developer role keyword in the title or description";
      if (!hasRelevantSkill) return "None of the candidate's skills appear in the title or description";
      if (isSenior) return "Senior title";
      return null;
    };

    const filteredJobs = jobs.filter((job: IncomingJob) => filterReasonFor(job) === null);

    const uniqueFilteredJobs = Array.from(
      new Map<string, any>(
        filteredJobs.map((job: any) => [`${job.title}-${job.company}`, job])
      ).values()
    );

    const rankedJobs = [...uniqueFilteredJobs].sort((a: any, b: any) => {
      const scoreJob = (job: any) => {
        const text = `${job.title} ${job.description}`.toLowerCase();
        let score = 0;
        skillKeywords.forEach((skill: string) => {
          if (text.includes(skill)) score += 10;
        });
        if (text.includes("junior")) score += 5;
        if (text.includes("graduate")) score += 5;
        return score;
      };
      return scoreJob(b) - scoreJob(a);
    });

const MAX_JOBS_TO_SCORE = 10;

const selectedJobs = rankedJobs.slice(0, MAX_JOBS_TO_SCORE);

    const jobIdOf = (job: IncomingJob | null | undefined): number | null =>
      typeof job?.jobId === "number" ? job.jobId : null;
    const filteredOutJobs = jobs
      .map((job: IncomingJob) => ({ jobId: jobIdOf(job), reason: filterReasonFor(job) }))
      .filter((job: { jobId: number | null; reason: string | null }): job is { jobId: number; reason: string } =>
        job.jobId !== null && job.reason !== null
      );

  return { filteredJobs, uniqueFilteredJobs, rankedJobs, selectedJobs, filteredOut: filteredOutJobs };
}

function referencePromptV1(candidate: any, job: any, index: number) {
      const jobPrompt = `
You are a job matcher. Score how well this candidate matches this job.

CANDIDATE SKILLS: ${candidate.technicalSkills.join(", ")}
CANDIDATE BACKGROUND: ${candidate.summary}
EXPERIENCE LEVEL: ${candidate.experienceLevel}

JOB: ${job.title} at ${job.company}
REQUIRES: ${(job.description || "").slice(0, 150)}

Output JSON only. No explanation outside JSON.

{
  "jobNumber": ${index + 1},
  "matchScore": 0,
  "reason": "",
  "strengths": [],
  "missingSkills": [{"skill": "Spring Boot", "importance": "medium"}],
  "breakdown": {
    "technicalSkills": "<integer 0-100, unique to this job>",
    "experienceLevel": "<integer 0-100, unique to this job>",
    "projects": "<integer 0-100, unique to this job>",
    "growthPotential": "<integer 0-100, unique to this job>"
  }
}

Rules:
- matchScore 0-100 integer
- strengths must be from candidate skills only
- missingSkills must NOT include skills the candidate already has
- reason max 20 words
- jobNumber must be ${index + 1}
- Every number in "breakdown" MUST be calculated specifically for THIS job based on the candidate's actual skills versus this job's actual requirements. Do NOT reuse the same numbers across different jobs — a stronger match should score higher, a weaker match should score lower.
- "technicalSkills" = how many of the candidate's listed skills appear in this job's requirements, as a percentage.
- "experienceLevel" = how well the candidate's experience level suits this specific job's seniority.
- "projects" = how relevant the candidate's project background is to this specific job's domain.
- "growthPotential" = realistic potential for growth in this specific role given the candidate's trajectory.
`;
  return jobPrompt;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Fixtures ────────────────────────────────────────────────────────────────

const candidate: MatchCandidate = {
  technicalSkills: ["Java", "Kotlin", "React", "Node.js", "SQL", "Docker"],
  summary: "Graduate engineer who built an Android app and a web dashboard.",
  experienceLevel: "Graduate",
};

type Job = MatchJob & { id?: string; sourceIds?: string[]; url?: string };

const handPicked: Job[] = [
  { jobId: 1, id: "adzuna_1", title: "Junior Java Developer", company: "Acme", description: "Java and SQL, graduate scheme" },
  { jobId: 2, id: "reed_2", title: "Senior Java Developer", company: "Acme", description: "Lead a team using Java" },
  { jobId: 3, id: "adzuna_3", title: "Data Analyst", company: "Numbers", description: "Excel and Power BI" },
  { jobId: 4, id: "reed_4", title: "Frontend Developer", company: "Shop", description: "Ruby and Go only" },
  // A duplicate title + company: the last one wins, the first one's position is kept.
  { jobId: 5, id: "adzuna_5", title: "Android Engineer", company: "Mobi", description: "Kotlin" },
  { jobId: 6, id: "reed_6", title: "Android Engineer", company: "Mobi", description: "Kotlin, Java, Docker, junior" },
  // Missing fields: "undefined" ends up in the filter text, as before.
  { jobId: 7, id: "adzuna_7", title: "Graduate Software Engineer", company: "Corp" },
  { id: "reed_8", title: "React Developer", company: "NoId", description: "React and Node.js" },
  { jobId: "9" as unknown, id: "adzuna_9", title: "Lead Engineer", company: "StringId", description: "java" },
  { jobId: 10, id: "adzuna_10", title: "Engineering Manager", company: "Boss", description: "docker" },
  { jobId: 11, id: "reed_11", title: "Staff Developer", company: "S", description: "react" },
  { jobId: 12, id: "adzuna_12", title: "Leading Web Developer", company: "L", description: "sql" },
  // Equal rank: the stable sort keeps input order.
  { jobId: 13, id: "reed_13", title: "Web Developer", company: "Tie A", description: "sql" },
  { jobId: 14, id: "reed_14", title: "Web Developer", company: "Tie B", description: "sql" },
  { jobId: 15, id: "adzuna_15", title: "", company: "Blank", description: "" },
  // The de-duplication key is `${title}-${company}`, so these two collide in v1.
  { jobId: 16, id: "adzuna_16", title: "Java Developer-London", company: "X", description: "java" },
  { jobId: 17, id: "reed_17", title: "Java Developer", company: "London-X", description: "java" },
  // One job per role keyword, where that keyword is the only one present.
  ...[
    "software engineer", "software developer", "developer", "engineer",
    "frontend", "backend", "full stack", "full-stack", "android",
    "mobile", "graduate", "junior", "web developer",
  ].map((keyword, i) => ({
    jobId: 100 + i,
    id: `adzuna_${100 + i}`,
    title: `Role ${i}`,
    company: `Keyword ${i}`,
    description: `${keyword} with sql`,
  })),
];

/** Deterministic pseudo-random jobs (mulberry32), to cover many combinations. */
function generatedJobs(seed: number, n: number): Job[] {
  let s = seed;
  const rand = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const prefixes = ["", "Junior ", "Graduate ", "Senior ", "Lead ", "Principal ", "Mid "];
  const roles = ["Software Engineer", "Java Developer", "Frontend Developer", "Data Analyst", "Android Developer", "Product Manager", "QA Tester", "Full Stack Developer"];
  const companies = ["Acme", "Globex", "Initech", "Umbrella", "Hooli"];
  const words = ["java", "kotlin", "react", "node.js", "sql", "docker", "python", "excel", "junior", "graduate", "backend", "team", "agile", "aws"];
  return Array.from({ length: n }, (_, i) => {
    const description =
      rand() < 0.1 ? undefined : Array.from({ length: Math.floor(rand() * 40) }, () => pick(words)).join(" ");
    return {
      jobId: rand() < 0.9 ? i + 1 : undefined,
      id: `adzuna_${i}`,
      title: rand() < 0.03 ? undefined : `${pick(prefixes)}${pick(roles)}`,
      company: pick(companies),
      description,
    };
  });
}

const candidates: MatchCandidate[] = [
  candidate,
  { technicalSkills: ["Python"], summary: "Data person", experienceLevel: "Junior" },
  { technicalSkills: [], summary: "No skills listed", experienceLevel: "Entry" },
  // No summary or experience level: "undefined" appears in the prompt, as in v1.
  { technicalSkills: ["Java", "SQL"] },
  { summary: "No technicalSkills field" },
];

// ── Tests ───────────────────────────────────────────────────────────────────

describe("3b-1: job selection is unchanged from match/v1", () => {
  const fixtures: [string, Job[]][] = [
    ["hand-picked jobs", handPicked],
    ["no jobs", []],
    ["40 generated jobs", generatedJobs(1, 40)],
    ["200 generated jobs", generatedJobs(42, 200)],
    ["500 generated jobs", generatedJobs(7, 500)],
  ];

  for (const [name, jobs] of fixtures) {
    for (const [i, cand] of candidates.entries()) {
      test(`${name}, candidate ${i + 1}`, () => {
        const expected = referenceSelectionV1(cand, jobs);
        const actual = selectJobsForScoring(jobs, cand);
        assert.deepEqual(actual, expected);
        // The same job objects, in the same order (not copies).
        for (const key of ["filteredJobs", "uniqueFilteredJobs", "rankedJobs", "selectedJobs"] as const) {
          assert.equal(actual[key].length, expected[key].length, key);
          actual[key].forEach((job, j) => assert.equal(job, expected[key][j], `${key}[${j}]`));
        }
      });
    }
  }

  test("the hand-picked fixture exercises every branch", () => {
    const result = selectJobsForScoring(handPicked, candidate);
    const reasons = new Set(result.filteredOut.map((f) => f.reason));
    assert.deepEqual(
      [...reasons].sort(),
      [
        "No developer role keyword in the title or description",
        "None of the candidate's skills appear in the title or description",
        "Senior title",
      ]
    );
    // Duplicate title + company collapsed to the later job, in the earlier position.
    assert.equal(result.filteredJobs.filter((j) => j.title === "Android Engineer").length, 2);
    assert.deepEqual(result.uniqueFilteredJobs.filter((j) => j.title === "Android Engineer").map((j) => j.jobId), [6]);
    // Jobs without a numeric jobId are never reported as filtered out.
    assert.equal(result.filteredOut.some((f) => f.jobId === 9), false);
    // Whole-word seniority: "Leading" is not "Lead".
    assert.ok(result.filteredJobs.some((j) => j.jobId === 12));
  });

  test("at most MAX_JOBS_TO_SCORE (10) jobs are selected", () => {
    assert.equal(MAX_JOBS_TO_SCORE, 10);
    const result = selectJobsForScoring(generatedJobs(42, 200), candidate);
    assert.ok(result.rankedJobs.length > 10);
    assert.equal(result.selectedJobs.length, 10);
    assert.deepEqual(result.selectedJobs, result.rankedJobs.slice(0, 10));
  });

  test("helpers agree with the selection", () => {
    const skills = skillKeywordsFor(candidate);
    assert.deepEqual(skills, ["java", "kotlin", "react", "node.js", "sql", "docker"]);
    assert.deepEqual(skillKeywordsFor({}), []);
    assert.equal(filterReasonFor(handPicked[0], skills), null);
    assert.equal(filterReasonFor(handPicked[1], skills), "Senior title");
    assert.equal(jobIdOf({ jobId: 3 }), 3);
    assert.equal(jobIdOf({ jobId: "3" }), null);
    assert.equal(jobIdOf(null), null);
  });
});

describe("3b-1: the scoring prompt is unchanged from match/v1", () => {
  const long = "Requirements: ".padEnd(400, "java kotlin react ");
  const jobs: Job[] = [
    ...handPicked,
    { title: "Java Developer", company: "Long", description: long },
    { title: "Java Developer", company: "Exact", description: "x".repeat(150) },
    ...generatedJobs(3, 30),
  ];

  test("identical prompt text for every job, position and candidate", () => {
    for (const cand of candidates.filter((c) => Array.isArray(c.technicalSkills))) {
      jobs.forEach((job, index) => {
        assert.equal(buildMatchPrompt(cand, job, index), referencePromptV1(cand, job, index));
      });
    }
  });

  test("still limited to the first 150 characters of the description", () => {
    assert.equal(SCORING_DESCRIPTION_CHARS, 150);
    const prompt = buildMatchPrompt(candidate, { title: "T", company: "C", description: long }, 0);
    assert.ok(prompt.includes(`REQUIRES: ${long.slice(0, 150)}\n`));
    assert.equal(prompt.includes(long.slice(0, 151)), false);
  });

  test("a candidate without technicalSkills still throws, as before", () => {
    const cand = { summary: "x" };
    assert.throws(() => referencePromptV1(cand, handPicked[0], 0), TypeError);
    assert.throws(() => buildMatchPrompt(cand, handPicked[0], 0), TypeError);
  });
});

describe("3b-1: /api/match uses the extracted pipeline", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "..", "app/api/match/route.ts"), "utf8");

  test("the route calls selectJobsForScoring and buildMatchPrompt", () => {
    assert.match(source, /selectJobsForScoring<IncomingJob>\(jobs, candidate\)/);
    assert.match(source, /const jobPrompt = buildMatchPrompt\(candidate, job, index\);/);
  });

  test("no copy of the filter, ranking or prompt is left in the route", () => {
    for (const leftover of ["roleKeywords", "seniorTitlePattern", "MAX_JOBS_TO_SCORE =", "You are a job matcher", ".slice(0, 150)", "filterReasonFor"]) {
      assert.equal(source.includes(leftover), false, leftover);
    }
  });

  test("the prompt version is still match/v1", () => {
    assert.match(source, /const MATCH_PROMPT_VERSION = "match\/v1";/);
  });
});
