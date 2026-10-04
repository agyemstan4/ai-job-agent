import { NextResponse } from "next/server";
import { answerQuestions } from "@/lib/generation/questions";

// Thin route over lib/generation/questions.ts (shared with server-side
// preparation, POST /api/applications/prepare).
export async function POST(req: Request) {
  try {
    const { candidate, job, questions } = await req.json();

    if (!candidate || !job || !Array.isArray(questions) || questions.length === 0) {
      return NextResponse.json(
        { error: "Missing candidate, job, or questions." },
        { status: 400 }
      );
    }

    const answers = await answerQuestions(candidate, job, questions);
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
