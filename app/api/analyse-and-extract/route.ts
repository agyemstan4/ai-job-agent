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

const toTitleCase = (str: string): string =>
  str.toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());

const toArray = (value: any): any[] => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.split(",").map((s: string) => s.trim()).filter(Boolean);
  }
  return [];
};

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("cv");
    const roles = formData.get("roles");
    const selectedRoles = roles ? JSON.parse(roles.toString()) : [];

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "No CV uploaded." }, { status: 400 });
    }

    console.log("Reading PDF...");
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    console.time("PDF");
    const pdfData = await pdf(buffer);
    const cvText = pdfData.text.slice(0, 8000);
    console.timeEnd("PDF");

    console.log("CV characters:", cvText.length);

    const candidateName = toTitleCase(
      cvText
        .split("\n")
        .map((l: string) => l.trim())
        .find((l: string) => l.length > 0) || "the candidate"
    );

    console.time("Ollama-Combined");

    const ollamaResponse = await undiciFetch(
      "http://localhost:11434/api/generate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        dispatcher: longTimeoutAgent,
        body: JSON.stringify({
          model: "llama3.2:3b",
          prompt: `
You are an AI Job Agent. You will do THREE tasks on the same CV in one pass: (1) a candidate analysis, (2) structured CV parsing, (3) project extraction. Do all three carefully — do not skip or shortcut any of them.

The candidate's full name, exactly as written, is: "${candidateName}". Always use this exact spelling — never alter it.

Candidate is interested in these roles:
${selectedRoles.join(", ")}

CANDIDATE CV:

${cvText}

Return ONLY valid JSON in this EXACT combined shape:

{
  "analysis": {
    "matchScore": 0,
    "summary": "",
    "recommendation": "",
    "experienceLevel": "",
    "technicalSkills": ["", ""],
    "matchingSkills": ["", ""],
    "missingSkills": ["", ""],
    "strengths": ["", ""],
    "growthAreas": ["", ""]
  },
  "structuredCV": {
    "name": "",
    "email": "",
    "phone": "",
    "location": "",
    "summary": "",
    "experience": [
      { "title": "", "company": "", "dates": "", "bullets": [] }
    ],
    "education": [
      { "degree": "", "institution": "", "dates": "", "notes": "" }
    ],
    "skills": []
  },
  "projects": [
    { "name": "", "date": "", "bullets": [], "skillsUsed": [] }
  ]
}

=== RULES FOR "analysis" ===
- The candidate has graduated with a First-Class Honours degree in Software Engineering. Do not describe the candidate as a student.
- Treat university and personal projects as genuine engineering experience.
- "summary" must be 4-6 full sentences. Reference the candidate's degree classification, at least two named projects from the CV, and specific technologies actually used. Every sentence must contain a specific fact from this CV — no generic statements.
- "recommendation" must be 3-5 full sentences explaining, with specific reasoning, why the candidate fits (or doesn't fit) the selected roles, referencing specific skills or projects.
- "technicalSkills": up to 15 actual named languages, frameworks, tools, databases and APIs — no categories.
- "matchingSkills" and "missingSkills" must contain only concrete, named skills or technologies — e.g. "Kotlin", "REST APIs", "Spotify Web API". NEVER a category like "Full Stack", "Cloud Services", "backend experience", or "commercial experience".
- "strengths": 2-4 short bullet phrases on what makes this candidate stand out.
- "growthAreas": 1-3 short bullet phrases on realistic areas to develop.
- Generate an overall candidate suitability score from 0-100 as "matchScore".
- "technicalSkills", "matchingSkills", "missingSkills", "strengths", "growthAreas" MUST be JSON arrays of strings — never a comma-separated string.

=== RULES FOR "structuredCV" ===
- Include EVERY job/role found in the CV, not just the most recent.
- Include EVERY education entry found.
- Include ALL skills mentioned, not a limited subset.
- Bullets in "experience" should preserve the original meaning of each CV line but may be lightly cleaned up (no fixing typos into false claims).
- Do NOT put projects inside "structuredCV" — projects go ONLY in the separate top-level "projects" array.
- Company names: only extract a company name if it is CLEARLY and DIRECTLY associated with that specific job entry (same line, or the line immediately below/above it). Do NOT pull in an organisation name from elsewhere in the CV (e.g. from Education). An empty "company" field is correct and expected when the CV genuinely does not state one.
- Do not invent any information not present in the CV. If a field is not present, return an empty string or empty array.

=== RULES FOR "projects" ===
- Include EVERY project listed in the CV. Do not skip any.
- For EACH project, include EVERY bullet point listed under it as a SEPARATE string in "bullets". Never merge multiple bullets into one, never summarise/condense, never drop a bullet.
- Copy bullet text closely from the original — do not rewrite or paraphrase, only fix obvious typos.
- "skillsUsed" should list the specific technologies mentioned for that project.
- Copy each project "name" EXACTLY character-for-character as it appears in the CV, including unusual internal capitalisation (e.g. "VibeNSync"). Do NOT insert, remove, or "correct" spaces within a project name — only separate a trailing year if one is glued directly onto the end with no space.
- Do not invent any project not present in the CV.

Do not include markdown. Do not explain your answer. Do not wrap the JSON in code fences. Return the combined JSON object and nothing else.
`,
          stream: false,
          format: "json",
          keep_alive: "10m",
          options: {
            num_predict: 1400,
            temperature: 0,
            num_ctx: 4096,
          },
        }),
      }
    );

    if (!ollamaResponse.ok) {
      throw new Error(`Ollama error: ${ollamaResponse.status}`);
    }

const response = (await ollamaResponse.json()) as {
  response: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
};
 console.log("OLLAMA TIMING:", {
  total: response.total_duration
    ? `${(response.total_duration / 1e9).toFixed(2)}s`
    : "N/A",

  load: response.load_duration
    ? `${(response.load_duration / 1e9).toFixed(2)}s`
    : "N/A",

  promptEval: response.prompt_eval_duration
    ? `${(response.prompt_eval_duration / 1e9).toFixed(2)}s`
    : "N/A",

  promptTokens: response.prompt_eval_count ?? "N/A",

  generation: response.eval_duration
    ? `${(response.eval_duration / 1e9).toFixed(2)}s`
    : "N/A",

  generatedTokens: response.eval_count ?? "N/A",
});


    let parsed: any;
    try {
      parsed = JSON.parse(response.response);
    } catch (error) {
      console.error("JSON PARSE FAILED");
      console.error(response.response);
      throw new Error("Ollama returned invalid JSON");
    }

    console.timeEnd("Ollama-Combined");

    // ---- Normalize analysis ----
    const analysis = parsed.analysis || {};
    if (!analysis.matchScore) analysis.matchScore = 80;
    analysis.strengths = toArray(analysis.strengths);
    analysis.growthAreas = toArray(analysis.growthAreas);
    analysis.matchingSkills = toArray(analysis.matchingSkills);
    analysis.missingSkills = toArray(analysis.missingSkills);
    analysis.technicalSkills = toArray(analysis.technicalSkills);

    // ---- Normalize structuredCV ----
    const structuredCV = parsed.structuredCV || {};
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

    // ---- Normalize projects ----
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

    structuredCV.projects = projects;

    console.log("Combined result ready:", {
      analysisScore: analysis.matchScore,
      structuredCVName: structuredCV.name,
      projectCount: projects.length,
    });

    return NextResponse.json({
      success: true,
      analysis,
      structuredCV,
    });
  } catch (error) {
    console.error("FULL ERROR (analyse-and-extract):");
    console.error(error);

    return NextResponse.json(
      {
        error: "Combined analysis failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}