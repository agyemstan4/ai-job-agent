import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const totalStart = Date.now();

console.log("🔥 MATCH API STARTED");

  try {
    const { candidate, jobs } = await req.json();

  const candidateSummary = {
  summary: candidate.summary,
  education: candidate.education,
  experienceLevel: candidate.experienceLevel,

  technicalSkills: candidate.technicalSkills,

  matchingSkills: candidate.matchingSkills,

  projects: candidate.projects?.map((project:any) => ({
    name: project.name,
    skillsUsed: project.skillsUsed,
  })),

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

const seniorKeywords = [
  "senior",
  "lead",
  "principal",
  "staff",
  "architect",
  "manager",
  "director",
];

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

  const isSenior = seniorKeywords.some(
    (keyword: string) => text.includes(keyword)
  );


  return (
    hasDeveloperRole &&
    hasRelevantSkill &&
    !isSenior
  );

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

${job.description.slice(0, 600)}

`).join("\n")}


Rules:

- Output valid JSON only.
- No markdown.
- Score each job separately.
- Use integer scores only.
- Base scores on technical skills, projects, education, and practical engineering experience.
- Treat university projects, dissertation projects, personal projects, and portfolio applications as valid engineering experience.
- Do not penalise junior or graduate candidates for limited commercial employment history.
- Prioritise direct technology matches.
- Recognise Kotlin, Java, JavaScript, Firebase, APIs, Android development, and full-stack projects when relevant.
- If a candidate has built a project using a technology, consider that practical experience.
- Never assign projects score 0 when the candidate has relevant software projects.
- Never claim a candidate lacks a technology that appears in their candidate profile.

MissingSkills rules:

- MissingSkills must only contain real technical technologies.
- Allowed examples: React, Flutter, Docker, AWS, PostgreSQL, Swift, Kubernetes.
- Never include experience, knowledge, skills in general, responsibilities, or concepts.
- Never include phrases like:
  "AI integration"
  "backend experience"
  "mobile experience"
  "full stack knowledge"
- Do not include technologies already found in candidate technicalSkills or projects.
- Each item must contain:
  skill
  importance
- importance must be only:
  high
  medium
  low
- If no technical gap exists, return [].

General output rules:
- Reason must be one sentence under 30 words.
- strengths must contain up to 2 short strings.
- If only one genuine strength exists, return one.
- Never return empty strings.
- breakdown must contain ONLY these four numeric keys:
  technicalSkills,
  experienceLevel,
  projects,
  growthPotential.
- All breakdown values must be integers between 0 and 100.
- Never add explanations, labels, strings, arrays, or extra keys inside breakdown.
- Never place breakdown values outside the breakdown object.
- Complete the entire JSON object before stopping.
- Never stop generating while JSON is incomplete.

Return ONLY JSON.

You are scoring multiple jobs.

Return exactly one result for every job provided.

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
  },
  {
   "jobNumber":2,
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
  },
  {
   "jobNumber":3,
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
      model: "llama3.2:3b",
      prompt,
      stream: false,
      format: "json",
      options: {
        temperature: 0,
        num_predict: 350,
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

const uniqueResults = Array.from(
  new Map(
    scoredJobs.map((item:any)=>[
      item.jobNumber,
      item
    ])
  ).values()
);

const matches = uniqueResults
  .map((result: any) => {

    const cleanBreakdown = {
  technicalSkills: Math.min(
    100,
    Math.max(0, Number(result.breakdown?.technicalSkills) || 0)
  ),

  experienceLevel: Math.min(
    100,
    Math.max(0, Number(result.breakdown?.experienceLevel) || 0)
  ),

  projects: Math.min(
    100,
    Math.max(
      0,
      Number(result.breakdown?.projects) || 0
    )
  ),

  growthPotential: Math.min(
    100,
    Math.max(
      0,
      Number(result.breakdown?.growthPotential) || 0
    )
  ),
};

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

      matchScore: Math.min(
  89,
  Number(result.matchScore) || 0
),
      breakdown: cleanBreakdown,
      reason: result.reason,
      strengths:
Array.isArray(result.strengths) &&
result.strengths.filter(Boolean).length > 0
? result.strengths.filter(Boolean).slice(0,2)
: [
    "Software engineering projects",
    "Relevant technical skills"
  ],

   missingSkills:
  Array.isArray(result.missingSkills)
    ? result.missingSkills
        .map((item:any) => {
          if (typeof item === "string") {
            return {
              skill: item,
              importance: "medium"
            };
          }

          return item;
        })
       .filter(
  (item:any) =>
    item.skill &&
    ![
      "experience",
      "knowledge",
      "years",
      "integration",
      "development",
      "required",
      "programming",
      "ability",
      "understanding",
      "familiarity",
      "exposure",
      "asynchronous"
    ].some(
      (word) =>
        item.skill.toLowerCase().includes(word)
    )
)
        .map((item:any)=>({
          skill:item.skill,
          importance:
            ["high","medium","low"].includes(item.importance)
              ? item.importance
              : "medium"
        }))
    : [],
    };

  })
  .filter(Boolean)
  .sort(
    (a: any, b: any) =>
      b.matchScore - a.matchScore
  );
   
   

    console.log("Finished scoring jobs.");
    console.log(
  "FINAL MATCHES:",
  JSON.stringify(matches, null, 2)
);

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