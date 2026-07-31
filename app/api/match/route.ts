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

const selectedJobs = jobs.slice(0, 3);

console.log(
  "Batch scoring jobs:",
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

Description:
${job.description.slice(0, 300)}

`).join("\n")}


Rules:

- Output valid JSON only.
- No markdown.
- Score each job separately.
- Use integer scores only.
- Base scores only on candidate profile and job description.
- If a required skill is missing, include it in missingSkills.
- Reason must be one sentence under 30 words.
- Strengths should contain 2-3 specific reasons.
- All breakdown scores must be between 0 and 100.
- Consider junior and graduate expectations.

Return ONLY JSON.

You are scoring 3 jobs.

You MUST include all 3 results inside the "results" array.

Never return a single result.

Return JSON in this exact format:

{
 "results": [
  {
   "jobNumber": 1,
   "matchScore":0,
   "reason":"",
   "strengths":[],
   "breakdown":{
    "technicalSkills":0,
    "experienceLevel":0,
    "projects":0,
    "growthPotential":0
   },
   "missingSkills":[]
  },
  {
   "jobNumber": 2,
   "matchScore":0,
   "reason":"",
   "strengths":[],
   "breakdown":{
    "technicalSkills":0,
    "experienceLevel":0,
    "projects":0,
    "growthPotential":0
   },
   "missingSkills":[]
  },
  {
   "jobNumber": 3,
   "matchScore":0,
   "reason":"",
   "strengths":[],
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
        num_predict: 700,
        num_ctx: 2048,
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

scoredJobs = parsed.results || [];

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