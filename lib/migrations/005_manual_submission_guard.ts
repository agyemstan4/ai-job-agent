import type { DB } from "../repositories/shared.ts";

// Phase 2 (manual submission tracking): database-level guards so that only
// the user can record a submission and its follow-up statuses. Additive
// only: new triggers, no table, column or existing trigger is changed, and
// the triggers from 002 and 004 stay in force alongside these.
//
//   1. Events moving an application into submission (submitting, submitted)
//      or a post-submission status (acknowledged, interviewing, offer,
//      unsuccessful), or withdrawing it after submission, must be recorded
//      with actor 'user'. 004 already requires every status change to be
//      preceded by its own matching event, so together no status change into
//      or after submission can happen without a user action. (A system or
//      scheduler can never submit; any future automated method would need a
//      new migration.)
//   2. 'submitted' requires a submission method.
//   3. submitted_at, when first set, must be a real UTC 'YYYY-MM-DD HH:MM:SS'
//      time, not in the future and not before approved_at. (Once set, 004
//      keeps it read-only.)
//   4. submission_reference may change only during submitting → submitted, or
//      after submission when the latest event is the user's 'external_update'
//      recording exactly that change ({field, from, to}).
//   5. An event payload's occurredAt, if present, must be a real UTC
//      'YYYY-MM-DD HH:MM:SS' time, not in the future and not before the
//      application's submitted_at (so only after submission).

const TIMESTAMP_GLOB = "'[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9] [0-2][0-9]:[0-5][0-9]:[0-5][0-9]'";

// True when the expression is not a valid, normalised UTC timestamp.
// datetime() returns NULL for impossible values and normalises overflowing
// ones (e.g. Feb 30), so a round-trip mismatch also means "invalid".
const invalidTimestamp = (expr: string) =>
  `(typeof(${expr}) IS NOT 'text' OR ${expr} NOT GLOB ${TIMESTAMP_GLOB} OR datetime(${expr}) IS NOT ${expr})`;

const OCCURRED_AT = "json_extract(NEW.payload_json, '$.occurredAt')";
const SUBMITTED_AT_OF_APP = "(SELECT submitted_at FROM applications WHERE id = NEW.application_id)";

const SQL = `
  -- 1. Submission and post-submission status events are the user's alone.
  CREATE TRIGGER trg_events_submission_statuses_by_user
  BEFORE INSERT ON application_events
  WHEN NEW.actor IS NOT 'user'
   AND (NEW.to_status IN ('submitting', 'submitted', 'acknowledged', 'interviewing', 'offer', 'unsuccessful')
        OR (NEW.to_status = 'withdrawn'
            AND NEW.from_status IN ('submitted', 'acknowledged', 'interviewing', 'offer')))
  BEGIN
    SELECT RAISE(ABORT, 'SUBMISSION_GATE: submission and post-submission status changes can only be recorded by the user');
  END;

  -- 2. A submitted application records how it was submitted.
  CREATE TRIGGER trg_applications_submitted_requires_method
  BEFORE UPDATE OF status ON applications
  WHEN NEW.status = 'submitted' AND OLD.status IS NOT 'submitted' AND NEW.submission_method IS NULL
  BEGIN
    SELECT RAISE(ABORT, 'SUBMISSION_GATE: submitted requires a submission method');
  END;

  -- 3. The submission time is real, not in the future, and not before approval.
  CREATE TRIGGER trg_applications_submitted_at_valid
  BEFORE UPDATE OF submitted_at ON applications
  WHEN NEW.submitted_at IS NOT NULL AND OLD.submitted_at IS NULL
   AND (${invalidTimestamp("NEW.submitted_at")}
        OR NEW.submitted_at > datetime('now')
        OR NEW.approved_at IS NULL
        OR NEW.submitted_at < NEW.approved_at)
  BEGIN
    SELECT RAISE(ABORT, 'SUBMISSION_GATE: submitted_at must be a valid time, not in the future and not before approval');
  END;

  -- 4. Every change to the submission reference is recorded by the user first.
  CREATE TRIGGER trg_applications_reference_change_recorded
  BEFORE UPDATE OF submission_reference ON applications
  WHEN NEW.submission_reference IS NOT OLD.submission_reference
   AND NOT (OLD.status = 'submitting' AND NEW.status = 'submitted')
   AND (OLD.submitted_at IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM application_events e
          WHERE e.id = (SELECT MAX(id) FROM application_events WHERE application_id = NEW.id)
            AND e.event_type = 'external_update'
            AND e.actor = 'user'
            AND json_extract(e.payload_json, '$.field') = 'submission_reference'
            AND json_extract(e.payload_json, '$.from') IS OLD.submission_reference
            AND json_extract(e.payload_json, '$.to') IS NEW.submission_reference))
  BEGIN
    SELECT RAISE(ABORT, 'AUDIT: a submission reference can only change after submission, recorded by the user as an event first');
  END;

  -- 5. "When it happened" on an event is real, not in the future, and after submission.
  CREATE TRIGGER trg_events_occurred_at_valid
  BEFORE INSERT ON application_events
  WHEN ${OCCURRED_AT} IS NOT NULL
   AND (${invalidTimestamp(OCCURRED_AT)}
        OR ${OCCURRED_AT} > datetime('now')
        OR ${SUBMITTED_AT_OF_APP} IS NULL
        OR ${OCCURRED_AT} < ${SUBMITTED_AT_OF_APP})
  BEGIN
    SELECT RAISE(ABORT, 'SUBMISSION_GATE: occurredAt must be a valid time, not in the future and not before submission');
  END;
`;

export const migration005ManualSubmissionGuard = {
  version: 5,
  name: "manual_submission_guard",
  checksumSource: SQL,
  up(db: DB) {
    db.exec(SQL);
  },
};
