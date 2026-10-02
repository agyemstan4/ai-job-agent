import { NextResponse } from "next/server";
import db, { markJobsSeen } from "@/lib/db";
import { abortMatching, beginMatching, recordMatchResults } from "@/lib/pipeline/matching";
import type { MatchingSession, ScoredJob } from "@/lib/pipeline/matching";

const MATCH_MODEL = "llama3.2:3b";
// Recorded on each match. Bump when the scoring prompt below changes.
const MATCH_PROMPT_VERSION = "match/v1";

// Returns a 0-100 integer, or null if the model gave no usable number.
function parseScore(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(100, Math.max(0, n)));
}

const aliases: Record<string, string[]> = {
  "full stack": ["full stack", "frontend", "backend", "node.js", "web development"],
  "mobile app development": ["android", "kotlin", "mobile app"],
  "java / kotlin": ["java", "kotlin"],
  "java / jvm / kotlin": ["java", "kotlin"],
  "javascript": ["javascript", "js"],
};

function validateStrengths(strengths: string[], candidate: any) {
  const candidateText = JSON.stringify(candidate).toLowerCase();

  const candidateSkills = (candidate.technicalSkills || [])
    .map((skill: string) => skill.toLowerCase());

  // candidate.projects no longer exists in the trimmed analyse-cv schema —
  // technicalSkills and matchingSkills already cover the same ground.
  const allCandidateSkills = [
    ...candidateSkills,
    ...(candidate.matchingSkills || []).map((skill: string) => skill.toLowerCase()),
  ];

  return strengths
    .filter((skill: string) => {
      const normalised = skill
        .toLowerCase()
        .replace("containerization with ", "")
        .replace("development", "")
        .replace("engineering", "")
        .replace("services", "")
        .trim();

      if (allCandidateSkills.some(s => s.includes(normalised) || normalised.includes(s))) {
        return true;
      }

      return Object.entries(aliases).some(([key, values]) => {
        if (normalised.includes(key)) {
          return values.some(value => candidateText.includes(value));
        }
        return false;
      });
    })
    .map((skill: string) => {
      if (skill.toLowerCase().includes("java / jvm / kotlin")) {
        return "Java / Kotlin";
      }
      return skill;
    });
}

function validateReason(reason: string, candidate: any) {
  const candidateText = JSON.stringify(candidate).toLowerCase();
  const lowerReason = reason.toLowerCase();

  console.log("REASON CHECK:", lowerReason);
  console.log("CANDIDATE CHECK:", candidateText);

  const forbidden = [
    "python", "fastapi", "postgresql", "react", "react native",
    "typescript", "c#", "docker", "kubernetes", "ci/cd", "aws",
    "spring", "spring boot",
  ];

  const containsUnknown = forbidden.some(
    skill => lowerReason.includes(skill) && !candidateText.includes(skill)
  );

  const falseGap =
    lowerReason.includes("lacks experience with backend") &&
    (
      candidateText.includes("backend") ||
      candidateText.includes("node.js") ||
      candidateText.includes("node") ||
      candidateText.includes("firebase")
    );

  const falseJvmGap =
    (
      lowerReason.includes("lacks experience in jvm") ||
      lowerReason.includes("lacks experience with jvm") ||
      lowerReason.includes("lacks jvm experience")
    ) &&
    (
      candidateText.includes("java") ||
      candidateText.includes("kotlin") ||
      candidateText.includes("android")
    );

  if (containsUnknown || falseGap || falseJvmGap) {
    return "Match based on relevant technical skills and engineering projects.";
  }

  return reason;
}

function validateMissingSkills(missingSkills: any[], candidate: any) {
  const candidateText = JSON.stringify(candidate).toLowerCase();

  return missingSkills.filter((item: any) => {
    const skill = typeof item === "string" ? item : item.skill;
    return skill && !candidateText.includes(skill.toLowerCase());
  });
}

export async function POST(req: Request) {
  const totalStart = Date.now();
  console.log("🔥 MATCH API STARTED");

  let session: MatchingSession | null = null;
  try {
    const { candidate, jobs, candidateProfileId } = await req.json();

console.log("🔍 TOTAL JOBS RECEIVED:", jobs.length);

console.log(
  "🔍 CANDIDATE SKILLS:",
  candidate.technicalSkills
);

console.log(
  "🔍 FIRST 3 JOBS:",
  jobs.slice(0, 3).map((job: any) => ({
    title: job.title,
    company: job.company,
    description: job.description?.slice(0, 300),
  }))
);


    const roleKeywords = [
      "software engineer", "software developer", "developer", "engineer",
      "frontend", "backend", "full stack", "full-stack", "android",
      "mobile", "graduate", "junior", "web developer",
    ];

    const skillKeywords = (candidate.technicalSkills || []).map(
      (skill: string) => skill.toLowerCase()
    );

    // Seniority is judged from the job TITLE only, on whole words. Matching
    // substrings across the full description wrongly rejected junior roles
    // (e.g. "leading", "our staff", "reporting to the engineering manager").
    const seniorTitlePattern =
      /\b(senior|lead|principal|staff|architect|manager|director)\b/i;

console.log("🔍 TOTAL JOBS RECEIVED:", jobs.length);
console.log(
  "🔍 FIRST 3 JOBS:",
  jobs.slice(0, 3).map((job: any) => ({
    title: job.title,
    company: job.company,
    description: job.description?.slice(0, 300),
  }))
);

    // Why a job fails the pre-filter, or null if it passes. A job passes
    // only with a developer role keyword, a candidate skill, and no senior title.
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

    // We want to score enough jobs to eventually support
// up to 10 applications per day.
const MAX_JOBS_TO_SCORE = 10;

const selectedJobs = rankedJobs.slice(0, MAX_JOBS_TO_SCORE);

console.log("🔎 FILTERED JOB COUNT:", filteredJobs.length);
console.log("🔎 UNIQUE JOB COUNT:", uniqueFilteredJobs.length);
console.log("🔎 RANKED JOB COUNT:", rankedJobs.length);
console.log("🔎 SELECTED JOB COUNT:", selectedJobs.length);

    // ── Persistence (Step 7) ───────────────────────────────────────────────
    // Only for a stored candidate profile (the UI); the scheduler sends none
    // and only marks seen_jobs, as before. Persisting never changes which
    // jobs are scored or what this route returns, and a failure to persist
    // is reported, not fatal.
    const persistenceWarnings: string[] = [];
    const jobIdOf = (job: IncomingJob | null | undefined): number | null =>
      typeof job?.jobId === "number" ? job.jobId : null;
    const filteredOutJobs = jobs
      .map((job: IncomingJob) => ({ jobId: jobIdOf(job), reason: filterReasonFor(job) }))
      .filter((job: { jobId: number | null; reason: string | null }): job is { jobId: number; reason: string } =>
        job.jobId !== null && job.reason !== null
      );
    // Scoring failures by jobNumber (1-based index into selectedJobs).
    const failures = new Map<number, string>();
    try {
      session = beginMatching(db, { candidateProfileId, params: { jobsReceived: jobs.length } });
      if (session) persistenceWarnings.push(...session.warnings);
    } catch (error) {
      persistenceWarnings.push(`Matches are not being saved: ${error instanceof Error ? error.message : String(error)}`);
    }

    const persistMatches = (scored: ScoredJob[]): Map<number, number> => {
      if (!session) return new Map();
      try {
        const failed = selectedJobs.flatMap((job: IncomingJob, index: number) => {
          const error = failures.get(index + 1);
          const jobId = jobIdOf(job);
          return error && jobId !== null ? [{ jobId, error }] : [];
        });
        const result = recordMatchResults(db, session, {
          scored,
          filteredOut: filteredOutJobs,
          failed,
          model: MATCH_MODEL,
          promptVersion: MATCH_PROMPT_VERSION,
          stats: {
            jobsReceived: jobs.length,
            filteredOut: jobs.length - filteredJobs.length,
            selected: selectedJobs.length,
            scored: scored.length,
            failed: failed.length,
          },
        });
        persistenceWarnings.push(...result.warnings);
        return result.matchIds;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Saving match results failed:", error);
        persistenceWarnings.push(`Match results were not saved: ${message}`);
        abortMatching(db, session, message);
        return new Map();
      }
    };
    const withWarnings = <T extends object>(body: T) =>
      persistenceWarnings.length > 0 ? { ...body, persistenceWarnings } : body;

if (selectedJobs.length === 0) {
  console.log("⚠️ NO JOBS SURVIVED MATCH FILTERING");
  persistMatches([]);
  return NextResponse.json(withWarnings({ matches: [] }));
}

    console.log("Filtered jobs:", selectedJobs.map((job: any) => job.title));

    // -----------------------------------------------
    // Parallel Ollama calls — one per job
    // -----------------------------------------------

    const callOllama = async (job: any, index: number) => {
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

      const res = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MATCH_MODEL,
          prompt: jobPrompt,
          stream: false,
          format: "json",
          options: {
            temperature: 0,
            num_predict: 400,
            num_ctx: 2048,
          },
        }),
      });

      if (!res.ok) {
        throw new Error(`Ollama error: ${res.status}`);
      }

      const data = await res.json();

      try {
        const parsed = JSON.parse(
          data.response.replace(/```json/g, "").replace(/```/g, "").trim()
        );
        console.log(`✅ Job ${index + 1} (${job.title}) done`);
        console.log(`RAW:`, data.response);
        return { ...parsed, jobNumber: index + 1 };
      } catch {
        console.error(`❌ Job ${index + 1} failed to parse`);
        failures.set(index + 1, "The model's response was not valid JSON");
        return null;
      }
    };

    // A failed call (Ollama down, timeout, HTTP error) only drops that job
    // instead of rejecting the whole batch. Errors are kept so they can
    // be reported if every call fails.
    const ollamaErrors: string[] = [];
    const safeCallOllama = (job: Parameters<typeof callOllama>[0], index: number) =>
      callOllama(job, index).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        ollamaErrors.push(message);
        failures.set(index + 1, `Ollama call failed: ${message}`);
        console.error(`❌ Job ${index + 1} Ollama call failed:`, message);
        return null;
      });

    const ollamaStart = Date.now();
console.log("🤖 Calling Ollama in parallel...");

console.log("📊 SELECTED JOB COUNT:", selectedJobs.length);

const BATCH_SIZE = 5;
const rawResults: any[] = [];

for (let i = 0; i < selectedJobs.length; i += BATCH_SIZE) {
  const batch = selectedJobs.slice(i, i + BATCH_SIZE);

  console.log(
    `🚀 Starting Ollama batch ${Math.floor(i / BATCH_SIZE) + 1} with ${batch.length} jobs`
  );

  const batchResults = await Promise.all(
    batch.map((job: any, batchIndex: number) =>
      safeCallOllama(job, i + batchIndex)
    )
  );

  rawResults.push(...batchResults.filter(Boolean));

  console.log(
    `✅ Finished Ollama batch ${Math.floor(i / BATCH_SIZE) + 1}`
  );
}

    console.log(
      `✅ All Ollama calls finished in ${((Date.now() - ollamaStart) / 1000).toFixed(2)}s`
    );

    const scoredJobs = rawResults.filter(Boolean);

    console.log("AI RETURN:", scoredJobs);
    console.log("AI RETURN TYPE:", typeof scoredJobs);

    if (scoredJobs.length === 0) {
      // Nothing was scored, so nothing is marked as seen — these jobs remain
      // eligible next time (failed matches are retried).
      persistMatches([]);
      return NextResponse.json(
        withWarnings({
          error: "AI scoring failed",
          details: ollamaErrors.length > 0
            ? `Ollama failed for ${ollamaErrors.length} of ${selectedJobs.length} jobs: ${ollamaErrors[0]}`
            : "The AI model did not return any valid match scores.",
        }),
        { status: 502 }
      );
    }

    // -----------------------------------------------
    // Build final matches with backend corrections
    // -----------------------------------------------

    const uniqueResults = Array.from(
      new Map(scoredJobs.map((item: any) => [item.jobNumber, item])).values()
    );

    const matches = uniqueResults
      .map((result: any) => {
        const job = selectedJobs[result.jobNumber - 1];
        if (!job) return null;

        const cleanBreakdown = {
          technicalSkills: Math.min(100, Math.max(0, Number(result.breakdown?.technicalSkills) || 0)),
          experienceLevel: Math.min(100, Math.max(0, Number(result.breakdown?.experienceLevel) || 0)),
          projects: Math.min(100, Math.max(0, Number(result.breakdown?.projects) || 0)),
          growthPotential: Math.max(40, Math.min(100, Number(result.breakdown?.growthPotential) || 40)),
        };

        const jobText = `${job.title} ${job.description}`.toLowerCase();
        const candidateSkills = (candidate.technicalSkills || []).map((s: string) => s.toLowerCase());

        // Java / Kotlin boost
        if (jobText.includes("java") || jobText.includes("kotlin") || jobText.includes("jvm")) {
          if (candidateSkills.includes("java") && candidateSkills.includes("kotlin")) {
            cleanBreakdown.technicalSkills = Math.max(cleanBreakdown.technicalSkills, 80);
          }
        }

        // "Multiple projects" signal used to come from candidate.projects.length,
        // which no longer exists in the trimmed analyse-cv schema. technicalSkills
        // breadth is a reasonable proxy for "has built several real things".
        if ((candidate.technicalSkills || []).length >= 8) {
          cleanBreakdown.projects = Math.max(cleanBreakdown.projects, 70);
          cleanBreakdown.experienceLevel = Math.max(cleanBreakdown.experienceLevel, 55);
        }

        console.log("BACKEND CORRECTED BREAKDOWN:", cleanBreakdown);

        // A missing or non-numeric model score is NOT treated as 0 (which
        // silently dragged the blended score down). If the model gave no
        // usable score and no usable breakdown either, the job is left
        // unscored and dropped from this run.
        const modelScore = parseScore(result.matchScore);
        const hasBreakdown = ["technicalSkills", "experienceLevel", "projects", "growthPotential"]
          .some((key) => parseScore(result.breakdown?.[key]) !== null);

        if (modelScore === null && !hasBreakdown) {
          console.warn(`⚠️ Job ${result.jobNumber} (${job.title}) returned no usable score — skipped`);
          failures.set(result.jobNumber, "The model returned no usable score");
          return null;
        }

const breakdownScore = Math.round(
  cleanBreakdown.technicalSkills * 0.45 +
  cleanBreakdown.experienceLevel * 0.20 +
  cleanBreakdown.projects * 0.25 +
  cleanBreakdown.growthPotential * 0.10
);

// Blend the model's own holistic score with the breakdown-derived score,
// weighted toward the model's score since it reasons about the full
// picture, while the breakdown catches cases where the model's stated
// score doesn't line up with its own stated skill/experience numbers.
// If the model's own score is unusable, fall back to the breakdown alone.
const finalMatchScore = modelScore === null
  ? breakdownScore
  : Math.round(modelScore * 0.6 + breakdownScore * 0.4);

        return {
          id: job.id,
          jobId: jobIdOf(job),
          modelScore,
          breakdownScore,
          sourceIds: job.sourceIds,
          source: job.source,
          title: job.title,
          company: job.company,
          location: job.location,
          // Passed through so tailoring, cover letters and application
          // answers see the real job description.
          description: job.description || "",
          url: job.url,
          salaryMin: job.salaryMin,
          salaryMax: job.salaryMax,
          contractType: job.contractType,
          created: job.created,
          matchScore: finalMatchScore,
          breakdown: cleanBreakdown,
          reason:
            validateReason(result.reason, candidate) ||
            "Strong match based on relevant technical skills and engineering projects.",
          strengths: Array.isArray(result.strengths)
            ? validateStrengths(result.strengths, candidate)
                .filter((skill: string) => skill.trim() !== "")
                .slice(0, 2)
            : [],
          missingSkills: Array.isArray(result.missingSkills)
            ? result.missingSkills
                .map((item: any) =>
                  typeof item === "string" ? { skill: item, importance: "medium" } : item
                )
                .filter(
                  (item: any) =>
                    item.skill &&
                    !["experience", "knowledge", "years", "integration", "required",
                      "programming", "ability", "understanding", "familiarity",
                      "exposure", "asynchronous"].some(word =>
                        item.skill.toLowerCase().includes(word)
                      )
                )
                .map((item: any) => ({
                  skill: item.skill,
                  importance: ["high", "medium", "low"].includes(item.importance)
                    ? item.importance
                    : "medium",
                }))
                .filter((item: any) => validateMissingSkills([item], candidate).length > 0)
                .filter(
                  (item: any) =>
                    !["claude", "cursor", "copilot", "augment", "chatgpt"].some(tool =>
                      item.skill.toLowerCase().includes(tool)
                    )
                )
            : [],
        };
      })
      .filter((match): match is NonNullable<typeof match> => match !== null)
      // Best match first — previously results kept the keyword-prefilter order.
      .sort((a, b) => b.matchScore - a.matchScore);

    // Mark only the jobs that were actually scored as seen (including any
    // cross-source duplicate IDs). Jobs that were filtered out, not selected,
    // or failed scoring stay eligible for future runs.
    const scoredIds = matches.flatMap((match) =>
      Array.isArray(match.sourceIds) && match.sourceIds.length > 0
        ? match.sourceIds
        : match.id ? [match.id] : []
    );
    if (scoredIds.length > 0) {
      markJobsSeen(scoredIds);
    }

    const matchIds = persistMatches(
      matches.flatMap((match) =>
        match.jobId === null
          ? []
          : [{
              jobId: match.jobId,
              score: match.matchScore,
              modelScore: match.modelScore,
              breakdownScore: match.breakdownScore,
              breakdown: match.breakdown,
              reason: match.reason,
              strengths: match.strengths,
              missingSkills: match.missingSkills,
            }]
      )
    );
    // modelScore/breakdownScore were only carried for persistence.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const responseMatches = matches.map(({ modelScore, breakdownScore, ...match }) => ({
      ...match,
      matchId: match.jobId === null ? null : matchIds.get(match.jobId) ?? null,
    }));

    console.log("Finished scoring jobs.");
    console.log("FINAL MATCHES:", JSON.stringify(responseMatches, null, 2));
    console.log(`🏁 MATCH API TOTAL: ${((Date.now() - totalStart) / 1000).toFixed(2)}s`);

    return NextResponse.json(withWarnings({ matches: responseMatches }));

  } catch (error) {
    console.error(error);
    abortMatching(db, session, error instanceof Error ? error.message : String(error));
    return NextResponse.json(
      {
        error: "Matching failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}