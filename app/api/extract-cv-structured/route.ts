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

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "No CV uploaded." },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    console.time("PDF");
    const pdfData = await pdf(buffer);
    const cvText = pdfData.text;
    console.timeEnd("PDF");

    console.log("CV characters:", cvText.length);

    console.time("Ollama-Structured");
    const ollamaResponse = await undiciFetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      dispatcher: longTimeoutAgent,
      body: JSON.stringify({
        model: "llama3.2:3b",
        prompt: `
You are a CV parsing engine.

Convert the following CV text into structured JSON. Do not summarise, condense, or omit entries. Extract everything present.

CV TEXT:

${cvText}

Return ONLY valid JSON in this exact format:

{
  "name": "",
  "email": "",
  "phone": "",
  "location": "",
  "summary": "",
  "experience": [
    {
      "title": "",
      "company": "",
      "dates": "",
      "bullets": []
    }
  ],
  "education": [
    {
      "degree": "",
      "institution": "",
      "dates": "",
      "notes": ""
    }
  ],
  "skills": []
}

Rules:
- Include EVERY job/role found in the CV, not just the most recent.
- Include EVERY education entry found.
- Include ALL skills mentioned, not a limited subset.
- Bullets in "experience" should preserve the original meaning of each CV line but may be lightly cleaned up (no fixing typos into false claims).
- Do NOT extract projects — that is handled separately. Ignore any project section in the CV text entirely.
- Do not invent any information not present in the CV.
- If a field is not present in the CV, return an empty string or empty array for it.
- Do not include markdown.
- Do not explain your answer.

Company names:
- Company or organisation names usually appear on the same line as the job title, or directly below/after it.
- Only extract a company name if it is CLEARLY and DIRECTLY associated with that specific job entry (same line, or the line immediately below/above it).
- Do NOT pull in an organisation name from elsewhere in the CV (e.g. from Education) just to avoid leaving "company" blank. An empty "company" field is correct and expected when the CV genuinely does not state one for that role — leave it as an empty string in that case rather than guessing.

`,
        stream: false,
        format: "json",
       options: {
          num_predict: 1400,
          temperature: 0,
          num_ctx: 4096,
        },
      }),
    });

    if (!ollamaResponse.ok) {
      throw new Error(`Ollama error: ${ollamaResponse.status}`);
    }

    const response = (await ollamaResponse.json()) as { response: string };

    let structuredCV;
    try {
      structuredCV = JSON.parse(response.response);
    } catch (error) {
      console.error("JSON PARSE FAILED");
      console.error(response.response);
      throw new Error("Ollama returned invalid JSON");
    }

    // The candidate's First-Class Honours classification is a fixed fact
    // that must always appear on the CV, but the model doesn't reliably
    // preserve it when extracting the degree line. Enforce it in code
    // rather than hoping the model keeps it — same approach used for the
    // profile summary.
    if (Array.isArray(structuredCV.education)) {
      structuredCV.education = structuredCV.education.map((edu: any) => {
        const degree = edu.degree || "";
        const isUniversityDegree = /beng|bsc|msc|ba |bachelor|master/i.test(degree);
        const alreadyMentionsHonours = /first[- ]class|honours/i.test(degree);

        if (isUniversityDegree && !alreadyMentionsHonours) {
          return { ...edu, degree: `${degree} — First-Class Honours` };
        }
        return edu;
      });
    }

    console.timeEnd("Ollama-Structured");

    return NextResponse.json({
      success: true,
      structuredCV,
    });
  } catch (error) {
    console.error("FULL ERROR:");
    console.error(error);

    return NextResponse.json(
      {
        error: "Structured extraction failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}