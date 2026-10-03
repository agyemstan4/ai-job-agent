import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { getPreferences, putPreferences } from "@/lib/pipeline/preferences";
import { describeError } from "@/lib/log-safety";

// Search preferences (Phase 3 checkpoint 3b-5a): search terms, location,
// exclude keywords and a minimum salary, used by job discovery. Saved with
// the candidate record; nothing else changes.

export async function GET() {
  try {
    const { status, body } = getPreferences(db);
    return NextResponse.json(body, { status });
  } catch (error) {
    console.error("GET /api/preferences error:", describeError(error));
    return NextResponse.json({ error: "Failed to load preferences" }, { status: 500 });
  }
}

// PUT { preferences: {...} } saves them (validated); { preferences: null } clears them.
export async function PUT(req: NextRequest) {
  try {
    const { status, body } = putPreferences(db, await req.json().catch(() => null));
    return NextResponse.json(body, { status });
  } catch (error) {
    console.error("PUT /api/preferences error:", describeError(error));
    return NextResponse.json({ error: "Failed to save preferences" }, { status: 500 });
  }
}
