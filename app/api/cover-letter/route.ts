import { NextResponse } from "next/server";
import { fetch as undiciFetch, Agent } from "undici";
import { coverLetterEmail, sendEmailCopy } from "@/lib/email-copies";

const longTimeoutAgent = new Agent({
  headersTimeout: 600000,
  bodyTimeout: 600000,
});

export async function POST(req: Request) {
  try {
    const { candidate, job } = await req.json();

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
       model: "llama3.2:3b",
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
      return NextResponse.json(
        { error: "Failed to generate cover letter" },
        { status: 500 }
      );
    }

    // Email copy, only if enabled (EMAIL_COPIES_ENABLED); in the background —
    // it never blocks or fails the response.
    void sendEmailCopy(coverLetterEmail(job, coverLetter));

    return NextResponse.json({ coverLetter });

  } catch (error) {
    console.error("Cover letter error:", error);
    return NextResponse.json(
      {
        error: "Cover letter generation failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}