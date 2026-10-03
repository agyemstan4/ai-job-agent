# AI Job Agent

A local, single-user assistant for finding and preparing job applications. It
analyses your CV, finds suitable jobs, prepares a tailored CV and cover letter
for each one, and tracks every application — while **you** stay in control of
every decision that matters.

> **Safety rule: the Job Agent never submits an application for you.**
> It prepares drafts. You review and explicitly approve them, you submit the
> application yourself on the employer's website, and only then do you mark it
> as applied. Nothing is ever sent to an employer automatically.

---

## Features

- **CV analysis** — upload a PDF CV; a local AI model extracts a structured CV
  and an analysis (skills, strengths, experience level). Re-uploading the same
  CV with the same roles reuses the stored analysis instead of re-running it.
- **Job discovery** — searches Adzuna and (optionally) Reed, records every
  listing, and merges duplicates across sources into one job.
- **Matching** — filters jobs by role keywords, your skills and seniority, then
  scores the best candidates with the local model. Every outcome (scored,
  filtered out, failed) is recorded per CV profile version.
- **Application preparation** — for selected jobs: a tailored CV (PDF, or DOCX
  if PDF conversion is unavailable), a cover letter, and answers to pasted
  application questions.
- **Review and approval** (`/review`) — read and edit each prepared
  application, then approve or reject it. Approval confirms the exact content
  you reviewed; any later change withdraws the approval automatically.
- **Manual application tracking** (`/applications`) — "Apply Now" opens the
  employer's site (and does nothing else). After you have applied yourself,
  "Mark as applied" records when, how (manual) and any reference. Later you
  can record acknowledged, interviewing, offer, unsuccessful or withdrawn.
- **Audit trail** — every status change, approval, edit and reference change is
  an append-only event, recorded with who made it.

## Architecture

```
app/                       Next.js App Router (UI pages + API routes)
  page.tsx                 CV upload, job search, matching, batch preparation
  review/page.tsx          review queue: edit, approve, reject
  applications/page.tsx    tracker: Apply Now, Mark as applied, status updates
  api/                     route handlers (thin: validate, call lib, respond)
lib/
  database.ts, db.ts       opens SQLite and applies pending migrations
  migrate.ts, migrations/  versioned, additive schema migrations (001–006)
  repositories/            all database access: candidates, jobs, matches,
                           runs, applications (state machine, approval gate,
                           manual submission), review read model
  pipeline/                workflows built on the repositories: CV, discovery,
                           matching, applications (batch save), review actions
  generation/versions.ts   model and prompt versions for preparation
  tracker-client.ts        framework-free client logic for /applications
  ollama-json.ts           safe parsing of model JSON output
  email-copies.ts          optional email copies (off by default)
  log-safety.ts            redacts URLs/keys from logged errors
tests/                     node:test suites (scratch databases only)
scripts/scheduler.mjs      optional command-line discovery + matching run
```

The approval and submission rules are enforced twice: in the repository code
and by database triggers (migrations 002, 004, 005, 006), so no code path can
approve or submit on the user's behalf.

## Tech stack

- **Next.js 16** (App Router, Turbopack), **React 19**, **TypeScript**, Tailwind CSS
- **SQLite** via `better-sqlite3` (WAL mode, foreign keys on)
- **Ollama** running `llama3.2:3b` locally (CPU is fine, but slow)
- **LibreOffice** (headless) to convert the tailored CV to PDF
- **Adzuna** and **Reed** job search APIs; **Resend** only if email copies are enabled
- Tests: Node's built-in `node:test`

## Local setup

Requirements:

1. **Node.js** (the project is developed on Node 24).
2. **Ollama** with the model pulled: `ollama pull llama3.2:3b`, and running (`ollama serve`).
3. **LibreOffice** installed at `C:\Program Files\LibreOffice` (otherwise CVs are delivered as DOCX).
4. API keys for Adzuna (required) and Reed (optional), in `.env.local`.

```bash
npm install
npm run dev          # http://127.0.0.1:3000 (bound to localhost only)
```

On CPU, expect roughly: CV analysis ~10 minutes, matching ~5–6 minutes for
10 jobs, and ~5–7 minutes per prepared application. Keep long-running work in
a terminal you control.

## Environment variables

Set in `.env.local` (never commit it; `.env*` is git-ignored).

| Variable | Required | Purpose |
|---|---|---|
| `ADZUNA_APP_ID` | yes | Adzuna API application ID |
| `ADZUNA_APP_KEY` | yes | Adzuna API key |
| `REED_API_KEY` | no | Reed API key; Reed is skipped without it |
| `EMAIL_COPIES_ENABLED` | no | `true` to email yourself copies of generated CVs and cover letters. **Off by default.** |
| `RESEND_API_KEY` | only with email copies | Resend API key; not needed while email copies are off |
| `EMAIL_COPIES_TO` | no | Recipient for email copies (defaults to the owner's address) |
| `JOB_AGENT_DB_PATH` | no | Use a different database file (e.g. a scratch copy). Default: `.data/jobs.db` |

## Database and migrations

- The database lives in `.data/jobs.db` (git-ignored, with its `-wal`/`-shm`
  files and `.data/backups/`).
- Migrations in `lib/migrations/` are **additive** and are applied
  automatically, in order, whenever the app opens the database. Before
  migrating an existing database the runner writes a backup to
  `.data/backups/jobs.vX-to-vY.<timestamp>.db`. There are no down-migrations:
  the backup is the rollback.
- Current schema: **v6** (001 baseline, 002 core schema, 003 legacy import,
  004 approval-gate hardening, 005 manual-submission guard, 006 withdrawn
  asset lock).
- To back up by hand, use SQLite's `VACUUM INTO` (it includes data still in the
  WAL file); never copy `jobs.db` on its own while a `-wal` file holds data.
- Opening the database starts migrations, so test against a copy by setting
  `JOB_AGENT_DB_PATH` before touching a live database with new code.

## How it works

### Job discovery
`POST /api/jobs` queries Adzuna and Reed for your role plus a set of related
search terms, records each listing (with its raw data and description
snippet), and deduplicates listings into canonical jobs: the same source ID,
or the same normalised company and title across sources. A job counts as
already processed if it was scored or filtered out for your current profile,
or if any of its listings is in the original `seen_jobs` table.

### Matching
`POST /api/match` pre-filters jobs (developer role keywords, at least one of
your skills, no senior title), scores the top 10 with the local model
(blending the model's score with a breakdown-based score), and records each
outcome. Scored jobs are also marked as seen so they don't reappear.

### CV and application preparation
For each selected job the page calls `/api/tailor-cv`, `/api/generate-cv-docx`
and `/api/cover-letter`, then saves the result with `POST /api/applications`
as an application ready for review, with versioned assets. Application
question answers come from `/api/application-questions`.

### Review and approval
`/review` lists applications awaiting review. Approving sends the hash of the
exact content shown; if anything changed since, approval is refused. Editing
an approved application withdraws the approval until you approve again.

### Manual application tracking
`/applications` groups applications into Ready to apply, Applied / in
progress, Closed and All tracked. "Apply Now" is a plain link to the
employer's site. "Mark as applied" requires an explicit confirmation and
records the time (earlier is allowed, never in the future or before the
approval), method (manual), optional reference and note, and whether you
changed anything on the employer's site. Submission is permanent: a mistake is
corrected by moving the application to Withdrawn with a note. After
submission the application's content is locked.

## Testing

```bash
npm test             # all node:test suites (scratch databases in the OS temp dir)
npx tsc --noEmit     # type check
npm run lint         # ESLint (the codebase has a known baseline of existing warnings/errors)
```

Build without touching your real database (route modules open the database
when loaded):

```bash
JOB_AGENT_DB_PATH=/path/to/scratch/jobs.db npm run build
```

Tests never open `.data/jobs.db`, and must not import route modules for the
same reason.

## Privacy and safety

- The app binds to `127.0.0.1` and has no authentication: keep it local.
- Your CV, contact details and analyses are stored unencrypted in
  `.data/jobs.db`. `.data/` and `.env*` are git-ignored.
- Server logs contain counts, IDs, scores, timings and error categories —
  not CV text, names, contact details, application content or API keys.
- External calls: Adzuna and Reed (search terms and location), Ollama
  (local), and Resend only if you enable email copies.
- **Human approval is mandatory**: only you can approve an application, mark
  it as applied, or change its status afterwards — enforced in code and in the
  database.
