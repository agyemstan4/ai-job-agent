import { fetch as undiciFetch, Agent } from "undici";
import { parseOllamaJson } from "../ollama-json.ts";
import { GENERATION_MODEL, TAILOR_CV_PROMPT_VERSION } from "./versions.ts";

// CV tailoring, moved unchanged from app/api/tailor-cv/route.ts (3c) so the
// route and server-side preparation share it. Sends nothing anywhere except
// the local Ollama.

const NUM_PREDICT = 1800;
const NUM_CTX = 6144;

// Ollama only replies once generation has finished. On CPU a tailored CV
// takes 5-7 minutes (~1,300 tokens at ~4 tokens/s plus the prompt), longer
// than the 5-minute default headers timeout of the built-in fetch.
const longTimeoutAgent = new Agent({
  headersTimeout: 1_200_000,
  bodyTimeout: 1_200_000,
});

export type TailorJob = { title?: unknown; company?: unknown; description?: string | null };

/**
 * v1: the model returns the WHOLE CV, copying the unchanged fields itself.
 * v2 (3d): the model returns only what it rewrites — "summary" and the
 * experience "bullets" — and the code merges them into the stored CV, so
 * name, contact details, education, skills and projects are copied exactly
 * and far fewer tokens are generated (the main cost on CPU).
 */
export type TailorVariant = "v1" | "v2";
export const DEFAULT_TAILOR_VARIANT: TailorVariant = (TAILOR_CV_PROMPT_VERSION as string) === "tailor-cv/v2" ? "v2" : "v1";

/* eslint-disable @typescript-eslint/no-explicit-any -- free-form structured CV data */
/** v2: the stored CV with the model's summary and experience bullets merged in. */
export function mergeTailoredParts(structuredCV: any, parts: any): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...structuredCV };
  if (typeof parts?.summary === "string" && parts.summary.trim()) merged.summary = parts.summary.trim();
  const original: any[] = Array.isArray(structuredCV?.experience) ? structuredCV.experience : [];
  const rewritten: any[] = Array.isArray(parts?.experience) ? parts.experience : [];
  // Title, company and dates always come from the CV; only the bullets are the model's.
  // The rule "keep 2-3 bullets; keep all if a role has fewer than 3" is enforced here:
  // if the model kept too few (or gave none), the role keeps its original bullets unchanged.
  merged.experience = original.map((role, i) => {
    const originalBullets: unknown[] = Array.isArray(role?.bullets) ? role.bullets : [];
    const needed = Math.min(2, originalBullets.length);
    const bullets = rewritten[i]?.bullets;
    const ok = Array.isArray(bullets) && bullets.length > 0 && bullets.length >= needed && bullets.every((b: unknown) => typeof b === "string" && b.trim());
    return { ...role, bullets: ok ? bullets.map((b: string) => b.trim()) : originalBullets };
  });
  return merged;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function reorderSkillsForJob(skills: string[], jobDescription: string): string[] {
  const jobText = jobDescription.toLowerCase();

  const relevant = skills.filter((skill) =>
    jobText.includes(skill.toLowerCase())
  );
  const rest = skills.filter(
    (skill) => !jobText.includes(skill.toLowerCase())
  );

  return [...relevant, ...rest];
}

/** The tailored CV (same shape as the structured CV). Throws on failure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the structured CV is free-form model output
export async function tailorCv(structuredCV: any, job: TailorJob, options: { variant?: TailorVariant } = {}): Promise<Record<string, unknown>> {
    const variant = options.variant ?? DEFAULT_TAILOR_VARIANT;
    // Only insist on a First-Class Honours mention when the CV data actually
    // contains it — never add a classification the CV doesn't state.
    const cvStatesFirstClass = /\b(first[- ]class|1st[- ]class)\b/i.test(
      JSON.stringify(structuredCV)
    );
    const degreeRule = cvStatesFirstClass
      ? `- The candidate graduated with a First-Class Honours degree. This MUST always be mentioned explicitly in the summary (e.g. "First-Class Honours graduate" or "graduated with First-Class Honours"), regardless of which job this is being tailored for. Never omit it, and never describe the candidate as a current student — they have already graduated.`
      : `- Describe the candidate's education only as stated in the CV. Never invent a degree classification or graduation status.`;

    const prompt = `
You are a CV tailoring engine. You will be given a candidate's full structured CV and a specific job. Your ONLY job is to rewrite the "summary" field and trim/rewrite the "bullets" arrays inside "experience" to emphasise relevance to this job. Do not touch anything else.

CANDIDATE'S FULL CV (JSON):
${JSON.stringify(structuredCV)}

TARGET JOB:
Title: ${job.title}
Company: ${job.company}
Description: ${job.description || "Not provided"}

Return ONLY valid JSON in the EXACT SAME shape as the input CV:

{
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
  "skills": [],
  "projects": [
    { "name": "", "date": "", "bullets": [], "skillsUsed": [] }
  ]
}

Rules:
- "summary": rewrite in 4-5 full sentences tailored to THIS specific role. It MUST name at least two specific projects from the CV by their real name and mention specific technologies used, exactly as the original CV summary does. Do not shorten, generalise, or strip out specific project names or technologies that were present in the original summary — you are re-angling the emphasis toward this job, not compressing the content. Never write a generic sentence that could apply to any candidate (e.g. avoid phrasing like "highly motivated" or "proficient in X, Y, Z" with no further detail) — every sentence must contain a specific, concrete fact from the CV.
${degreeRule}
- "experience": for each role, select and lightly rewrite only the 2-3 bullets most relevant to this job. Do not invent new bullets or claims. If a role has fewer than 3 bullets, keep all of them.
- "name", "email", "phone", "location", "education", "skills", "projects": copy these EXACTLY as given in the input CV, character for character, no reordering, no rewriting, no changes whatsoever.
- Never fabricate a skill, employer, project, or achievement not present in the original CV.
- Do not include markdown.
- Do not explain your answer.
`;

    const promptV2 = `
You are a CV tailoring engine. You will be given a candidate's full structured CV and a specific job. Your ONLY job is to rewrite the "summary" field and trim/rewrite the "bullets" arrays inside "experience" to emphasise relevance to this job.

CANDIDATE'S FULL CV (JSON):
${JSON.stringify(structuredCV)}

TARGET JOB:
Title: ${job.title}
Company: ${job.company}
Description: ${job.description || "Not provided"}

PROJECTS IN THIS CV (name at least two of them in the summary): ${(Array.isArray(structuredCV?.projects) ? structuredCV.projects : []).map((p: { name?: unknown }) => p?.name).filter(Boolean).join(", ") || "none"}

Return ONLY valid JSON with exactly these two fields (everything else in the CV is kept as it is automatically):

{
  "summary": "<4-5 sentences for this role that name at least two projects from the list above, with their technologies>",
  "experience": [
    { "title": "", "bullets": [] }
  ]
}

Rules:
- "summary": rewrite in 4-5 full sentences tailored to THIS specific role. It MUST name at least two specific projects from the CV by their real name and mention specific technologies used, exactly as the original CV summary does. Do not shorten, generalise, or strip out specific project names or technologies that were present in the original summary — you are re-angling the emphasis toward this job, not compressing the content. Never write a generic sentence that could apply to any candidate (e.g. avoid phrasing like "highly motivated" or "proficient in X, Y, Z" with no further detail) — every sentence must contain a specific, concrete fact from the CV.
${degreeRule}
- "experience": one entry per role in the CV, in the same order, with the role's title; for each role, select and lightly rewrite only the 2-3 bullets most relevant to this job. Do not invent new bullets or claims. If a role has fewer than 3 bullets, keep all of them.
- Never fabricate a skill, employer, project, or achievement not present in the original CV.
- Do not include markdown.
- Do not explain your answer.
`;

    const ollamaResponse = await undiciFetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      dispatcher: longTimeoutAgent,
      body: JSON.stringify({
        model: GENERATION_MODEL,
        prompt: variant === "v2" ? promptV2 : prompt,
        stream: false,
        format: "json",
        options: {
          num_predict: NUM_PREDICT,
          temperature: 0,
          num_ctx: NUM_CTX,
        },
      }),
    });

    if (!ollamaResponse.ok) {
      throw new Error(`Ollama error: ${ollamaResponse.status}`);
    }

    const response = (await ollamaResponse.json()) as {
      response: string;
      done_reason?: string;
      eval_count?: number;
    };
    console.log("tailor-cv done:", { model: GENERATION_MODEL, promptVersion: TAILOR_CV_PROMPT_VERSION, variant, generatedTokens: response.eval_count ?? "N/A" });

    let tailoredCV;
    try {
      const parsed = parseOllamaJson(response, NUM_PREDICT);
      tailoredCV = (variant === "v2" ? mergeTailoredParts(structuredCV, parsed) : parsed) as Record<string, unknown> & { skills?: unknown };
    } catch (error) {
      // The model output contains CV content: log only its shape, never the text.
      console.error("JSON PARSE FAILED:", {
        outputChars: response.response?.length ?? 0,
        doneReason: response.done_reason ?? "unknown",
        generatedTokens: response.eval_count ?? "N/A",
      });
      throw error;
    }

    // Skills and projects are copied verbatim by the AI — reorder skills here in code, not via AI
    if (Array.isArray(tailoredCV.skills)) {
      tailoredCV.skills = reorderSkillsForJob(tailoredCV.skills, job.description || "");
    }

    return tailoredCV;
}
