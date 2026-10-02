import type { DB } from "../repositories/shared.ts";
import type { CandidateInput, CandidateProfile } from "../repositories/candidates.ts";
import {
  addCvDocument,
  createCandidate,
  createProfileVersion,
  findIdenticalProfileVersion,
  getDefaultCandidate,
  setCurrentProfile,
  updateCandidate,
} from "../repositories/candidates.ts";

// Step 5: persists an uploaded CV and the profile extracted from it
// (/api/analyse-and-extract). Single-user: everything belongs to the default
// candidate, created on the first upload.

export type SaveCvAnalysisInput = {
  file: Buffer;
  originalFilename: string;
  mimeType: string;
  extractedText?: string | null;
  analysis: Record<string, unknown>;
  structuredCv: Record<string, unknown>;
  /** Used as the candidate's name when the structured CV has none. */
  fallbackName: string;
  model: string;
  promptVersion: string;
};

/**
 * created     — new profile version, now current
 * unchanged   — the current version already has exactly this content
 * reactivated — an older version with exactly this content is current again
 */
export type ProfileOutcome = "created" | "unchanged" | "reactivated";

export type SaveCvAnalysisResult = {
  candidateId: number;
  candidateCreated: boolean;
  cvDocumentId: number;
  documentCreated: boolean;
  profile: CandidateProfile;
  profileOutcome: ProfileOutcome;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Stores the CV (deduplicated by content) and makes a profile version with
 * this analysis current. Re-uploading the same CV with the same extraction
 * creates nothing new; a different extraction becomes a new version. Existing
 * versions are never modified, and contact details already on the candidate
 * are never overwritten (only missing ones are filled in).
 */
export function saveCvAnalysis(db: DB, input: SaveCvAnalysisInput): SaveCvAnalysisResult {
  return db
    .transaction((): SaveCvAnalysisResult => {
      const details = {
        email: nonEmptyString(input.structuredCv.email),
        phone: nonEmptyString(input.structuredCv.phone),
        location: nonEmptyString(input.structuredCv.location),
      };

      let candidate = getDefaultCandidate(db);
      const candidateCreated = candidate === null;
      if (!candidate) {
        candidate = createCandidate(db, {
          fullName: nonEmptyString(input.structuredCv.name) ?? input.fallbackName,
          ...details,
        });
      } else {
        const patch: Partial<CandidateInput> = {};
        if (candidate.email === null && details.email) patch.email = details.email;
        if (candidate.phone === null && details.phone) patch.phone = details.phone;
        if (candidate.location === null && details.location) patch.location = details.location;
        if (Object.keys(patch).length > 0) candidate = updateCandidate(db, candidate.id, patch);
      }

      const { document, created: documentCreated } = addCvDocument(db, {
        candidateId: candidate.id,
        originalFilename: input.originalFilename,
        mimeType: input.mimeType,
        file: input.file,
        extractedText: input.extractedText ?? null,
      });

      const content = {
        candidateId: candidate.id,
        cvDocumentId: document.id,
        origin: "ai_extraction" as const,
        analysis: input.analysis,
        structuredCv: input.structuredCv,
        model: input.model,
        promptVersion: input.promptVersion,
      };

      const identical = findIdenticalProfileVersion(db, content);
      let profile: CandidateProfile;
      let profileOutcome: ProfileOutcome;
      if (identical?.isCurrent) {
        profile = identical;
        profileOutcome = "unchanged";
      } else if (identical) {
        profile = setCurrentProfile(db, identical.id);
        profileOutcome = "reactivated";
      } else {
        profile = createProfileVersion(db, {
          ...content,
          experienceLevel: nonEmptyString(input.analysis.experienceLevel),
        });
        profileOutcome = "created";
      }

      return {
        candidateId: candidate.id,
        candidateCreated,
        cvDocumentId: document.id,
        documentCreated,
        profile,
        profileOutcome,
      };
    })
    .immediate();
}
