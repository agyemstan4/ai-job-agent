import type { DB } from "../repositories/shared.ts";

// Additive only: creates the new persistence model alongside the legacy
// batch_runs / batch_results / seen_jobs tables, which are not touched.
const SQL = `
  -- ── Candidate & CV ──────────────────────────────────────────────────────

  CREATE TABLE candidates (
    id INTEGER PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    location TEXT,
    portfolio_url TEXT,
    preferences_json TEXT CHECK (preferences_json IS NULL OR json_valid(preferences_json)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE cv_documents (
    id INTEGER PRIMARY KEY,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    file_blob BLOB NOT NULL,
    extracted_text TEXT,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (candidate_id, sha256)
  );
  CREATE INDEX ix_cv_documents_candidate ON cv_documents(candidate_id, uploaded_at);

  CREATE TRIGGER trg_cv_documents_immutable
  BEFORE UPDATE ON cv_documents
  BEGIN
    SELECT RAISE(ABORT, 'IMMUTABLE: cv_documents rows cannot be modified');
  END;

  CREATE TABLE candidate_profiles (
    id INTEGER PRIMARY KEY,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    cv_document_id INTEGER REFERENCES cv_documents(id) ON DELETE SET NULL,
    parent_profile_id INTEGER REFERENCES candidate_profiles(id),
    version INTEGER NOT NULL CHECK (version >= 1),
    is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
    origin TEXT NOT NULL CHECK (origin IN ('ai_extraction', 'user_edit', 'legacy_import')),
    analysis_json TEXT NOT NULL CHECK (json_valid(analysis_json)),
    structured_cv_json TEXT NOT NULL CHECK (json_valid(structured_cv_json)),
    experience_level TEXT,
    model TEXT,
    prompt_version TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (candidate_id, version)
  );
  CREATE UNIQUE INDEX ux_candidate_profiles_one_current
    ON candidate_profiles(candidate_id) WHERE is_current = 1;

  -- Profile versions are immutable; only is_current (and cv_document_id via
  -- ON DELETE SET NULL) may change.
  CREATE TRIGGER trg_candidate_profiles_immutable
  BEFORE UPDATE ON candidate_profiles
  WHEN NEW.id IS NOT OLD.id
    OR NEW.candidate_id IS NOT OLD.candidate_id
    OR NEW.parent_profile_id IS NOT OLD.parent_profile_id
    OR NEW.version IS NOT OLD.version
    OR NEW.origin IS NOT OLD.origin
    OR NEW.analysis_json IS NOT OLD.analysis_json
    OR NEW.structured_cv_json IS NOT OLD.structured_cv_json
    OR NEW.experience_level IS NOT OLD.experience_level
    OR NEW.model IS NOT OLD.model
    OR NEW.prompt_version IS NOT OLD.prompt_version
    OR NEW.created_at IS NOT OLD.created_at
  BEGIN
    SELECT RAISE(ABORT, 'IMMUTABLE: candidate profile versions cannot be modified; create a new version');
  END;

  -- ── Sources, runs, jobs ─────────────────────────────────────────────────

  CREATE TABLE job_sources (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('api', 'manual', 'legacy')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
  );

  INSERT INTO job_sources (id, display_name, kind) VALUES
    ('adzuna', 'Adzuna', 'api'),
    ('reed', 'Reed', 'api'),
    ('legacy', 'Legacy batch import', 'legacy');

  CREATE TABLE pipeline_runs (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('discovery', 'matching', 'preparation', 'full', 'legacy_batch')),
    triggered_by TEXT NOT NULL CHECK (triggered_by IN ('ui', 'scheduler', 'migration')),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
    candidate_profile_id INTEGER REFERENCES candidate_profiles(id),
    params_json TEXT CHECK (params_json IS NULL OR json_valid(params_json)),
    stats_json TEXT CHECK (stats_json IS NULL OR json_valid(stats_json)),
    error TEXT,
    legacy_batch_run_id INTEGER UNIQUE,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE UNIQUE INDEX ux_pipeline_runs_one_running_per_kind
    ON pipeline_runs(kind) WHERE status = 'running';

  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    fingerprint_version INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    location TEXT,
    salary_min REAL,
    salary_max REAL,
    salary_is_predicted INTEGER CHECK (salary_is_predicted IN (0, 1)),
    contract_type TEXT,
    contract_time TEXT,
    posted_at TEXT,
    expires_at TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'closed')),
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX ix_jobs_status_last_seen ON jobs(status, last_seen_at);

  CREATE TABLE job_listings (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES job_sources(id),
    external_id TEXT NOT NULL,
    url TEXT,
    title TEXT,
    company TEXT,
    location TEXT,
    salary_min REAL,
    salary_max REAL,
    posted_at TEXT,
    raw_json TEXT CHECK (raw_json IS NULL OR json_valid(raw_json)),
    first_seen_run_id INTEGER REFERENCES pipeline_runs(id),
    last_seen_run_id INTEGER REFERENCES pipeline_runs(id),
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (source_id, external_id)
  );
  CREATE INDEX ix_job_listings_job ON job_listings(job_id);

  CREATE TABLE job_descriptions (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    job_listing_id INTEGER REFERENCES job_listings(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('snippet', 'full')),
    content TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    char_count INTEGER NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (job_id, content_sha256)
  );
  CREATE INDEX ix_job_descriptions_best ON job_descriptions(job_id, kind, char_count DESC);

  -- ── Matches ─────────────────────────────────────────────────────────────

  CREATE TABLE matches (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    candidate_profile_id INTEGER REFERENCES candidate_profiles(id),
    run_id INTEGER REFERENCES pipeline_runs(id),
    job_description_id INTEGER REFERENCES job_descriptions(id),
    outcome TEXT NOT NULL CHECK (outcome IN ('scored', 'filtered_out', 'failed', 'legacy')),
    filter_reason TEXT,
    score INTEGER CHECK (score IS NULL OR score BETWEEN 0 AND 100),
    model_score INTEGER CHECK (model_score IS NULL OR model_score BETWEEN 0 AND 100),
    breakdown_score INTEGER CHECK (breakdown_score IS NULL OR breakdown_score BETWEEN 0 AND 100),
    score_source TEXT CHECK (score_source IS NULL OR score_source IN ('blended', 'breakdown', 'legacy')),
    breakdown_json TEXT CHECK (breakdown_json IS NULL OR json_valid(breakdown_json)),
    reason TEXT,
    strengths_json TEXT CHECK (strengths_json IS NULL OR json_valid(strengths_json)),
    missing_skills_json TEXT CHECK (missing_skills_json IS NULL OR json_valid(missing_skills_json)),
    model TEXT,
    prompt_version TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (job_id, candidate_profile_id),
    CHECK ((outcome = 'legacy') = (candidate_profile_id IS NULL))
  );
  CREATE INDEX ix_matches_profile_rank ON matches(candidate_profile_id, outcome, score DESC);

  -- ── Applications ────────────────────────────────────────────────────────

  CREATE TABLE applications (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
    match_id INTEGER REFERENCES matches(id) ON DELETE SET NULL,
    candidate_profile_id INTEGER REFERENCES candidate_profiles(id),
    run_id INTEGER REFERENCES pipeline_runs(id),
    status TEXT NOT NULL CHECK (status IN (
      'preparing', 'preparation_failed', 'ready_for_review', 'approved', 'rejected',
      'submitting', 'submitted', 'submission_failed',
      'acknowledged', 'interviewing', 'offer', 'unsuccessful', 'withdrawn')),
    approved_at TEXT,
    approved_assets_sha256 TEXT,
    submission_method TEXT CHECK (submission_method IS NULL OR submission_method IN ('manual', 'email', 'api')),
    submitted_at TEXT,
    submission_reference TEXT,
    notes TEXT,
    last_error TEXT,
    legacy_batch_result_id INTEGER UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (status NOT IN ('approved', 'submitting', 'submitted', 'submission_failed')
           OR (approved_at IS NOT NULL AND approved_assets_sha256 IS NOT NULL))
  );
  -- One active application per job (legacy imports are exempt so two old
  -- batches holding the same job can both be preserved; the repository still
  -- counts them when creating new applications).
  CREATE UNIQUE INDEX ux_applications_one_active_per_job
    ON applications(job_id)
    WHERE legacy_batch_result_id IS NULL
      AND status NOT IN ('rejected', 'withdrawn', 'unsuccessful', 'preparation_failed');
  CREATE INDEX ix_applications_status ON applications(status, updated_at);

  CREATE TABLE application_events (
    id INTEGER PRIMARY KEY,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (event_type IN (
      'status_change', 'asset_generated', 'asset_edited', 'note',
      'notification_sent', 'submission_attempt', 'external_update', 'migrated')),
    from_status TEXT,
    to_status TEXT,
    actor TEXT NOT NULL CHECK (actor IN ('user', 'system', 'scheduler', 'migration')),
    detail TEXT,
    payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- Only a human (or the one-off legacy import) can record an approval.
    CHECK (to_status IS NOT 'approved' OR actor IN ('user', 'migration'))
  );
  CREATE INDEX ix_application_events_app_time ON application_events(application_id, created_at);

  CREATE TRIGGER trg_application_events_no_update
  BEFORE UPDATE ON application_events
  BEGIN
    SELECT RAISE(ABORT, 'APPEND_ONLY: application events cannot be modified');
  END;

  CREATE TRIGGER trg_application_events_no_delete
  BEFORE DELETE ON application_events
  BEGIN
    SELECT RAISE(ABORT, 'APPEND_ONLY: application events cannot be deleted');
  END;

  CREATE TABLE application_assets (
    id INTEGER PRIMARY KEY,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('tailored_cv_data', 'tailored_cv_file', 'cover_letter', 'question_answers')),
    version INTEGER NOT NULL CHECK (version >= 1),
    is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
    origin TEXT NOT NULL CHECK (origin IN ('generated', 'user_edit', 'legacy_import')),
    parent_asset_id INTEGER REFERENCES application_assets(id),
    content_text TEXT,
    content_json TEXT CHECK (content_json IS NULL OR json_valid(content_json)),
    file_blob BLOB,
    filename TEXT,
    mime_type TEXT,
    sha256 TEXT NOT NULL,
    model TEXT,
    prompt_version TEXT,
    source_job_description_id INTEGER REFERENCES job_descriptions(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (content_text IS NOT NULL OR content_json IS NOT NULL OR file_blob IS NOT NULL),
    UNIQUE (application_id, kind, version)
  );
  CREATE UNIQUE INDEX ux_application_assets_one_current
    ON application_assets(application_id, kind) WHERE is_current = 1;

  CREATE TRIGGER trg_application_assets_immutable
  BEFORE UPDATE ON application_assets
  WHEN NEW.id IS NOT OLD.id
    OR NEW.application_id IS NOT OLD.application_id
    OR NEW.kind IS NOT OLD.kind
    OR NEW.version IS NOT OLD.version
    OR NEW.origin IS NOT OLD.origin
    OR NEW.content_text IS NOT OLD.content_text
    OR NEW.content_json IS NOT OLD.content_json
    OR NEW.file_blob IS NOT OLD.file_blob
    OR NEW.filename IS NOT OLD.filename
    OR NEW.mime_type IS NOT OLD.mime_type
    OR NEW.sha256 IS NOT OLD.sha256
  BEGIN
    SELECT RAISE(ABORT, 'IMMUTABLE: application assets cannot be modified; add a new version');
  END;

  -- ── Human-approval gate ─────────────────────────────────────────────────
  --
  -- Enforced in the database so no code path (route, script, worker) can
  -- reach submission without an explicit, current, human approval.

  -- New applications cannot start approved or in submission. Only the
  -- one-off legacy import may carry over an old approve/reject decision.
  CREATE TRIGGER trg_applications_insert_guard
  BEFORE INSERT ON applications
  WHEN NEW.status NOT IN ('preparing', 'preparation_failed', 'ready_for_review')
   AND NOT (NEW.legacy_batch_result_id IS NOT NULL AND NEW.status IN ('approved', 'rejected'))
  BEGIN
    SELECT RAISE(ABORT, 'APPROVAL_GATE: new applications must start in preparing, preparation_failed or ready_for_review');
  END;

  -- Becoming approved requires: coming from ready_for_review, AND the latest
  -- event for this application being a status_change to 'approved' by 'user'.
  CREATE TRIGGER trg_applications_approval_requires_user
  BEFORE UPDATE OF status ON applications
  WHEN NEW.status = 'approved' AND OLD.status IS NOT 'approved'
   AND (OLD.status IS NOT 'ready_for_review'
        OR NOT EXISTS (
          SELECT 1 FROM application_events e
          WHERE e.id = (SELECT MAX(id) FROM application_events WHERE application_id = NEW.id)
            AND e.event_type = 'status_change'
            AND e.to_status = 'approved'
            AND e.actor = 'user'))
  BEGIN
    SELECT RAISE(ABORT, 'APPROVAL_GATE: approval must be recorded by the user from ready_for_review');
  END;

  -- Entering submission requires: approved (or retrying a failed submission),
  -- an approval snapshot, and the most recent review decision being a user
  -- approval (legacy-imported approvals therefore cannot be submitted until
  -- the user re-approves).
  CREATE TRIGGER trg_applications_submission_requires_approval
  BEFORE UPDATE OF status ON applications
  WHEN NEW.status = 'submitting' AND OLD.status IS NOT 'submitting'
   AND (OLD.status NOT IN ('approved', 'submission_failed')
        OR NEW.approved_at IS NULL
        OR NEW.approved_assets_sha256 IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM application_events e
          WHERE e.id = (
            SELECT MAX(id) FROM application_events
            WHERE application_id = NEW.id
              AND event_type = 'status_change'
              AND to_status IN ('approved', 'ready_for_review', 'rejected', 'preparing'))
            AND e.to_status = 'approved'
            AND e.actor = 'user'))
  BEGIN
    SELECT RAISE(ABORT, 'APPROVAL_GATE: submission requires an explicit, current user approval');
  END;

  CREATE TRIGGER trg_applications_submitted_requires_submitting
  BEFORE UPDATE OF status ON applications
  WHEN NEW.status = 'submitted' AND OLD.status IS NOT 'submitted' AND OLD.status IS NOT 'submitting'
  BEGIN
    SELECT RAISE(ABORT, 'APPROVAL_GATE: only an application in submitting can become submitted');
  END;

  -- Content is locked once submission has started.
  CREATE TRIGGER trg_application_assets_locked_insert
  BEFORE INSERT ON application_assets
  WHEN (SELECT status FROM applications WHERE id = NEW.application_id)
       IN ('submitting', 'submitted', 'acknowledged', 'interviewing', 'offer', 'unsuccessful')
  BEGIN
    SELECT RAISE(ABORT, 'ASSETS_LOCKED: application content cannot change after submission has started');
  END;

  CREATE TRIGGER trg_application_assets_locked_update
  BEFORE UPDATE OF is_current ON application_assets
  WHEN (SELECT status FROM applications WHERE id = NEW.application_id)
       IN ('submitting', 'submitted', 'acknowledged', 'interviewing', 'offer', 'unsuccessful')
  BEGIN
    SELECT RAISE(ABORT, 'ASSETS_LOCKED: application content cannot change after submission has started');
  END;

  -- Any content change after approval withdraws the approval: the user must
  -- review and approve the new content.
  CREATE TRIGGER trg_application_assets_invalidate_approval_insert
  AFTER INSERT ON application_assets
  WHEN NEW.origin IS NOT 'legacy_import'
   AND (SELECT status FROM applications WHERE id = NEW.application_id) IN ('approved', 'submission_failed')
  BEGIN
    INSERT INTO application_events (application_id, event_type, from_status, to_status, actor, detail)
      SELECT id, 'status_change', status, 'ready_for_review', 'system',
             'Approval withdrawn: application content changed after approval'
      FROM applications WHERE id = NEW.application_id;
    UPDATE applications
      SET status = 'ready_for_review', approved_at = NULL, approved_assets_sha256 = NULL,
          updated_at = datetime('now')
      WHERE id = NEW.application_id;
  END;

  CREATE TRIGGER trg_application_assets_invalidate_approval_update
  AFTER UPDATE OF is_current ON application_assets
  WHEN NEW.is_current IS NOT OLD.is_current
   AND (SELECT status FROM applications WHERE id = NEW.application_id) IN ('approved', 'submission_failed')
  BEGIN
    INSERT INTO application_events (application_id, event_type, from_status, to_status, actor, detail)
      SELECT id, 'status_change', status, 'ready_for_review', 'system',
             'Approval withdrawn: application content changed after approval'
      FROM applications WHERE id = NEW.application_id;
    UPDATE applications
      SET status = 'ready_for_review', approved_at = NULL, approved_assets_sha256 = NULL,
          updated_at = datetime('now')
      WHERE id = NEW.application_id;
  END;
`;

export const migration002CoreSchema = {
  version: 2,
  name: "core_schema",
  checksumSource: SQL,
  up(db: DB) {
    db.exec(SQL);
  },
};
