import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TestDb } from "./helpers.ts";
import { freshDb, quietly } from "./helpers.ts";
import type { MarkAppliedForm } from "../lib/tracker-client.ts";
import {
  buildMarkSubmittedRequest,
  buildReferenceRequest,
  buildStatusUpdateRequest,
  callApi,
  initialMarkAppliedForm,
  localInputToDate,
  minInputValue,
  patchApplication,
  statusLabel,
  toLocalInputValue,
  TRACKER_TABS,
} from "../lib/tracker-client.ts";
import { applyReviewAction, parseReviewAction } from "../lib/pipeline/review.ts";
import type { ReviewItem } from "../lib/repositories/review.ts";
import { getReviewItem, listTrackerItems } from "../lib/repositories/review.ts";
import { recordJobListing } from "../lib/repositories/jobs.ts";
import { addApplicationAsset, createApplication, listApplicationEvents, transitionApplication } from "../lib/repositories/applications.ts";

// Phase 2 checkpoint 2d: the /applications tracker UI. The project has no
// browser/component test framework, so the page's behaviour lives in
// lib/tracker-client.ts (tested here, including against the real API layer)
// and its structure is checked from the page source.

const root = path.join(import.meta.dirname, "..");
const pageSource = fs.readFileSync(path.join(root, "app/applications/page.tsx"), "utf8");
const reviewSource = fs.readFileSync(path.join(root, "app/review/page.tsx"), "utf8");
const clientSource = fs.readFileSync(path.join(root, "lib/tracker-client.ts"), "utf8");

let t: TestDb;
let jobCounter = 0;
beforeEach(() => {
  t = quietly(freshDb);
});
afterEach(() => t.close());

function approvedItem(): ReviewItem {
  jobCounter++;
  const job = recordJobListing(t.db, {
    sourceId: "reed", externalId: `ui${jobCounter}`, title: `Role ${jobCounter}`, company: "Acme", url: `https://jobs.example.com/${jobCounter}`,
  });
  const app = createApplication(t.db, { jobId: job.jobId });
  addApplicationAsset(t.db, { applicationId: app.id, kind: "cover_letter", origin: "generated", contentText: "Dear Acme" });
  transitionApplication(t.db, app.id, "ready_for_review", { actor: "system" });
  const ready = getReviewItem(t.db, app.id)!;
  return applyReviewAction(t.db, app.id, parseReviewAction({ action: "approve", reviewedAssetsSha256: ready.assetsHash }));
}

/** An application approved by the user three hours ago (through the trigger-checked raw path). */
function approvedEarlierItem(): ReviewItem {
  jobCounter++;
  const job = recordJobListing(t.db, { sourceId: "reed", externalId: `ui-e${jobCounter}`, title: `Earlier ${jobCounter}`, company: "Acme" });
  const app = createApplication(t.db, { jobId: job.jobId });
  addApplicationAsset(t.db, { applicationId: app.id, kind: "cover_letter", origin: "generated", contentText: "Dear Acme" });
  transitionApplication(t.db, app.id, "ready_for_review", { actor: "system" });
  const ready = getReviewItem(t.db, app.id)!;
  t.db.prepare(
    "INSERT INTO application_events (application_id, event_type, from_status, to_status, actor) VALUES (?, 'status_change', 'ready_for_review', 'approved', 'user')"
  ).run(app.id);
  t.db.prepare(
    `UPDATE applications SET status = 'approved', approved_at = datetime('now', '-3 hours'),
       approved_assets_sha256 = ?, approved_asset_ids = (SELECT group_concat(id) FROM application_assets WHERE application_id = ? AND is_current = 1)
     WHERE id = ?`
  ).run(ready.assetsHash, app.id, app.id);
  return getReviewItem(t.db, app.id)!;
}

/** Sends a body built by the client helpers through the real API layer (what the route does). */
const send = (item: ReviewItem, body: Record<string, unknown>) => applyReviewAction(t.db, item.id, parseReviewAction(body));

const form = (patch: Partial<MarkAppliedForm> = {}): MarkAppliedForm => ({ ...initialMarkAppliedForm(), confirmed: true, ...patch });
const built = <T extends { ok: boolean }>(result: T) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as unknown as { body: Record<string, unknown> }).body;
};
const refused = (result: { ok: boolean; error?: string }) => {
  assert.equal(result.ok, false);
  return (result as { error: string }).error;
};

describe("tracker page structure", () => {
  test("renders the four tracker sections", () => {
    assert.deepEqual(TRACKER_TABS.map((tab) => tab.label), ["Ready to apply", "Applied / in progress", "Closed", "All tracked"]);
    assert.deepEqual(TRACKER_TABS.map((tab) => tab.key), ["to_apply", "applied", "closed", "tracked"]);
    assert.match(pageSource, /TRACKER_TABS\.map/);
    assert.match(pageSource, /callApi<ReviewItem\[\]>\(`\/api\/applications\?status=\$\{tab\}`\)/);
  });

  test("Apply Now is a plain external link that calls and records nothing", () => {
    const component = pageSource.slice(pageSource.indexOf("function ApplyNowLink"), pageSource.indexOf("function ApprovedAssets"));
    assert.match(component, /<a\s/);
    assert.match(component, /href=\{url\}/);
    assert.match(component, /target="_blank"/);
    assert.match(component, /rel="noopener noreferrer"/);
    assert.match(component, /Apply Now/);
    assert.doesNotMatch(component, /onClick|fetch|callApi|patchApplication|mark_submitted|buildMarkSubmittedRequest/);
  });

  test("only the confirmed Mark as applied panel builds a mark_submitted request", () => {
    // The request body is built in one place (lib/tracker-client.ts) …
    assert.equal(pageSource.includes("mark_submitted"), false);
    assert.equal(pageSource.match(/buildMarkSubmittedRequest\(/g)?.length, 1);
    // … called only from the panel's confirm handler, which is behind the confirm checkbox.
    const panel = pageSource.slice(pageSource.indexOf("function MarkAppliedPanel"), pageSource.indexOf("function SubmissionDetails"));
    assert.match(panel, /async function confirm\(\)[\s\S]*buildMarkSubmittedRequest\(item, form\)/);
    assert.match(panel, /disabled=\{!form\.confirmed \|\| saving\}/);
    assert.match(panel, /I have submitted this application on the employer&rsquo;s site/);
    assert.match(clientSource, /action: "mark_submitted"/);
  });

  test("there is no undo, revert or offer-accepted action anywhere in the tracker", () => {
    for (const source of [pageSource, clientSource]) {
      assert.doesNotMatch(source, /\bundo\b|\brevert\b|offer[ _-]?accepted/i);
    }
  });

  test("the tracker never sends email or contacts anything but the Job Agent API", () => {
    for (const source of [pageSource, clientSource]) {
      assert.doesNotMatch(source, /resend|sendEmailCopy|child_process|undici|window\.open/);
    }
    // Every API call goes to /api/applications.
    const urls = [...clientSource.matchAll(/callApi<[^>]+>\(`([^`]+)`/g), ...pageSource.matchAll(/callApi<[^>]+>\(`([^`]+)`/g)].map((m) => m[1]);
    assert.ok(urls.length >= 2);
    for (const url of urls) assert.match(url, /^\/api\/applications/);
  });

  test("review stays on /review, linked to the tracker; approval is not on /applications", () => {
    assert.match(reviewSource, /href="\/applications"/);
    assert.match(reviewSource, /Track in Applications/);
    for (const action of ["approve", "reject", "withdraw", "edit_cover_letter"]) {
      assert.match(reviewSource, new RegExp(`"${action}"|action: "${action}"|${action}`), action);
    }
    assert.doesNotMatch(pageSource, /"approve"|action: "approve"|edit_cover_letter|"reject"/);
    assert.match(pageSource, /href="\/review"/);
  });

  test("status labels: submitted shows as Applied; the existing statuses only", () => {
    assert.equal(statusLabel("submitted"), "Applied");
    assert.equal(statusLabel("approved"), "Ready to apply");
    for (const s of ["acknowledged", "interviewing", "offer", "unsuccessful", "withdrawn"]) assert.ok(statusLabel(s));
  });
});

describe("Mark as applied form", () => {
  test("defaults to now (no date sent) and builds the request for the 2c API", () => {
    const item = approvedItem();
    const body = built(buildMarkSubmittedRequest(item, form()));
    assert.deepEqual(body, {
      action: "mark_submitted",
      confirm: true,
      reviewedAssetsSha256: item.assetsHash,
      submittedContent: "as_approved",
    });
    const done = send(item, body);
    assert.equal(done.status, "submitted");
    assert.equal(done.submission!.method, "manual");
  });

  test("is refused until the user confirms they have applied", () => {
    const item = approvedItem();
    assert.match(refused(buildMarkSubmittedRequest(item, form({ confirmed: false }))), /confirm you have submitted/);
  });

  test("an earlier date can be chosen; it is sent as UTC and kept", () => {
    const item = approvedEarlierItem();
    const now = new Date();
    // One hour ago, as the user would pick it in the date input (local time, minutes).
    const input = toLocalInputValue(new Date(now.getTime() - 60 * 60 * 1000));
    const choice = localInputToDate(input)!;
    const body = built(buildMarkSubmittedRequest(item, form({ dateEdited: true, appliedAtInput: input }), now));
    assert.equal(body.submittedAt, choice.toISOString());
    assert.equal(send(item, body).submission!.submittedAt, choice.toISOString().replace("T", " ").slice(0, 19));
  });

  test("a future date, a date before approval or an invalid date is refused before sending", () => {
    const item = approvedItem();
    const now = new Date();
    const future = toLocalInputValue(new Date(now.getTime() + 2 * 60 * 1000));
    assert.match(refused(buildMarkSubmittedRequest(item, form({ dateEdited: true, appliedAtInput: future }), now)), /future/);
    const beforeApproval = toLocalInputValue(new Date(new Date(`${item.approvedAt!.replace(" ", "T")}Z`).getTime() - 10 * 60 * 1000));
    assert.match(refused(buildMarkSubmittedRequest(item, form({ dateEdited: true, appliedAtInput: beforeApproval }), now)), /before the approval/);
    assert.match(refused(buildMarkSubmittedRequest(item, form({ dateEdited: true, appliedAtInput: "not a date" }), now)), /valid/);
    // The server refuses a future time too, even if a client sent one.
    assert.throws(() => send(item, { action: "mark_submitted", confirm: true, reviewedAssetsSha256: item.assetsHash, submittedAt: new Date(Date.now() + 3600e3).toISOString() }), /future/);
  });

  test("the reference and the external-modification marker are sent correctly", () => {
    const item = approvedItem();
    const body = built(buildMarkSubmittedRequest(item, form({
      reference: "  CONF-555  ",
      note: " Applied via portal ",
      modifiedExternally: true,
      externalChanges: " Shortened the cover letter ",
    })));
    assert.equal(body.reference, "CONF-555");
    assert.equal(body.note, "Applied via portal");
    assert.equal(body.submittedContent, "modified_externally");
    assert.equal(body.externalChanges, "Shortened the cover letter");
    const done = send(item, body);
    assert.equal(done.submission!.reference, "CONF-555");
    assert.equal(done.submission!.submittedContent, "modified_externally");
    assert.equal(done.submission!.externalChanges, "Shortened the cover letter");
  });

  test("missing change details, an over-long reference, or a non-approved item are refused", () => {
    const item = approvedItem();
    assert.match(refused(buildMarkSubmittedRequest(item, form({ modifiedExternally: true, externalChanges: "  " }))), /Describe what you changed/);
    assert.match(refused(buildMarkSubmittedRequest(item, form({ reference: "x".repeat(201) }))), /at most 200/);
    const done = send(item, built(buildMarkSubmittedRequest(item, form())));
    assert.match(refused(buildMarkSubmittedRequest(done, form())), /Only an approved application/);
  });

  test("the date input never offers a time before the approval (rounded up to the minute)", () => {
    const value = minInputValue("2026-10-03 10:34:17");
    const min = localInputToDate(value)!;
    assert.equal(min.toISOString(), "2026-10-03T10:35:00.000Z");
    assert.equal(localInputToDate(minInputValue("2026-10-03 10:34:00"))!.toISOString(), "2026-10-03T10:34:00.000Z");
  });
});

describe("status updates and reference editing through the API", () => {
  function appliedItem(): ReviewItem {
    const item = approvedItem();
    return send(item, built(buildMarkSubmittedRequest(item, form())));
  }

  test("updates follow the server's allowed next statuses", () => {
    let item = appliedItem();
    for (const to of ["acknowledged", "interviewing", "offer"]) {
      assert.ok((item.nextStatuses as string[]).includes(to));
      item = send(item, built(buildStatusUpdateRequest(item, { to, occurredAtInput: "", note: "" })));
      assert.equal(item.status, to);
    }
    // From offer only withdrawn is offered; anything else is refused before sending.
    assert.deepEqual(item.nextStatuses, ["withdrawn"]);
    assert.match(refused(buildStatusUpdateRequest(item, { to: "interviewing", occurredAtInput: "", note: "" })), /cannot move/);
    assert.match(refused(buildStatusUpdateRequest(item, { to: "", occurredAtInput: "", note: "" })), /Choose/);
  });

  test("withdrawal requires a note, which is kept and shown", () => {
    const item = appliedItem();
    assert.match(refused(buildStatusUpdateRequest(item, { to: "withdrawn", occurredAtInput: "", note: "  " })), /needs a note/);
    const done = send(item, built(buildStatusUpdateRequest(item, { to: "withdrawn", occurredAtInput: "", note: "Marked as applied by mistake" })));
    assert.equal(done.status, "withdrawn");
    assert.equal(done.notes, "Marked as applied by mistake");
    assert.deepEqual(done.nextStatuses, []); // final: nothing offered, no undo
  });

  test("an optional occurredAt is validated and recorded", () => {
    const now = new Date();
    const approved = approvedEarlierItem();
    const appliedInput = toLocalInputValue(new Date(now.getTime() - 2 * 60 * 60 * 1000));
    const item = send(approved, built(buildMarkSubmittedRequest(approved, form({ dateEdited: true, appliedAtInput: appliedInput }), now)));
    const future = toLocalInputValue(new Date(now.getTime() + 2 * 60 * 1000));
    assert.match(refused(buildStatusUpdateRequest(item, { to: "acknowledged", occurredAtInput: future, note: "" }, now)), /future/);
    const beforeApplying = toLocalInputValue(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    assert.match(refused(buildStatusUpdateRequest(item, { to: "acknowledged", occurredAtInput: beforeApplying, note: "" }, now)), /before the application date/);
    const anHourAgo = toLocalInputValue(new Date(now.getTime() - 60 * 60 * 1000));
    const done = send(item, built(buildStatusUpdateRequest(item, { to: "acknowledged", occurredAtInput: anHourAgo, note: "" }, now)));
    assert.equal(done.statusHistory.at(-1)!.occurredAt, localInputToDate(anHourAgo)!.toISOString().replace("T", " ").slice(0, 19));
  });

  test("the reference can be added, edited and cleared; each change is audited", () => {
    let item = appliedItem();
    item = send(item, built(buildReferenceRequest(" REF-A ")));
    item = send(item, built(buildReferenceRequest("REF-B")));
    item = send(item, built(buildReferenceRequest("")));
    assert.deepEqual(item.referenceHistory.map((c) => [c.from, c.to]), [[null, "REF-A"], ["REF-A", "REF-B"], ["REF-B", null]]);
    assert.equal(listApplicationEvents(t.db, item.id).filter((e) => e.eventType === "external_update" && e.actor === "user").length, 3);
    assert.match(refused(buildReferenceRequest("x".repeat(201))), /at most 200/);
  });

  test("the approved application appears in Ready to apply, then moves to Applied", () => {
    const item = approvedItem();
    assert.deepEqual(listTrackerItems(t.db, "to_apply").map((i) => i.id), [item.id]);
    send(item, built(buildMarkSubmittedRequest(item, form())));
    assert.deepEqual(listTrackerItems(t.db, "to_apply"), []);
    assert.deepEqual(listTrackerItems(t.db, "applied").map((i) => i.id), [item.id]);
  });
});

describe("API errors shown to the user", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const respond = (status: number, body: unknown) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  };

  test("validation, stale approval and already-applied refusals show the server's explanation", async () => {
    respond(400, { error: "The application date cannot be in the future" });
    await assert.rejects(patchApplication(1, {}), /cannot be in the future/);
    respond(409, { error: "The content confirmed for application 1 is not the approved content; review it again" });
    await assert.rejects(patchApplication(1, {}), /review it again/);
    respond(409, { error: "Application 1 is submitted; only an approved application can be marked as applied" });
    await assert.rejects(patchApplication(1, {}), /only an approved application/);
  });

  test("missing applications, invalid IDs, server errors and network failures stay generic", async () => {
    respond(404, { error: "Application 9 not found" });
    await assert.rejects(patchApplication(9, {}), /not found/);
    await assert.rejects(patchApplication(Number.NaN, {}), /Invalid application/);
    await assert.rejects(patchApplication(-1, {}), /Invalid application/);
    respond(500, { error: "SQLITE_IOERR: disk I/O error at C:\\dev\\..." });
    await assert.rejects(patchApplication(1, {}), (error: Error) => !/SQLITE|C:\\/.test(error.message) && /try again/.test(error.message));
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(callApi("/api/applications?status=applied"), /Could not reach the Job Agent/);
  });

  test("a successful call returns the updated application", async () => {
    respond(200, { id: 1, status: "submitted" });
    assert.deepEqual(await patchApplication(1, { action: "set_reference", reference: "R" }), { id: 1, status: "submitted" });
  });
});
