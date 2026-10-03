import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { listReviewItems, REVIEW_FILTERS } from "@/lib/repositories/review";

// The review queue: applications with their job, match and current content.
// ?status=pending|approved|rejected|failed|withdrawn|all (default all).
export async function GET(req: NextRequest) {
  try {
    const filter = req.nextUrl.searchParams.get("status") ?? "all";
    const statuses = REVIEW_FILTERS[filter];
    if (!statuses) {
      return NextResponse.json({ error: `Unknown status filter: ${filter}` }, { status: 400 });
    }
    return NextResponse.json(listReviewItems(db, statuses));
  } catch (error) {
    console.error("GET /api/applications error:", error);
    return NextResponse.json({ error: "Failed to fetch applications" }, { status: 500 });
  }
}
