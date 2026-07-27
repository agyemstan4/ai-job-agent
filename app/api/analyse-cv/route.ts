import { NextResponse } from "next/server";


// @ts-ignore
const pdf = require("pdf-parse/lib/pdf-parse.js");

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();

    const file = formData.get("cv");
    const jobDescription = formData.get("jobDescription") as string;
    const roles = formData.get("roles");
    const selectedRoles = roles
  ? JSON.parse(roles.toString())
  : [];
  

  
  console.log("JOB DESCRIPTION:", jobDescription);

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "No CV uploaded." },
        { status: 400 }
      );
    }

    console.log("Reading PDF...");

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const pdfData = await pdf(buffer);
    const cvText = pdfData.text.slice(0, 3500);


    console.log("PDF extracted");
    console.log("Characters:", cvText.length);

    console.log("Sending request to Ollama...");

    console.log("Before Ollama call");
    console.log("Prompt length:", cvText.length);



 console.time("Ollama");
 const ollamaResponse = await fetch("http://localhost:11434/api/generate", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  model: "phi3.5:latest",
  prompt: `
You are an AI Job Agent.

Analyse the candidate CV and compare it against the job description.
Create a structured candidate profile while evaluating job suitability.
You are not writing a CV review.
You are scoring how well this candidate matches this specific job.

Candidate is interested in these roles:

${selectedRoles.join(", ")}

JOB DESCRIPTION:

${jobDescription}

CANDIDATE CV:

${cvText}

Return ONLY JSON.

Do not repeat the CV.
Do not explain your answer.
Do not include markdown.
Your entire response must start with { and end with }.

MatchScore rules:

90-100 = Excellent match, candidate meets almost all requirements.
70-89 = Strong match, candidate can realistically apply.
50-69 = Possible match, some missing skills but suitable for junior level.
30-49 = Weak match, major gaps.
0-29 = Poor match.
90-100 scores should be rare.
Only use 90+ when the candidate directly satisfies almost every required technology and responsibility.

Never output single digit scores.
Do not output 7, 8, 9.
Use realistic percentages like 65, 72, 84.
Do not use fractions like 6/10.
Example: 60 means 60 percent match.

{
  "matchScore": 0,
  "summary": "",
  "education": "",
  "experienceLevel": "",
  "technicalSkills": [],
  "projects": [],
  "matchingSkills": [],
  "missingSkills": [],
  "recommendation": ""
}
  Important candidate context:
- Identify education level accurately.
- If the candidate has graduated, do not describe them as a student.
- The candidate has graduated with a First-Class Honours degree in Software Engineering.
- Highlight academic achievement as a strength.
- Do not describe the candidate only by lack of professional employment.
- Treat university and personal software projects as evidence of engineering experience.
- Identify relevant projects.
- Include programming languages, frameworks, tools, databases, APIs, and development tools.
- Consider personal projects as evidence of engineering ability.

Return ONLY valid JSON.
Keep responses concise.
Summary: maximum 2 sentences.
Recommendation: maximum 2 sentences.
Do not include markdown.
Do not stop before completing the JSON.
`,
  stream: false,
  format: "json",
  options: {
    num_predict: 700,
    temperature: 0.2,
    num_ctx: 2048
  }
}),
    
});

if (!ollamaResponse.ok) {
  throw new Error(`Ollama error: ${ollamaResponse.status}`);
}

const response = await ollamaResponse.json();

console.log("After Ollama call");
console.log(response.response);
console.log("Ollama finished");

console.timeEnd("Ollama");

    return NextResponse.json({
      success: true,
      analysis: response.response,
    });

  } catch (error) {
    console.error("FULL ERROR:");
    console.error(error);

    return NextResponse.json(
      {
        error: "Analysis failed",
        details:
          error instanceof Error ? error.message : String(error),
      },
      {
        status: 500,
      }
    );
  }
}