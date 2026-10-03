import { NextRequest, NextResponse } from "next/server";
import db, {
  getBatchResults,
  getBatchRuns,
  createBatchRun,
  saveBatchResult,
} from "@/lib/db";
import { saveBatchApplications } from "@/lib/pipeline/applications";
import type { BatchResultInput } from "@/lib/pipeline/applications";

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
    const { results, candidateProfileId } = body;

    if (!Array.isArray(results) || results.length === 0) {
      return NextResponse.json({ error: "No results provided" }, { status: 400 });
    }

    // Legacy review queue (still written until the new model is verified).
    const batchRunId = createBatchRun(results.length);
    const prepared: BatchResultInput[] = [];

    for (const result of results) {
      const cvBuffer = result.cvBase64
        ? Buffer.from(result.cvBase64, "base64")
        : undefined;

      const batchResultId = saveBatchResult({
        batchRunId,
        job: result.job,
        coverLetter: result.coverLetter,
        cvBuffer,
        cvFilename: result.cvFilename,
        success: result.success,
        error: result.error,
      });
      prepared.push({
        batchResultId,
        jobId: result.job?.jobId,
        matchId: result.job?.matchId,
        success: Boolean(result.success),
        error: result.error ?? null,
        coverLetter: result.coverLetter ?? null,
        cvFile: cvBuffer ?? null,
        cvFilename: result.cvFilename ?? null,
        tailoredCv: result.tailoredCV,
      });
    }

    // Applications for review in the new model. Never fatal: the legacy
    // rows above are already saved.
    let applications: ReturnType<typeof saveBatchApplications>["saved"] = [];
    const persistenceWarnings: string[] = [];
    try {
      const outcome = saveBatchApplications(db, { candidateProfileId, results: prepared });
      applications = outcome.saved;
      persistenceWarnings.push(...outcome.warnings);
    } catch (error) {
      console.error("Saving applications failed:", error);
      persistenceWarnings.push(
        `Applications were not saved: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    for (const warning of persistenceWarnings) console.warn("Batch save:", warning);

    return NextResponse.json({
      batchRunId,
      saved: results.length,
      applications,
      ...(persistenceWarnings.length > 0 ? { persistenceWarnings } : {}),
    });
  } catch (error) {
    console.error("POST /api/batch-results error:", error);
    return NextResponse.json({ error: "Failed to save results" }, { status: 500 });
  }
}