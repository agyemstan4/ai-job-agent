import { NextResponse } from "next/server";
import { sendEmailCopy, tailoredCvEmail } from "@/lib/email-copies";
import { renderCvDocument } from "@/lib/generation/cv-document";
import { attachmentHeaders } from "@/lib/download-headers";

export const runtime = "nodejs";

// Thin route over lib/generation/cv-document.ts (shared with server-side
// preparation, which never sends email).
export async function POST(req: Request) {
  try {
    const { tailoredCV, job } = await req.json();

    if (!tailoredCV) {
      return NextResponse.json({ error: "Missing tailoredCV." }, { status: 400 });
    }

    const file = await renderCvDocument(tailoredCV, job);

    // Email copy, only if enabled (EMAIL_COPIES_ENABLED); in the background —
    // it never blocks or fails the response.
    void sendEmailCopy(tailoredCvEmail(job, { filename: file.filename, content: file.buffer, format: file.format }));

    // Return the file to the browser for download
    return new NextResponse(new Uint8Array(file.buffer), {
      status: 200,
      headers: attachmentHeaders(file.filename, file.mimeType),
    });

  } catch (error) {
    console.error("FULL ERROR:", error);
    return NextResponse.json(
      { error: "Document generation failed", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
