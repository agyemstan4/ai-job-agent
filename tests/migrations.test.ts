import { describe, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { recordJobListing } from "../lib/repositories/jobs.ts";
import { createCandidate, createProfileVersion } from "../lib/repositories/candidates.ts";
import { recordMatch } from "../lib/repositories/matches.ts";
import { completeRun, startRun } from "../lib/repositories/runs.ts";
import {
  addApplicationAsset,
  approveApplication,
  beginSubmission,
  createApplication,
  getApplication,
  getCurrentAssetsHash,
  recordManualSubmission,
  recordSubmissionResult,
  transitionApplication,
  updateSubmittedStatus,
} from "../lib/repositories/applications.ts";
import { openDatabase, resolveDbPath, DEFAULT_DB_PATH } from "../lib/database.ts";
import { MIGRATIONS, runMigrations } from "../lib/migrate.ts";
import { sha256 } from "../lib/repositories/shared.ts";
import type { Migration } from "../lib/migrate.ts";
import {
  count,
  createLegacyDbFile,
  freshDb,
  makeTempDir,
  quietly,
  removeTempDir,
  seedSeenJobs,
  tableExists,
} from "./helpers.ts";

const NEW_TABLES = [
  "schema_migrations",
  "candidates",
  "cv_documents",
  "candidate_profiles",
  "job_sources",
  "pipeline_runs",
  "jobs",
  "job_listings",
  "job_descriptions",
  "matches",
  "applications",
  "application_events",
  "application_assets",
];
const LEGACY_TABLES = ["batch_runs", "batch_results", "seen_jobs"];
const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;
const ALL_VERSIONS = MIGRATIONS.map((m) => m.version);

describe("database path", () => {
  test("defaults to .data/jobs.db in the working directory", () => {
    assert.equal(DEFAULT_DB_PATH, path.join(process.cwd(), ".data", "jobs.db"));
    assert.equal(resolveDbPath({}), DEFAULT_DB_PATH);
    assert.equal(resolveDbPath({ JOB_AGENT_DB_PATH: "   " }), DEFAULT_DB_PATH);
  });

  test("JOB_AGENT_DB_PATH overrides it", () => {
    const custom = path.join(makeTempDir(), "elsewhere", "agent.db");
    assert.equal(resolveDbPath({ JOB_AGENT_DB_PATH: custom }), path.resolve(custom));
  });
});

describe("migration runner", () => {
  test("a fresh database gets every migration and all tables", () => {
    const t = quietly(freshDb);
    try {
      const versions = (t.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
        version: number;
      }[]).map((r) => r.version);
      assert.deepEqual(versions, MIGRATIONS.map((m) => m.version));
      for (const table of [...LEGACY_TABLES, ...NEW_TABLES]) {
        assert.ok(tableExists(t.db, table), `missing table ${table}`);
      }
      assert.deepEqual(
        (t.db.prepare("SELECT id FROM job_sources ORDER BY id").all() as { id: string }[]).map((r) => r.id),
        ["adzuna", "legacy", "reed"]
      );
      assert.equal(t.db.pragma("foreign_keys", { simple: true }), 1);
      assert.equal(t.db.pragma("busy_timeout", { simple: true }), 5000);
    } finally {
      t.close();
    }
  });

  test("no backup is written for a brand-new database", () => {
    const t = quietly(freshDb);
    try {
      assert.equal(fs.existsSync(path.join(t.dir, "backups")), false);
    } finally {
      t.close();
    }
  });

  test("is idempotent: reopening applies nothing and changes nothing", () => {
    const t = quietly(freshDb);
    try {
      t.db.close();
      const again = quietly(() => openDatabase(t.file));
      const result = runMigrations(again);
      assert.deepEqual(result.applied, []);
      assert.equal(result.backupPath, null);
      assert.equal(count(again, "schema_migrations"), MIGRATIONS.length);
      assert.equal(count(again, "job_sources"), 3);
      again.close();
    } finally {
      t.close();
    }
  });

  test("upgrades a pre-Phase-1 database without losing data, after backing it up", () => {
    const dir = makeTempDir();
    const file = createLegacyDbFile(dir, (db) => {
      seedSeenJobs(db, 167);
      db.prepare("INSERT INTO batch_runs (job_count) VALUES (1)").run();
      db.prepare(
        "INSERT INTO batch_results (batch_run_id, job_title, job_company, cover_letter) VALUES (1, 'Dev', 'Acme', 'Hi')"
      ).run();
    });

    const db = quietly(() => openDatabase(file));
    let backup: Database.Database | null = null;
    try {
      for (const table of [...LEGACY_TABLES, ...NEW_TABLES]) assert.ok(tableExists(db, table), table);
      assert.equal(count(db, "seen_jobs"), 167);
      assert.equal(count(db, "batch_runs"), 1);
      assert.equal(count(db, "batch_results"), 1);
      assert.equal(
        (db.prepare("SELECT cover_letter FROM batch_results").get() as { cover_letter: string }).cover_letter,
        "Hi"
      );

      const backups = fs.readdirSync(path.join(dir, "backups"));
      assert.equal(backups.length, 1);
      assert.match(backups[0], new RegExp(`^jobs\\.v0-to-v${LATEST}\\.\\d{12}\\.db$`));
      backup = new Database(path.join(dir, "backups", backups[0]), { readonly: true });
      assert.equal(count(backup, "seen_jobs"), 167);
      assert.equal(tableExists(backup, "schema_migrations"), false);
      assert.equal(tableExists(backup, "applications"), false);
    } finally {
      backup?.close();
      db.close();
      removeTempDir(dir);
    }
  });

  test("adds the error column to databases created before it existed", () => {
    const dir = makeTempDir();
    const file = createLegacyDbFile(
      dir,
      (db) => {
        db.prepare("INSERT INTO batch_runs (job_count) VALUES (1)").run();
        db.prepare(
          "INSERT INTO batch_results (batch_run_id, job_title, job_company) VALUES (1, 'Dev', 'Acme')"
        ).run();
      },
      { withErrorColumn: false }
    );
    const db = quietly(() => openDatabase(file));
    try {
      const columns = (db.prepare("PRAGMA table_info(batch_results)").all() as { name: string }[]).map(
        (c) => c.name
      );
      assert.ok(columns.includes("error"));
      assert.equal(count(db, "batch_results"), 1);
    } finally {
      db.close();
      removeTempDir(dir);
    }
  });

  test("a failing migration rolls back the whole batch", () => {
    const dir = makeTempDir();
    const file = createLegacyDbFile(dir, (db) => seedSeenJobs(db, 3));
    const db = new Database(file);
    const failing: Migration = {
      version: 99,
      name: "explodes",
      checksumSource: "x",
      up(inner) {
        inner.exec("CREATE TABLE should_not_survive (id INTEGER)");
        throw new Error("boom");
      },
    };
    try {
      assert.throws(
        () => quietly(() => runMigrations(db, { migrations: [...MIGRATIONS, failing] })),
        /boom/
      );
      assert.equal(tableExists(db, "schema_migrations"), false); // created inside the rolled-back transaction
      assert.equal(tableExists(db, "should_not_survive"), false);
      assert.equal(tableExists(db, "applications"), false);
      assert.equal(count(db, "seen_jobs"), 3);
    } finally {
      db.close();
      removeTempDir(dir);
    }
  });

  test("warns (without failing) when an applied migration's content changed", () => {
    const t = quietly(freshDb);
    try {
      const edited = MIGRATIONS.map((m) => (m.version === 1 ? { ...m, checksumSource: "edited" } : m));
      const result = quietly(() => runMigrations(t.db, { migrations: edited }));
      assert.equal(result.checksumWarnings.length, 1);
      assert.match(result.checksumWarnings[0], /Migration 1/);
    } finally {
      t.close();
    }
  });

  test("rejects a malformed migration list", () => {
    const db = new Database(":memory:");
    try {
      const [first] = MIGRATIONS;
      assert.throws(() => runMigrations(db, { migrations: [first, first] }), /strictly increasing/);
    } finally {
      db.close();
    }
  });

  test("two connections migrating the same file apply each migration once", () => {
    const dir = makeTempDir();
    const file = createLegacyDbFile(dir, (db) => seedSeenJobs(db, 5));
    const a = new Database(file);
    const b = new Database(file);
    try {
      a.pragma("busy_timeout = 5000");
      b.pragma("busy_timeout = 5000");
      const ra = quietly(() => runMigrations(a));
      const rb = quietly(() => runMigrations(b));
      assert.deepEqual(ra.applied, ALL_VERSIONS);
      assert.deepEqual(rb.applied, []);
      assert.equal(count(a, "schema_migrations"), MIGRATIONS.length);
      assert.equal(count(a, "seen_jobs"), 5);
    } finally {
      a.close();
      b.close();
      removeTempDir(dir);
    }
  });
});

// ── Added with migration 004 ────────────────────────────────────────────────

describe("runner — database newer than the code", () => {
  test("warns about unknown applied versions and applies nothing", () => {
    const t = quietly(freshDb);
    try {
      t.db.prepare("INSERT INTO schema_migrations (version, name, checksum) VALUES (99, 'future', 'x')").run();
      const result = quietly(() => runMigrations(t.db));
      assert.deepEqual(result.unknownVersions, [99]);
      assert.deepEqual(result.applied, []);
    } finally {
      t.close();
    }
  });
});

describe("v3 → v4 upgrade", () => {
  test("keeps data, and an approval made before 004 must be renewed before submission", () => {
    const dir = makeTempDir();
    const file = createLegacyDbFile(dir, (db) => seedSeenJobs(db, 7));
    const db = new Database(file);
    try {
      db.pragma("foreign_keys = ON");
      quietly(() => runMigrations(db, { migrations: MIGRATIONS.slice(0, 3) }));

      // An application approved by the Phase 1 (v3) code: event first, then status.
      const job = recordJobListing(db, { sourceId: "reed", externalId: "v3", title: "Dev", company: "Acme" });
      const app = createApplication(db, { jobId: job.jobId });
      addApplicationAsset(db, { applicationId: app.id, kind: "cover_letter", origin: "generated", contentText: "Hi" });
      transitionApplication(db, app.id, "ready_for_review", { actor: "system" });
      db.prepare(
        "INSERT INTO application_events (application_id, event_type, from_status, to_status, actor) VALUES (?, 'status_change', 'ready_for_review', 'approved', 'user')"
      ).run(app.id);
      db.prepare(
        "UPDATE applications SET status = 'approved', approved_at = datetime('now'), approved_assets_sha256 = ? WHERE id = ?"
      ).run(getCurrentAssetsHash(db, app.id), app.id);

      const result = quietly(() => runMigrations(db, { backupDir: path.join(dir, "backups"), migrations: MIGRATIONS.slice(0, 4) }));
      assert.deepEqual(result.applied, [4]);
      assert.match(path.basename(result.backupPath!), /^jobs\.v3-to-v4\.\d{12}\.db$/);
      assert.equal(count(db, "seen_jobs"), 7);

      const upgraded = getApplication(db, app.id)!;
      assert.equal(upgraded.status, "approved");
      assert.equal(upgraded.approvedAssetIds, null);
      assert.throws(() => beginSubmission(db, app.id, { method: "manual", actor: "user" }), { code: "APPROVAL_REQUIRED" });

      // Re-review and re-approve, then the gate opens.
      transitionApplication(db, app.id, "ready_for_review", { actor: "user" });
      approveApplication(db, app.id, { reviewedAssetsSha256: getCurrentAssetsHash(db, app.id) });
      assert.equal(beginSubmission(db, app.id, { method: "manual", actor: "user" }).status, "submitting");
    } finally {
      db.close();
      removeTempDir(dir);
    }
  });
});

describe("v4 → v5 upgrade (migration 005)", () => {
  const TRIGGERS_005 = [
    "trg_events_submission_statuses_by_user",
    "trg_applications_submitted_requires_method",
    "trg_applications_submitted_at_valid",
    "trg_applications_reference_change_recorded",
    "trg_events_occurred_at_valid",
  ];
  const triggerNames = (db: Database.Database) =>
    new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]).map((r) => r.name)
    );
  // Every row of every table except the migration bookkeeping.
  const fingerprint = (db: Database.Database) => {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name")
        .all() as { name: string }[]
    ).map((r) => r.name);
    return Object.fromEntries(
      tables.map((table) => [
        table,
        createHash("sha256").update(JSON.stringify(db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all())).digest("hex"),
      ])
    );
  };

  /** A v4 database with data shaped like the live one after the acceptance test. */
  function seedV4(db: Database.Database): { approvedId: number; readyId: number } {
    seedSeenJobs(db, 167);
    db.prepare("INSERT INTO batch_runs (job_count) VALUES (1)").run();
    db.prepare("INSERT INTO batch_results (batch_run_id, job_title, job_company, status) VALUES (1, 'Old', 'Old Co', 'pending')").run();
    const candidate = createCandidate(db, { fullName: "A Candidate", email: "a@example.com" });
    const profile = createProfileVersion(db, {
      candidateId: candidate.id, origin: "ai_extraction", analysis: { _inputs: { selectedRoles: ["Dev"] } }, structuredCv: { name: "A" },
    });
    const run = startRun(db, { kind: "discovery", triggeredBy: "ui", candidateProfileId: profile.id });
    completeRun(db, run.id, { rawListings: 2 });
    const jobs = ["Full Stack Developer", "Junior Developer"].map(
      (title, i) => recordJobListing(db, { sourceId: "adzuna", externalId: `v4-${i}`, title, company: "Acme", description: "Kotlin", runId: run.id }).jobId
    );
    const match = recordMatch(db, { jobId: jobs[0], candidateProfileId: profile.id, outcome: "scored", score: 83 });
    const prepare = (jobId: number, matchId: number | null) => {
      const app = createApplication(db, { jobId, matchId, candidateProfileId: profile.id });
      addApplicationAsset(db, { applicationId: app.id, kind: "cover_letter", origin: "generated", contentText: "Dear Acme" });
      addApplicationAsset(db, { applicationId: app.id, kind: "tailored_cv_file", origin: "generated", file: Buffer.from("%PDF"), filename: "cv.pdf", mimeType: "application/pdf" });
      return transitionApplication(db, app.id, "ready_for_review", { actor: "system" });
    };
    const approved = prepare(jobs[0], match.id);
    approveApplication(db, approved.id, { reviewedAssetsSha256: getCurrentAssetsHash(db, approved.id) });
    const ready = prepare(jobs[1], null);
    return { approvedId: approved.id, readyId: ready.id };
  }

  test("a fresh database gets migration 005 and its five triggers", () => {
    const t = quietly(freshDb);
    try {
      const names = triggerNames(t.db);
      for (const trigger of TRIGGERS_005) assert.ok(names.has(trigger), trigger);
      const row = t.db.prepare("SELECT version, name FROM schema_migrations WHERE version = 5").get();
      assert.deepEqual(row, { version: 5, name: "manual_submission_guard" });
    } finally {
      t.close();
    }
  });

  test("keeps every row unchanged, backs up first, and the guards apply afterwards", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "jobs.db");
    const db = new Database(file);
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      quietly(() => runMigrations(db, { migrations: MIGRATIONS.slice(0, 4) }));
      const { approvedId, readyId } = seedV4(db);
      const before = fingerprint(db);
      const triggersBefore = triggerNames(db);
      for (const trigger of TRIGGERS_005) assert.equal(triggersBefore.has(trigger), false);

      const result = quietly(() => runMigrations(db, { backupDir: path.join(dir, "backups"), migrations: MIGRATIONS.slice(0, 5) }));
      assert.deepEqual(result.applied, [5]);
      assert.deepEqual([result.fromVersion, result.toVersion], [4, 5]);
      assert.match(path.basename(result.backupPath!), /^jobs\.v4-to-v5\.\d{12}\.db$/);

      // Additive only: every row of every table is exactly as before.
      assert.deepEqual(fingerprint(db), before);
      assert.equal(count(db, "seen_jobs"), 167);
      assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
      assert.deepEqual(db.pragma("foreign_key_check"), []);
      // Every earlier trigger is still there, plus the five new ones.
      const triggersAfter = triggerNames(db);
      for (const trigger of triggersBefore) assert.ok(triggersAfter.has(trigger), trigger);
      assert.equal(triggersAfter.size, triggersBefore.size + TRIGGERS_005.length);

      // The backup is the database exactly as it was at v4.
      const backup = new Database(result.backupPath!, { readonly: true });
      try {
        assert.equal((backup.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v, 4);
        assert.deepEqual(fingerprint(backup), before);
        assert.equal(triggerNames(backup).has(TRIGGERS_005[0]), false);
      } finally {
        backup.close();
      }

      // The approved application can be submitted only by the user.
      assert.throws(() => beginSubmission(db, approvedId, { method: "manual", actor: "system" }), /SUBMISSION_GATE/);
      assert.equal(beginSubmission(db, approvedId, { method: "manual", actor: "user" }).status, "submitting");
      assert.equal(recordSubmissionResult(db, approvedId, { success: true, reference: "R-1" }, "user").status, "submitted");
      // The application awaiting review is untouched by all of this.
      assert.equal(getApplication(db, readyId)!.status, "ready_for_review");

      // Reopening applies nothing more.
      assert.deepEqual(quietly(() => runMigrations(db, { backupDir: path.join(dir, "backups"), migrations: MIGRATIONS.slice(0, 5) })).applied, []);
    } finally {
      db.close();
      removeTempDir(dir);
    }
  });

  test("a failure while applying 005 leaves the database at v4", () => {
    const dir = makeTempDir();
    const db = new Database(path.join(dir, "jobs.db"));
    try {
      quietly(() => runMigrations(db, { migrations: MIGRATIONS.slice(0, 4) }));
      seedV4(db);
      const before = fingerprint(db);
      const failing005: Migration = {
        ...MIGRATIONS[4],
        up(target) {
          MIGRATIONS[4].up(target);
          throw new Error("boom after creating the triggers");
        },
      };
      assert.throws(() => quietly(() => runMigrations(db, { migrations: [...MIGRATIONS.slice(0, 4), failing005] })), /boom/);
      assert.equal((db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v, 4);
      for (const trigger of TRIGGERS_005) assert.equal(triggerNames(db).has(trigger), false);
      assert.deepEqual(fingerprint(db), before);
    } finally {
      db.close();
      removeTempDir(dir);
    }
  });
});

describe("v5 → v6 upgrade (migration 006)", () => {
  const TRIGGERS_006 = ["trg_application_assets_locked_withdrawn_insert", "trg_application_assets_locked_withdrawn_update"];
  const names = (db: Database.Database) =>
    new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]).map((r) => r.name));
  const version = (db: Database.Database) => (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v;
  const print = (db: Database.Database) => {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name")
        .all() as { name: string }[]
    ).map((r) => r.name);
    return Object.fromEntries(
      tables.map((t) => [t, createHash("sha256").update(JSON.stringify(db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all())).digest("hex")])
    );
  };

  /** A v5 database with data like the live one, plus applications in every Phase 2 state. */
  function seedV5(db: Database.Database): { withdrawnId: number } {
    seedSeenJobs(db, 167);
    db.prepare("INSERT INTO batch_runs (job_count) VALUES (1)").run();
    db.prepare("INSERT INTO batch_results (batch_run_id, job_title, job_company, status) VALUES (1, 'Old', 'Old Co', 'pending')").run();
    const candidate = createCandidate(db, { fullName: "A Candidate" });
    const profile = createProfileVersion(db, { candidateId: candidate.id, origin: "ai_extraction", analysis: {}, structuredCv: {} });
    const prepare = (i: number) => {
      const jobId = recordJobListing(db, { sourceId: "adzuna", externalId: `v5-${i}`, title: `Role ${i}`, company: "Acme" }).jobId;
      const app = createApplication(db, { jobId, candidateProfileId: profile.id });
      addApplicationAsset(db, { applicationId: app.id, kind: "cover_letter", origin: "generated", contentText: "Dear Acme" });
      return transitionApplication(db, app.id, "ready_for_review", { actor: "system" });
    };
    const submit = (i: number) => {
      const app = prepare(i);
      const approved = approveApplication(db, app.id, { reviewedAssetsSha256: getCurrentAssetsHash(db, app.id) });
      return recordManualSubmission(db, app.id, { reviewedAssetsSha256: approved.approvedAssetsSha256!, reference: `R-${i}` });
    };
    prepare(1); // ready for review
    const approved = prepare(2);
    approveApplication(db, approved.id, { reviewedAssetsSha256: getCurrentAssetsHash(db, approved.id) });
    const acknowledged = submit(3);
    updateSubmittedStatus(db, acknowledged.id, { to: "acknowledged" });
    const withdrawn = submit(4);
    updateSubmittedStatus(db, withdrawn.id, { to: "withdrawn", note: "Withdrawn before v6" });
    return { withdrawnId: withdrawn.id };
  }

  test("a fresh database reaches v6 with both triggers and the correct checksum", () => {
    const t = quietly(freshDb);
    try {
      assert.equal(version(t.db), 6);
      for (const trigger of TRIGGERS_006) assert.ok(names(t.db).has(trigger), trigger);
      const row = t.db.prepare("SELECT name, checksum FROM schema_migrations WHERE version = 6").get() as { name: string; checksum: string };
      const m = MIGRATIONS[5];
      assert.equal(row.name, "withdrawn_asset_lock");
      assert.equal(row.checksum, sha256(`${m.version}:${m.name}:${m.checksumSource}`));
    } finally {
      t.close();
    }
  });

  test("v5 → v6 keeps every row unchanged, backs up first, keeps earlier triggers, and locks withdrawn content", () => {
    const dir = makeTempDir();
    const db = new Database(path.join(dir, "jobs.db"));
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      quietly(() => runMigrations(db, { migrations: MIGRATIONS.slice(0, 5) }));
      const { withdrawnId } = seedV5(db);
      const before = print(db);
      const triggersBefore = names(db);

      const result = quietly(() => runMigrations(db, { backupDir: path.join(dir, "backups") }));
      assert.deepEqual(result.applied, [6]);
      assert.deepEqual([result.fromVersion, result.toVersion], [5, 6]);
      assert.deepEqual(result.checksumWarnings, []);
      assert.match(path.basename(result.backupPath!), /^jobs\.v5-to-v6\.\d{12}\.db$/);

      assert.deepEqual(print(db), before);
      assert.equal(count(db, "seen_jobs"), 167);
      assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
      assert.deepEqual(db.pragma("foreign_key_check"), []);
      const triggersAfter = names(db);
      for (const trigger of triggersBefore) assert.ok(triggersAfter.has(trigger), trigger);
      assert.equal(triggersAfter.size, triggersBefore.size + TRIGGERS_006.length);

      const backup = new Database(result.backupPath!, { readonly: true });
      try {
        assert.equal(version(backup), 5);
        assert.deepEqual(print(backup), before);
      } finally {
        backup.close();
      }

      // The application withdrawn before the upgrade is now locked in the database.
      assert.throws(
        () => db.prepare("UPDATE application_assets SET is_current = 0 WHERE application_id = ? AND is_current = 1").run(withdrawnId),
        /ASSETS_LOCKED: application content cannot change after the application has been submitted/
      );
      assert.deepEqual(print(db), before);
      assert.deepEqual(quietly(() => runMigrations(db, { backupDir: path.join(dir, "backups") })).applied, []);
    } finally {
      db.close();
      removeTempDir(dir);
    }
  });

  test("a failure while applying 006 leaves the database at v5", () => {
    const dir = makeTempDir();
    const db = new Database(path.join(dir, "jobs.db"));
    try {
      db.pragma("foreign_keys = ON");
      quietly(() => runMigrations(db, { migrations: MIGRATIONS.slice(0, 5) }));
      seedV5(db);
      const before = print(db);
      const failing006: Migration = {
        ...MIGRATIONS[5],
        up(target) {
          MIGRATIONS[5].up(target);
          throw new Error("boom after creating the triggers");
        },
      };
      assert.throws(() => quietly(() => runMigrations(db, { migrations: [...MIGRATIONS.slice(0, 5), failing006] })), /boom/);
      assert.equal(version(db), 5);
      for (const trigger of TRIGGERS_006) assert.equal(names(db).has(trigger), false);
      assert.deepEqual(print(db), before);
    } finally {
      db.close();
      removeTempDir(dir);
    }
  });
});

function runNode(code: string, options: { cwd: string; env?: Record<string, string> }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e", code],
      { cwd: options.cwd, env: { ...process.env, ...options.env } }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err}`))));
  });
}

const moduleUrl = (relative: string) => pathToFileURL(path.resolve(relative)).href;

describe("JOB_AGENT_DB_PATH end to end", () => {
  test("lib/db.ts opens and migrates the configured database, not the default one", async () => {
    const dir = makeTempDir();
    const target = path.join(dir, "custom", "agent.db");
    const realDb = path.resolve(".data", "jobs.db");
    const realBefore = fs.existsSync(realDb) ? fs.statSync(realDb).mtimeMs : null;
    try {
      // cwd is the temp dir, so even if the variable were ignored the default
      // path would resolve inside it, never to the real database.
      const out = await runNode(
        `const lib = await import(${JSON.stringify(moduleUrl("lib/db.ts"))});
         console.log("RESULT" + JSON.stringify({ unseen: lib.filterNewJobs([{ id: "reed_1" }]).length }));`,
        { cwd: dir, env: { JOB_AGENT_DB_PATH: target } }
      );
      assert.match(out, /RESULT\{"unseen":1\}/);
      assert.ok(fs.existsSync(target));
      assert.equal(fs.existsSync(path.join(dir, ".data")), false);

      const db = new Database(target, { readonly: true });
      assert.equal(count(db, "schema_migrations"), MIGRATIONS.length);
      db.close();

      const realAfter = fs.existsSync(realDb) ? fs.statSync(realDb).mtimeMs : null;
      assert.equal(realAfter, realBefore);
    } finally {
      removeTempDir(dir);
    }
  });
});

describe("multi-process concurrency", () => {
  test("processes migrating the same file at once apply each migration exactly once", async () => {
    const dir = makeTempDir();
    const file = createLegacyDbFile(dir, (db) => seedSeenJobs(db, 167));
    const backups = path.join(dir, "backups");
    const code = `
      const { openDatabase } = await import(${JSON.stringify(moduleUrl("lib/database.ts"))});
      const { runMigrations } = await import(${JSON.stringify(moduleUrl("lib/migrate.ts"))});
      const db = openDatabase(${JSON.stringify(file)}, { migrate: false });
      const result = runMigrations(db, { backupDir: ${JSON.stringify(backups)} });
      db.close();
      console.log("RESULT" + JSON.stringify(result.applied));`;
    try {
      const outputs = await Promise.all(Array.from({ length: 4 }, () => runNode(code, { cwd: dir })));
      const applied = outputs.flatMap((out) => JSON.parse(out.split("RESULT")[1]) as number[]);
      assert.deepEqual(applied.sort((a, b) => a - b), ALL_VERSIONS);

      const db = new Database(file, { readonly: true });
      assert.equal(count(db, "schema_migrations"), MIGRATIONS.length);
      assert.equal(count(db, "seen_jobs"), 167);
      db.close();

      // One backup per minute window (two only if the run straddles a minute).
      const files = fs.readdirSync(backups);
      assert.ok(files.length >= 1 && files.length <= 2, `backups: ${files.join(", ")}`);
      for (const name of files) {
        const backup = new Database(path.join(backups, name), { readonly: true });
        assert.equal(count(backup, "seen_jobs"), 167);
        backup.close();
      }
    } finally {
      removeTempDir(dir);
    }
  });
});
