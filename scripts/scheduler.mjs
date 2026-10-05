// The daily career agent trigger (Phase 4b).
//
// Run once a day (06:30, Windows Task Scheduler — see
// scripts/register-daily-task.ps1) while the Job Agent server is running.
// It asks the server to run the daily agent and exits: no long-running
// process. The server uses your stored CV profile and saved search
// preferences, finds and matches new jobs with the existing pipeline and
// saves today's brief for the Today page. It never prepares, approves or
// submits applications, and sends no email or notifications.
//
// Repeated or overlapping runs are safe: a second run the same day does
// nothing ("already_ready"), and one started while another is in progress
// stops at once ("already_running").
//
// A daily run can legitimately take far longer than the 5 minutes after which
// Node's built-in fetch gives up waiting for response headers, so this uses
// the same long-timeout undici dispatcher as the matching route. The outcome is
// reported accurately: "not_running" (server unreachable), "timed_out" (this
// script stopped waiting; the server may still be working) or "failed" (the
// server reported an error) are different results.

import { pathToFileURL } from "node:url";
import { Agent, fetch as undiciFetch } from "undici";

const BASE_URL = process.env.JOB_AGENT_URL ?? "http://127.0.0.1:3000";

// Shorter than the 3-hour limit of the Windows task, longer than any real run.
export const RUN_TIMEOUT_MS = 170 * 60_000;

const OK_STATUSES = ["completed", "already_ready", "already_running"];
const TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"]);

/** What kind of failure a fetch error is: the server is down, or we ran out of patience. */
export function classifyFetchError(error) {
  const code = error?.cause?.code ?? error?.code;
  if (TIMEOUT_CODES.has(code) || error?.name === "TimeoutError" || error?.name === "AbortError") return "timed_out";
  return "not_running";
}

/** Process exit code for a final status. */
export function exitCodeFor(status) {
  if (OK_STATUSES.includes(status)) return 0;
  if (status === "not_running") return 2;
  if (status === "timed_out") return 3;
  return 1;
}

/**
 * Asks the server to run the daily agent and returns { status, exitCode, outcome }.
 * `fetchImpl` and `dispatcher` are injectable for tests.
 */
export async function triggerDailyRun({ baseUrl = BASE_URL, fetchImpl = undiciFetch, dispatcher, now = () => new Date() } = {}) {
  const startedAt = now();
  const longTimeout = dispatcher ?? new Agent({ headersTimeout: RUN_TIMEOUT_MS, bodyTimeout: RUN_TIMEOUT_MS });
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/agent/daily-run`, { method: "POST", dispatcher: longTimeout });
  } catch (error) {
    if (classifyFetchError(error) === "timed_out") {
      // We stopped waiting, which is not the same as the run failing: check the server.
      const todays = await fetchImpl(`${baseUrl}/api/agent/brief`, { dispatcher: longTimeout, signal: AbortSignal.timeout(15_000) })
        .then((r) => r.json())
        .catch(() => null);
      if (todays?.status === "ready") {
        return { startedAt, status: "completed", exitCode: 0, outcome: { status: "completed", note: "the server finished after this script stopped waiting; today's brief is ready" } };
      }
      return {
        startedAt,
        status: "timed_out",
        exitCode: exitCodeFor("timed_out"),
        outcome: { status: "timed_out", note: `no answer after ${Math.round(RUN_TIMEOUT_MS / 60_000)} minutes; the server may still be working — check the Today page` },
      };
    }
    return { startedAt, status: "not_running", exitCode: exitCodeFor("not_running"), outcome: { status: "not_running", note: `Job Agent is not running at ${baseUrl} — start it (npm start), then try again.` } };
  }
  const body = await response.json().catch(() => ({}));
  const status = body.status ?? `http_${response.status}`;
  const warnings = Array.isArray(body.stats?.warnings) ? body.stats.warnings : [];
  return {
    startedAt,
    status,
    exitCode: exitCodeFor(status),
    outcome: {
      status,
      briefDate: body.briefDate ?? null,
      items: body.stats?.items ?? null,
      newInBrief: body.stats?.newInBrief ?? null,
      discovered: body.stats?.discovered ?? null,
      scored: body.stats?.scored ?? null,
      searchedWith: body.stats?.searchedWith ?? null,
      partialSources: body.stats?.partialSources ?? [],
      warnings,
      ...(body.error ? { error: String(body.error).slice(0, 200) } : {}),
    },
  };
}

async function main() {
  const result = await triggerDailyRun();
  const line = `[${result.startedAt.toISOString()}] daily agent:`;
  (result.exitCode === 0 ? console.log : console.error)(line, JSON.stringify(result.outcome));
  process.exit(result.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
