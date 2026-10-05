# Registers the Job Agent daily brief in Windows Task Scheduler (Phase 4b).
# Run this yourself, once, when you are ready — it changes your Windows
# scheduled tasks. It registers two tasks:
#
#   "Job Agent server"       at log on: runs the production server (npm start,
#                            http://127.0.0.1:3000) from the last `npm run build`.
#   "Job Agent daily brief"  every day at 06:30: runs scripts/scheduler.mjs, which
#                            asks the running server to prepare today's brief.
#
# Build first (the server task refuses to start an old or missing build):
#   npm run build
# Remove both again with:
#   Unregister-ScheduledTask -TaskName "Job Agent daily brief" -Confirm:$false
#   Unregister-ScheduledTask -TaskName "Job Agent server" -Confirm:$false
#
# The server must be running at 06:30 for the brief to be prepared; if it is
# not, the daily task logs "not_running" and does nothing else. The dev server
# (npm run dev) is for development only and is not used here.

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path "$repo\.next\BUILD_ID")) {
  throw "No production build found. Run 'npm run build' in $repo first."
}
$node = (Get-Command node).Source
$npm = (Get-Command npm.cmd).Source

$serverAction = New-ScheduledTaskAction -Execute $npm -Argument "start" -WorkingDirectory $repo
$serverTrigger = New-ScheduledTaskTrigger -AtLogOn
# Keep the server running; never start a second copy.
$serverSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName "Job Agent server" -Action $serverAction -Trigger $serverTrigger -Settings $serverSettings `
  -Description "Runs the Job Agent production server (npm start) on 127.0.0.1:3000." | Out-Null

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$repo\scripts\scheduler.mjs`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At "06:30"
# Start when possible if the computer was asleep or off at 06:30; never run twice at once.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3)
Register-ScheduledTask -TaskName "Job Agent daily brief" -Action $action -Trigger $trigger -Settings $settings `
  -Description "Asks the running Job Agent to prepare today's job brief. Never applies for jobs." | Out-Null
Write-Host "Registered 'Job Agent server' (at log on, npm start) and 'Job Agent daily brief' (06:30 every day)."
