import { NextResponse } from "next/server";
import { fetch as undiciFetch, Agent } from "undici";
import { parseOllamaJson } from "@/lib/ollama-json";

const NUM_PREDICT = 1800;
const NUM_CTX = 6144;

// Ollama only replies once generation has finished. On CPU a tailored CV
// takes 5-7 minutes (~1,300 tokens at ~4 tokens/s plus the prompt), longer
// than the 5-minute default headers timeout of the built-in fetch.
const longTimeoutAgent = new Agent({
  headersTimeout: 1_200_000,
  bodyTimeout: 1_200_000,
});

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

export async function POST(req: Request) {
  try {
    const { structuredCV, job } = await req.json();

    if (!structuredCV || !job) {
      return NextResponse.json(
        { error: "Missing structuredCV or job." },
        { status: 400 }
      );
    }

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

    const ollamaResponse = await undiciFetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      dispatcher: longTimeoutAgent,
      body: JSON.stringify({
        model: "llama3.2:3b",
        prompt,
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
    console.log("tailor-cv generated tokens:", response.eval_count ?? "N/A");

    let tailoredCV;
    try {
      tailoredCV = parseOllamaJson(response, NUM_PREDICT) as Record<string, unknown> & { skills?: unknown };
    } catch (error) {
      console.error("JSON PARSE FAILED");
      console.error(response.response);
      throw error;
    }

    // Skills and projects are copied verbatim by the AI — reorder skills here in code, not via AI
    if (Array.isArray(tailoredCV.skills)) {
      tailoredCV.skills = reorderSkillsForJob(tailoredCV.skills, job.description || "");
    }

    return NextResponse.json({
      success: true,
      tailoredCV,
    });
  } catch (error) {
    console.error("FULL ERROR:");
    console.error(error);

    return NextResponse.json(
      {
        error: "Tailoring failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}