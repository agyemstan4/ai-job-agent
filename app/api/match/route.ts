import { NextResponse } from "next/server";

function validateStrengths(
  strengths: string[],
  candidate: any
) {
  const candidateText = JSON.stringify(candidate)
    .toLowerCase();

  return strengths.filter((skill:string) => {

    const parts = skill
      .toLowerCase()
      .split("/")
      .map(part => part.trim());

    return parts.some(part =>
      candidateText.includes(part)
    );

  });
}

function validateReason(
  reason:string,
  candidate:any
){

 const candidateText =
 JSON.stringify(candidate)
 .toLowerCase();


 const forbidden = [
   "python",
   "react",
   "docker",
   "kubernetes",
   "ci/cd",
   "aws"
 ];


 const containsUnknown =
 forbidden.some(skill =>
   reason
   .toLowerCase()
   .includes(skill)
   &&
   !candidateText.includes(skill)
 );


 if(containsUnknown){
   return "Match based on transferable technical skills and project experience.";
 }


 return reason;

}

function validateMissingSkills(
  missingSkills: any[],
  candidate: any
) {
  const candidateText = JSON.stringify(candidate)
    .toLowerCase();

  return missingSkills.filter((item:any)=>{

    const skill =
      typeof item === "string"
        ? item
        : item.skill;

    return skill &&
      !candidateText.includes(
        skill.toLowerCase()
      );

  });
}


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

const rankedJobs = [...uniqueFilteredJobs].sort(
  (a:any,b:any)=>{

    const scoreJob = (job:any)=>{

      const text =
      `${job.title} ${job.description}`
      .toLowerCase();

      let score = 0;

      skillKeywords.forEach(
        (skill:string)=>{
          if(text.includes(skill)){
            score += 10;
          }
        }
      );

      if(text.includes("junior"))
        score += 5;

      if(text.includes("graduate"))
        score += 5;

      return score;
    }

    return scoreJob(b) - scoreJob(a);

  }
);


const selectedJobs = rankedJobs.slice(0,5);



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

${job.description.slice(0, 450)}

`).join("\n")}


Rules:

- Output valid JSON only.
- Score each job separately.
- Use integer scores only.
- Base scores on technical skills, projects, education, and practical engineering ability.
- Treat university projects, dissertation projects, and portfolio applications as valid experience.
- Do not penalise junior/graduate candidates for limited commercial employment.
- ExperienceLevel should reflect practical engineering ability, not only paid jobs.
- Graduate candidates with software projects should have experienceLevel of at least 50.
- Projects using job technologies should score 70+.
- Junior/graduate candidates must have growthPotential of at least 40.
- GrowthPotential is based on learning ability, projects, education, and technical foundation.

Technology rules:

- Prioritise direct technology matches.
- If Kotlin appears in candidate technicalSkills or projects, treat it as relevant experience for JVM roles.
- If Java appears in candidate technicalSkills or projects, never state the candidate lacks Java.
- Never claim missing skills that already exist in candidate technicalSkills or projects.
- Never invent candidate strengths from job requirements.
- Do not describe job-required technologies as candidate experience unless they appear in the candidate profile.
- Every strength must exactly match a technology or engineering capability present in the candidate profile.
- Never use job requirements as strengths.
- Evaluate the candidate only from the provided candidate profile.

MissingSkills rules:

- Only include real technical technologies.
- Never include concepts, responsibilities, or experience gaps.
- Do not include a missing skill if it already appears anywhere in the candidate technicalSkills or project skills.
- Each item must be:
{
 "skill":"",
 "importance":"high|medium|low"
}
- Return [] if no technical gaps exist.

Output rules:

- Reason must be one sentence under 30 words.
- strengths must contain 1-2 real candidate strengths.
- breakdown must only contain:
technicalSkills,
experienceLevel,
projects,
growthPotential
- Values must be integers between 0-100.

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
   "strengths":[""],
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
   "strengths":[""],
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
        num_predict: 650,
        num_ctx: 4096,
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

  growthPotential: Math.max(
40,
Math.min(
100,
Number(result.breakdown?.growthPotential) || 40
)
)
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
  100,
  Number(result.matchScore) || 0
),
      breakdown: cleanBreakdown,
      reason: validateReason(
  result.reason,
  candidate
),
      strengths:
Array.isArray(result.strengths)
? validateStrengths(
    result.strengths,
    candidate
  )
  .slice(0,2)
: [],

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
.filter((item:any)=>
  validateMissingSkills(
    [item],
    candidate
  ).length > 0
)
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