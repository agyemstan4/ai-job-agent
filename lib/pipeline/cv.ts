import type { DB } from "../repositories/shared.ts";
import type { CandidateInput, CandidateProfile } from "../repositories/candidates.ts";
import {
  addCvDocument,
  createCandidate,
  createProfileVersion,
  findCvDocumentBySha256,
  findIdenticalProfileVersion,
  getDefaultCandidate,
  listProfiles,
  setCurrentProfile,
  updateCandidate,
} from "../repositories/candidates.ts";
import { sha256 } from "../repositories/shared.ts";

// Step 5: persists an uploaded CV and the profile extracted from it
// (/api/analyse-and-extract). Single-user: everything belongs to the default
// candidate, created on the first upload.
//
// The AI output is not deterministic, so re-analysing the same CV gives a
// slightly different profile each time. Instead, an upload of a CV that was
// already analysed with the same inputs reuses the stored profile
// (findReusableCvAnalysis) and the AI is not called again.

/** Inputs that shape the analysis besides the CV, the model and the prompt. */
export type AnalysisInputs = { selectedRoles: string[] };

// Stored inside analysis_json under this key; never returned to the client.
const INPUTS_KEY = "_inputs";

export type SaveCvAnalysisInput = {
  file: Buffer;
  originalFilename: string;
  mimeType: string;
  extractedText?: string | null;
  analysis: Record<string, unknown>;
  structuredCv: Record<string, unknown>;
  inputs: AnalysisInputs;
  /** Used as the candidate's name when the structured CV has none. */
  fallbackName: string;
  model: string;
  promptVersion: string;
};

function withInputs(analysis: Record<string, unknown>, inputs: AnalysisInputs) {
  return { ...analysis, [INPUTS_KEY]: { selectedRoles: inputs.selectedRoles } };
}

/** The analysis as the client sees it (without the stored inputs). */
export function analysisForClient(profile: CandidateProfile): Record<string, unknown> {
  const { [INPUTS_KEY]: _inputs, ...analysis } = profile.analysis;
  void _inputs;
  return analysis;
}

function sameInputs(profile: CandidateProfile, inputs: AnalysisInputs): boolean {
  const stored = profile.analysis[INPUTS_KEY] as AnalysisInputs | undefined;
  return (
    stored !== undefined &&
    JSON.stringify(stored.selectedRoles) === JSON.stringify(inputs.selectedRoles)
  );
}

export type ReusedCvAnalysis = {
  profile: CandidateProfile;
  profileOutcome: "unchanged" | "reactivated";
  analysis: Record<string, unknown>;
  structuredCv: Record<string, unknown>;
};

/**
 * The stored analysis of exactly this CV (same bytes) with the same inputs,
 * model and prompt version, if there is one — made current if it was not.
 * Only AI extractions qualify; profiles saved without recorded inputs never do.
 */
export function findReusableCvAnalysis(
  db: DB,
  input: { file: Buffer; inputs: AnalysisInputs; model: string; promptVersion: string }
): ReusedCvAnalysis | null {
  return db
    .transaction((): ReusedCvAnalysis | null => {
      const candidate = getDefaultCandidate(db);
      if (!candidate) return null;
      const document = findCvDocumentBySha256(db, candidate.id, sha256(input.file));
      if (!document) return null;

      const matching = listProfiles(db, candidate.id).filter(
        (profile) =>
          profile.cvDocumentId === document.id &&
          profile.origin === "ai_extraction" &&
          profile.model === input.model &&
          profile.promptVersion === input.promptVersion &&
          sameInputs(profile, input.inputs)
      );
      // Prefer the current version; otherwise the newest (listProfiles is newest first).
      const chosen = matching.find((profile) => profile.isCurrent) ?? matching[0];
      if (!chosen) return null;

      const profile = chosen.isCurrent ? chosen : setCurrentProfile(db, chosen.id);
      return {
        profile,
        profileOutcome: chosen.isCurrent ? "unchanged" : "reactivated",
        analysis: analysisForClient(profile),
        structuredCv: profile.structuredCv,
      };
    })
    .immediate();
}

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
        analysis: withInputs(input.analysis, input.inputs),
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
