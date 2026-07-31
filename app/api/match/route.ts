import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const totalStart = Date.now();

console.log("🔥 MATCH API STARTED");

  try {
    const { candidate, jobs } = await req.json();

    const candidateSummary = {
  summary: candidate.summary,
  technicalSkills: candidate.technicalSkills,
  experienceLevel: candidate.experienceLevel,
  projects: candidate.projects,
};

const roleKeywords = [
  "software engineer",
  "software developer",
  "developer",
  "engineer",
  "frontend",
  "backend",
  "full stack",
  "full-stack",
  "android",
  "mobile",
  "graduate",
  "junior",
  "web developer",
];

const skillKeywords = (candidate.technicalSkills || []).map(
  (skill: string) => skill.toLowerCase()
);

const filteredJobs = jobs.filter((job: any) => {

  const text = `
    ${job.title}
    ${job.description}
  `.toLowerCase();


 const hasDeveloperRole = roleKeywords.some(
  (keyword: string) => text.includes(keyword)
);


const hasRelevantSkill = skillKeywords.some(
  (skill: string) => text.includes(skill)
);


 return hasDeveloperRole && hasRelevantSkill;

});

const uniqueFilteredJobs = Array.from(
  new Map<string, any>(
    filteredJobs.map((job: any) => [
      `${job.title}-${job.company}`,
      job,
    ])
  ).values()
);

const selectedJobs = uniqueFilteredJobs.slice(0, 3);

if (selectedJobs.length === 0) {
  return NextResponse.json({
    matches: [],
  });
}

console.log(
  "Filtered jobs:",
  selectedJobs.map((job: any) => job.title)
);

const prompt = `

You are an expert job matching AI.

Compare the candidate against multiple jobs.

Candidate:
${JSON.stringify(candidateSummary)}

Jobs:

${selectedJobs.map((job: any, index: number) => `

JOB NUMBER: ${index + 1}

Title:
${job.title}

Company:
${job.company}

${job.description.slice(0, 250)}

`).join("\n")}


Rules:

- Output valid JSON only.
- No markdown.
- Score each job separately.
- Use integer scores only.
- Base scores only on the candidate profile and job description.
- Prioritise technical skill overlap, projects, and software engineering ability.
- Do not penalise the candidate for lacking company-specific industry experience.
- Do not invent missing skills unless they are clearly required in the job description.
- Consider transferable experience from projects, university work, and personal applications.
- Consider junior and graduate candidates with limited professional experience fairly.
- A strong portfolio project can count as relevant practical experience.
- Kotlin, Java, JavaScript, Firebase, APIs, Android development, and full-stack projects should be recognised where relevant.
- MissingSkills should only contain important technical requirements that are genuinely absent.
- Reason must be one sentence under 30 words.
- strengths must always contain exactly 2 short strings.
- breakdown must contain ONLY numbers.
- Never write explanations inside breakdown.
- growthPotential must be a number between 0 and 100.

Return ONLY JSON.

You are scoring multiple jobs.

Return exactly one result for each job provided.

Never return a single result.

Return JSON in this exact format:

{
 "results": [
  {
   "jobNumber":1,
   "matchScore":0,
   "reason":"",
   "strengths":["",""],
   "breakdown":{
    "technicalSkills":0,
    "experienceLevel":0,
    "projects":0,
    "growthPotential":0
   },
   "missingSkills":[]
  }
 ]
}

Include one result for every job provided.

`;


console.log(
  "Batch prompt length:",
  prompt.length
);


const ollamaStart = Date.now();

console.log("🤖 Calling Ollama batch...");


const response = await fetch(
  "http://localhost:11434/api/generate",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "phi3.5:latest",
      prompt,
      stream: false,
      format: "json",
      options: {
        temperature: 0,
        num_predict: 450,
        num_ctx: 3072,
      },
    }),
  }
);


console.log(
  `✅ Batch Ollama finished in ${(
    (Date.now() - ollamaStart) /
    1000
  ).toFixed(2)}s`
);


const data = await response.json();


let scoredJobs;

try {

  const parsed = JSON.parse(
  data.response
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim()
);

console.log("RAW OLLAMA RESPONSE:");
console.log(JSON.stringify(parsed, null, 2));

scoredJobs = Array.isArray(parsed.results)
  ? parsed.results
  : [];

console.log("AI RETURN:", scoredJobs);
console.log("AI RETURN TYPE:", typeof scoredJobs);

} catch (error) {

  console.error("❌ Invalid batch JSON:");
  console.log(data.response);

  return NextResponse.json({
    error: "AI response invalid",
  });

}


const matches = scoredJobs
  .map((result: any) => {

    
    const job = selectedJobs[result.jobNumber - 1];

if (!job) return null;

    return {
      title: job.title,
      company: job.company,
      location: job.location,
      url: job.url,

      salaryMin: job.salaryMin,
      salaryMax: job.salaryMax,
      contractType: job.contractType,
      created: job.created,

      matchScore: result.matchScore,
      breakdown: result.breakdown,
      reason: result.reason,
      strengths: result.strengths,

      missingSkills:
        result.missingSkills?.filter(
          (skill: string) => skill.trim() !== ""
        ) || [],
    };

  })
  .filter(Boolean)
  .sort(
    (a: any, b: any) =>
      b.matchScore - a.matchScore
  );
   
   

    console.log("Finished scoring jobs.");
    console.log("FINAL MATCHES:", matches);

console.log(
  `🏁 MATCH API TOTAL: ${(
    (Date.now() - totalStart) /
    1000
  ).toFixed(2)}s`
);

return NextResponse.json({
  matches,
});
    

  } catch (error) {

    console.error(error);

    return NextResponse.json(
      {
        error: "Matching failed",
      },
      {
        status: 500,
      }
    );

  }
}