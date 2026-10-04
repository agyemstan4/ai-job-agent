import fs from "node:fs";
import path from "node:path";
import type { DB } from "./repositories/shared.ts";
import { sha256 } from "./repositories/shared.ts";
import { migration001Baseline } from "./migrations/001_baseline.ts";
import { migration002CoreSchema } from "./migrations/002_core_schema.ts";
import { migration003ImportLegacyBatches } from "./migrations/003_import_legacy_batches.ts";
import { migration004ApprovalGateHardening } from "./migrations/004_approval_gate_hardening.ts";
import { migration005ManualSubmissionGuard } from "./migrations/005_manual_submission_guard.ts";
import { migration006WithdrawnAssetLock } from "./migrations/006_withdrawn_asset_lock.ts";
import { migration007DailyAgent } from "./migrations/007_daily_agent.ts";

export type Migration = {
  version: number;
  name: string;
  /**
   * Stable text identifying the migration's content (its SQL, or a revision
   * string for code migrations). Hashed into schema_migrations.checksum.
   */
  checksumSource: string;
  up: (db: DB) => void;
};

export const MIGRATIONS: readonly Migration[] = [
  migration001Baseline,
  migration002CoreSchema,
  migration003ImportLegacyBatches,
  migration004ApprovalGateHardening,
  migration005ManualSubmissionGuard,
  migration006WithdrawnAssetLock,
  migration007DailyAgent,
];

export type MigrationResult = {
  fromVersion: number;
  toVersion: number;
  applied: number[];
  backupPath: string | null;
  checksumWarnings: string[];
  /** Applied versions this code does not know (database newer than the code). */
  unknownVersions: number[];
};

export type RunMigrationsOptions = {
  /** Directory for the pre-migration backup. No backup when omitted. */
  backupDir?: string;
  migrations?: readonly Migration[];
  now?: Date;
};

function checksumOf(migration: Migration): string {
  return sha256(`${migration.version}:${migration.name}:${migration.checksumSource}`);
}

function validateMigrationList(migrations: readonly Migration[]) {
  migrations.forEach((migration, index) => {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new Error(`Invalid migration version: ${migration.version}`);
    }
    if (index > 0 && migration.version <= migrations[index - 1].version) {
      throw new Error("Migrations must have unique, strictly increasing versions.");
    }
  });
}

const CREATE_SCHEMA_MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

function appliedMigrations(db: DB): Map<number, string> {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!exists) return new Map();
  const rows = db
    .prepare("SELECT version, checksum FROM schema_migrations")
    .all() as { version: number; checksum: string }[];
  return new Map(rows.map((row) => [row.version, row.checksum]));
}

function hasUserData(db: DB): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'`
    )
    .get() as { count: number };
  return row.count > 0;
}

function timestamp(date: Date): string {
  // Minute resolution, so parallel `next build` workers share one backup file.
  return date.toISOString().slice(0, 16).replace(/[-:T]/g, "");
}

/**
 * Applies pending migrations in order, each recorded in schema_migrations.
 *
 * - Pending migrations run inside one BEGIN IMMEDIATE transaction, re-checking
 *   what is applied after taking the write lock, so concurrent processes (e.g.
 *   `next build` workers) cannot apply the same migration twice. A failure
 *   rolls back every migration in the batch.
 * - Before an existing database is migrated, a consistent copy is written with
 *   VACUUM INTO. There are no down-migrations: the backup is the rollback.
 * - A changed checksum for an already-applied migration is reported, not fatal.
 * - So is a database newer than this code (an applied version it doesn't know):
 *   the database's own triggers still apply, but this code may be out of date.
 */
export function runMigrations(db: DB, options: RunMigrationsOptions = {}): MigrationResult {
  const migrations = options.migrations ?? MIGRATIONS;
  validateMigrationList(migrations);

  // Nothing is written before the backup, so it is an exact copy of the
  // database as it was.
  const applied = appliedMigrations(db);
  const fromVersion = applied.size > 0 ? Math.max(...applied.keys()) : 0;

  const checksumWarnings = migrations
    .filter((m) => applied.has(m.version) && applied.get(m.version) !== checksumOf(m))
    .map((m) => `Migration ${m.version} (${m.name}) has changed since it was applied.`);
  for (const warning of checksumWarnings) {
    console.warn(`[migrations] ${warning}`);
  }

  const known = new Set(migrations.map((m) => m.version));
  const unknownVersions = [...applied.keys()].filter((v) => !known.has(v)).sort((a, b) => a - b);
  if (unknownVersions.length > 0) {
    console.warn(
      `[migrations] ${db.name} has migration(s) ${unknownVersions.join(", ")} that this code does not know; ` +
        "the database is newer than the code."
    );
  }

  const pending = migrations.filter((m) => !applied.has(m.version));
  if (pending.length === 0) {
    return {
      fromVersion,
      toVersion: fromVersion,
      applied: [],
      backupPath: null,
      checksumWarnings,
      unknownVersions,
    };
  }

  let backupPath: string | null = null;
  if (options.backupDir && !db.memory && hasUserData(db)) {
    fs.mkdirSync(options.backupDir, { recursive: true });
    const target = pending[pending.length - 1].version;
    const base = path.basename(db.name, path.extname(db.name));
    backupPath = path.join(
      options.backupDir,
      `${base}.v${fromVersion}-to-v${target}.${timestamp(options.now ?? new Date())}.db`
    );
    if (!fs.existsSync(backupPath)) {
      try {
        db.prepare("VACUUM INTO ?").run(backupPath);
      } catch (error) {
        // Another process created the same backup at the same moment.
        if (!fs.existsSync(backupPath)) throw error;
      }
    }
  }

  const appliedNow: number[] = [];
  db.transaction(() => {
    db.exec(CREATE_SCHEMA_MIGRATIONS);
    const appliedInLock = appliedMigrations(db);
    const record = db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)"
    );
    for (const migration of migrations) {
      if (appliedInLock.has(migration.version)) continue;
      migration.up(db);
      record.run(migration.version, migration.name, checksumOf(migration));
      appliedNow.push(migration.version);
    }
  }).immediate();

  const toVersion = Math.max(fromVersion, ...appliedNow);
  if (appliedNow.length > 0) {
    console.log(
      `[migrations] ${db.name}: applied ${appliedNow.join(", ")} (v${fromVersion} → v${toVersion})` +
        (backupPath ? `; backup: ${backupPath}` : "")
    );
  }
  return { fromVersion, toVersion, applied: appliedNow, backupPath, checksumWarnings, unknownVersions };
}
