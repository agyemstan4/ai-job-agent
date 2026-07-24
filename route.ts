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
    model: "llama3.2:3b",
    prompt: `
You are an AI Job Agent.

You MUST return ONLY valid JSON.
No markdown.
No explanation.
No text before or after the JSON.

Use exactly this format:

{
  "summary": "",
  "skills": [],
  "recommendedRoles": [],
  "missingSkills": [],
  "cvImprovements": []
}

Analyse this CV.

The candidate is interested in these roles:

${selectedRoles.join(", ")}

${cvText}
`,
    stream: false,
    format: "json",
    options: {
  num_predict: 250,
  temperature: 0.2,
  num_ctx: 1024
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