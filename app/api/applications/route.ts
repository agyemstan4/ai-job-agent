import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { isTrackerFilter, listReviewItems, listTrackerItems, REVIEW_FILTERS } from "@/lib/repositories/review";
import { handleBatchSave } from "@/lib/batch-save-route";

// Applications with their job, match, current content and tracking record.
// ?status=pending|approved|rejected|failed|withdrawn|all (the review queue;
// default all) or to_apply|applied|closed|tracked (the application tracker).
// Read-only: listing never changes any application.
export async function GET(req: NextRequest) {
  try {
    const filter = req.nextUrl.searchParams.get("status") ?? "all";
    if (isTrackerFilter(filter)) {
      return NextResponse.json(listTrackerItems(db, filter));
    }
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

// Saves a finished batch run as applications awaiting review.
export async function POST(req: NextRequest) {
  return handleBatchSave(req, "POST /api/applications");
}
