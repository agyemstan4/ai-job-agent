import type { DB } from "../repositories/shared.ts";
import { PersistenceError } from "../repositories/shared.ts";
import {
  addApplicationAsset,
  addApplicationNote,
  approveApplication,
  getApplication,
  rejectApplication,
  transitionApplication,
} from "../repositories/applications.ts";
import type { ReviewItem } from "../repositories/review.ts";
import { getReviewItem } from "../repositories/review.ts";

// Step 9: the reviewer's actions. Every action here is a direct user action
// from the review page. Approval only records the user's decision — nothing
// is submitted — and it must confirm the exact content that was reviewed
// (reviewedAssetsSha256), so content that changed in the meantime cannot be
// approved unseen.

export type ReviewAction =
  | { action: "approve"; reviewedAssetsSha256: string; note?: string | null }
  | { action: "reject"; note?: string | null }
  | { action: "withdraw"; note?: string | null }
  | { action: "note"; note: string }
  | { action: "edit_cover_letter"; coverLetter: string };

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

/** Validates an untrusted request body. Throws BAD_REQUEST. */
export function parseReviewAction(body: unknown): ReviewAction {
  const b = (body ?? {}) as Record<string, unknown>;
  const note = text(b.note);
  switch (b.action) {
    case "approve":
      if (typeof b.reviewedAssetsSha256 !== "string" || !b.reviewedAssetsSha256) {
        throw new PersistenceError("BAD_REQUEST", "Approval must include the reviewed content hash");
      }
      return { action: "approve", reviewedAssetsSha256: b.reviewedAssetsSha256, note };
    case "reject":
    case "withdraw":
      return { action: b.action, note };
    case "note":
      if (note === null) throw new PersistenceError("BAD_REQUEST", "A note cannot be empty");
      return { action: "note", note };
    case "edit_cover_letter": {
      const coverLetter = text(b.coverLetter);
      if (coverLetter === null) throw new PersistenceError("BAD_REQUEST", "The cover letter cannot be empty");
      return { action: "edit_cover_letter", coverLetter };
    }
    default:
      throw new PersistenceError("BAD_REQUEST", `Unknown review action: ${String(b.action)}`);
  }
}

/** Applies one reviewer action and returns the updated review item. */
export function applyReviewAction(db: DB, applicationId: number, request: ReviewAction): ReviewItem {
  return db.transaction((): ReviewItem => {
    const application = getApplication(db, applicationId);
    if (!application) throw new PersistenceError("NOT_FOUND", `Application ${applicationId} not found`);

    // A note typed alongside a decision is saved first, as its own event.
    const note = "note" in request ? request.note : null;
    if (note && request.action !== "note" && note !== application.notes) {
      addApplicationNote(db, applicationId, note, "user");
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
    }
    return getReviewItem(db, applicationId)!;
  })();
}

/** HTTP status for a persistence error raised by a review action. */
export function httpStatusFor(error: unknown): number {
  // Refusals raised by the database's own approval-gate triggers.
  if (
    error instanceof Error &&
    /^(APPROVAL_GATE|SUBMISSION_GATE|ASSETS_LOCKED|IMMUTABLE|APPEND_ONLY|AUDIT):/.test(error.message)
  ) {
    return 409;
  }
  if (!(error instanceof PersistenceError)) return 500;
  switch (error.code) {
    case "BAD_REQUEST":
      return 400;
    case "NOT_FOUND":
      return 404;
    default:
      // STALE_REVIEW, INVALID_TRANSITION, NOTHING_TO_APPROVE, GATED_TRANSITION …
      return 409;
  }
}
