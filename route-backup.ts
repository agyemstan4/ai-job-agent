import { NextResponse } from "next/server";

// @ts-ignore
const pdf = require("pdf-parse/lib/pdf-parse.js");

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    // Get uploaded data
    const formData = await request.formData();

    // Get CV file
    const file = formData.get("cv");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "No CV uploaded." },
        { status: 400 }
      );
    }

    // Convert file into a buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Extract PDF text
    const data = await pdf(buffer);

    console.log("PDF RESULT:", data);

    const text = data.text;

    const ollamaResponse = await fetch(
  "http://localhost:11434/api/generate",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama3.1:8b",
      prompt: `
You are an AI Job Agent.

Analyse this CV and provide:

1. Candidate summary
2. Technical skills
3. Suitable junior software roles
4. Missing skills to improve
5. Advice for getting hired

CV:
${text}
`,
      stream: false,
    }),
  }
);

const ollamaData = await ollamaResponse.json();

    // Return extracted text
    return NextResponse.json({
  success: true,
  analysis: ollamaData.response,
});

  } catch (error) {
    console.error("PDF ERROR:", error);

    return NextResponse.json(
      {
        error: "Something went wrong.",
        details: String(error),
      },
      { status: 500 }
    );
  }
}