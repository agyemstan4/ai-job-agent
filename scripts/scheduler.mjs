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
// Replaces the earlier script, which sent a hard-coded CV summary without a
// profile: its scores were never saved, yet the jobs were marked as seen, so
// they were hidden from your real profile.

const BASE_URL = process.env.JOB_AGENT_URL ?? "http://127.0.0.1:3000";

async function main() {
  const startedAt = new Date();
  let response;
  try {
    response = await fetch(`${BASE_URL}/api/agent/daily-run`, { method: "POST" });
  } catch {
    console.error(`[${startedAt.toISOString()}] Job Agent is not running at ${BASE_URL} — start it, then try again.`);
    process.exit(2);
  }
  const body = await response.json().catch(() => ({}));
  const summary = {
    status: body.status ?? `http_${response.status}`,
    briefDate: body.briefDate ?? null,
    items: body.stats?.items ?? null,
    newInBrief: body.stats?.newInBrief ?? null,
    discovered: body.stats?.discovered ?? null,
    scored: body.stats?.scored ?? null,
    warnings: Array.isArray(body.stats?.warnings) ? body.stats.warnings.length : 0,
  };
  console.log(`[${startedAt.toISOString()}] daily agent:`, JSON.stringify(summary));
  process.exit(["completed", "already_ready", "already_running"].includes(summary.status) ? 0 : 1);
}

main();
