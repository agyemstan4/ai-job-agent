import { NextResponse } from "next/server";

export async function POST(req: Request) {
  console.log("🔥 MATCH API STARTED");

  try {
    const { candidate, jobs } = await req.json();

    const matches = [];

    for (const job of jobs) {
      console.log("Scoring:", job.title);

      const prompt = `
You are a job matching AI.

Candidate profile:
${JSON.stringify(candidate)}

IMPORTANT:

Do not assume the candidate matches because they are a software engineer.

Compare:
1. Required technologies
2. Required experience
3. Industry/domain knowledge
4. Missing requirements

Be realistic.

A junior candidate with transferable skills should not automatically score above 80.

Only give 80+ when most requirements are directly matched.

Job Title:
${job.title}

Company:
${job.company}

Job Description:
${job.description.slice(0, 300)}

Return ONLY JSON.

Format:

{
  "title":"",
  "company":"",
  "matchScore":0,
  "breakdown":{
    "technicalSkills":0,
    "experienceLevel":0,
    "projects":0,
    "growthPotential":0
  },
  "reason":"",
  "missingSkills":[]
}

Scoring breakdown:

technicalSkills:
How closely the candidate's technologies match the job.

experienceLevel:
Whether the role matches junior/graduate experience.

projects:
Whether the candidate's projects demonstrate relevant ability.

growthPotential:
Whether the candidate could realistically succeed with some learning.

The final matchScore should be an average of these factors.

MatchScore rules:

90-100 = Excellent match.
70-89 = Strong match.
50-69 = Possible match.
30-49 = Weak match.
0-29 = Poor match.

Never output single digit scores.
Use realistic percentages.

Important rules:
- Do not invent company names.
- Do not change candidate names.
- Use professional grammar.
- Only use information provided in the CV and job description.
- If a skill is missing, state it clearly and accurately.

Only analyse the match.
`;

      const controller = new AbortController();

      const timeout = setTimeout(() => {
  controller.abort();
}, 180000);

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
              num_predict: 250,
              num_ctx: 1024,
            },
          }),
        }
      );

      clearTimeout(timeout);

      if (!response.ok) {
        console.log("Ollama failed for", job.title);
        continue;
      }

      const data = await response.json();

      let result;

      try {

  const cleaned = data.response
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  result = JSON.parse(cleaned);

} catch {

  console.log(
    "FAILED JSON:",
    data.response
  );

  continue;
}
      matches.push({
  title: job.title,
  company: job.company,
  location: job.location,
  url: job.url,
  matchScore: result.matchScore,
  breakdown: result.breakdown,
  reason: result.reason,
  missingSkills: result.missingSkills,
});
    }

    matches.sort((a, b) => b.matchScore - a.matchScore);

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