import { NextResponse } from "next/server";

export async function POST(req: Request) {
  console.log("🔥 MATCH API STARTED");

  try {
    const { candidate, jobs } = await req.json();

    const candidateSummary = {
  summary: candidate.summary,
  technicalSkills: candidate.technicalSkills,
  experienceLevel: candidate.experienceLevel,
  projects: candidate.projects,
};


    const jobPromises = jobs.slice(0, 3).map(async (job: any) => {
      console.log("Scoring:", job.title);

console.log(
  `${job.title} description length:`,
  job.description.length
);

      console.time(`${job.title}-${job.company}`);

console.log(
  "Candidate summary length:",
  JSON.stringify(candidateSummary).length
);

console.log(
  "Original candidate length:",
  JSON.stringify(candidate).length
);
      const prompt = `
      
You are an expert job matching AI.

Compare the candidate against the job description.

Candidate:
${JSON.stringify(candidateSummary)}


Job Title:
${job.title}

Company:
${job.company}

Job Description:
${job.description.slice(0, 300)}

Important:
- Write the reason in professional English.
- Use correct grammar and punctuation.
- If referring to the candidate, use "Stanley's".
- Never use "Stanley'n".

Rules:
- Output valid JSON only.
- No markdown.
- No explanations outside the JSON.
- Use integer scores only.
- Base the score only on the candidate profile and job description.
- If a required skill is missing, include it in "missingSkills".
- Calculate matchScore as the average of the four breakdown scores.
- The reason field MUST be a single sentence under 30 words.
- The strengths array should contain 2-3 specific reasons why the candidate fits this role.
- All breakdown scores must be between 0 and 100.
- Do not inflate scores.
- Missing core requirements should reduce scores.
- Consider junior and graduate expectations.

Return JSON in this exact format:

{
  "matchScore": 0,
  "reason": "",
  "strengths": [],
  "breakdown": {
    "technicalSkills": 0,
    "experienceLevel": 0,
    "projects": 0,
    "growthPotential": 0
  },
  "missingSkills": []
}
`;

console.log(
  `${job.title} prompt length:`,
  prompt.length
);
    const controller = new AbortController();

      const timeout = setTimeout(() => {
        controller.abort();
      }, 300000);


      try {

        const response = await fetch(
          "http://localhost:11434/api/generate",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            signal: controller.signal,
            body: JSON.stringify({
              model: "phi3.5:latest",
              prompt,
              stream: false,
              format: "json",
              options: {
                temperature: 0,
                num_predict:180,
                num_ctx: 1536,
              },
            }),
          }
        );


        clearTimeout(timeout);


        if (!response.ok) {
          console.log("Ollama failed for", job.title);
          return null;
        }

const data = await response.json();

let result;

try {
  result = JSON.parse(
    data.response
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim()
  );
} catch (error) {
  console.error(`❌ Invalid JSON from Ollama for ${job.title}:`);
  console.log(data.response);

  return null;
}
       
        console.timeEnd(`${job.title}-${job.company}`);


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


      } catch (error) {

        console.log(
          "FAILED SCORING:",
          job.title,
          error
        );

        return null;
      }

    });


    const results = await Promise.all(jobPromises);


    const matches = results
      .filter((job) => job !== null)
      .sort(
        (a, b) =>
          b.matchScore - a.matchScore
      );


    console.log("Finished scoring jobs.");
    console.log("FINAL MATCHES:", matches);


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