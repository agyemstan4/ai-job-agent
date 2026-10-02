import { NextResponse } from "next/server";
import { fetch as undiciFetch, Agent } from "undici";

const longTimeoutAgent = new Agent({
  headersTimeout: 600000,
  bodyTimeout: 600000,
});

export async function POST(req: Request) {
  try {
    const { candidate, job, questions } = await req.json();

    if (!candidate || !job || !Array.isArray(questions) || questions.length === 0) {
      return NextResponse.json(
        { error: "Missing candidate, job, or questions." },
        { status: 400 }
      );
    }

    const questionsList = questions
      .map((q: string, i: number) => `${i + 1}. ${q}`)
      .join("\n");

    // Build project entries using the bullets array (projects schema
    // moved from a single "description" string to "bullets": [] earlier
    // today — using the old field name here meant every project was
    // silently falling back to skills-only, with no real detail).
    const projectsText = (candidate.projects || [])
      .map((p: any) => {
        const skills = Array.isArray(p.skillsUsed) ? p.skillsUsed.join(", ") : (p.skillsUsed || "");
        const bullets = Array.isArray(p.bullets) ? p.bullets.join("; ") : "";
        if (bullets) {
          return `- ${p.name} (${skills}): ${bullets}`;
        }
        return `- ${p.name} (${skills})`;
      })
      .join("\n");

    const educationText = Array.isArray(candidate.education)
      ? candidate.education
          .map((e: any) => `${e.degree || ""}${e.institution ? ` — ${e.institution}` : ""}`)
          .join("; ")
      : "";

    // The real field from extract-cv-structured is "experience", not
    // "workExperience", and its objects use title/company/dates/bullets —
    // not role/company/duration. This mapping never matched the actual
    // data shape, so Experience has always rendered blank here.
    const experienceText = (candidate.experience || [])
      .map((e: any) => {
        const company = e.company ? ` at ${e.company}` : "";
        const bullets = Array.isArray(e.bullets) ? e.bullets.join("; ") : "";
        return `${e.title || ""}${company} (${e.dates || ""})${bullets ? `: ${bullets}` : ""}`;
      })
      .join(" | ") || candidate.experienceLevel || "";

    const prompt = `You are helping a job candidate answer application questions honestly and specifically, using only facts about them provided below.

CANDIDATE:
Name: ${candidate.name || "Stanley Sarfo Peprah"}
Education: ${educationText}
Skills: ${(candidate.technicalSkills || []).join(", ")}
Projects:
${projectsText}
Experience: ${experienceText}

JOB:
Title: ${job.title}
Company: ${job.company}
Description: ${job.description?.slice(0, 300) || "Not provided"}

APPLICATION QUESTIONS:
${questionsList}

INSTRUCTIONS:
Write a genuine, specific answer to EACH question using only facts given above.
Match answer length to what the question expects — simple questions get short answers.

CRITICAL — for "describe a time when...", "give an example of...", or any behavioural/situational question:
- You MUST use only specific challenges, problems, or outcomes that are explicitly described in the Projects or Experience sections above.
- If a project description mentions a real challenge or technical obstacle, use that. Quote the scenario accurately — do not add steps, tools, or details that are not listed.
- If no specific scenario is provided for that type of question, give a shorter, general answer based on the candidate's background rather than inventing a story.
- Never fabricate a specific bug, workaround, architectural decision, or implementation detail that is not stated above. A vague but honest answer is always better than a specific but invented one.

Do not use generic filler phrases like "I am a hard worker" without backing it up with something specific from the candidate's background.

Return ONLY valid JSON in this exact format, with one object per question inside "answers", in the same order as given:

{
  "answers": [
    { "question": "", "answer": "" }
  ]
}

Do not include markdown. Do not explain your answer.`;
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
          temperature: 0.6,
          num_predict: 1200,
          num_ctx: 4096,
        },
      }),
    });

    if (!ollamaResponse.ok) {
      throw new Error(`Ollama error: ${ollamaResponse.status}`);
    }

    const response = (await ollamaResponse.json()) as { response: string };

    let answers;
    try {
      const parsed = JSON.parse(response.response);

      if (Array.isArray(parsed)) {
        answers = parsed;
      } else if (Array.isArray(parsed.answers)) {
        answers = parsed.answers;
      } else if (Array.isArray(parsed.questions)) {
        answers = parsed.questions;
      } else if (typeof parsed?.answer === "string") {
        // Ollama's JSON mode can only return an object, so the model
        // sometimes returns a single bare { question, answer }.
        answers = [parsed];
      } else {
        // Fallback: find the first array value in the object, whatever it's called
        const firstArray = Object.values(parsed).find((v) => Array.isArray(v));
        answers = firstArray || [];
      }
    } catch (error) {
      console.error("JSON PARSE FAILED");
      console.error(response.response);
      throw new Error("Ollama returned invalid JSON");
    }

    if (answers.length === 0) {
      console.error("NO ANSWERS IN MODEL OUTPUT");
      console.error(response.response);
      throw new Error("The AI model returned no answers. Please try again.");
    }

    return NextResponse.json({ success: true, answers });
  } catch (error) {
    console.error("FULL ERROR:");
    console.error(error);

    return NextResponse.json(
      {
        error: "Answering application questions failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}