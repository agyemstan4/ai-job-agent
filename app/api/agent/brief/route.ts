import { NextResponse } from "next/server";
import db from "@/lib/db";
import { getTodaysSavedBrief } from "@/lib/pipeline/saved-brief";
import { describeError } from "@/lib/log-safety";

// Today's saved daily brief (Phase 4b), composed with live job and
// application data. Read only. { brief: null } when no brief is ready today.
export async function GET() {
  try {
    return NextResponse.json(getTodaysSavedBrief(db));
  } catch (error) {
    console.error("GET /api/agent/brief error:", describeError(error));
    return NextResponse.json({ error: "Failed to load the daily brief" }, { status: 500 });
  }
}
