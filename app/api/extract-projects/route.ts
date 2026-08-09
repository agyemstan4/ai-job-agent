import { NextResponse } from "next/server";
import { fetch as undiciFetch, Agent } from "undici";

// @ts-ignore
const pdf = require("pdf-parse/lib/pdf-parse.js");

export const runtime = "nodejs";

const longTimeoutAgent = new Agent({
  headersTimeout: 600000,
  bodyTimeout: 600000,
});

// The model unreliably splits a trailing year off a project name
// (e.g. "Portfolio Website2026") and unreliably separates a glued-on
// label (e.g. "VibeNSyncFinal Year Dissertation"). Both are really the
// same underlying problem: no space between two words that got
// concatenated during PDF text extraction. This is a deterministic
// string fix, not something worth re-prompting the model over.
// Only insert a space when the uppercase letter starts a genuine new
// word (i.e. is followed by a lowercase letter) — e.g. "ToolFinal Year"
// becomes "Tool Final Year". Skip cases like "VibeNSync" where the
// uppercase letter is followed by another uppercase letter, since that's
// a stylised brand name, not two words glued together.
const insertMissingSpaces = (text: string): string =>
  (text || "").replace(/([a-z])(?=[A-Z][a-z])/g, "$1 ").trim();

const splitTrailingYear = (name: string): { name: string; year: string } => {
  const match = name?.match(/^(.*?)(\d{4})$/);
  if (match) {
    return { name: match[1].trim(), year: match[2] };
  }
  return { name: (name || "").trim(), year: "" };
};

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("cv");

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "No CV uploaded." }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const pdfData = await pdf(buffer);
    const cvText = pdfData.text;

    console.time("Ollama-Projects");
    const ollamaResponse = await undiciFetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      dispatcher: longTimeoutAgent,
      body: JSON.stringify({
        model: "llama3.2:3b",
        prompt: `
You are a CV parsing engine. Your ONLY task is to extract the PROJECTS section of this CV. Ignore work experience, education, and everything else — focus only on projects.

CV TEXT:

${cvText}

Return ONLY valid JSON in this exact format:

{
  "projects": [
    {
      "name": "",
      "date": "",
      "bullets": [],
      "skillsUsed": []
    }
  ]
}

Critical rules:
- Include EVERY project listed in the CV. Do not skip any.
- For EACH project, include EVERY bullet point listed under it as a SEPARATE string in the "bullets" array. If a project has 4 bullet points in the CV, "bullets" must have 4 entries. NEVER merge multiple bullets into one. NEVER summarise or condense multiple bullets down to fewer bullets. NEVER drop a bullet because it seems repetitive or less important — include all of them exactly as written, only lightly cleaned up for grammar.
- Copy bullet text closely from the original — do not rewrite or paraphrase, only fix obvious typos.
- "skillsUsed" should list the specific technologies mentioned for that project.
- Copy each "name" EXACTLY character-for-character as it appears in the CV, including unusual internal capitalisation (e.g. "VibeNSync"). Do NOT insert, remove, or "correct" any spaces within a project name — only separate a trailing year if one is glued directly onto the end with no space.
- Do not invent any information not present in the CV.
- Do not include markdown.
- Do not explain your answer.
`,
        stream: false,
        format: "json",
        options: {
          num_predict: 1800,
          temperature: 0,
          num_ctx: 4096,
        },
      }),
    });

    if (!ollamaResponse.ok) {
      throw new Error(`Ollama error: ${ollamaResponse.status}`);
    }

    const response = (await ollamaResponse.json()) as { response: string };

    let parsed;
    try {
      parsed = JSON.parse(response.response);
    } catch (error) {
      console.error("JSON PARSE FAILED (extract-projects)");
      console.error(response.response);
      throw new Error("Ollama returned invalid JSON");
    }

    const projects = Array.isArray(parsed.projects)
      ? parsed.projects.map((p: any) => {
          const cleanedName = insertMissingSpaces(p.name || "");
          const { name, year } = splitTrailingYear(cleanedName);
          return {
            name,
            date: p.date && p.date.trim() ? p.date : year,
            bullets: Array.isArray(p.bullets) ? p.bullets : [],
            skillsUsed: Array.isArray(p.skillsUsed) ? p.skillsUsed : [],
          };
        })
      : [];

    console.timeEnd("Ollama-Projects");

    return NextResponse.json({ success: true, projects });
  } catch (error) {
    console.error("FULL ERROR (extract-projects):");
    console.error(error);

    return NextResponse.json(
      {
        error: "Project extraction failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}