import { NextRequest, NextResponse } from "next/server";
import { getBatchResults, getBatchRuns } from "@/lib/db";
import { handleBatchSave } from "@/lib/batch-save-route";

// Legacy review queue. batch_runs / batch_results are no longer written; they
// keep the rows saved before the applications model took over (each of which
// also exists as an application: imported by migration 003, or saved
// alongside one during the transition). Read-only.
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status") ?? undefined;
    const view = searchParams.get("view");

    if (view === "runs") {
      return NextResponse.json(getBatchRuns());
    }

    return NextResponse.json(getBatchResults(status));
  } catch (error) {
    console.error("GET /api/batch-results error:", error);
    return NextResponse.json({ error: "Failed to fetch results" }, { status: 500 });
  }
}

// Kept as an alias of POST /api/applications for older clients; it saves
// applications only (no legacy rows).
export async function POST(req: NextRequest) {
  return handleBatchSave(req, "POST /api/batch-results");
}
