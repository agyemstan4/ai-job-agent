import type { DB } from "../repositories/shared.ts";

// Phase 2 hardening (defence in depth). Additive only: two new triggers; no
// table, column, data or existing trigger is changed.
//
// Migration 002 locks an application's assets while its status is
// submitting, submitted, acknowledged, interviewing, offer or unsuccessful.
// "withdrawn" is not in that list because, before Phase 2, an application
// could not be withdrawn after it was submitted. Now it can, and its content
// must stay what was submitted. The repository already refuses this
// (addApplicationAsset); these triggers make the database refuse it too, for
// any writer.
//
// Applications withdrawn before they were ever submitted (submitted_at NULL)
// are unaffected, exactly as before. submitted_at cannot be cleared once set
// (migration 004), so the lock cannot be lifted.

const SQL = `
  CREATE TRIGGER trg_application_assets_locked_withdrawn_insert
  BEFORE INSERT ON application_assets
  WHEN (SELECT status FROM applications WHERE id = NEW.application_id) = 'withdrawn'
   AND (SELECT submitted_at FROM applications WHERE id = NEW.application_id) IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'ASSETS_LOCKED: application content cannot change after the application has been submitted');
  END;

  CREATE TRIGGER trg_application_assets_locked_withdrawn_update
  BEFORE UPDATE OF is_current ON application_assets
  WHEN (SELECT status FROM applications WHERE id = NEW.application_id) = 'withdrawn'
   AND (SELECT submitted_at FROM applications WHERE id = NEW.application_id) IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'ASSETS_LOCKED: application content cannot change after the application has been submitted');
  END;
`;

export const migration006WithdrawnAssetLock = {
  version: 6,
  name: "withdrawn_asset_lock",
  checksumSource: SQL,
  up(db: DB) {
    db.exec(SQL);
  },
};
