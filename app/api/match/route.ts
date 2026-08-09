import { NextResponse } from "next/server";

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

  try {
    const { candidate, jobs } = await req.json();

    const roleKeywords = [
      "software engineer", "software developer", "developer", "engineer",
      "frontend", "backend", "full stack", "full-stack", "android",
      "mobile", "graduate", "junior", "web developer",
    ];

    const skillKeywords = (candidate.technicalSkills || []).map(
      (skill: string) => skill.toLowerCase()
    );

    const seniorKeywords = [
      "senior", "lead", "principal", "staff", "architect", "manager", "director",
    ];

    const filteredJobs = jobs.filter((job: any) => {
      const text = `${job.title} ${job.description}`.toLowerCase();
      const hasDeveloperRole = roleKeywords.some(kw => text.includes(kw));
      const hasRelevantSkill = skillKeywords.some((skill: string) => text.includes(skill));
      const isSenior = seniorKeywords.some(kw => text.includes(kw));
      return hasDeveloperRole && hasRelevantSkill && !isSenior;
    });

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

    const selectedJobs = rankedJobs.slice(0, 5);

    if (selectedJobs.length === 0) {
      return NextResponse.json({ matches: [] });
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
REQUIRES: ${job.description.slice(0, 150)}

Output JSON only. No explanation outside JSON.

{
  "jobNumber": ${index + 1},
  "matchScore": 0,
  "reason": "",
  "strengths": [],
  "missingSkills": [{"skill": "Spring Boot", "importance": "medium"}],
  "breakdown": {
    "technicalSkills": 80,
    "experienceLevel": 60,
    "projects": 70,
    "growthPotential": 55
  }
}

Rules:
- matchScore 0-100 integer
- strengths must be from candidate skills only
- missingSkills must NOT include skills the candidate already has
- reason max 20 words
- jobNumber must be ${index + 1}
`;

      const res = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "mistral",
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

      const data = await res.json();

      try {
        const parsed = JSON.parse(
          data.response.replace(/```json/g, "").replace(/```/g, "").trim()
        );
        console.log(`✅ Job ${index + 1} (${job.title}) done`);
        console.log(`RAW:`, data.response);
        return { ...parsed, jobNumber: index + 1 };
      } catch (e) {
        console.error(`❌ Job ${index + 1} failed to parse`);
        return null;
      }
    };

    const ollamaStart = Date.now();
    console.log("🤖 Calling Ollama in parallel...");

    const rawResults = [];
for (let i = 0; i < selectedJobs.length; i++) {
  const result = await callOllama(selectedJobs[i], i);
  rawResults.push(result);
}

    console.log(
      `✅ All Ollama calls finished in ${((Date.now() - ollamaStart) / 1000).toFixed(2)}s`
    );

    const scoredJobs = rawResults.filter(Boolean);

    console.log("AI RETURN:", scoredJobs);
    console.log("AI RETURN TYPE:", typeof scoredJobs);

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

        const finalMatchScore = Math.round(
          cleanBreakdown.technicalSkills * 0.45 +
          cleanBreakdown.experienceLevel * 0.20 +
          cleanBreakdown.projects * 0.25 +
          cleanBreakdown.growthPotential * 0.10
        );

        return {
          title: job.title,
          company: job.company,
          location: job.location,
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
      .filter(Boolean);

    console.log("Finished scoring jobs.");
    console.log("FINAL MATCHES:", JSON.stringify(matches, null, 2));
    console.log(`🏁 MATCH API TOTAL: ${((Date.now() - totalStart) / 1000).toFixed(2)}s`);

    return NextResponse.json({ matches });

  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Matching failed" }, { status: 500 });
  }
}