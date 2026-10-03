import { NextResponse } from "next/server";
import db from "@/lib/db";
import { saveBatchRequest } from "@/lib/pipeline/applications";

/**
 * Shared handler for saving a finished batch run as applications awaiting
 * review (POST /api/applications and its legacy alias POST
 * /api/batch-results). Results that cannot be saved (e.g. the job already
 * has an application) are reported in "warnings"; nothing is submitted.
 */
export async function handleBatchSave(req: Request, label: string) {
  try {
    const outcome = saveBatchRequest(db, await req.json().catch(() => null));
    if (!outcome) {
      return NextResponse.json({ error: "No results provided" }, { status: 400 });
    }
    for (const warning of outcome.warnings) console.warn(`${label}:`, warning);
    return NextResponse.json({
      saved: outcome.saved.filter((s) => s.applicationId !== null).length,
      applications: outcome.saved,
      ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
    });
  } catch (error) {
    console.error(`${label} error:`, error);
    return NextResponse.json({ error: "Failed to save results" }, { status: 500 });
  }
}
