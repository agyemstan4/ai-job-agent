import { NextResponse } from "next/server";
import { fetch as undiciFetch, Agent } from "undici";
import db from "@/lib/db";
import { findReusableCvAnalysis, saveCvAnalysis } from "@/lib/pipeline/cv";
import { parseOllamaJson } from "@/lib/ollama-json";

// @ts-ignore
const pdf = require("pdf-parse/lib/pdf-parse.js");

export const runtime = "nodejs";

const OLLAMA_MODEL = "llama3.2:3b";
// Recorded on each profile version. Bump when the prompt below changes.
const PROMPT_VERSION = "analyse-and-extract/v1";

// The combined analysis of a full CV needs ~2,500 output tokens, and on CPU
// the model produces ~5 tokens/s. num_ctx must hold the prompt (up to ~3,300
// tokens for an 8,000-character CV) plus the output.
const NUM_PREDICT = 3584;
const NUM_CTX = 8192;

// Ollama only replies once generation has finished.
const longTimeoutAgent = new Agent({
  headersTimeout: 1_200_000,
  bodyTimeout: 1_200_000,
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

// Returns a 0-100 integer, or null if the model gave no usable number.
const parseScore = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(100, Math.max(0, n)));
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

    // The same CV analysed before with the same roles, model and prompt: reuse
    // the stored profile instead of re-running the (slow, non-deterministic)
    // analysis. A lookup failure just falls through to a fresh analysis.
    const analysisInputs = {
      selectedRoles: Array.isArray(selectedRoles) ? selectedRoles.map(String) : [],
    };
    try {
      const reused = findReusableCvAnalysis(db, {
        file: buffer,
        inputs: analysisInputs,
        model: OLLAMA_MODEL,
        promptVersion: PROMPT_VERSION,
      });
      if (reused) {
        console.log("Reusing stored CV analysis:", {
          profileId: reused.profile.id,
          profileVersion: reused.profile.version,
          profileOutcome: reused.profileOutcome,
        });
        return NextResponse.json({
          success: true,
          analysis: reused.analysis,
          structuredCV: reused.structuredCv,
          candidateProfileId: reused.profile.id,
          reusedAnalysis: true,
        });
      }
    } catch (error) {
      console.error("Looking up a stored CV analysis failed:", error);
    }

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

    const cvStatesFirstClass = /\b(first[- ]class|1st[- ]class)\b/i.test(cvText);
    const degreeRule = cvStatesFirstClass
      ? "- The candidate has graduated with a First-Class Honours degree, as stated in the CV. Do not describe the candidate as a student."
      : "- Describe the candidate's education only as stated in the CV. Never invent a degree classification or graduation status.";

    console.time("Ollama-Combined");

    const ollamaResponse = await undiciFetch(
      "http://localhost:11434/api/generate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        dispatcher: longTimeoutAgent,
        body: JSON.stringify({
          model: OLLAMA_MODEL,
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
${degreeRule}
- Treat university and personal projects as genuine engineering experience.
- "summary" must be 4-6 full sentences. Reference the candidate's degree classification (only if the CV states one), at least two named projects from the CV, and specific technologies actually used. Every sentence must contain a specific fact from this CV — no generic statements.
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
            num_predict: NUM_PREDICT,
            temperature: 0,
            num_ctx: NUM_CTX,
          },
        }),
      }
    );

    if (!ollamaResponse.ok) {
      throw new Error(`Ollama error: ${ollamaResponse.status}`);
    }

const response = (await ollamaResponse.json()) as {
  response: string;
  done_reason?: string;
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
      parsed = parseOllamaJson(response, NUM_PREDICT);
    } catch (error) {
      // The model output contains CV content: log only its shape, never the text.
      console.error("JSON PARSE FAILED:", {
        outputChars: response.response?.length ?? 0,
        doneReason: response.done_reason ?? "unknown",
        generatedTokens: response.eval_count ?? "N/A",
      });
      throw error;
    }

    console.timeEnd("Ollama-Combined");

    // ---- Normalize analysis ----
    const analysis = parsed.analysis || {};
    // No fabricated default: a missing/invalid score is reported as null and
    // the UI shows "No score" instead of a made-up 80.
    analysis.matchScore = parseScore(analysis.matchScore);
    analysis.strengths = toArray(analysis.strengths);
    analysis.growthAreas = toArray(analysis.growthAreas);
    analysis.matchingSkills = toArray(analysis.matchingSkills);
    analysis.missingSkills = toArray(analysis.missingSkills);
    analysis.technicalSkills = toArray(analysis.technicalSkills);

    // ---- Normalize structuredCV ----
    const structuredCV = parsed.structuredCV || {};
    // Only restore a First-Class Honours label the model dropped if the CV
    // itself actually states it — never add a classification that isn't there.
    if (cvStatesFirstClass && Array.isArray(structuredCV.education)) {
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
      experienceCount: Array.isArray(structuredCV.experience) ? structuredCV.experience.length : 0,
      projectCount: projects.length,
    });

    // Persisting is best-effort: a database failure is reported alongside the
    // analysis instead of discarding it.
    let candidateProfileId: number | null = null;
    const persistenceWarnings: string[] = [];
    try {
      const saved = saveCvAnalysis(db, {
        file: buffer,
        originalFilename: file.name || "cv.pdf",
        mimeType: file.type || "application/pdf",
        extractedText: pdfData.text,
        analysis,
        structuredCv: structuredCV,
        inputs: analysisInputs,
        fallbackName: candidateName,
        model: OLLAMA_MODEL,
        promptVersion: PROMPT_VERSION,
      });
      candidateProfileId = saved.profile.id;
      console.log("CV saved:", {
        cvDocumentId: saved.cvDocumentId,
        documentCreated: saved.documentCreated,
        profileId: saved.profile.id,
        profileVersion: saved.profile.version,
        profileOutcome: saved.profileOutcome,
      });
    } catch (error) {
      console.error("Saving the CV analysis failed:", error);
      persistenceWarnings.push(
        `The analysis was not saved: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return NextResponse.json({
      success: true,
      analysis,
      structuredCV,
      candidateProfileId,
      ...(persistenceWarnings.length > 0 ? { persistenceWarnings } : {}),
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