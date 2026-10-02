import type { DB } from "../repositories/shared.ts";

// Hardens the database-level approval gate from 002 (which is applied and
// frozen). Additive only: one new nullable column and new triggers. Nothing is
// dropped, rewritten or deleted, and 002's triggers stay in force alongside
// these (any trigger that aborts wins).
//
// Closes the gaps found in the Phase 1 review:
//   • every status change must be recorded as an event first (no silent changes,
//     so an old user approval can no longer be "reused" after tampering);
//   • approval snapshots the exact set of current asset IDs — assets are
//     immutable, so the ID set identifies the approved content — and the
//     database checks it at approval and at submission;
//   • post-submission statuses require an actual submission;
//   • the approval record is read-only once submitted;
//   • assets cannot be deleted;
//   • 'migration' approvals are limited to legacy-imported applications;
//   • 'legacy_import' assets are limited to legacy-imported applications;
//   • the approval snapshot can only be set by the transition to approved;
//   • an application's job cannot change.
//
// What remains out of reach of any database: code with direct database access
// deliberately forging a user approval event (and the matching approval). Such
// a forgery is explicit and permanently recorded (events are append-only).

// Ordered, comma-separated IDs of an application's current assets. Must match
// currentAssetIdSet() in lib/repositories/applications.ts.
const CURRENT_ASSET_IDS = `(
  SELECT group_concat(id, ',' ORDER BY id) FROM application_assets
  WHERE application_id = NEW.id AND is_current = 1
)`;

const SQL = `
  ALTER TABLE applications ADD COLUMN approved_asset_ids TEXT;

  -- 1. Every status change must be immediately preceded by its own event.
  CREATE TRIGGER trg_applications_status_change_requires_event
  BEFORE UPDATE OF status ON applications
  WHEN NEW.status IS NOT OLD.status
   AND NOT EXISTS (
     SELECT 1 FROM application_events e
     WHERE e.id = (SELECT MAX(id) FROM application_events WHERE application_id = NEW.id)
       AND e.event_type IN ('status_change', 'submission_attempt')
       AND e.from_status IS OLD.status
       AND e.to_status = NEW.status)
  BEGIN
    SELECT RAISE(ABORT, 'AUDIT: a status change must be recorded as an event first');
  END;

  -- 2. Approval must snapshot exactly the current content.
  CREATE TRIGGER trg_applications_approval_snapshots_assets
  BEFORE UPDATE OF status ON applications
  WHEN NEW.status = 'approved' AND OLD.status IS NOT 'approved'
   AND (NEW.approved_asset_ids IS NULL OR NEW.approved_asset_ids IS NOT ${CURRENT_ASSET_IDS})
  BEGIN
    SELECT RAISE(ABORT, 'APPROVAL_GATE: approval must snapshot exactly the current application content');
  END;

  -- 3. Submission requires the approved content to still be the current content.
  CREATE TRIGGER trg_applications_submission_requires_approved_assets
  BEFORE UPDATE OF status ON applications
  WHEN NEW.status = 'submitting' AND OLD.status IS NOT 'submitting'
   AND (NEW.approved_asset_ids IS NULL OR NEW.approved_asset_ids IS NOT ${CURRENT_ASSET_IDS})
  BEGIN
    SELECT RAISE(ABORT, 'APPROVAL_GATE: the approved content is no longer the current content; approve again');
  END;

  -- 4. 'submitted' must record when.
  CREATE TRIGGER trg_applications_submitted_requires_timestamp
  BEFORE UPDATE OF status ON applications
  WHEN NEW.status = 'submitted' AND OLD.status IS NOT 'submitted' AND NEW.submitted_at IS NULL
  BEGIN
    SELECT RAISE(ABORT, 'SUBMISSION_GATE: submitted requires submitted_at');
  END;

  -- 5. Post-submission statuses require an actual, approved submission.
  CREATE TRIGGER trg_applications_post_submission_requires_submitted
  BEFORE UPDATE OF status ON applications
  WHEN NEW.status IN ('acknowledged', 'interviewing', 'offer', 'unsuccessful')
   AND NEW.status IS NOT OLD.status
   AND (OLD.status NOT IN ('submitted', 'acknowledged', 'interviewing', 'offer')
        OR NEW.approved_at IS NULL
        OR NEW.submitted_at IS NULL)
  BEGIN
    SELECT RAISE(ABORT, 'SUBMISSION_GATE: only a submitted application can move to a post-submission status');
  END;

  -- 6. Once submitted, the approval record and submission time are read-only.
  CREATE TRIGGER trg_applications_submission_record_read_only
  BEFORE UPDATE OF approved_at, approved_assets_sha256, approved_asset_ids, submitted_at ON applications
  WHEN OLD.submitted_at IS NOT NULL
   AND (NEW.approved_at IS NOT OLD.approved_at
        OR NEW.approved_assets_sha256 IS NOT OLD.approved_assets_sha256
        OR NEW.approved_asset_ids IS NOT OLD.approved_asset_ids
        OR NEW.submitted_at IS NOT OLD.submitted_at)
  BEGIN
    SELECT RAISE(ABORT, 'IMMUTABLE: the approval and submission record cannot change after submission');
  END;

  -- 7. Assets are append-only, like events.
  CREATE TRIGGER trg_application_assets_no_delete
  BEFORE DELETE ON application_assets
  BEGIN
    SELECT RAISE(ABORT, 'APPEND_ONLY: application assets cannot be deleted');
  END;

  -- 8. Only the one-off legacy import may record a 'migration' approval.
  CREATE TRIGGER trg_application_events_migration_approval_legacy_only
  BEFORE INSERT ON application_events
  WHEN NEW.to_status = 'approved' AND NEW.actor = 'migration'
   AND (SELECT legacy_batch_result_id FROM applications WHERE id = NEW.application_id) IS NULL
  BEGIN
    SELECT RAISE(ABORT, 'APPROVAL_GATE: migration approvals are only allowed for legacy-imported applications');
  END;

  -- 9. Keep the asset snapshot consistent when an approval is revoked (002's
  --    revocation triggers clear approved_at but predate this column).
  CREATE TRIGGER trg_applications_clear_asset_snapshot
  AFTER UPDATE OF approved_at ON applications
  WHEN NEW.approved_at IS NULL AND NEW.approved_asset_ids IS NOT NULL
  BEGIN
    UPDATE applications SET approved_asset_ids = NULL WHERE id = NEW.id;
  END;

  -- 10. 'legacy_import' assets belong only to legacy-imported applications.
  --     (002 does not revoke approval for that origin, so on a normal
  --     application it could change content without revoking approval.)
  CREATE TRIGGER trg_application_assets_legacy_origin_legacy_only
  BEFORE INSERT ON application_assets
  WHEN NEW.origin = 'legacy_import'
   AND (SELECT legacy_batch_result_id FROM applications WHERE id = NEW.application_id) IS NULL
  BEGIN
    SELECT RAISE(ABORT, 'APPROVAL_GATE: legacy_import assets are only allowed on legacy-imported applications');
  END;

  -- 11. The approval snapshot can only be SET (to a non-null value) by the
  --     transition ready_for_review → approved, where the approval triggers
  --     verify it. Clearing stays allowed: revocation (002, and trigger 9
  --     above) and leaving approval clear it, which only weakens an approval.
  CREATE TRIGGER trg_applications_approval_snapshot_set_only_by_approval
  BEFORE UPDATE OF approved_at, approved_assets_sha256, approved_asset_ids ON applications
  WHEN ((NEW.approved_at IS NOT OLD.approved_at AND NEW.approved_at IS NOT NULL)
        OR (NEW.approved_assets_sha256 IS NOT OLD.approved_assets_sha256 AND NEW.approved_assets_sha256 IS NOT NULL)
        OR (NEW.approved_asset_ids IS NOT OLD.approved_asset_ids AND NEW.approved_asset_ids IS NOT NULL))
   AND NOT (OLD.status = 'ready_for_review' AND NEW.status = 'approved')
  BEGIN
    SELECT RAISE(ABORT, 'IMMUTABLE: the approval snapshot can only be set by approving the application');
  END;

  -- 12. An application's job is fixed at creation.
  CREATE TRIGGER trg_applications_job_immutable
  BEFORE UPDATE OF job_id ON applications
  WHEN NEW.job_id IS NOT OLD.job_id
  BEGIN
    SELECT RAISE(ABORT, 'IMMUTABLE: an application''s job cannot change');
  END;
`;

export const migration004ApprovalGateHardening = {
  version: 4,
  name: "approval_gate_hardening",
  checksumSource: SQL,
  up(db: DB) {
    db.exec(SQL);
  },
};
