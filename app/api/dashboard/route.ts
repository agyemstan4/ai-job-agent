import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { getDashboard } from "@/lib/pipeline/dashboard";
import { describeError } from "@/lib/log-safety";

// The Command Centre data (Phase 3 checkpoint 3c): read only.
export async function GET(req: NextRequest) {
  try {
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? "");
    return NextResponse.json(getDashboard(db, { limit: Number.isFinite(limit) && limit > 0 ? limit : undefined }));
  } catch (error) {
    console.error("GET /api/dashboard error:", describeError(error));
    return NextResponse.json({ error: "Failed to load the dashboard" }, { status: 500 });
  }
}
