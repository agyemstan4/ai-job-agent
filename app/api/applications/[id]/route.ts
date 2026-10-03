import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { getReviewItem } from "@/lib/repositories/review";
import { applyReviewAction, httpStatusFor, parseReviewAction } from "@/lib/pipeline/review";

type Context = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Context) {
  try {
    const { id } = await params;
    const item = getReviewItem(db, Number(id));
    if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(item);
  } catch (error) {
    console.error("GET /api/applications/[id] error:", error);
    return NextResponse.json({ error: "Failed to fetch application" }, { status: 500 });
  }
}

// A reviewer action: approve (with the reviewed content hash), reject,
// withdraw, note, or edit_cover_letter. Approval is a decision only;
// nothing is submitted.
export async function PATCH(req: NextRequest, { params }: Context) {
  try {
    const { id } = await params;
    const action = parseReviewAction(await req.json().catch(() => null));
    return NextResponse.json(applyReviewAction(db, Number(id), action));
  } catch (error) {
    const status = httpStatusFor(error);
    if (status === 500) console.error("PATCH /api/applications/[id] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update application" },
      { status }
    );
  }
}
