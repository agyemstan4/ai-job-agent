import { NextRequest, NextResponse } from "next/server";
import { getResultById } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const result = getResultById(Number(id));
    if (!result) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!result.cv_file) {
      return NextResponse.json({ error: "No CV file stored" }, { status: 404 });
    }
    // The CV is a PDF normally, but a DOCX when LibreOffice conversion fell
    // back — serve it with the type matching its stored filename.
    const filename = String(result.cv_filename || "CV.pdf").replace(/[^\w.-]/g, "_");
    const isDocx = filename.toLowerCase().endsWith(".docx");
    return new NextResponse(result.cv_file, {
      headers: {
        "Content-Type": isDocx
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error("GET /api/batch-results/[id] error:", error);
    return NextResponse.json({ error: "Failed to fetch result" }, { status: 500 });
  }
}

// Review decisions and edits are made on applications now; changing a legacy
// row would make it disagree with its application.
export async function PATCH() {
  return NextResponse.json(
    {
      error: "The legacy review queue is read-only. Use PATCH /api/applications/{id} instead.",
    },
    { status: 410 }
  );
}