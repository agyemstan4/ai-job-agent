import { NextResponse } from "next/server";
import { coverLetterEmail, sendEmailCopy } from "@/lib/email-copies";
import { generateCoverLetter } from "@/lib/generation/cover-letter";

// Thin route over lib/generation/cover-letter.ts (shared with server-side
// preparation, which never sends email).
export async function POST(req: Request) {
  try {
    const { candidate, job } = await req.json();

    let coverLetter: string;
    try {
      coverLetter = await generateCoverLetter(candidate, job);
    } catch (error) {
      if (error instanceof Error && error.message === "Failed to generate cover letter") {
        return NextResponse.json(
          { error: "Failed to generate cover letter" },
          { status: 500 }
        );
      }
      throw error;
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
