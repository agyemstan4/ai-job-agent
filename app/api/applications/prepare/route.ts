import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { defaultPrepareDeps } from "@/lib/pipeline/prepare";
import { enqueuePreparation, getPreparationStatus, kickQueue } from "@/lib/pipeline/preparation-queue";
import { describeError } from "@/lib/log-safety";

// Queue application preparation (Phase 3 checkpoint 3d). Returns at once:
//   POST { matchId, questions?, retry? }       → one job
//   POST { matchIds: [...] }                   → several jobs (batch)
// Preparation then runs on the server in bounded workers (it continues if the
// page is closed); poll GET /api/applications/preparation for progress.
// Idempotent: a job already queued, preparing or prepared is not prepared
// again. Never approves, submits or emails anything.
export async function POST(req: NextRequest) {
  try {
    const body = ((await req.json().catch(() => null)) ?? {}) as { matchId?: unknown; matchIds?: unknown; questions?: unknown; retry?: unknown };
    const deps = await defaultPrepareDeps();

    if (Array.isArray(body.matchIds)) {
      if (body.matchIds.length === 0 || body.matchIds.length > 25) {
        return NextResponse.json({ error: "Send 1–25 matchIds" }, { status: 400 });
      }
      const results = [...new Set(body.matchIds)].map((matchId) => enqueuePreparation(db, { matchId, retry: body.retry }));
      kickQueue(db, deps);
      console.log("prepare (batch):", { requested: results.length, queued: results.filter((r) => r.status === 202).length, existing: results.filter((r) => r.status === 200).length });
      return NextResponse.json({ results, preparation: getPreparationStatus(db) }, { status: 202 });
    }

    const result = enqueuePreparation(db, body);
    kickQueue(db, deps);
    console.log("prepare:", { status: result.status, applicationId: result.applicationId ?? null, state: result.state ?? null });
    return NextResponse.json(result, { status: result.status });
  } catch (error) {
    console.error("POST /api/applications/prepare error:", describeError(error));
    return NextResponse.json({ error: "Queueing the preparation failed" }, { status: 500 });
  }
}
