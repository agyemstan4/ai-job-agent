import { NextResponse } from "next/server";
import { fetch as undiciFetch, Agent } from "undici";

// @ts-ignore
const pdf = require("pdf-parse/lib/pdf-parse.js");

export const runtime = "nodejs";

const longTimeoutAgent = new Agent({
  headersTimeout: 600000,
  bodyTimeout: 600000,
});

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
const cvText = pdfData.text.slice(0, 8000);

console.timeEnd("PDF");
    

    console.log("PDF extracted");
    console.log("Characters:", cvText.length);

     console.log("Sending request to Ollama...");

console.log("Before Ollama call");

console.log("CV characters:", cvText.length);

// Small local models can drift/misspell proper nouns over a long
// generation. Extract the name directly from the CV text instead of
// trusting the model to reproduce it correctly.
const toTitleCase = (str: string): string =>
  str
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());

const candidateName = toTitleCase(
  cvText
    .split("\n")
    .map((l: string) => l.trim())
    .find((l: string) => l.length > 0) || "the candidate"
);

console.time("Ollama");

 const ollamaResponse = await undiciFetch("http://localhost:11434/api/generate", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  dispatcher: longTimeoutAgent,
  body: JSON.stringify({
  model: "llama3.2:3b",
  prompt: `
You are an AI Job Agent producing a detailed candidate analysis for a recruiter to read.

The candidate's full name, exactly as written, is: "${candidateName}". Always use this exact spelling — never alter it.

Candidate is interested in these roles:

${selectedRoles.join(", ")}

CANDIDATE CV:

${cvText}

Return ONLY valid JSON. Use this exact format, with these exact types:

{
  "matchScore": 0,
  "summary": "",
  "recommendation": "",
  "experienceLevel": "",
  "technicalSkills": ["", ""],
  "matchingSkills": ["", ""],
  "missingSkills": ["", ""],
  "strengths": ["", ""],
  "growthAreas": ["", ""]
}

IMPORTANT: "technicalSkills", "matchingSkills", "missingSkills", "strengths", and "growthAreas" MUST be JSON arrays of strings — never a single comma-separated string.

Content rules:

- The candidate has graduated with a First-Class Honours degree in Software Engineering. Do not describe the candidate as a student.
- Treat university and personal projects as genuine engineering experience.
- "summary" must be 4-6 full sentences. Reference the candidate's degree classification, at least two named projects from the CV, and specific technologies actually used. Every sentence must contain a specific fact from this CV — no generic statements.
- "recommendation" must be 3-5 full sentences explaining, with specific reasoning, why the candidate fits (or doesn't fit) the selected roles, referencing specific skills or projects.
- "technicalSkills": up to 15 actual named languages, frameworks, tools, databases and APIs — no categories.
- "matchingSkills" and "missingSkills" must contain only concrete, named skills or technologies — e.g. "Kotlin", "REST APIs", "Spotify Web API". NEVER a category like "Full Stack", "Cloud Services", "backend experience", or "commercial experience".
- "strengths": 2-4 short bullet phrases on what makes this candidate stand out.
- "growthAreas": 1-3 short bullet phrases on realistic areas to develop.
- Generate an overall candidate suitability score from 0-100.

Do not include markdown. Do not explain your answer. Do not wrap the JSON in code fences.
`,
  stream: false,
  format: "json",
  options: {
    num_predict: 1500,
    temperature: 0,
    num_ctx: 4096,
  }
}),
    
});

if (!ollamaResponse.ok) {
  throw new Error(`Ollama error: ${ollamaResponse.status}`);
}

const response = (await ollamaResponse.json()) as { response: string };

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

    // Ollama doesn't reliably obey the type constraints in the prompt
    // (e.g. returns skillsUsed as a comma string instead of an array,
    // or education as a plain string instead of an array of objects).
    // Normalize here so the frontend always gets a consistent shape,
    // regardless of what the model actually returned.

    const toArray = (value: any): any[] => {
      if (Array.isArray(value)) return value;
      if (typeof value === "string" && value.trim().length > 0) {
        return value.split(",").map((s: string) => s.trim()).filter(Boolean);
      }
      return [];
    };

    parsedAnalysis.strengths = toArray(parsedAnalysis.strengths);
    parsedAnalysis.growthAreas = toArray(parsedAnalysis.growthAreas);
    parsedAnalysis.matchingSkills = toArray(parsedAnalysis.matchingSkills);
    parsedAnalysis.missingSkills = toArray(parsedAnalysis.missingSkills);
    parsedAnalysis.technicalSkills = toArray(parsedAnalysis.technicalSkills);

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