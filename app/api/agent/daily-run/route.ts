import { NextRequest, NextResponse } from "next/server";
import db from "@/lib/db";
import { POST as discoverJobs } from "@/app/api/jobs/route";
import { POST as matchJobs } from "@/app/api/match/route";
import { runDailyAgent } from "@/lib/pipeline/daily-run";
import type { DiscoveredJob } from "@/lib/pipeline/daily-run";
import { DEFAULT_HOME_ROLE } from "@/lib/preferences-client";
import { describeError } from "@/lib/log-safety";
import { DISCOVERY_REPORT_HEADER, readDiscoveryReport } from "@/lib/pipeline/source-search";

// The daily career agent (Phase 4b) — POST, from this machine only (the
// 06:30 scheduled task runs scripts/scheduler.mjs, which calls this). It
// reuses the existing discovery and matching handlers in-process, with the
// candidate's stored CV profile and saved preferences; it never prepares,
// approves or submits anything and sends no email or notifications.
// Repeated or overlapping calls are safe (see lib/pipeline/daily-run.ts).

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** The same job fields the home page passes from discovery to matching. */
function forMatching(job: Record<string, unknown>): DiscoveredJob {
  return {
    id: job.id,
    jobId: job.jobId as number | undefined,
    sourceIds: job.sourceIds,
    source: job.source,
    title: job.title,
    company: job.company,
    location: job.location,
    url: job.url,
    description: typeof job.description === "string" ? job.description.slice(0, 500) : job.description,
    salaryMin: job.salary_min,
    salaryMax: job.salary_max,
    contractType: job.contract_type,
    created: job.created,
  };
}

export async function POST(req: NextRequest) {
  if (!LOCAL.test(req.headers.get("host") ?? "")) {
    return NextResponse.json({ error: "The daily run can only be started from this computer." }, { status: 403 });
  }
  try {
    const result = await runDailyAgent(db, {
      discover: async ({ candidateProfileId, usingPreferences }) => {
        const res = await discoverJobs(
          new Request("http://localhost/api/jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // Saved preferences decide the search (requirePreferences: never silently fall
            // back to the defaults); with none saved, the home page's default search.
            body: JSON.stringify({
              role: usingPreferences ? undefined : DEFAULT_HOME_ROLE,
              location: "London",
              candidateProfileId,
              triggeredBy: "scheduler",
              requirePreferences: usingPreferences,
            }),
          })
        );
        const body = (await res.json().catch(() => null)) as unknown;
        if (!res.ok || !Array.isArray(body)) return { ok: false, error: `discovery HTTP ${res.status}` };
        return { ok: true, jobs: (body as Record<string, unknown>[]).map(forMatching), report: readDiscoveryReport(res.headers.get(DISCOVERY_REPORT_HEADER)) };
      },
      match: async ({ candidateProfileId, analysis, jobs }) => {
        const res = await matchJobs(
          new Request("http://localhost/api/match", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ candidate: analysis, jobs, candidateProfileId, triggeredBy: "scheduler" }),
          })
        );
        const body = (await res.json().catch(() => null)) as { matches?: unknown[] } | null;
        if (!res.ok || !Array.isArray(body?.matches)) return { ok: false, error: `matching HTTP ${res.status}` };
        return { ok: true, scored: body.matches.length };
      },
    });
    const status = result.status === "failed" ? 500 : result.status === "no_profile" ? 409 : 200;
    return NextResponse.json(result, { status });
  } catch (error) {
    console.error("POST /api/agent/daily-run error:", describeError(error));
    return NextResponse.json({ error: "The daily run failed" }, { status: 500 });
  }
}
