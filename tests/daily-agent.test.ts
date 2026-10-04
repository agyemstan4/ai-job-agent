import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { TestDb } from "./helpers.ts";
import { count, freshDb, makeTempDir, quietly, removeTempDir } from "./helpers.ts";
import { MIGRATIONS, runMigrations } from "../lib/migrate.ts";
import { runDailyAgent, DAILY_RUN_STALE_MINUTES } from "../lib/pipeline/daily-run.ts";
import type { DailyRunDeps, DiscoveredJob } from "../lib/pipeline/daily-run.ts";
import { getTodaysSavedBrief, recordDefaultCandidateEvent } from "../lib/pipeline/saved-brief.ts";
import { claimBrief, getBrief, getBriefItems, getOpportunityStates, recordOpportunityEvent } from "../lib/repositories/briefs.ts";
import { startRun } from "../lib/repositories/runs.ts";
import { createCandidate, createProfileVersion } from "../lib/repositories/candidates.ts";
import { recordJobListing } from "../lib/repositories/jobs.ts";
import { recordMatch } from "../lib/repositories/matches.ts";
import { putPreferences } from "../lib/pipeline/preferences.ts";
import { loadSavedBrief, sendOpportunityEvent, workedWhileAway } from "../lib/agent-client.ts";
import type { DailyBrief } from "../lib/daily-brief.ts";

// Phase 4b: the daily career agent — scratch/in-memory databases and fake
// discovery/matching only. No network, no email, no preparation.

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

let t: TestDb;
let candidateId: number;
let profileId: number;
let n = 0;

beforeEach(() => {
  t = quietly(freshDb);
  candidateId = createCandidate(t.db, { fullName: "Sam Example" }).id;
  profileId = createProfileVersion(t.db, { candidateId, origin: "ai_extraction", analysis: { technicalSkills: ["Kotlin"] }, structuredCv: { name: "Sam", education: [], projects: [], experience: [] } }).id;
});
afterEach(() => t.close());

/** A job as the existing discovery stores it (listing + description). */
function job(title: string, description = "", salary: [number, number] | null = [36000, 40000]): number {
  n++;
  return recordJobListing(t.db, {
    sourceId: "reed", externalId: `D${n}`, title, company: `Co ${n}`, location: "London", url: `https://example.invalid/${n}`,
    salaryMin: salary?.[0] ?? null, salaryMax: salary?.[1] ?? null, salaryIsPredicted: false, description,
  }).jobId;
}
const score = (jobId: number, value: number) => recordMatch(t.db, { jobId, candidateProfileId: profileId, outcome: "scored", score: value });

/** Fake discovery/matching that behave like the existing pipeline: discovery returns new jobs, matching stores scores. */
function deps(found: { jobId: number; score: number }[] = [], over: Partial<DailyRunDeps> = {}, day = "2026-10-05T05:30:00Z"): DailyRunDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    now: () => new Date(day),
    discover: async () => {
      calls.push("discover");
      return { ok: true, jobs: found.map((f) => ({ jobId: f.jobId, title: "x" }) as DiscoveredJob) };
    },
    match: async ({ jobs }) => {
      calls.push(`match:${jobs.length}`);
      for (const f of found) score(f.jobId, f.score);
      return { ok: true, scored: found.length };
    },
    ...over,
  };
}
const run = (d: DailyRunDeps) => quietly(() => runDailyAgent(t.db, d));

describe("4b: migration 007", () => {
  test("adds the three tables (additively) on a fresh database", () => {
    for (const table of ["daily_briefs", "daily_brief_items", "opportunity_states"]) {
      assert.ok(t.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
    }
    assert.equal((t.db.prepare("SELECT MAX(version) v FROM schema_migrations").get() as { v: number }).v, 7);
  });

  test("v6 → v7 keeps every existing row, backs up first, and is a no-op the second time", () => {
    const dir = makeTempDir();
    const db = new Database(path.join(dir, "jobs.db"));
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      quietly(() => runMigrations(db, { migrations: MIGRATIONS.slice(0, 6) }));
      db.prepare("INSERT INTO candidates (full_name) VALUES ('A')").run();
      db.prepare("INSERT INTO seen_jobs (job_id) VALUES ('reed_1')").run();
      const before = JSON.stringify([db.prepare("SELECT * FROM candidates").all(), db.prepare("SELECT * FROM seen_jobs").all()]);
      const result = quietly(() => runMigrations(db, { backupDir: path.join(dir, "backups") }));
      assert.deepEqual(result.applied, [7]);
      assert.match(path.basename(result.backupPath!), /^jobs\.v6-to-v7\.\d{12}\.db$/);
      assert.ok(fs.existsSync(result.backupPath!));
      assert.equal(JSON.stringify([db.prepare("SELECT * FROM candidates").all(), db.prepare("SELECT * FROM seen_jobs").all()]), before);
      assert.deepEqual(quietly(() => runMigrations(db, { backupDir: path.join(dir, "backups") })).applied, []);
    } finally {
      db.close();
      removeTempDir(dir);
    }
  });

  test("one brief per candidate per day is enforced by the database", () => {
    t.db.prepare("INSERT INTO daily_briefs (candidate_id, brief_date, origin, status, started_at, updated_at) VALUES (?, '2026-10-05', 'scheduled_run', 'ready', 'x', 'x')").run(candidateId);
    assert.throws(() => t.db.prepare("INSERT INTO daily_briefs (candidate_id, brief_date, origin, status, started_at, updated_at) VALUES (?, '2026-10-05', 'scheduled_run', 'building', 'x', 'x')").run(candidateId), /UNIQUE/);
  });
});

describe("4b: the daily run", () => {
  test("creates today's brief from existing discovery + matching + intelligence; records what surfaced", async () => {
    const a = job("Territory Manager", "Company car provided.");
    const b = job("Android Developer");
    const r = await run(deps([{ jobId: a, score: 85 }, { jobId: b, score: 60 }]));
    assert.equal(r.status, "completed");
    if (r.status !== "completed") return;
    assert.equal(r.briefDate, "2026-10-05");
    const brief = getBrief(t.db, candidateId, "2026-10-05")!;
    assert.deepEqual([brief.status, brief.origin, brief.candidateProfileId], ["ready", "scheduled_run", profileId]);
    const items = getBriefItems(t.db, brief.id);
    assert.deepEqual(items.map((i) => [i.jobId, i.rank, i.wasNew]), [[a, 1, true], [b, 2, true]]);
    assert.deepEqual(r.stats, { considered: 2, strongMatches: 1, priorityCount: 2, items: 2, newInBrief: 2, discovered: 2, scored: 2, warnings: [] });
    assert.equal(count(t.db, "opportunity_states", "candidate_id = ?", candidateId), 2);
    assert.equal(count(t.db, "pipeline_runs", "kind = 'full' AND status = 'completed' AND triggered_by = 'scheduler'"), 1);
  });

  test("idempotent: a second run the same day does nothing", async () => {
    score(job("Driver"), 70);
    const first = await run(deps());
    const second = await run(deps());
    assert.equal(first.status, "completed");
    assert.equal(second.status, "already_ready");
    assert.equal(count(t.db, "daily_briefs"), 1);
    assert.equal(count(t.db, "daily_brief_items"), 1);
    assert.equal(count(t.db, "pipeline_runs", "kind = 'full' AND status = 'cancelled'"), 1);
  });

  test("a run already in progress (or a second trigger at the same moment) is refused safely", async () => {
    score(job("Driver"), 70);
    // Another run holds the lock.
    const held = startRun(t.db, { kind: "full", triggeredBy: "scheduler", candidateProfileId: profileId });
    assert.equal((await run(deps())).status, "already_running");
    assert.equal(count(t.db, "daily_briefs"), 0);
    t.db.prepare("UPDATE pipeline_runs SET status = 'completed', finished_at = datetime('now') WHERE id = ?").run(held.id);
    // Two triggers at once: one runs, the other stops at the lock.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = deps([], { discover: async () => { await gate; return { ok: true, jobs: [] }; } });
    const one = quietly(() => runDailyAgent(t.db, slow));
    const two = await run(deps());
    release();
    assert.deepEqual([(await one).status, two.status].sort(), ["already_running", "completed"]);
    assert.equal(count(t.db, "daily_briefs"), 1);
  });

  test("new vs already surfaced: tomorrow only genuinely new opportunities are marked new", async () => {
    const a = job("Territory Manager");
    await run(deps([{ jobId: a, score: 80 }], {}, "2026-10-05T05:30:00Z"));
    const b = job("Field Sales Executive");
    await run(deps([{ jobId: b, score: 75 }], {}, "2026-10-06T05:30:00Z"));
    const day2 = getBriefItems(t.db, getBrief(t.db, candidateId, "2026-10-06")!.id);
    assert.deepEqual(Object.fromEntries(day2.map((i) => [i.jobId, i.wasNew])), { [a]: false, [b]: true });
  });

  test("priority order uses the existing tiers and scores (a confirmed important benefit outranks a higher score)", async () => {
    putPreferences(t.db, { preferences: { targetRoles: ["territory_management"], location: "London", benefits: { companyCar: "important" } } });
    const car = job("Area Manager", "Company car provided.");
    const top = job("Java Developer");
    const weak = job("Sales Assistant");
    const r = await run(deps([{ jobId: car, score: 72 }, { jobId: top, score: 95 }, { jobId: weak, score: 55 }]));
    assert.equal(r.status, "completed");
    const items = getBriefItems(t.db, getBrief(t.db, candidateId, "2026-10-05")!.id);
    assert.deepEqual(items.map((i) => [i.jobId, i.tier]), [[car, 2], [top, 4], [weak, 5]]);
    assert.equal(items[0].headline, "Company car matches an important preference");
  });

  test("individual job failures don't stop the brief (failed matches are left for the next run)", async () => {
    const ok = job("Driver");
    const bad = job("Courier");
    const d = deps([], {
      discover: async () => ({ ok: true, jobs: [{ jobId: ok }, { jobId: bad }] as DiscoveredJob[] }),
      match: async () => {
        score(ok, 70);
        recordMatch(t.db, { jobId: bad, candidateProfileId: profileId, outcome: "failed", error: "model timeout" });
        return { ok: true, scored: 1 };
      },
    });
    const r = await run(d);
    assert.equal(r.status, "completed");
    const items = getBriefItems(t.db, getBrief(t.db, candidateId, "2026-10-05")!.id);
    assert.deepEqual(items.map((i) => i.jobId), [ok]);
  });

  test("failed discovery (an error or a throw): the brief is still built from stored matches, with a warning", async () => {
    score(job("Driver"), 70);
    const r = await run(deps([], { discover: async () => ({ ok: false, error: "discovery HTTP 502" }) }));
    assert.equal(r.status, "completed");
    if (r.status === "completed") assert.deepEqual(r.stats.warnings, ["discovery_failed: discovery HTTP 502"]);
    assert.equal(count(t.db, "daily_brief_items"), 1);
    const view = getTodaysSavedBrief(t.db, new Date("2026-10-05T09:00:00Z"));
    assert.deepEqual(view.brief?.warnings, ["Some job sites couldn't be reached during the last run."]);

    t.close();
    t = quietly(freshDb);
    candidateId = createCandidate(t.db, { fullName: "B" }).id;
    profileId = createProfileVersion(t.db, { candidateId, origin: "ai_extraction", analysis: {}, structuredCv: { name: "B", education: [], projects: [], experience: [] } }).id;
    const thrown = await run(deps([], { discover: async () => { throw new Error("network down"); } }));
    assert.equal(thrown.status, "completed");
    if (thrown.status === "completed") assert.match(String((thrown.stats.warnings as string[])[0]), /^discovery_failed: network down/);
  });

  test("an unexpected failure marks the run and brief failed; the next trigger retries and succeeds", async () => {
    score(job("Driver"), 70);
    t.db.exec("CREATE TEMP TRIGGER break_items BEFORE INSERT ON daily_brief_items BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
    const failed = await run(deps());
    assert.equal(failed.status, "failed");
    assert.equal(getBrief(t.db, candidateId, "2026-10-05")!.status, "failed");
    assert.equal(count(t.db, "daily_brief_items"), 0, "never half-written");
    assert.equal(count(t.db, "pipeline_runs", "kind = 'full' AND status = 'failed'"), 1);
    t.db.exec("DROP TRIGGER break_items");
    const retried = await run(deps());
    assert.equal(retried.status, "completed");
    if (retried.status === "completed") assert.equal(retried.retry, true);
    assert.equal(count(t.db, "daily_briefs"), 1, "the same day's brief is reused");
  });

  test("a crashed run (process restart) is recovered after the stale limit", async () => {
    score(job("Driver"), 70);
    t.db.prepare("INSERT INTO pipeline_runs (kind, triggered_by, status, started_at) VALUES ('full', 'scheduler', 'running', datetime('now', ?))").run(`-${DAILY_RUN_STALE_MINUTES + 5} minutes`);
    t.db.prepare("INSERT INTO daily_briefs (candidate_id, brief_date, origin, status, started_at, updated_at) VALUES (?, '2026-10-05', 'scheduled_run', 'building', datetime('now', '-4 hours'), datetime('now', '-4 hours'))").run(candidateId);
    const r = await run(deps());
    assert.equal(r.status, "completed");
    if (r.status === "completed") assert.equal(r.retry, true);
    assert.equal(count(t.db, "pipeline_runs", "kind = 'full' AND status = 'failed' AND error LIKE 'Abandoned%'"), 1);
  });

  test("a brief being built right now by someone else is left alone", () => {
    t.db.prepare("INSERT INTO daily_briefs (candidate_id, brief_date, origin, status, started_at, updated_at) VALUES (?, '2026-10-05', 'scheduled_run', 'building', datetime('now'), datetime('now'))").run(candidateId);
    return run(deps()).then((r) => assert.equal(r.status, "already_running"));
  });

  test("empty results: a ready, empty brief", async () => {
    const r = await run(deps());
    assert.equal(r.status, "completed");
    assert.equal(count(t.db, "daily_brief_items"), 0);
    const view = getTodaysSavedBrief(t.db, new Date("2026-10-05T09:00:00Z"));
    assert.deepEqual([view.brief?.items.length, view.brief?.considered], [0, 0]);
  });

  test("no CV profile: nothing runs, nothing is written", async () => {
    t.db.prepare("UPDATE candidate_profiles SET is_current = 0").run();
    const d = deps();
    assert.equal((await run(d)).status, "no_profile");
    assert.deepEqual(d.calls, []);
    assert.equal(count(t.db, "daily_briefs") + count(t.db, "pipeline_runs"), 0);
  });

  test("it only orchestrates: no preparation, approval, submission, email or notification", () => {
    const source = read("lib/pipeline/daily-run.ts").split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    assert.doesNotMatch(source, /enqueuePreparation|kickQueue|prepareApplication|approveApplication|submit|sendEmailCopy|email-copies|Notification|fetch\(/);
  });
});

describe("4b: seen / reviewed and multiple candidates", () => {
  test("opening and acting on an opportunity are remembered (first time kept)", async () => {
    const a = job("Driver");
    await run(deps([{ jobId: a, score: 70 }]));
    assert.equal(recordDefaultCandidateEvent(t.db, a, "seen"), true);
    const firstSeen = getOpportunityStates(t.db, candidateId, [a]).get(a)!.seenAt;
    recordDefaultCandidateEvent(t.db, a, "reviewed");
    const state = getOpportunityStates(t.db, candidateId, [a]).get(a)!;
    assert.equal(state.seenAt, firstSeen);
    assert.ok(state.reviewedAt);
    assert.equal(getTodaysSavedBrief(t.db, new Date("2026-10-05T09:00:00Z")).brief?.items[0].viewed, true);
    assert.equal(recordDefaultCandidateEvent(t.db, 999999, "seen"), false, "unknown job refused");
  });

  test("briefs and states are kept per candidate", () => {
    const other = createCandidate(t.db, { fullName: "Other" }).id;
    const a = claimBrief(t.db, { candidateId, candidateProfileId: profileId, briefDate: "2026-10-05", origin: "scheduled_run", staleMinutes: 180 });
    const b = claimBrief(t.db, { candidateId: other, candidateProfileId: null, briefDate: "2026-10-05", origin: "scheduled_run", staleMinutes: 180 });
    assert.deepEqual([a.kind, b.kind], ["claimed", "claimed"]);
    assert.notEqual(a.brief.id, b.brief.id);
    const j = job("Driver");
    recordOpportunityEvent(t.db, other, j, "seen");
    assert.equal(getOpportunityStates(t.db, candidateId, [j]).size, 0);
    assert.equal(getOpportunityStates(t.db, other, [j]).size, 1);
  });
});

describe("4b: Today consumes the saved brief", () => {
  test("the saved brief is composed with live data (an application made since shows its current state)", async () => {
    const a = job("Territory Manager", "Company car provided. Travel expenses paid.");
    await run(deps([{ jobId: a, score: 85 }]));
    const view = getTodaysSavedBrief(t.db, new Date("2026-10-05T09:00:00Z"));
    assert.equal(view.brief?.origin, "scheduled_run");
    assert.equal(view.brief?.items[0].jobId, a);
    assert.deepEqual(view.brief?.items[0].benefits.map((b) => b.id), ["companyCar", "travelExpenses"]);
    assert.equal(view.brief?.away?.newOpportunities, 1);
    assert.equal(getTodaysSavedBrief(t.db, new Date("2026-10-06T09:00:00Z")).brief, null, "no brief for a day that hasn't run");
  });

  test("browser helpers: load the brief, record events, and only claim 'worked while away' for a later scheduled brief", async () => {
    const brief = { origin: "scheduled_run", generatedAt: "2026-10-05T05:31:00Z" } as DailyBrief;
    assert.equal(workedWhileAway(brief, Date.parse("2026-10-04T20:00:00Z")), true);
    assert.equal(workedWhileAway(brief, Date.parse("2026-10-05T08:00:00Z")), false);
    assert.equal(workedWhileAway({ ...brief, origin: "on_demand" }, null), false);
    const urls: string[] = [];
    const fake = async (url: string, init?: RequestInit) => {
      urls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(JSON.stringify(url.includes("brief") ? { brief: null, status: null } : { ok: true }), { status: 200 });
    };
    assert.deepEqual(await loadSavedBrief(fake), { kind: "none", status: null });
    assert.equal(await sendOpportunityEvent(3, "seen", fake), true);
    assert.deepEqual(urls, ["GET /api/agent/brief", "POST /api/agent/opportunity-state"]);
  });

  test("Today and the opportunity view use them; the run route is local-only and reuses the existing handlers", () => {
    const today = read("app/today/page.tsx");
    assert.match(today, /loadSavedBrief\(\)/);
    assert.match(today, /workedWhileAway\(saved\.brief, lastVisit\)/);
    assert.ok(today.includes("Your agent worked while you were away."));
    const opportunity = read("app/opportunity/[id]/page.tsx");
    assert.match(opportunity, /sendOpportunityEvent\(opened\.jobId, "seen"\)/);
    assert.match(opportunity, /sendOpportunityEvent\(match\.jobId, "reviewed"\)/);
    const route = read("app/api/agent/daily-run/route.ts");
    assert.match(route, /import \{ POST as discoverJobs \} from "@\/app\/api\/jobs\/route";/);
    assert.match(route, /import \{ POST as matchJobs \} from "@\/app\/api\/match\/route";/);
    assert.match(route, /if \(!LOCAL\.test\(req\.headers\.get\("host"\) \?\? ""\)\)/);
    const scheduler = read("scripts/scheduler.mjs");
    assert.doesNotMatch(scheduler, /Stanley|technicalSkills|summary:/, "no personal data in the trigger");
  });
});

describe("4b: protected systems unchanged", () => {
  const h = (file: string) => crypto.createHash("sha256").update(read(file).replace(/\r\n/g, "\n")).digest("hex");
  test("discovery, matching, opportunity intelligence, benefits, preferences, the preparation queue and email are byte-identical to 3043c13", () => {
    const pins: Record<string, string> = {
      "app/api/match/route.ts": "ef112d155048614c24e9a4cbb5d3af2d79536891b6891af64e3899d14107e8b2",
      "lib/pipeline/match-scoring.ts": "be378063794df4bd46d250822f0602ec4a4daa0e79046cb964928a38195a7790",
      "app/api/jobs/route.ts": "d8f1e9018619fd947e85483ec9ca58112dcd94e1942ee4569930ec775c8fd1e4",
      "lib/pipeline/opportunity.ts": "be06f22dd5b159b6b713591057a46720816e1796fc6fa0333893af54a4193f89",
      "lib/pipeline/benefits.ts": "0ae0c6bbd0481753d5701b16653ced78f8d5ffe1edf32f5eaab9ab32813d0766",
      "lib/pipeline/preferences.ts": "289992084026b51e2f75818df69b71ff5b03788e6bedbda081c8231249ad1756",
      "lib/pipeline/preparation-queue.ts": "398e35fc5bfbbec9c3d4b41148a5aa89d300828a0006738815a3aa804aa71574",
      "lib/pipeline/preparation-registry.ts": "1453bbb8d2fe50ec1fbb8468585413a3b0dc913ca718b0d52bc03c1783b3c23e",
      "lib/pipeline/prepare.ts": "404d944e54ce5a8d5d21e69aba22d6e5a3c3467d8882a105888957a00ac59026",
      "lib/email-copies.ts": "22126ebc9dbfba7786fd566c4b4bd418918340262628b7e73e7c6334ed3fb4a8",
    };
    for (const [file, hash] of Object.entries(pins)) assert.equal(h(file), hash, file);
  });
});
