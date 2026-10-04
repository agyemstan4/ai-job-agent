import { NextResponse } from "next/server";
import db from "@/lib/db";
import { defaultPrepareDeps } from "@/lib/pipeline/prepare";
import { getPreparationStatus, kickQueue } from "@/lib/pipeline/preparation-queue";
import { describeError } from "@/lib/log-safety";

// Preparation queue status (Phase 3 checkpoint 3d): preparing, queued,
// recently ready or failed jobs, with each job's stages. Read only, apart from
// starting idle workers for queued jobs (which also resumes after a restart).
export async function GET() {
  try {
    kickQueue(db, await defaultPrepareDeps());
    return NextResponse.json(getPreparationStatus(db));
  } catch (error) {
    console.error("GET /api/applications/preparation error:", describeError(error));
    return NextResponse.json({ error: "Failed to load the preparation status" }, { status: 500 });
  }
}
