import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { getReviewItem } from "@/lib/repositories/review";
import { applyReviewAction, clientErrorMessage, httpStatusFor, parseReviewAction } from "@/lib/pipeline/review";

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

// A user action: approve (with the reviewed content hash), reject, withdraw,
// note, edit_cover_letter, mark_submitted (the user applied on the employer's
// site themselves; requires confirm: true), update_status (after applying)
// or set_reference. Nothing here submits anything, opens a website or sends
// email.
export async function PATCH(req: NextRequest, { params }: Context) {
  try {
    const { id } = await params;
    const action = parseReviewAction(await req.json().catch(() => null));
    return NextResponse.json(applyReviewAction(db, Number(id), action));
  } catch (error) {
    const status = httpStatusFor(error);
    if (status === 500) console.error("PATCH /api/applications/[id] error:", error);
    return NextResponse.json({ error: clientErrorMessage(error, "Failed to update application") }, { status });
  }
}
