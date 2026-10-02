import { NextRequest, NextResponse } from "next/server";
import {
  getResultById,
  updateResultStatus,
  updateCoverLetter,
} from "@/lib/db";

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
    return new NextResponse(result.cv_file, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${result.cv_filename || "CV.pdf"}"`,
      },
    });
  } catch (error) {
    console.error("GET /api/batch-results/[id] error:", error);
    return NextResponse.json({ error: "Failed to fetch result" }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: idParam } = await params;
    const id = Number(idParam);
    const body = await req.json();

    if (body.status === "approved" || body.status === "rejected") {
      updateResultStatus(id, body.status, body.notes);
    }

    if (body.coverLetter !== undefined) {
      updateCoverLetter(id, body.coverLetter);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("PATCH /api/batch-results/[id] error:", error);
    return NextResponse.json({ error: "Failed to update result" }, { status: 500 });
  }
}