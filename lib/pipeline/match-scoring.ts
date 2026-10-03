// The /api/match pre-filter, job selection and scoring prompt, moved out of
// the route unchanged (Phase 3 checkpoint 3b-1) so they can be tested and
// reused. The model call, backend corrections and persistence stay in the route.

/** The candidate fields the filter and prompt read (the CV analysis). */
export type MatchCandidate = {
  technicalSkills?: string[];
  summary?: unknown;
  experienceLevel?: unknown;
};

/** A job as sent to /api/match; other fields are passed through untouched. */
export type MatchJob = {
  jobId?: unknown;
  title?: string;
  company?: string;
  description?: string;
};

export const ROLE_KEYWORDS = [
  "software engineer", "software developer", "developer", "engineer",
  "frontend", "backend", "full stack", "full-stack", "android",
  "mobile", "graduate", "junior", "web developer",
];

// Seniority is judged from the job TITLE only, on whole words. Matching
// substrings across the full description wrongly rejected junior roles
// (e.g. "leading", "our staff", "reporting to the engineering manager").
export const SENIOR_TITLE_PATTERN = /\b(senior|lead|principal|staff|architect|manager|director)\b/i;

// We want to score enough jobs to eventually support
// up to 10 applications per day.
export const MAX_JOBS_TO_SCORE = 10;

// Ollama settings for a scoring call. The prompt and the answer share the
// context window, so the prompt must fit in MATCH_PROMPT_TOKEN_BUDGET tokens:
// a longer prompt is cut from the START by Ollama, silently losing the
// instructions and the candidate.
export const MATCH_NUM_CTX = 2048;
export const MATCH_NUM_PREDICT = 400;
export const MATCH_PROMPT_TOKEN_BUDGET = MATCH_NUM_CTX - MATCH_NUM_PREDICT;

/**
 * How much of the job description the scoring prompt includes (match/v2;
 * v1 used 150). Search snippets (Adzuna ≤ 500, Reed 453 characters) fit
 * whole; a full Reed description is cut at a word. Measured with
 * llama3.2:3b on synthetic prompts (4.2–4.45 characters per token): a
 * v1-sized prompt is ~590 tokens, a snippet ~660, a 2,000-character
 * description with a typical CV ~980, and with a larger CV (30 skills,
 * 1,000-character summary) ~1,140 — still 500 below the budget.
 */
export const SCORING_DESCRIPTION_CHARS = 2000;

/**
 * Whether Ollama probably cut the prompt. Ollama reports the token count
 * AFTER cutting (a 12,800-character prompt was reported as 1,026 tokens),
 * so besides reaching the budget, a prompt with far more characters per
 * token than normal text (~4.2–4.5) is also flagged.
 */
export function promptMayBeTruncated(promptChars: number, promptTokens: number | undefined): boolean {
  if (!promptTokens) return false;
  return promptTokens >= MATCH_PROMPT_TOKEN_BUDGET || promptChars > promptTokens * 6;
}

/**
 * The first maxChars characters of a description, cut back to the last
 * space or line break (if one is in the second half) and ended with "…".
 * Text that fits is returned unchanged.
 */
export function boundDescription(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const lastBreak = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"));
  const cut = lastBreak >= maxChars / 2 ? head.slice(0, lastBreak) : head;
  return `${cut.trimEnd()}…`;
}

/** The stored job ID, or null for jobs that were not recorded. */
export function jobIdOf(job: MatchJob | null | undefined): number | null {
  return typeof job?.jobId === "number" ? job.jobId : null;
}

export function skillKeywordsFor(candidate: MatchCandidate): string[] {
  return (candidate.technicalSkills || []).map((skill: string) => skill.toLowerCase());
}

/**
 * Why a job fails the pre-filter, or null if it passes. A job passes only
 * with a developer role keyword, a candidate skill, and no senior title.
 */
export function filterReasonFor(job: MatchJob, skillKeywords: string[]): string | null {
  const text = `${job.title} ${job.description}`.toLowerCase();
  const hasDeveloperRole = ROLE_KEYWORDS.some(kw => text.includes(kw));
  const hasRelevantSkill = skillKeywords.some((skill: string) => text.includes(skill));
  const isSenior = SENIOR_TITLE_PATTERN.test(job.title || "");
  if (!hasDeveloperRole) return "No developer role keyword in the title or description";
  if (!hasRelevantSkill) return "None of the candidate's skills appear in the title or description";
  if (isSenior) return "Senior title";
  return null;
}

/** Keyword ranking: +10 per candidate skill mentioned, +5 for junior, +5 for graduate. */
export function keywordRank(job: MatchJob, skillKeywords: string[]): number {
  const text = `${job.title} ${job.description}`.toLowerCase();
  let score = 0;
  skillKeywords.forEach((skill: string) => {
    if (text.includes(skill)) score += 10;
  });
  if (text.includes("junior")) score += 5;
  if (text.includes("graduate")) score += 5;
  return score;
}

export type JobSelection<T extends MatchJob> = {
  /** Jobs that passed the pre-filter. */
  filteredJobs: T[];
  /** Passing jobs, one per title + company (the last one wins, first position kept). */
  uniqueFilteredJobs: T[];
  /** Unique passing jobs, best keyword rank first (stable). */
  rankedJobs: T[];
  /** The top MAX_JOBS_TO_SCORE ranked jobs, sent to the model. */
  selectedJobs: T[];
  /** Stored jobs that failed the pre-filter, with the reason. */
  filteredOut: { jobId: number; reason: string }[];
};

export function selectJobsForScoring<T extends MatchJob>(jobs: T[], candidate: MatchCandidate): JobSelection<T> {
  const skillKeywords = skillKeywordsFor(candidate);

  const filteredJobs = jobs.filter((job) => filterReasonFor(job, skillKeywords) === null);

  const uniqueFilteredJobs = Array.from(
    new Map<string, T>(filteredJobs.map((job) => [`${job.title}-${job.company}`, job])).values()
  );

  const rankedJobs = [...uniqueFilteredJobs].sort(
    (a, b) => keywordRank(b, skillKeywords) - keywordRank(a, skillKeywords)
  );

  const selectedJobs = rankedJobs.slice(0, MAX_JOBS_TO_SCORE);

  const filteredOut = jobs
    .map((job) => ({ jobId: jobIdOf(job), reason: filterReasonFor(job, skillKeywords) }))
    .filter((job): job is { jobId: number; reason: string } => job.jobId !== null && job.reason !== null);

  return { filteredJobs, uniqueFilteredJobs, rankedJobs, selectedJobs, filteredOut };
}

/**
 * The scoring prompt for one job (`index` is its 0-based position in
 * selectedJobs). `description` is the text to score against — the job's
 * best stored description (see scoringDescriptionFor), else the one sent in —
 * and is bounded to SCORING_DESCRIPTION_CHARS. Bump MATCH_PROMPT_VERSION in
 * the route when this changes. Throws if the candidate has no
 * technicalSkills array, as before.
 */
export function buildMatchPrompt(
  candidate: MatchCandidate,
  job: MatchJob,
  index: number,
  description: string = job.description || ""
): string {
  return `
You are a job matcher. Score how well this candidate matches this job.

CANDIDATE SKILLS: ${(candidate.technicalSkills as string[]).join(", ")}
CANDIDATE BACKGROUND: ${candidate.summary}
EXPERIENCE LEVEL: ${candidate.experienceLevel}

JOB: ${job.title} at ${job.company}
REQUIRES: ${boundDescription(description, SCORING_DESCRIPTION_CHARS)}

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
}
