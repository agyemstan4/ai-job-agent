import type { DB } from "../repositories/shared.ts";

// Migration 007 (Phase 4b): the daily career agent. Additive only — three new
// tables, no change to any existing table.
//
//   daily_briefs        one brief per candidate per local day (UNIQUE), with
//                       its status (building / ready / failed), the run that
//                       built it and summary stats. The UNIQUE key is what
//                       makes a repeated or duplicate daily run a no-op.
//   daily_brief_items   the ranked opportunities in a brief: references to the
//                       existing job and match plus the ranking snapshot (tier,
//                       rank, why it is there, headline, reasons). Prepared /
//                       Applied always come live from applications.
//   opportunity_states  per candidate per job: when it first appeared in a
//                       brief ("new"), when it was opened ("seen") and when it
//                       was acted on ("reviewed"). seen_jobs is unchanged: it
//                       still means "already scored, don't score again".
//
// Notification tables are deliberately not part of this migration.

const SQL = `
  CREATE TABLE daily_briefs (
    id INTEGER PRIMARY KEY,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    candidate_profile_id INTEGER REFERENCES candidate_profiles(id),
    brief_date TEXT NOT NULL CHECK (brief_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    origin TEXT NOT NULL CHECK (origin IN ('scheduled_run', 'on_demand')),
    status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'failed')),
    run_id INTEGER REFERENCES pipeline_runs(id),
    stats_json TEXT CHECK (stats_json IS NULL OR json_valid(stats_json)),
    error TEXT,
    started_at TEXT NOT NULL,
    generated_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (candidate_id, brief_date)
  );
  CREATE INDEX ix_daily_briefs_recent ON daily_briefs(candidate_id, brief_date DESC);

  CREATE TABLE daily_brief_items (
    id INTEGER PRIMARY KEY,
    brief_id INTEGER NOT NULL REFERENCES daily_briefs(id) ON DELETE CASCADE,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    match_id INTEGER REFERENCES matches(id) ON DELETE SET NULL,
    rank INTEGER NOT NULL CHECK (rank >= 1),
    tier INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 5),
    why_here TEXT NOT NULL,
    headline TEXT NOT NULL,
    reasons_json TEXT CHECK (reasons_json IS NULL OR json_valid(reasons_json)),
    was_new INTEGER NOT NULL CHECK (was_new IN (0, 1)),
    UNIQUE (brief_id, job_id),
    UNIQUE (brief_id, rank)
  );
  CREATE INDEX ix_daily_brief_items_brief ON daily_brief_items(brief_id, rank);

  CREATE TABLE opportunity_states (
    candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    first_surfaced_at TEXT NOT NULL,
    first_brief_id INTEGER REFERENCES daily_briefs(id) ON DELETE SET NULL,
    seen_at TEXT,
    reviewed_at TEXT,
    PRIMARY KEY (candidate_id, job_id)
  );
`;

export const migration007DailyAgent = {
  version: 7,
  name: "daily_agent",
  checksumSource: SQL,
  up(db: DB) {
    db.exec(SQL);
  },
};
