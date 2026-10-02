import { NextRequest, NextResponse } from "next/server";
import {
  getBatchResults,
  getBatchRuns,
  createBatchRun,
  saveBatchResult,
} from "@/lib/db";

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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { results } = body;

    if (!Array.isArray(results) || results.length === 0) {
      return NextResponse.json({ error: "No results provided" }, { status: 400 });
    }

    const batchRunId = createBatchRun(results.length);

    for (const result of results) {
      const cvBuffer = result.cvBase64
        ? Buffer.from(result.cvBase64, "base64")
        : undefined;

      saveBatchResult({
        batchRunId,
        job: result.job,
        coverLetter: result.coverLetter,
        cvBuffer,
        cvFilename: result.cvFilename,
        success: result.success,
        error: result.error,
      });
    }

    return NextResponse.json({ batchRunId, saved: results.length });
  } catch (error) {
    console.error("POST /api/batch-results error:", error);
    return NextResponse.json({ error: "Failed to save results" }, { status: 500 });
  }
}