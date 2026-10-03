import type { DB } from "./shared.ts";
import { assetSetHash, fromJson, nowIso, PersistenceError, sha256, toDbTimestamp, toJson } from "./shared.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export type ApplicationStatus =
  | "preparing"
  | "preparation_failed"
  | "ready_for_review"
  | "approved"
  | "rejected"
  | "submitting"
  | "submitted"
  | "submission_failed"
  | "acknowledged"
  | "interviewing"
  | "offer"
  | "unsuccessful"
  | "withdrawn";

export type Actor = "user" | "system" | "scheduler";
export type AssetKind = "tailored_cv_data" | "tailored_cv_file" | "cover_letter" | "question_answers";
export type SubmissionMethod = "manual" | "email" | "api";

export type Application = {
  id: number;
  jobId: number;
  matchId: number | null;
  candidateProfileId: number | null;
  runId: number | null;
  status: ApplicationStatus;
  approvedAt: string | null;
  approvedAssetsSha256: string | null;
  /** Ordered IDs of the assets that were approved (immutable, so they identify the content). */
  approvedAssetIds: string | null;
  submissionMethod: SubmissionMethod | null;
  submittedAt: string | null;
  submissionReference: string | null;
  notes: string | null;
  lastError: string | null;
  legacyBatchResultId: number | null;
  createdAt: string;
  updatedAt: string;
};

type ApplicationRow = {
  id: number;
  job_id: number;
  match_id: number | null;
  candidate_profile_id: number | null;
  run_id: number | null;
  status: ApplicationStatus;
  approved_at: string | null;
  approved_assets_sha256: string | null;
  approved_asset_ids: string | null;
  submission_method: SubmissionMethod | null;
  submitted_at: string | null;
  submission_reference: string | null;
  notes: string | null;
  last_error: string | null;
  legacy_batch_result_id: number | null;
  created_at: string;
  updated_at: string;
};

function toApplication(row: ApplicationRow): Application {
  return {
    id: row.id,
    jobId: row.job_id,
    matchId: row.match_id,
    candidateProfileId: row.candidate_profile_id,
    runId: row.run_id,
    status: row.status,
    approvedAt: row.approved_at,
    approvedAssetsSha256: row.approved_assets_sha256,
    approvedAssetIds: row.approved_asset_ids,
    submissionMethod: row.submission_method,
    submittedAt: row.submitted_at,
    submissionReference: row.submission_reference,
    notes: row.notes,
    lastError: row.last_error,
    legacyBatchResultId: row.legacy_batch_result_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type ApplicationAsset = {
  id: number;
  applicationId: number;
  kind: AssetKind;
  version: number;
  isCurrent: boolean;
  origin: "generated" | "user_edit" | "legacy_import";
  parentAssetId: number | null;
  contentText: string | null;
  contentJson: unknown;
  filename: string | null;
  mimeType: string | null;
  sha256: string;
  hasFile: boolean;
  model: string | null;
  promptVersion: string | null;
  sourceJobDescriptionId: number | null;
  createdAt: string;
};

type AssetRow = {
  id: number;
  application_id: number;
  kind: AssetKind;
  version: number;
  is_current: number;
  origin: "generated" | "user_edit" | "legacy_import";
  parent_asset_id: number | null;
  content_text: string | null;
  content_json: string | null;
  filename: string | null;
  mime_type: string | null;
  sha256: string;
  has_file: number;
  model: string | null;
  prompt_version: string | null;
  source_job_description_id: number | null;
  created_at: string;
};

// Blobs are only loaded by getAssetFile, so listings stay light.
const ASSET_COLUMNS = `id, application_id, kind, version, is_current, origin, parent_asset_id,
  content_text, content_json, filename, mime_type, sha256, (file_blob IS NOT NULL) AS has_file,
  model, prompt_version, source_job_description_id, created_at`;

function toAsset(row: AssetRow): ApplicationAsset {
  return {
    id: row.id,
    applicationId: row.application_id,
    kind: row.kind,
    version: row.version,
    isCurrent: row.is_current === 1,
    origin: row.origin,
    parentAssetId: row.parent_asset_id,
    contentText: row.content_text,
    contentJson: fromJson<unknown>(row.content_json),
    filename: row.filename,
    mimeType: row.mime_type,
    sha256: row.sha256,
    hasFile: row.has_file === 1,
    model: row.model,
    promptVersion: row.prompt_version,
    sourceJobDescriptionId: row.source_job_description_id,
    createdAt: row.created_at,
  };
}

export type ApplicationEvent = {
  id: number;
  applicationId: number;
  eventType: string;
  fromStatus: ApplicationStatus | null;
  toStatus: ApplicationStatus | null;
  actor: Actor | "migration";
  detail: string | null;
  payload: unknown;
  createdAt: string;
};

type EventRow = {
  id: number;
  application_id: number;
  event_type: string;
  from_status: ApplicationStatus | null;
  to_status: ApplicationStatus | null;
  actor: Actor | "migration";
  detail: string | null;
  payload_json: string | null;
  created_at: string;
};

function toEvent(row: EventRow): ApplicationEvent {
  return {
    id: row.id,
    applicationId: row.application_id,
    eventType: row.event_type,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actor: row.actor,
    detail: row.detail,
    payload: fromJson<unknown>(row.payload_json),
    createdAt: row.created_at,
  };
}

// ── State machine ───────────────────────────────────────────────────────────
//
// Transitions to "approved", "submitting", "submitted" and "submission_failed"
// are NOT available through transitionApplication: they only happen through
// approveApplication, beginSubmission and recordSubmissionResult, and the
// database triggers in migration 002 enforce the same rules independently.

const ALLOWED_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  preparing: ["ready_for_review", "preparation_failed", "withdrawn"],
  preparation_failed: ["preparing", "withdrawn"],
  ready_for_review: ["approved", "rejected", "preparing", "withdrawn"],
  approved: ["ready_for_review", "rejected", "submitting", "withdrawn"],
  rejected: ["ready_for_review"],
  submitting: ["submitted", "submission_failed"],
  submission_failed: ["submitting", "ready_for_review", "withdrawn"],
  submitted: ["acknowledged", "interviewing", "offer", "unsuccessful", "withdrawn"],
  acknowledged: ["interviewing", "offer", "unsuccessful", "withdrawn"],
  interviewing: ["offer", "unsuccessful", "withdrawn"],
  offer: ["withdrawn"],
  unsuccessful: [],
  withdrawn: [],
};

const GATED_STATUSES: ApplicationStatus[] = ["approved", "submitting", "submitted", "submission_failed"];

// Statuses that free a job for a new application.
const INACTIVE_STATUSES: ApplicationStatus[] = ["rejected", "withdrawn", "unsuccessful", "preparation_failed"];

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// ── Internal helpers ────────────────────────────────────────────────────────

function requireApplication(db: DB, id: number): Application {
  const application = getApplication(db, id);
  if (!application) throw new PersistenceError("NOT_FOUND", `Application ${id} not found`);
  return application;
}

function insertEvent(
  db: DB,
  event: {
    applicationId: number;
    eventType: string;
    fromStatus?: ApplicationStatus | null;
    toStatus?: ApplicationStatus | null;
    actor: Actor;
    detail?: string | null;
    payload?: unknown;
  }
): void {
  db.prepare(
    `INSERT INTO application_events
       (application_id, event_type, from_status, to_status, actor, detail, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.applicationId,
    event.eventType,
    event.fromStatus ?? null,
    event.toStatus ?? null,
    event.actor,
    event.detail ?? null,
    toJson(event.payload),
    nowIso()
  );
}

function setStatus(db: DB, id: number, status: ApplicationStatus, extra: Record<string, unknown> = {}) {
  const columns = Object.keys(extra);
  db.prepare(
    `UPDATE applications SET status = ?, updated_at = ?${columns.map((c) => `, ${c} = ?`).join("")}
     WHERE id = ?`
  ).run(status, nowIso(), ...columns.map((c) => extra[c]), id);
}

// ── Applications ────────────────────────────────────────────────────────────

export function getApplication(db: DB, id: number): Application | null {
  const row = db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as ApplicationRow | undefined;
  return row ? toApplication(row) : null;
}

export function listApplications(
  db: DB,
  options: { status?: ApplicationStatus; limit?: number } = {}
): Application[] {
  return (
    db
      .prepare(
        `SELECT * FROM applications WHERE (? IS NULL OR status = ?)
         ORDER BY updated_at DESC, id DESC LIMIT ?`
      )
      .all(options.status ?? null, options.status ?? null, options.limit ?? -1) as ApplicationRow[]
  ).map(toApplication);
}

/** The job's active application, if any (legacy imports included). */
export function getActiveApplicationForJob(db: DB, jobId: number): Application | null {
  const row = db
    .prepare(
      `SELECT * FROM applications
       WHERE job_id = ? AND status NOT IN (${INACTIVE_STATUSES.map(() => "?").join(", ")})
       ORDER BY id DESC LIMIT 1`
    )
    .get(jobId, ...INACTIVE_STATUSES) as ApplicationRow | undefined;
  return row ? toApplication(row) : null;
}

export function createApplication(
  db: DB,
  input: {
    jobId: number;
    matchId?: number | null;
    candidateProfileId?: number | null;
    runId?: number | null;
    status?: "preparing" | "ready_for_review";
    notes?: string | null;
    actor?: Exclude<Actor, "user">;
    /** Stored on the (append-only) creation event, e.g. where the application came from. */
    eventPayload?: unknown;
  }
): Application {
  return db.transaction(() => {
    const active = getActiveApplicationForJob(db, input.jobId);
    if (active) {
      throw new PersistenceError(
        "ACTIVE_APPLICATION_EXISTS",
        `Job ${input.jobId} already has active application ${active.id} (${active.status})`
      );
    }
    const status = input.status ?? "preparing";
    const id = Number(
      db
        .prepare(
          `INSERT INTO applications (job_id, match_id, candidate_profile_id, run_id, status, notes)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.jobId,
          input.matchId ?? null,
          input.candidateProfileId ?? null,
          input.runId ?? null,
          status,
          input.notes ?? null
        ).lastInsertRowid
    );
    insertEvent(db, {
      applicationId: id,
      eventType: "status_change",
      fromStatus: null,
      toStatus: status,
      actor: input.actor ?? "system",
      detail: "Application created",
      payload: input.eventPayload,
    });
    return getApplication(db, id)!;
  })();
}

/**
 * Generic transition for every status except the gated ones (approved,
 * submitting, submitted, submission_failed), which have dedicated functions.
 */
export function transitionApplication(
  db: DB,
  id: number,
  to: ApplicationStatus,
  options: { actor: Actor; detail?: string | null; error?: string | null; payload?: unknown }
): Application {
  if (GATED_STATUSES.includes(to)) {
    throw new PersistenceError(
      "GATED_TRANSITION",
      `"${to}" can only be reached through the approval/submission functions`
    );
  }
  return db.transaction(() => {
    const application = requireApplication(db, id);
    if (!canTransition(application.status, to)) {
      throw new PersistenceError(
        "INVALID_TRANSITION",
        `Cannot move application ${id} from ${application.status} to ${to}`
      );
    }
    insertEvent(db, {
      applicationId: id,
      eventType: "status_change",
      fromStatus: application.status,
      toStatus: to,
      actor: options.actor,
      detail: options.detail,
      payload: options.payload,
    });
    // Leaving approval before submission (re-review, rejection, withdrawal)
    // clears the snapshot; after submission it is kept as a record.
    const clearApproval =
      application.status === "approved" || application.status === "submission_failed";
    setStatus(db, id, to, {
      ...(clearApproval
        ? { approved_at: null, approved_assets_sha256: null, approved_asset_ids: null }
        : {}),
      ...(options.error !== undefined ? { last_error: options.error } : {}),
    });
    return getApplication(db, id)!;
  })();
}

export function addApplicationNote(db: DB, id: number, note: string, actor: Actor = "user"): Application {
  return db.transaction(() => {
    requireApplication(db, id);
    insertEvent(db, { applicationId: id, eventType: "note", actor, detail: note });
    db.prepare("UPDATE applications SET notes = ?, updated_at = ? WHERE id = ?").run(note, nowIso(), id);
    return getApplication(db, id)!;
  })();
}

export function listApplicationEvents(db: DB, id: number): ApplicationEvent[] {
  return (
    db
      .prepare("SELECT * FROM application_events WHERE application_id = ? ORDER BY id")
      .all(id) as EventRow[]
  ).map(toEvent);
}

// ── Assets (versioned) ──────────────────────────────────────────────────────

/**
 * Adds a new version of an asset and makes it current. Adding content to an
 * approved application withdraws the approval (enforced by DB trigger).
 * Content is locked once submission has started (DB trigger), and stays
 * locked once the application has been submitted — including after it is
 * later withdrawn or unsuccessful, which the trigger does not cover — so the
 * current content always remains what was submitted.
 */
export function addApplicationAsset(
  db: DB,
  input: {
    applicationId: number;
    kind: AssetKind;
    origin: "generated" | "user_edit";
    contentText?: string | null;
    contentJson?: unknown;
    file?: Buffer | null;
    filename?: string | null;
    mimeType?: string | null;
    model?: string | null;
    promptVersion?: string | null;
    sourceJobDescriptionId?: number | null;
    actor?: Actor;
  }
): ApplicationAsset {
  const contentJson = input.contentJson === undefined ? null : JSON.stringify(input.contentJson);
  if (input.contentText == null && contentJson === null && !input.file) {
    throw new PersistenceError("EMPTY_ASSET", "An asset needs text, JSON or a file");
  }
  const hash = sha256(
    input.file ?? (input.contentText != null ? `text:${input.contentText}` : `json:${contentJson}`)
  );

  return db.transaction(() => {
    const application = requireApplication(db, input.applicationId);
    if (application.submittedAt !== null) {
      throw new PersistenceError(
        "ASSETS_LOCKED",
        "ASSETS_LOCKED: application content cannot change after the application has been submitted"
      );
    }
    const previous = db
      .prepare(
        `SELECT id, version FROM application_assets
         WHERE application_id = ? AND kind = ? ORDER BY version DESC LIMIT 1`
      )
      .get(input.applicationId, input.kind) as { id: number; version: number } | undefined;
    const current = db
      .prepare(
        "SELECT id FROM application_assets WHERE application_id = ? AND kind = ? AND is_current = 1"
      )
      .get(input.applicationId, input.kind) as { id: number } | undefined;

    if (current) {
      db.prepare("UPDATE application_assets SET is_current = 0 WHERE id = ?").run(current.id);
    }

    const id = Number(
      db
        .prepare(
          `INSERT INTO application_assets
             (application_id, kind, version, is_current, origin, parent_asset_id, content_text,
              content_json, file_blob, filename, mime_type, sha256, model, prompt_version,
              source_job_description_id)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.applicationId,
          input.kind,
          (previous?.version ?? 0) + 1,
          input.origin,
          current?.id ?? null,
          input.contentText ?? null,
          contentJson,
          input.file ?? null,
          input.filename ?? null,
          input.mimeType ?? null,
          hash,
          input.model ?? null,
          input.promptVersion ?? null,
          input.sourceJobDescriptionId ?? null
        ).lastInsertRowid
    );

    insertEvent(db, {
      applicationId: input.applicationId,
      eventType: input.origin === "user_edit" ? "asset_edited" : "asset_generated",
      actor: input.actor ?? (input.origin === "user_edit" ? "user" : "system"),
      detail: `${input.kind} v${(previous?.version ?? 0) + 1}`,
      payload: { assetId: id, kind: input.kind },
    });
    return getAsset(db, id)!;
  })();
}

export function getAsset(db: DB, assetId: number): ApplicationAsset | null {
  const row = db
    .prepare(`SELECT ${ASSET_COLUMNS} FROM application_assets WHERE id = ?`)
    .get(assetId) as AssetRow | undefined;
  return row ? toAsset(row) : null;
}

export function getAssetFile(db: DB, assetId: number): Buffer | null {
  const row = db.prepare("SELECT file_blob FROM application_assets WHERE id = ?").get(assetId) as
    | { file_blob: Buffer | null }
    | undefined;
  return row?.file_blob ?? null;
}

export function getCurrentAssets(db: DB, applicationId: number): ApplicationAsset[] {
  return (
    db
      .prepare(
        `SELECT ${ASSET_COLUMNS} FROM application_assets
         WHERE application_id = ? AND is_current = 1 ORDER BY kind`
      )
      .all(applicationId) as AssetRow[]
  ).map(toAsset);
}

export function listAssetVersions(db: DB, applicationId: number, kind: AssetKind): ApplicationAsset[] {
  return (
    db
      .prepare(
        `SELECT ${ASSET_COLUMNS} FROM application_assets
         WHERE application_id = ? AND kind = ? ORDER BY version DESC`
      )
      .all(applicationId, kind) as AssetRow[]
  ).map(toAsset);
}

/**
 * Ordered IDs of the current assets — the same value migration 004's
 * triggers compute in SQL to check approval and submission.
 */
export function currentAssetIdSet(db: DB, applicationId: number): string | null {
  const ids = getCurrentAssets(db, applicationId)
    .map((asset) => asset.id)
    .sort((a, b) => a - b);
  return ids.length > 0 ? ids.join(",") : null;
}

/** Hash of exactly what the reviewer is looking at (all current assets). */
export function getCurrentAssetsHash(db: DB, applicationId: number): string {
  return assetSetHash(getCurrentAssets(db, applicationId));
}

// ── Human approval gate ─────────────────────────────────────────────────────

/**
 * Records the user's explicit approval. This is the ONLY way an application
 * becomes approved. The caller must pass the asset hash the user actually
 * reviewed; if the content changed since, approval is refused.
 *
 * Must only be called from a direct user action (the review UI), never from
 * a scheduler or background job.
 */
export function approveApplication(
  db: DB,
  id: number,
  confirmation: { reviewedAssetsSha256: string; note?: string | null }
): Application {
  return db.transaction(() => {
    const application = requireApplication(db, id);
    if (application.status !== "ready_for_review") {
      throw new PersistenceError(
        "INVALID_TRANSITION",
        `Only applications in ready_for_review can be approved (application ${id} is ${application.status})`
      );
    }
    const assets = getCurrentAssets(db, id);
    if (assets.length === 0) {
      throw new PersistenceError("NOTHING_TO_APPROVE", `Application ${id} has no content to approve`);
    }
    const currentHash = assetSetHash(assets);
    if (confirmation.reviewedAssetsSha256 !== currentHash) {
      throw new PersistenceError(
        "STALE_REVIEW",
        `Application ${id} changed after it was reviewed; review the current content again`
      );
    }

    // The approval event must be inserted first: the DB trigger only allows
    // the status change when the latest event is this user approval.
    insertEvent(db, {
      applicationId: id,
      eventType: "status_change",
      fromStatus: "ready_for_review",
      toStatus: "approved",
      actor: "user",
      detail: confirmation.note ?? "Approved by user",
      payload: { approvedAssetsSha256: currentHash },
    });
    setStatus(db, id, "approved", {
      approved_at: nowIso(),
      approved_assets_sha256: currentHash,
      approved_asset_ids: currentAssetIdSet(db, id),
    });
    return getApplication(db, id)!;
  })();
}

/** The user's explicit rejection. */
export function rejectApplication(db: DB, id: number, options: { note?: string | null } = {}): Application {
  return transitionApplication(db, id, "rejected", {
    actor: "user",
    detail: options.note ?? "Rejected by user",
  });
}

/**
 * The gate every future submission path must pass through. It does NOT
 * submit anything; it verifies the explicit, current user approval and moves
 * the application to "submitting". Throws APPROVAL_REQUIRED otherwise.
 * Since migration 005 the database requires actor "user" for this move.
 */
export function beginSubmission(
  db: DB,
  id: number,
  options: { method: SubmissionMethod; actor?: Exclude<Actor, "user"> | "user" }
): Application {
  return db.transaction(() => {
    const application = requireApplication(db, id);
    if (application.status !== "approved" && application.status !== "submission_failed") {
      throw new PersistenceError(
        "APPROVAL_REQUIRED",
        `Application ${id} is ${application.status}; it must be explicitly approved before submission`
      );
    }

    const lastDecision = db
      .prepare(
        `SELECT to_status, actor FROM application_events
         WHERE application_id = ? AND event_type = 'status_change'
           AND to_status IN ('approved', 'ready_for_review', 'rejected', 'preparing')
         ORDER BY id DESC LIMIT 1`
      )
      .get(id) as { to_status: string; actor: string } | undefined;
    if (!lastDecision || lastDecision.to_status !== "approved" || lastDecision.actor !== "user") {
      throw new PersistenceError(
        "APPROVAL_REQUIRED",
        `Application ${id} has no current user approval; it must be reviewed and approved by the user`
      );
    }

    if (
      !application.approvedAssetsSha256 ||
      application.approvedAssetsSha256 !== getCurrentAssetsHash(db, id) ||
      !application.approvedAssetIds ||
      application.approvedAssetIds !== currentAssetIdSet(db, id)
    ) {
      throw new PersistenceError(
        "APPROVAL_REQUIRED",
        `Application ${id} content differs from what was approved; it must be approved again`
      );
    }

    // Event first: the DB requires every status change to be recorded beforehand.
    insertEvent(db, {
      applicationId: id,
      eventType: "status_change",
      fromStatus: application.status,
      toStatus: "submitting",
      actor: options.actor ?? "system",
      detail: `Submission started (${options.method})`,
    });
    setStatus(db, id, "submitting", { submission_method: options.method, last_error: null });
    return getApplication(db, id)!;
  })();
}

/**
 * Records the outcome of a submission attempt that passed beginSubmission.
 * Since migration 005 the database accepts a successful submission (and the
 * move to submitting) only with actor "user".
 */
export function recordSubmissionResult(
  db: DB,
  id: number,
  result:
    | {
        success: true;
        reference?: string | null;
        /** When it was submitted (validated by the caller and migration 005); default now. */
        submittedAt?: string;
        detail?: string;
        payload?: unknown;
      }
    | { success: false; error: string },
  actor: Actor = "system"
): Application {
  return db.transaction(() => {
    const application = requireApplication(db, id);
    if (application.status !== "submitting") {
      throw new PersistenceError(
        "INVALID_TRANSITION",
        `Application ${id} is ${application.status}, not submitting`
      );
    }
    const to: ApplicationStatus = result.success ? "submitted" : "submission_failed";
    // Event first: the DB requires every status change to be recorded beforehand.
    insertEvent(db, {
      applicationId: id,
      eventType: "submission_attempt",
      fromStatus: "submitting",
      toStatus: to,
      actor,
      detail: result.success ? result.detail ?? "Submitted" : result.error,
      payload: result.success ? result.payload : undefined,
    });
    setStatus(
      db,
      id,
      to,
      result.success
        ? {
            submitted_at: result.submittedAt ?? nowIso(),
            submission_reference: result.reference ?? null,
            last_error: null,
          }
        : { last_error: result.error }
    );
    return getApplication(db, id)!;
  })();
}

// ── Manual submission tracking (Phase 2) ────────────────────────────────────
//
// The user applies on the employer's site themselves, then records it here.
// Nothing in this section submits anything anywhere, and opening a job's
// website never calls it. Every write is a user action (actor "user"), which
// migration 005 also enforces in the database.

export type SubmittedContent = "as_approved" | "modified_externally";

export type PostSubmissionStatus = "acknowledged" | "interviewing" | "offer" | "unsuccessful" | "withdrawn";

export const POST_SUBMISSION_STATUSES: readonly PostSubmissionStatus[] = [
  "acknowledged",
  "interviewing",
  "offer",
  "unsuccessful",
  "withdrawn",
];

export const MAX_SUBMISSION_REFERENCE_LENGTH = 200;

// Submitted applications that can still move on (unsuccessful and withdrawn are final).
const OPEN_SUBMITTED_STATUSES: ApplicationStatus[] = ["submitted", "acknowledged", "interviewing", "offer"];
const CLOSED_SUBMITTED_STATUSES: ApplicationStatus[] = ["unsuccessful", "withdrawn"];

function cleanText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function cleanReference(value: string | null | undefined): string | null {
  const reference = cleanText(value);
  if (reference !== null && reference.length > MAX_SUBMISSION_REFERENCE_LENGTH) {
    throw new PersistenceError(
      "INVALID_INPUT",
      `A submission reference can be at most ${MAX_SUBMISSION_REFERENCE_LENGTH} characters`
    );
  }
  return reference;
}

function requireNotInFuture(timestamp: string, what: string): void {
  if (timestamp > nowIso()) {
    throw new PersistenceError("INVALID_TIMESTAMP", `${what} cannot be in the future`);
  }
}

export type ManualSubmissionInput = {
  /** Hash of the content the user confirmed; must be the approved content. */
  reviewedAssetsSha256: string;
  /** When the user applied (default now). May be earlier, never future or before approval. */
  submittedAt?: Date | string | null;
  reference?: string | null;
  note?: string | null;
  /** Whether what was sent matches the approved Job Agent content (default "as_approved"). */
  submittedContent?: SubmittedContent;
  /** Required when submittedContent is "modified_externally": what the user changed. */
  externalChanges?: string | null;
};

/**
 * Records that the user applied on the employer's site themselves. Only an
 * approved application qualifies, and only for exactly the approved content.
 * Moves approved → submitting → submitted through the existing gate
 * (beginSubmission / recordSubmissionResult) with actor "user", method
 * "manual", in one transaction. The approval snapshot is kept unchanged.
 */
export function recordManualSubmission(db: DB, id: number, input: ManualSubmissionInput): Application {
  return db.transaction((): Application => {
    const application = requireApplication(db, id);
    if (application.status !== "approved") {
      throw new PersistenceError(
        "APPROVAL_REQUIRED",
        `Application ${id} is ${application.status}; only an approved application can be marked as applied`
      );
    }
    if (!application.approvedAt || !application.approvedAssetsSha256 || !application.approvedAssetIds) {
      throw new PersistenceError("APPROVAL_REQUIRED", `Application ${id} has no approval snapshot; approve it first`);
    }
    if (input.reviewedAssetsSha256 !== application.approvedAssetsSha256) {
      throw new PersistenceError(
        "STALE_REVIEW",
        `The content confirmed for application ${id} is not the approved content; review it again`
      );
    }

    const submittedAt = input.submittedAt == null ? nowIso() : toDbTimestamp(input.submittedAt);
    requireNotInFuture(submittedAt, "The application date");
    if (submittedAt < application.approvedAt) {
      throw new PersistenceError(
        "INVALID_TIMESTAMP",
        `The application date cannot be before the approval (${application.approvedAt} UTC)`
      );
    }

    const submittedContent = input.submittedContent ?? "as_approved";
    if (submittedContent !== "as_approved" && submittedContent !== "modified_externally") {
      throw new PersistenceError("INVALID_INPUT", `Unknown submitted content: ${String(submittedContent)}`);
    }
    const externalChanges = cleanText(input.externalChanges);
    if (submittedContent === "modified_externally" && externalChanges === null) {
      throw new PersistenceError("INVALID_INPUT", "Describe what was changed on the employer's site");
    }
    if (submittedContent === "as_approved" && externalChanges !== null) {
      throw new PersistenceError("INVALID_INPUT", "External changes only apply when the content was modified");
    }
    const reference = cleanReference(input.reference);

    const note = cleanText(input.note);
    if (note !== null) addApplicationNote(db, id, note, "user");

    // The existing gate: a current user approval of exactly the current content.
    beginSubmission(db, id, { method: "manual", actor: "user" });
    return recordSubmissionResult(
      db,
      id,
      {
        success: true,
        reference,
        submittedAt,
        detail: "Applied by the user on the employer's site",
        payload: { method: "manual", submittedAt, reference, submittedContent, externalChanges, recordedAt: nowIso() },
      },
      "user"
    );
  })();
}

/**
 * A later status update for a submitted application (acknowledged,
 * interviewing, offer, unsuccessful or withdrawn), following the existing
 * forward-only rules. occurredAt (optional) says when it happened: not in
 * the future and not before the submission.
 */
export function updateSubmittedStatus(
  db: DB,
  id: number,
  input: { to: PostSubmissionStatus; occurredAt?: Date | string | null; note?: string | null }
): Application {
  if (!POST_SUBMISSION_STATUSES.includes(input.to)) {
    throw new PersistenceError("INVALID_TRANSITION", `"${String(input.to)}" is not a post-submission status`);
  }
  return db.transaction((): Application => {
    const application = requireApplication(db, id);
    if (application.submittedAt === null || !OPEN_SUBMITTED_STATUSES.includes(application.status)) {
      throw new PersistenceError(
        "INVALID_TRANSITION",
        `Application ${id} is ${application.status}; only an open submitted application can be updated`
      );
    }
    let occurredAt: string | null = null;
    if (input.occurredAt != null) {
      occurredAt = toDbTimestamp(input.occurredAt);
      requireNotInFuture(occurredAt, "The date of this update");
      if (occurredAt < application.submittedAt) {
        throw new PersistenceError(
          "INVALID_TIMESTAMP",
          `The date of this update cannot be before the application was submitted (${application.submittedAt} UTC)`
        );
      }
    }
    const note = cleanText(input.note);
    if (note !== null) addApplicationNote(db, id, note, "user");

    // The existing state machine decides which moves are allowed.
    return transitionApplication(db, id, input.to, {
      actor: "user",
      detail: `Updated by the user: ${input.to}`,
      payload: occurredAt === null ? undefined : { occurredAt },
    });
  })();
}

/**
 * Adds, changes or clears the reference of a submitted application. Every
 * change is recorded first as a user "external_update" event (migration 005
 * refuses unrecorded changes). Setting the same value again changes nothing.
 */
export function setSubmissionReference(db: DB, id: number, reference: string | null): Application {
  return db.transaction((): Application => {
    const application = requireApplication(db, id);
    if (application.submittedAt === null) {
      throw new PersistenceError(
        "INVALID_TRANSITION",
        `Application ${id} has not been submitted; a reference can only be recorded after submission`
      );
    }
    const next = cleanReference(reference);
    if (next === application.submissionReference) return application;

    insertEvent(db, {
      applicationId: id,
      eventType: "external_update",
      actor: "user",
      detail: next === null ? "Submission reference removed" : "Submission reference updated",
      payload: { field: "submission_reference", from: application.submissionReference, to: next },
    });
    db.prepare("UPDATE applications SET submission_reference = ?, updated_at = ? WHERE id = ?").run(next, nowIso(), id);
    return getApplication(db, id)!;
  })();
}

// ── Tracker read helpers ─────────────────────────────────────────────────────

/**
 * to_apply — approved, not yet applied
 * applied  — submitted and still open (submitted, acknowledged, interviewing, offer)
 * closed   — submitted, then unsuccessful or withdrawn
 * Applications withdrawn or rejected before submission are not tracked here.
 */
export type TrackerGroup = "to_apply" | "applied" | "closed";

export function trackerGroupOf(application: Application): TrackerGroup | null {
  if (application.status === "approved") return "to_apply";
  if (application.submittedAt === null) return null;
  if (OPEN_SUBMITTED_STATUSES.includes(application.status)) return "applied";
  if (CLOSED_SUBMITTED_STATUSES.includes(application.status)) return "closed";
  return null;
}

/** Tracked applications in one group (or all of them), most recent first. */
export function listTrackedApplications(db: DB, group: TrackerGroup | "tracked"): Application[] {
  const inList = (statuses: ApplicationStatus[]) => statuses.map((s) => `'${s}'`).join(", ");
  const conditions: Record<TrackerGroup, string> = {
    to_apply: "status = 'approved'",
    applied: `submitted_at IS NOT NULL AND status IN (${inList(OPEN_SUBMITTED_STATUSES)})`,
    closed: `submitted_at IS NOT NULL AND status IN (${inList(CLOSED_SUBMITTED_STATUSES)})`,
  };
  const where =
    group === "tracked" ? Object.values(conditions).map((c) => `(${c})`).join(" OR ") : conditions[group];
  return (
    db
      .prepare(
        `SELECT * FROM applications WHERE ${where}
         ORDER BY COALESCE(submitted_at, approved_at, updated_at) DESC, id DESC`
      )
      .all() as ApplicationRow[]
  ).map(toApplication);
}

export type SubmissionRecord = {
  method: SubmissionMethod | null;
  submittedAt: string;
  reference: string | null;
  submittedContent: SubmittedContent | null;
  externalChanges: string | null;
  /** When the submission was recorded in the Job Agent (may be later than submittedAt). */
  recordedAt: string;
};

type SubmissionPayload = {
  submittedContent?: SubmittedContent;
  externalChanges?: string | null;
  recordedAt?: string;
};

/** How and when the application was submitted, or null if it has not been. */
export function getSubmissionRecord(db: DB, id: number): SubmissionRecord | null {
  const application = getApplication(db, id);
  if (!application || application.submittedAt === null) return null;
  const event = db
    .prepare(
      `SELECT * FROM application_events
       WHERE application_id = ? AND event_type = 'submission_attempt' AND to_status = 'submitted'
       ORDER BY id DESC LIMIT 1`
    )
    .get(id) as EventRow | undefined;
  const payload = (event ? fromJson<SubmissionPayload>(event.payload_json) : null) ?? {};
  return {
    method: application.submissionMethod,
    submittedAt: application.submittedAt,
    reference: application.submissionReference,
    submittedContent: payload.submittedContent ?? null,
    externalChanges: payload.externalChanges ?? null,
    recordedAt: payload.recordedAt ?? event?.created_at ?? application.submittedAt,
  };
}

export type StatusHistoryEntry = {
  eventId: number;
  fromStatus: ApplicationStatus | null;
  toStatus: ApplicationStatus;
  actor: Actor | "migration";
  detail: string | null;
  /** When it happened, if the user said so; otherwise null (see recordedAt). */
  occurredAt: string | null;
  recordedAt: string;
};

/** Every status change of an application, oldest first. */
export function listStatusHistory(db: DB, id: number): StatusHistoryEntry[] {
  return listApplicationEvents(db, id)
    .filter((event) => event.toStatus !== null)
    .map((event) => {
      const payload = (event.payload ?? {}) as { occurredAt?: unknown };
      return {
        eventId: event.id,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus!,
        actor: event.actor,
        detail: event.detail,
        occurredAt: typeof payload.occurredAt === "string" ? payload.occurredAt : null,
        recordedAt: event.createdAt,
      };
    });
}

export type ReferenceChange = {
  eventId: number;
  from: string | null;
  to: string | null;
  actor: Actor | "migration";
  recordedAt: string;
};

/** Every change of the submission reference after submission, oldest first. */
export function listReferenceHistory(db: DB, id: number): ReferenceChange[] {
  return listApplicationEvents(db, id)
    .filter((event) => event.eventType === "external_update")
    .map((event) => ({ event, payload: (event.payload ?? {}) as { field?: unknown; from?: unknown; to?: unknown } }))
    .filter(({ payload }) => payload.field === "submission_reference")
    .map(({ event, payload }) => ({
      eventId: event.id,
      from: typeof payload.from === "string" ? payload.from : null,
      to: typeof payload.to === "string" ? payload.to : null,
      actor: event.actor,
      recordedAt: event.createdAt,
    }));
}
