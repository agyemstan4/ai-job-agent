import { NextResponse } from "next/server";


// @ts-ignore
const pdf = require("pdf-parse/lib/pdf-parse.js");

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();

    const file = formData.get("cv");
    const roles = formData.get("roles");
    const selectedRoles = roles
  ? JSON.parse(roles.toString())
  : [];
  

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "No CV uploaded." },
        { status: 400 }
      );
    }

    console.log("Reading PDF...");

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
 
    console.time("PDF");

const pdfData = await pdf(buffer);
const cvText = pdfData.text.slice(0, 3000);

console.timeEnd("PDF");
    

    console.log("PDF extracted");
    console.log("Characters:", cvText.length);

     console.log("Sending request to Ollama...");

console.log("Before Ollama call");

console.log("CV characters:", cvText.length);



 console.time("Ollama");
 const ollamaResponse = await fetch("http://localhost:11434/api/generate", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
  model: "llama3.2:3b",
  prompt: `
You are an AI Job Agent.

Analyse the candidate CV and create a structured candidate profile for job matching.

Candidate is interested in these roles:

${selectedRoles.join(", ")}

CANDIDATE CV:

${cvText}

Return ONLY valid JSON.

Use this exact format:

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

Rules:

- The candidate has graduated with a First-Class Honours degree in Software Engineering.
- Do not describe the candidate as a student.
- Treat university and personal projects as engineering experience.
- Highlight academic achievement as a strength.
- Include programming languages, frameworks, tools, databases, APIs and development technologies.
- Identify relevant projects only.
- Generate an overall candidate suitability score from 0-100.
- Score based on selected roles, technical skills, projects, education and experience.

Limits:

- Summary maximum 2 sentences.
- Recommendation maximum 2 sentences.
- Maximum 2 projects.
- Each project only contains name and skillsUsed.
- Maximum 5 items in arrays.

Do not include markdown.
Do not explain your answer.

`,
  stream: false,
  format: "json",
  options: {
    num_predict: 400,
    temperature: 0,
    num_ctx: 2048
  }
}),
    
});

if (!ollamaResponse.ok) {
  throw new Error(`Ollama error: ${ollamaResponse.status}`);
}

const response = await ollamaResponse.json();

let parsedAnalysis;

try {
  parsedAnalysis = JSON.parse(response.response);
} catch (error) {
  console.error("JSON PARSE FAILED");
  console.error(response.response);

  throw new Error("Ollama returned invalid JSON");
}

if (!parsedAnalysis.matchScore) {
  parsedAnalysis.matchScore = 80;
}

console.log("After Ollama call");
console.log(parsedAnalysis);
console.log("Ollama finished");
console.timeEnd("Ollama");



    return NextResponse.json({
  success: true,
  analysis: parsedAnalysis,
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