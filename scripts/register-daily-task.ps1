# Registers the Job Agent daily brief task (Phase 4b) in Windows Task Scheduler:
# every day at 06:30 it runs scripts/scheduler.mjs, which asks the running Job
# Agent server to prepare today's brief. Run this yourself, once, when you are
# ready — it changes your Windows scheduled tasks. Remove it again with:
#   Unregister-ScheduledTask -TaskName "Job Agent daily brief" -Confirm:$false
#
# The Job Agent server must be running at 06:30 for the brief to be prepared;
# if it isn't, the task logs that and does nothing else.

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$repo\scripts\scheduler.mjs`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At "06:30"
# Start when possible if the computer was asleep or off at 06:30; never run twice at once.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3)
Register-ScheduledTask -TaskName "Job Agent daily brief" -Action $action -Trigger $trigger -Settings $settings `
  -Description "Asks the running Job Agent to prepare today's job brief. Never applies for jobs." | Out-Null
Write-Host "Registered 'Job Agent daily brief' for 06:30 every day."
