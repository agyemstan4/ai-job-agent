import { describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Dashboard, DashboardMatch } from "../lib/pipeline/dashboard.ts";
import type { PreparationStatus } from "../lib/pipeline/preparation-queue.ts";
import { awayLines, buildDailyBrief, markViewed, readViewed, TIER_TEXT, VIEWED_KEY } from "../lib/daily-brief.ts";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  loadNotificationSettings,
  NOTIFICATION_SETTINGS_KEY,
  NOTIFICATIONS_DELIVERY_ENABLED,
  notificationSupport,
  parseNotificationSettings,
  saveNotificationSettings,
} from "../lib/notifications.ts";
import { activeSection } from "../lib/nav.ts";
import manifest from "../app/manifest.ts";

// Phase 4a: the daily brief, mobile Today and the notification foundation.

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

let id = 0;
function match(over: Partial<DashboardMatch> = {}): DashboardMatch {
  id++;
  return {
    matchId: id, jobId: id, score: 60, title: `Job ${id}`, company: `Co ${id}`, location: "London", salaryMin: 30000, salaryMax: 35000,
    salaryIsPredicted: false, contractTime: null, contractType: null, url: null, sources: ["reed"], reason: null, strengths: [], missingSkills: [],
    breakdown: null, postedAt: null, firstSeenAt: "2026-10-01 09:00:00", matchedAt: "2026-10-01 09:00:00", promptVersion: "match/v3",
    application: null, benefits: [], requirements: [], standsOut: [], preferenceFit: [], benefitSummary: null, cautions: [],
    opportunity: {
      roleFit: { status: "no_match", via: null, direction: null },
      locationFit: { status: "match", jobLocation: "London", preferred: "London" },
      compensation: { status: "stated", meetsMinimum: null, minimum: null },
      benefitFit: { items: [], distinctions: [] },
      evidence: { source: "advert_summary", chars: 300, limited: true },
    },
    ...over,
  };
}
function dashboard(topMatches: DashboardMatch[], over: Partial<Dashboard["stats"]> = {}): Dashboard {
  return {
    hasProfile: true, firstName: "Sam",
    search: { usingPreferences: true, location: "London", terms: ["territory manager"], roles: ["Territory Management"], minSalary: null, benefits: {} },
    agent: { lastDiscoveryAt: "2026-10-04 08:00:00", lastMatchingAt: "2026-10-04 08:05:00" },
    stats: { discoveredJobs: 40, scoredMatches: topMatches.length, strongMatches: topMatches.filter((m) => (m.score ?? 0) >= 70).length, strongToday: 0, preparing: 0, needsReview: 0, readyToApply: 0, submitted: 0, applicationsByStatus: {}, ...over },
    strongMatchScore: 70,
    topMatches,
  };
}
const NOW = new Date("2026-10-04T09:00:00Z");

describe("4a: daily brief structure", () => {
  test("built from existing data: counts, date, origin, at most 10 ranked items and 3 to review first", () => {
    const ms = Array.from({ length: 14 }, (_, i) => match({ score: 50 + i * 3 }));
    const b = buildDailyBrief(dashboard(ms), null, { now: NOW });
    assert.equal(b.origin, "on_demand", "never claims a scheduled run");
    assert.equal(b.date, "2026-10-04");
    assert.equal(b.generatedAt, NOW.toISOString());
    assert.equal(b.considered, 14);
    assert.equal(b.items.length, 10);
    assert.equal(b.priorityCount, 3);
    assert.deepEqual(b.items.map((i) => i.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(b.lastSearchAt, "2026-10-04 08:00:00");
  });

  test("A/B: no CV, or no opportunities — an honest empty brief", () => {
    const empty = buildDailyBrief({ ...dashboard([]), hasProfile: false }, null, { now: NOW });
    assert.deepEqual([empty.hasProfile, empty.items, empty.considered, empty.priorityCount, empty.away], [false, [], 0, 0, null]);
    const none = buildDailyBrief(dashboard([]), null, { now: NOW, lastVisit: NOW.getTime() - 1 });
    assert.deepEqual([none.items.length, none.away], [0, null]);
  });

  test("only opportunities you can still act on; one per job (no duplicates)", () => {
    const applied = match({ application: { id: 9, status: "submitted" } });
    const declined = match({ application: { id: 10, status: "rejected" } }); // free again → still an opportunity
    const a = match({ jobId: 500 });
    const dup = match({ jobId: 500, score: 99 });
    const b = buildDailyBrief(dashboard([applied, declined, a, dup]), null, { now: NOW });
    assert.ok(!b.items.some((i) => i.matchId === applied.matchId));
    assert.ok(b.items.some((i) => i.matchId === declined.matchId));
    assert.equal(b.items.filter((i) => i.jobId === 500).length, 1);
    assert.equal(new Set(b.items.map((i) => i.matchId)).size, b.items.length);
  });
});

describe("4a: explainable priority (no new score)", () => {
  test("tiers from existing signals, then the existing match score", () => {
    const ready = match({ score: 55, application: { id: 1, status: "ready_for_review" } });
    const strongCar = match({ score: 72, preferenceFit: [{ id: "companyCar", label: "Company car", priority: "important", status: "confirmed", evidence: null }], standsOut: ["Company car matches an important preference"] });
    const strongRole = match({ score: 90, opportunity: { ...match().opportunity, roleFit: { status: "match", via: "category", direction: "Territory Management" } } });
    const strongOnly = match({ score: 95 });
    const weak = match({ score: 65 });
    const b = buildDailyBrief(dashboard([weak, strongOnly, strongRole, strongCar, ready]), null, { now: NOW });
    assert.deepEqual(b.items.map((i) => i.matchId), [ready.matchId, strongCar.matchId, strongRole.matchId, strongOnly.matchId, weak.matchId]);
    assert.deepEqual(b.items.map((i) => i.whyHere), [TIER_TEXT[1], TIER_TEXT[2], TIER_TEXT[3], TIER_TEXT[4], TIER_TEXT[5]]);
    assert.equal(b.items[0].headline, "Your application is ready to review");
    assert.equal(b.items[1].headline, "Company car matches an important preference");
    // Scores are carried through untouched.
    assert.deepEqual(b.items.map((i) => i.score), [55, 72, 90, 95, 65]);
  });

  test("within a tier: higher score first; on a tie, the new opportunity first", () => {
    const old = match({ score: 80, firstSeenAt: "2026-10-01 09:00:00" });
    const fresh = match({ score: 80, firstSeenAt: "2026-10-04 07:00:00" });
    const higher = match({ score: 85 });
    const b = buildDailyBrief(dashboard([old, fresh, higher]), null, { now: NOW, lastVisit: Date.parse("2026-10-03T00:00:00Z") });
    assert.deepEqual(b.items.map((i) => i.matchId), [higher.matchId, fresh.matchId, old.matchId]);
  });

  test("an unclear benefit you care about does not lift a job into tier 2", () => {
    const m = match({ score: 80, preferenceFit: [{ id: "companyCar", label: "Company car", priority: "important", status: "unclear", evidence: null }] });
    assert.equal(buildDailyBrief(dashboard([m]), null, { now: NOW }).items[0].tier, 4);
  });
});

describe("4a: card data — evidence only", () => {
  test("only confirmed benefits, yours first, at most two", () => {
    const m = match({
      benefits: [
        { id: "companyCar", label: "Company car", status: "confirmed", evidence: "Company car provided", priority: "important", note: null },
        { id: "travelExpenses", label: "Travel expenses paid", status: "confirmed", evidence: "x", priority: "important", note: null },
        { id: "pension", label: "Pension", status: "confirmed", evidence: "x", priority: null, note: null },
        { id: "accommodation", label: "Accommodation provided", status: "unclear", evidence: "x", priority: "preferred", note: "…" },
      ],
    });
    const item = buildDailyBrief(dashboard([m]), null, { now: NOW }).items[0];
    assert.deepEqual(item.benefits.map((b) => b.id), ["companyCar", "travelExpenses"]);
    const silent = buildDailyBrief(dashboard([match()]), null, { now: NOW }).items[0];
    assert.deepEqual(silent.benefits, [], "no benefits invented for a silent advert");
  });

  test("new vs seen, viewed on this device, and preparation status", () => {
    const fresh = match({ firstSeenAt: "2026-10-04 07:00:00" });
    const old = match({ firstSeenAt: "2026-09-01 07:00:00", application: { id: 77, status: "preparing" } });
    const prep: PreparationStatus = {
      summary: { preparing: 0, queued: 1, ready: 0, failed: 0, needsAttention: 0 },
      items: [{ applicationId: 77, matchId: old.matchId, jobId: old.jobId, title: "", company: "", state: "queued", queuePosition: 1, stages: [], currentStage: null, error: null, updatedAt: "2026-10-04 08:00:00" }],
      limits: { workers: 2, ollama: 1, pdf: 1 },
    };
    const b = buildDailyBrief(dashboard([fresh, old]), prep, { now: NOW, lastVisit: Date.parse("2026-10-03T00:00:00Z"), viewed: new Set([old.matchId]) });
    const f = b.items.find((i) => i.matchId === fresh.matchId)!;
    const o = b.items.find((i) => i.matchId === old.matchId)!;
    assert.deepEqual([f.isNew, f.viewed, f.preparation], [true, false, "not_started"]);
    assert.deepEqual([o.isNew, o.viewed, o.preparation, o.applicationId], [false, true, "queued", 77]);
    // First visit: nothing is "new".
    assert.equal(buildDailyBrief(dashboard([fresh]), null, { now: NOW }).items[0].isNew, false);
  });
});

describe("4a: while you were away", () => {
  test("counts what changed since your last visit; only real, non-zero facts", () => {
    const since = Date.parse("2026-10-03T00:00:00Z");
    const ms = [
      match({ score: 85, firstSeenAt: "2026-10-04 07:00:00", preferenceFit: [{ id: "companyCar", label: "Company car", priority: "important", status: "confirmed", evidence: null }] }),
      match({ score: 60, firstSeenAt: "2026-10-04 07:30:00" }),
      match({ score: 90, firstSeenAt: "2026-09-20 07:00:00" }),
    ];
    const b = buildDailyBrief(dashboard(ms, { needsReview: 3 }), null, { now: NOW, lastVisit: since });
    assert.deepEqual(b.away, { newOpportunities: 2, newStrong: 1, withPrioritisedBenefits: 1, applicationsReady: 3, prepared: 0 });
    assert.deepEqual(awayLines(b.away!), ["2 new opportunities", "1 strong match", "1 with benefits you prioritised", "3 applications ready for review"]);
    assert.equal(buildDailyBrief(dashboard([ms[2]]), null, { now: NOW, lastVisit: since }).away, null, "nothing new → no banner");
    assert.equal(buildDailyBrief(dashboard(ms), null, { now: NOW }).away, null, "first visit → no banner");
  });
});

describe("4a: notification foundation — nothing is sent", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
  };

  test("delivery is off; defaults; choices saved per device; bad data falls back to defaults", () => {
    assert.equal(NOTIFICATIONS_DELIVERY_ENABLED, false);
    assert.deepEqual(DEFAULT_NOTIFICATION_SETTINGS, { morningBrief: true, standoutOpportunity: true, applicationReady: true, applicationFollowUp: false });
    const store = memory();
    assert.equal(saveNotificationSettings(store, { ...DEFAULT_NOTIFICATION_SETTINGS, morningBrief: false }), true);
    assert.equal(loadNotificationSettings(store).morningBrief, false);
    store.setItem(NOTIFICATION_SETTINGS_KEY, "{broken");
    assert.deepEqual(loadNotificationSettings(store), DEFAULT_NOTIFICATION_SETTINGS);
    assert.deepEqual(parseNotificationSettings({ morningBrief: "yes", extra: 1 }), DEFAULT_NOTIFICATION_SETTINGS);
    assert.deepEqual(loadNotificationSettings(null), DEFAULT_NOTIFICATION_SETTINGS);
  });

  test("support is only read, never requested", () => {
    assert.deepEqual(notificationSupport({}), { notifications: false, serviceWorker: false, push: false, permission: "unsupported", installed: false });
    const fake = { Notification: { permission: "default" }, navigator: { serviceWorker: {} }, PushManager: {}, matchMedia: () => ({ matches: true }) };
    assert.deepEqual(notificationSupport(fake), { notifications: true, serviceWorker: true, push: true, permission: "default", installed: true });
  });

  test("no code path sends, subscribes, registers a worker or asks for permission", () => {
    for (const file of ["lib/notifications.ts", "app/today/page.tsx", "lib/daily-brief.ts", "app/opportunity/[id]/page.tsx"]) {
      const source = read(file);
      assert.doesNotMatch(source, /requestPermission|new Notification\(|showNotification|pushManager|\.subscribe\(|serviceWorker\.register|sendEmailCopy|\/api\/(jobs|analyse-and-extract|match|cover-letter|generate-cv-docx)/, file);
    }
    assert.equal(fs.existsSync(path.join(root, "public/sw.js")), false, "no service worker yet");
  });
});

describe("4a: installable app", () => {
  const png = (file: string) => {
    const b = fs.readFileSync(path.join(root, "public", file));
    assert.equal(b.subarray(1, 4).toString(), "PNG", file);
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  };

  test("manifest: name, opens on Today, standalone, real 192/512/maskable icons", () => {
    const m = manifest();
    assert.equal(m.name, "Job Agent");
    assert.equal(m.start_url, "/today");
    assert.equal(m.display, "standalone");
    assert.equal(m.theme_color, "#4f46e5");
    for (const icon of m.icons ?? []) {
      const [w, h] = png(icon.src.slice(1));
      assert.equal(`${w}x${h}`, icon.sizes, icon.src);
    }
    assert.ok((m.icons ?? []).some((i) => i.purpose === "maskable"));
    assert.deepEqual(png("icons/apple-touch-icon.png"), [180, 180]);
  });

  test("layout: theme colour, safe areas and home-screen metadata", () => {
    const layout = read("app/layout.tsx");
    assert.match(layout, /export const viewport: Viewport = \{[\s\S]*themeColor: "#4f46e5"[\s\S]*viewportFit: "cover"/);
    assert.match(layout, /appleWebApp: \{ capable: true, title: "Job Agent"/);
  });

  test("navigation: Today in both bars; an opportunity belongs to Today", () => {
    assert.equal(activeSection("/today"), "/today");
    assert.equal(activeSection("/opportunity/12"), "/today");
    assert.equal(activeSection("/review"), "/applications");
    assert.match(read("app/components/AppNav.tsx"), /grid grid-cols-5/);
  });
});

describe("4a: Today and the opportunity view (source checks)", () => {
  const today = read("app/today/page.tsx");
  const opportunity = read("app/opportunity/[id]/page.tsx");

  test("Today reads the same data as Home and never searches or claims an overnight run", () => {
    assert.match(today, /Promise\.all\(\[loadDashboard\(\), loadPreparationStatus\(\)\]\)/);
    assert.match(today, /buildDailyBrief\(result\.dashboard, prep, \{ lastVisit, viewed \}\)/);
    assert.ok(today.includes("Based on the jobs your agent has found so far"));
    assert.doesNotMatch(today, /overnight|while you slept|searched for you today/i);
    for (const text of ["Worth reviewing first", "While you were away", "Review opportunity", "Phone notifications", "Not switched on yet"]) assert.ok(today.includes(text), text);
  });

  test("the opportunity view: one next step, reuses the existing actions, never submits", () => {
    assert.match(opportunity, /useParams<\{ id: string \}>\(\)/);
    assert.match(opportunity, /await queuePreparation\(match\.matchId, \{\}\)/, "Prepare uses the existing queue");
    assert.match(opportunity, /<PrimaryAction action=\{action\}/);
    assert.ok(opportunity.includes("Nothing is ever submitted for you"));
    assert.ok(opportunity.includes('href="/today"'));
  });
});

describe("4a: protected systems unchanged", () => {
  const h = (file: string) => crypto.createHash("sha256").update(read(file).replace(/\r\n/g, "\n")).digest("hex");
  test("match/v3, opportunity intelligence, benefits, preferences, discovery, the preparation queue, email and the scheduler are byte-identical to 59aafd9", () => {
    const pins: Record<string, string> = {
      "app/api/match/route.ts": "ef112d155048614c24e9a4cbb5d3af2d79536891b6891af64e3899d14107e8b2",
      "lib/pipeline/match-scoring.ts": "be378063794df4bd46d250822f0602ec4a4daa0e79046cb964928a38195a7790",
      "lib/pipeline/opportunity.ts": "be06f22dd5b159b6b713591057a46720816e1796fc6fa0333893af54a4193f89",
      "lib/pipeline/benefits.ts": "0ae0c6bbd0481753d5701b16653ced78f8d5ffe1edf32f5eaab9ab32813d0766",
      "lib/pipeline/preferences.ts": "289992084026b51e2f75818df69b71ff5b03788e6bedbda081c8231249ad1756",
      "app/api/jobs/route.ts": "d8f1e9018619fd947e85483ec9ca58112dcd94e1942ee4569930ec775c8fd1e4",
      "lib/pipeline/preparation-queue.ts": "398e35fc5bfbbec9c3d4b41148a5aa89d300828a0006738815a3aa804aa71574",
      "lib/pipeline/preparation-registry.ts": "1453bbb8d2fe50ec1fbb8468585413a3b0dc913ca718b0d52bc03c1783b3c23e",
      "lib/pipeline/prepare.ts": "404d944e54ce5a8d5d21e69aba22d6e5a3c3467d8882a105888957a00ac59026",
      "lib/email-copies.ts": "22126ebc9dbfba7786fd566c4b4bd418918340262628b7e73e7c6334ed3fb4a8",
      "scripts/scheduler.mjs": "c2456d2b8435811c96621b038fe06b862ec9c61ac4544bec3aabab1de1b8e119",
    };
    for (const [file, hash] of Object.entries(pins)) assert.equal(h(file), hash, file);
  });
});

describe("4a: viewed opportunities (this device)", () => {
  test("remembered safely; bad data or no storage is harmless", () => {
    const data = new Map<string, string>();
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    markViewed(store, 4);
    markViewed(store, 4);
    markViewed(store, 9);
    assert.deepEqual([...readViewed(store)], [4, 9]);
    data.set(VIEWED_KEY, "not json");
    assert.deepEqual([...readViewed(store)], []);
    assert.deepEqual([...readViewed(null)], []);
    assert.doesNotThrow(() => markViewed(null, 1));
  });
});
