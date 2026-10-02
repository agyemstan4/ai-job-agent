import { describe, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { openDatabase, resolveDbPath, DEFAULT_DB_PATH } from "../lib/database.ts";
import { MIGRATIONS, runMigrations } from "../lib/migrate.ts";
import type { Migration } from "../lib/migrate.ts";
import {
  count,
  createLegacyDbFile,
  freshDb,
  makeTempDir,
  quietly,
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
      assert.match(backups[0], /^jobs\.v0-to-v3\.\d{12}\.db$/);
      backup = new Database(path.join(dir, "backups", backups[0]), { readonly: true });
      assert.equal(count(backup, "seen_jobs"), 167);
      assert.equal(tableExists(backup, "schema_migrations"), false);
      assert.equal(tableExists(backup, "applications"), false);
    } finally {
      backup?.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
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
      fs.rmSync(dir, { recursive: true, force: true });
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
      fs.rmSync(dir, { recursive: true, force: true });
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
      assert.deepEqual(ra.applied, [1, 2, 3]);
      assert.deepEqual(rb.applied, []);
      assert.equal(count(a, "schema_migrations"), 3);
      assert.equal(count(a, "seen_jobs"), 5);
    } finally {
      a.close();
      b.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
