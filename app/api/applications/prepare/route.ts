import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { defaultPrepareDeps, prepareApplication } from "@/lib/pipeline/prepare";
import { describeError } from "@/lib/log-safety";

// Server-side preparation of ONE scored match (Phase 3 checkpoint 3c):
// POST { matchId, questions? } → a tailored CV, CV file, cover letter (and
// answers) saved as an application awaiting review. Takes several minutes on
// CPU. It never approves, submits or emails anything; preparing the same job
// again returns the existing application.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { matchId?: unknown; questions?: unknown } | null;
    const { status, body: result } = await prepareApplication(db, body ?? {}, await defaultPrepareDeps());
    console.log("prepare:", { status, applicationId: result.applicationId ?? null, alreadyPrepared: result.alreadyPrepared ?? false, warnings: result.warnings?.length ?? 0 });
    return NextResponse.json(result, { status });
  } catch (error) {
    console.error("POST /api/applications/prepare error:", describeError(error));
    return NextResponse.json({ error: "Preparing the application failed" }, { status: 500 });
  }
}
