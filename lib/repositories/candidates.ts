import type { DB } from "./shared.ts";
import { fromJson, nowIso, PersistenceError, sha256, toJson } from "./shared.ts";

// ── Candidates ──────────────────────────────────────────────────────────────

export type Candidate = {
  id: number;
  fullName: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  portfolioUrl: string | null;
  preferences: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

type CandidateRow = {
  id: number;
  full_name: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  portfolio_url: string | null;
  preferences_json: string | null;
  created_at: string;
  updated_at: string;
};

function toCandidate(row: CandidateRow): Candidate {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    location: row.location,
    portfolioUrl: row.portfolio_url,
    preferences: fromJson<Record<string, unknown>>(row.preferences_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type CandidateInput = {
  fullName: string;
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  portfolioUrl?: string | null;
  preferences?: Record<string, unknown> | null;
};

export function createCandidate(db: DB, input: CandidateInput): Candidate {
  const result = db
    .prepare(
      `INSERT INTO candidates (full_name, email, phone, location, portfolio_url, preferences_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.fullName,
      input.email ?? null,
      input.phone ?? null,
      input.location ?? null,
      input.portfolioUrl ?? null,
      toJson(input.preferences)
    );
  return getCandidate(db, Number(result.lastInsertRowid))!;
}

export function getCandidate(db: DB, id: number): Candidate | null {
  const row = db.prepare("SELECT * FROM candidates WHERE id = ?").get(id) as CandidateRow | undefined;
  return row ? toCandidate(row) : null;
}

/** The single-user default: the earliest candidate. */
export function getDefaultCandidate(db: DB): Candidate | null {
  const row = db.prepare("SELECT * FROM candidates ORDER BY id LIMIT 1").get() as
    | CandidateRow
    | undefined;
  return row ? toCandidate(row) : null;
}

export function updateCandidate(db: DB, id: number, patch: Partial<CandidateInput>): Candidate {
  const current = getCandidate(db, id);
  if (!current) throw new PersistenceError("NOT_FOUND", `Candidate ${id} not found`);
  db.prepare(
    `UPDATE candidates
     SET full_name = ?, email = ?, phone = ?, location = ?, portfolio_url = ?,
         preferences_json = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    patch.fullName ?? current.fullName,
    patch.email !== undefined ? patch.email : current.email,
    patch.phone !== undefined ? patch.phone : current.phone,
    patch.location !== undefined ? patch.location : current.location,
    patch.portfolioUrl !== undefined ? patch.portfolioUrl : current.portfolioUrl,
    toJson(patch.preferences !== undefined ? patch.preferences : current.preferences),
    nowIso(),
    id
  );
  return getCandidate(db, id)!;
}

// ── CV documents ────────────────────────────────────────────────────────────

export type CvDocument = {
  id: number;
  candidateId: number;
  originalFilename: string;
  mimeType: string;
  sha256: string;
  extractedText: string | null;
  uploadedAt: string;
};

type CvDocumentRow = {
  id: number;
  candidate_id: number;
  original_filename: string;
  mime_type: string;
  sha256: string;
  extracted_text: string | null;
  uploaded_at: string;
};

function toCvDocument(row: CvDocumentRow): CvDocument {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    sha256: row.sha256,
    extractedText: row.extracted_text,
    uploadedAt: row.uploaded_at,
  };
}

const CV_DOCUMENT_COLUMNS =
  "id, candidate_id, original_filename, mime_type, sha256, extracted_text, uploaded_at";

/** Stores an uploaded CV. Re-uploading identical bytes returns the existing row. */
export function addCvDocument(
  db: DB,
  input: {
    candidateId: number;
    originalFilename: string;
    mimeType: string;
    file: Buffer;
    extractedText?: string | null;
  }
): { document: CvDocument; created: boolean } {
  const hash = sha256(input.file);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO cv_documents
         (candidate_id, original_filename, mime_type, sha256, file_blob, extracted_text)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.candidateId,
      input.originalFilename,
      input.mimeType,
      hash,
      input.file,
      input.extractedText ?? null
    );
  const row = db
    .prepare(`SELECT ${CV_DOCUMENT_COLUMNS} FROM cv_documents WHERE candidate_id = ? AND sha256 = ?`)
    .get(input.candidateId, hash) as CvDocumentRow;
  return { document: toCvDocument(row), created: result.changes > 0 };
}

export function getCvDocument(db: DB, id: number): CvDocument | null {
  const row = db
    .prepare(`SELECT ${CV_DOCUMENT_COLUMNS} FROM cv_documents WHERE id = ?`)
    .get(id) as CvDocumentRow | undefined;
  return row ? toCvDocument(row) : null;
}

export function getCvDocumentFile(db: DB, id: number): Buffer | null {
  const row = db.prepare("SELECT file_blob FROM cv_documents WHERE id = ?").get(id) as
    | { file_blob: Buffer }
    | undefined;
  return row ? row.file_blob : null;
}

// ── Candidate profiles (immutable versions) ─────────────────────────────────

export type ProfileOrigin = "ai_extraction" | "user_edit" | "legacy_import";

export type CandidateProfile = {
  id: number;
  candidateId: number;
  cvDocumentId: number | null;
  parentProfileId: number | null;
  version: number;
  isCurrent: boolean;
  origin: ProfileOrigin;
  analysis: Record<string, unknown>;
  structuredCv: Record<string, unknown>;
  experienceLevel: string | null;
  model: string | null;
  promptVersion: string | null;
  createdAt: string;
};

type ProfileRow = {
  id: number;
  candidate_id: number;
  cv_document_id: number | null;
  parent_profile_id: number | null;
  version: number;
  is_current: number;
  origin: ProfileOrigin;
  analysis_json: string;
  structured_cv_json: string;
  experience_level: string | null;
  model: string | null;
  prompt_version: string | null;
  created_at: string;
};

function toProfile(row: ProfileRow): CandidateProfile {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    cvDocumentId: row.cv_document_id,
    parentProfileId: row.parent_profile_id,
    version: row.version,
    isCurrent: row.is_current === 1,
    origin: row.origin,
    analysis: JSON.parse(row.analysis_json) as Record<string, unknown>,
    structuredCv: JSON.parse(row.structured_cv_json) as Record<string, unknown>,
    experienceLevel: row.experience_level,
    model: row.model,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
  };
}

/**
 * Creates the next profile version for a candidate. Versions are never
 * edited; a user correction is a new version with origin "user_edit".
 */
export function createProfileVersion(
  db: DB,
  input: {
    candidateId: number;
    origin: ProfileOrigin;
    analysis: Record<string, unknown>;
    structuredCv: Record<string, unknown>;
    cvDocumentId?: number | null;
    parentProfileId?: number | null;
    experienceLevel?: string | null;
    model?: string | null;
    promptVersion?: string | null;
    makeCurrent?: boolean;
  }
): CandidateProfile {
  return db.transaction(() => {
    const { next } = db
      .prepare(
        "SELECT COALESCE(MAX(version), 0) + 1 AS next FROM candidate_profiles WHERE candidate_id = ?"
      )
      .get(input.candidateId) as { next: number };

    const makeCurrent = input.makeCurrent ?? true;
    if (makeCurrent) {
      db.prepare(
        "UPDATE candidate_profiles SET is_current = 0 WHERE candidate_id = ? AND is_current = 1"
      ).run(input.candidateId);
    }

    const result = db
      .prepare(
        `INSERT INTO candidate_profiles
           (candidate_id, cv_document_id, parent_profile_id, version, is_current, origin,
            analysis_json, structured_cv_json, experience_level, model, prompt_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.candidateId,
        input.cvDocumentId ?? null,
        input.parentProfileId ?? null,
        next,
        makeCurrent ? 1 : 0,
        input.origin,
        JSON.stringify(input.analysis),
        JSON.stringify(input.structuredCv),
        input.experienceLevel ?? null,
        input.model ?? null,
        input.promptVersion ?? null
      );
    return getProfile(db, Number(result.lastInsertRowid))!;
  })();
}

export function getProfile(db: DB, id: number): CandidateProfile | null {
  const row = db.prepare("SELECT * FROM candidate_profiles WHERE id = ?").get(id) as
    | ProfileRow
    | undefined;
  return row ? toProfile(row) : null;
}

export function getCurrentProfile(db: DB, candidateId: number): CandidateProfile | null {
  const row = db
    .prepare("SELECT * FROM candidate_profiles WHERE candidate_id = ? AND is_current = 1")
    .get(candidateId) as ProfileRow | undefined;
  return row ? toProfile(row) : null;
}

export function listProfiles(db: DB, candidateId: number): CandidateProfile[] {
  return (
    db
      .prepare("SELECT * FROM candidate_profiles WHERE candidate_id = ? ORDER BY version DESC")
      .all(candidateId) as ProfileRow[]
  ).map(toProfile);
}

export function setCurrentProfile(db: DB, profileId: number): CandidateProfile {
  const profile = getProfile(db, profileId);
  if (!profile) throw new PersistenceError("NOT_FOUND", `Profile ${profileId} not found`);
  db.transaction(() => {
    db.prepare(
      "UPDATE candidate_profiles SET is_current = 0 WHERE candidate_id = ? AND is_current = 1"
    ).run(profile.candidateId);
    db.prepare("UPDATE candidate_profiles SET is_current = 1 WHERE id = ?").run(profileId);
  })();
  return getProfile(db, profileId)!;
}
