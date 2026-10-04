import { fetch as undiciFetch, Agent } from "undici";
import { COVER_LETTER_PROMPT_VERSION, GENERATION_MODEL } from "./versions.ts";

// Cover letter generation, moved unchanged from app/api/cover-letter/route.ts
// (3c) so the route and server-side preparation share it. It never sends
// email: only the route sends its (opt-in) email copy.

const longTimeoutAgent = new Agent({
  headersTimeout: 600000,
  bodyTimeout: 600000,
});

/* eslint-disable @typescript-eslint/no-explicit-any -- free-form CV analysis data, as in the original route */
/** The cover letter text. Throws if the model returns nothing. */
export async function generateCoverLetter(candidate: any, job: any): Promise<string> {
    const degree = Array.isArray(candidate.education) && candidate.education.length > 0
      ? candidate.education
          .map((e: any) => `${e.qualification || e.degree || ""}${e.institution ? ` — ${e.institution}` : ""}`)
          .join("; ")
      : "";

    const prompt = `You are a professional cover letter writer. Write a confident, conversational cover letter for this candidate applying to this job.

CANDIDATE:
Name: Stanley Sarfo Peprah
Degree: ${degree}
Skills: ${(candidate.technicalSkills || []).join(", ")}
Projects: ${(candidate.projects || []).map((p: any) => `${p.name} (${Array.isArray(p.skillsUsed) ? p.skillsUsed.join(", ") : p.skillsUsed})`).join(" | ")}
Experience Level: ${candidate.experienceLevel}

JOB:
Title: ${job.title}
Company: ${job.company}
Description: ${job.description?.slice(0, 300) || "Not provided"}

Write 3 paragraphs only. Confident but not arrogant. No bullet points. Under 250 words. Output the cover letter text only.
NEVER start with "I am writing to" or "I would like to apply". Start with something direct and confident instead.`;

    const response = await undiciFetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      dispatcher: longTimeoutAgent,
      body: JSON.stringify({
       model: GENERATION_MODEL,
        prompt,
        stream: false,
        options: {
          temperature: 0.7,
          num_predict: 500,
          num_ctx: 2048,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status}`);
    }

    const data = (await response.json()) as { response?: string };
    const coverLetter = data.response?.trim();

    if (!coverLetter) {
      throw new Error("Failed to generate cover letter");
    }

    console.log("cover-letter done:", { model: GENERATION_MODEL, promptVersion: COVER_LETTER_PROMPT_VERSION, chars: coverLetter.length });
    return coverLetter;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
