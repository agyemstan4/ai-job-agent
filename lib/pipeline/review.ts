import type { DB } from "../repositories/shared.ts";
import { PersistenceError, toDbTimestamp } from "../repositories/shared.ts";
import type { PostSubmissionStatus, SubmittedContent } from "../repositories/applications.ts";
import {
  addApplicationAsset,
  addApplicationNote,
  approveApplication,
  getApplication,
  POST_SUBMISSION_STATUSES,
  recordManualSubmission,
  rejectApplication,
  setSubmissionReference,
  transitionApplication,
  updateSubmittedStatus,
} from "../repositories/applications.ts";
import type { ReviewItem } from "../repositories/review.ts";
import { getReviewItem } from "../repositories/review.ts";

// The user's actions on an application (PATCH /api/applications/[id]).
// Every action here is a direct user action from the UI. Nothing in this file
// submits anything anywhere, opens a website or sends email:
//
// - approve records the user's decision and must confirm the exact content
//   that was reviewed (reviewedAssetsSha256).
// - mark_submitted records that the user applied on the employer's site
//   themselves. It is the ONLY way an application becomes "applied", and it
//   requires an explicit confirm: true — opening a job's website never calls
//   it.
// - update_status and set_reference track what happened afterwards.

export type ReviewAction =
  | { action: "approve"; reviewedAssetsSha256: string; note?: string | null }
  | { action: "reject"; note?: string | null }
  | { action: "withdraw"; note?: string | null }
  | { action: "note"; note: string }
  | { action: "edit_cover_letter"; coverLetter: string }
  | {
      action: "mark_submitted";
      reviewedAssetsSha256: string;
      submittedAt?: string | Date;
      reference?: string | null;
      note?: string | null;
      submittedContent?: SubmittedContent;
      externalChanges?: string | null;
    }
  | { action: "update_status"; to: PostSubmissionStatus; occurredAt?: string | Date; note?: string | null }
  | { action: "set_reference"; reference: string | null };

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

const badRequest = (message: string) => new PersistenceError("BAD_REQUEST", message);

/** An optional free-text field: absent, null or a string; anything else is a bad request. */
function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw badRequest(`${field} must be text`);
  return text(value);
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;

/**
 * A time sent by the client: an ISO 8601 UTC string ending in "Z" (what
 * Date.toISOString() produces) or the stored "YYYY-MM-DD HH:MM:SS" UTC form.
 * Times without a time zone are refused rather than guessed.
 */
function optionalTime(value: unknown, field: string): string | Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw badRequest(`${field} must be a time string`);
  if (ISO_UTC.test(value)) {
    const date = new Date(value);
    // Refuse dates the parser would silently roll over (e.g. Feb 30).
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) {
      throw new PersistenceError("INVALID_TIMESTAMP", `${field} is not a valid date and time`);
    }
    return date;
  }
  return toDbTimestamp(value); // throws INVALID_TIMESTAMP for anything else
}

/** Validates an untrusted request body. Throws BAD_REQUEST (or INVALID_TIMESTAMP). */
export function parseReviewAction(body: unknown): ReviewAction {
  const b = (body ?? {}) as Record<string, unknown>;
  const note = text(b.note);
  switch (b.action) {
    case "approve":
      if (typeof b.reviewedAssetsSha256 !== "string" || !b.reviewedAssetsSha256) {
        throw badRequest("Approval must include the reviewed content hash");
      }
      return { action: "approve", reviewedAssetsSha256: b.reviewedAssetsSha256, note };
    case "reject":
    case "withdraw":
      return { action: b.action, note };
    case "note":
      if (note === null) throw badRequest("A note cannot be empty");
      return { action: "note", note };
    case "edit_cover_letter": {
      const coverLetter = text(b.coverLetter);
      if (coverLetter === null) throw badRequest("The cover letter cannot be empty");
      return { action: "edit_cover_letter", coverLetter };
    }
    case "mark_submitted": {
      // Recording "applied" is never implicit: the user must confirm it.
      if (b.confirm !== true) {
        throw badRequest("Confirm that you have submitted this application on the employer's site");
      }
      if (typeof b.reviewedAssetsSha256 !== "string" || !b.reviewedAssetsSha256) {
        throw badRequest("Marking as applied must include the approved content hash");
      }
      if (
        b.submittedContent !== undefined &&
        b.submittedContent !== "as_approved" &&
        b.submittedContent !== "modified_externally"
      ) {
        throw badRequest('submittedContent must be "as_approved" or "modified_externally"');
      }
      return {
        action: "mark_submitted",
        reviewedAssetsSha256: b.reviewedAssetsSha256,
        submittedAt: optionalTime(b.submittedAt, "submittedAt"),
        reference: optionalText(b.reference, "reference"),
        note: optionalText(b.note, "note"),
        submittedContent: b.submittedContent as SubmittedContent | undefined,
        externalChanges: optionalText(b.externalChanges, "externalChanges"),
      };
    }
    case "update_status": {
      if (typeof b.to !== "string" || !(POST_SUBMISSION_STATUSES as readonly string[]).includes(b.to)) {
        throw badRequest(`Status must be one of: ${POST_SUBMISSION_STATUSES.join(", ")}`);
      }
      const updateNote = optionalText(b.note, "note");
      // Withdrawing after applying (including correcting a mistaken "Applied")
      // must say why; there is no undo.
      if (b.to === "withdrawn" && updateNote === null) {
        throw badRequest("Withdrawing a submitted application requires a note explaining why");
      }
      return {
        action: "update_status",
        to: b.to as PostSubmissionStatus,
        occurredAt: optionalTime(b.occurredAt, "occurredAt"),
        note: updateNote,
      };
    }
    case "set_reference":
      if (!("reference" in b)) throw badRequest("set_reference must include a reference (or null to clear it)");
      return { action: "set_reference", reference: optionalText(b.reference, "reference") };
    default:
      throw badRequest(`Unknown review action: ${String(b.action)}`);
  }
}

/** Applies one user action and returns the updated application. */
export function applyReviewAction(db: DB, applicationId: number, request: ReviewAction): ReviewItem {
  return db.transaction((): ReviewItem => {
    const application = getApplication(db, applicationId);
    if (!application) throw new PersistenceError("NOT_FOUND", `Application ${applicationId} not found`);

    // A note typed alongside a review decision is saved first, as its own
    // event. (mark_submitted and update_status save their notes themselves.)
    if (
      (request.action === "approve" || request.action === "reject" || request.action === "withdraw") &&
      request.note &&
      request.note !== application.notes
    ) {
      addApplicationNote(db, applicationId, request.note, "user");
    }

    switch (request.action) {
      case "approve":
        approveApplication(db, applicationId, { reviewedAssetsSha256: request.reviewedAssetsSha256 });
        break;
      case "reject":
        rejectApplication(db, applicationId);
        break;
      case "withdraw":
        transitionApplication(db, applicationId, "withdrawn", { actor: "user", detail: "Withdrawn by user" });
        break;
      case "note":
        addApplicationNote(db, applicationId, request.note, "user");
        break;
      case "edit_cover_letter":
        addApplicationAsset(db, {
          applicationId,
          kind: "cover_letter",
          origin: "user_edit",
          contentText: request.coverLetter,
          mimeType: "text/plain",
          actor: "user",
        });
        break;
      case "mark_submitted":
        recordManualSubmission(db, applicationId, {
          reviewedAssetsSha256: request.reviewedAssetsSha256,
          submittedAt: request.submittedAt,
          reference: request.reference,
          note: request.note,
          submittedContent: request.submittedContent,
          externalChanges: request.externalChanges,
        });
        break;
      case "update_status":
        updateSubmittedStatus(db, applicationId, {
          to: request.to,
          occurredAt: request.occurredAt,
          note: request.note,
        });
        break;
      case "set_reference":
        setSubmissionReference(db, applicationId, request.reference);
        break;
    }
    return getReviewItem(db, applicationId)!;
  })();
}

/** HTTP status for an error raised by a user action. */
export function httpStatusFor(error: unknown): number {
  // Refusals raised by the database's own approval/submission triggers.
  if (
    error instanceof Error &&
    /^(APPROVAL_GATE|SUBMISSION_GATE|ASSETS_LOCKED|IMMUTABLE|APPEND_ONLY|AUDIT):/.test(error.message)
  ) {
    return 409;
  }
  if (!(error instanceof PersistenceError)) return 500;
  switch (error.code) {
    case "BAD_REQUEST":
    case "INVALID_INPUT":
    case "INVALID_TIMESTAMP":
      return 400;
    case "NOT_FOUND":
      return 404;
    default:
      // STALE_REVIEW, INVALID_TRANSITION, APPROVAL_REQUIRED, NOTHING_TO_APPROVE, GATED_TRANSITION …
      return 409;
  }
}

/** The message safe to return to the client: never internal details for unexpected errors. */
export function clientErrorMessage(error: unknown, fallback: string): string {
  return httpStatusFor(error) === 500 || !(error instanceof Error) ? fallback : error.message;
}
