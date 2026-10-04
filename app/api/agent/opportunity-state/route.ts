import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { recordDefaultCandidateEvent } from "@/lib/pipeline/saved-brief";
import { describeError } from "@/lib/log-safety";

// POST { jobId, event: "seen" | "reviewed" } — remembers that you opened or
// acted on an opportunity (Phase 4b). Nothing else changes.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { jobId?: unknown; event?: unknown } | null;
    const event = body?.event === "seen" || body?.event === "reviewed" ? body.event : null;
    if (!event || typeof body?.jobId !== "number") return NextResponse.json({ error: "Send { jobId, event: \"seen\" | \"reviewed\" }" }, { status: 400 });
    if (!recordDefaultCandidateEvent(db, body.jobId, event)) return NextResponse.json({ error: "Unknown job" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("POST /api/agent/opportunity-state error:", describeError(error));
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
