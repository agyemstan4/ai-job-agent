import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { TestDb } from "./helpers.ts";
import { count, createLegacyDbFile, freshDb, makeTempDir, quietly, seedSeenJobs } from "./helpers.ts";
import fs from "node:fs";
import type { SaveCvAnalysisInput } from "../lib/pipeline/cv.ts";
import { saveCvAnalysis } from "../lib/pipeline/cv.ts";
import { openDatabase } from "../lib/database.ts";
import {
  createCandidate,
  createProfileVersion,
  getCandidate,
  getCurrentProfile,
  getCvDocument,
  getCvDocumentFile,
  listProfiles,
} from "../lib/repositories/candidates.ts";

let t: TestDb;
beforeEach(() => {
  t = quietly(freshDb);
});
afterEach(() => t.close());

const CV_A = Buffer.from("%PDF-1.4 CV A");
const CV_B = Buffer.from("%PDF-1.4 CV B");

function upload(overrides: Partial<SaveCvAnalysisInput> = {}): SaveCvAnalysisInput {
  return {
    file: CV_A,
    originalFilename: "cv.pdf",
    mimeType: "application/pdf",
    extractedText: "Jane Doe\nKotlin developer",
    analysis: { matchScore: 72, experienceLevel: "Graduate", technicalSkills: ["Kotlin", "Java"] },
    structuredCv: {
      name: "Jane Doe",
      email: "jane@example.com",
      phone: "07000 000000",
      location: "London",
      projects: [{ name: "VibeNSync", bullets: ["Built it"] }],
    },
    fallbackName: "Jane Doe From Text",
    model: "llama3.2:3b",
    promptVersion: "analyse-and-extract/v1",
    ...overrides,
  };
}

function profileRows(db = t.db) {
  return db.prepare("SELECT * FROM candidate_profiles ORDER BY id").all();
}

describe("saveCvAnalysis: first upload", () => {
  test("creates the candidate, the CV document and a current v1 profile", () => {
    const result = saveCvAnalysis(t.db, upload());

    assert.equal(result.candidateCreated, true);
    assert.equal(result.documentCreated, true);
    assert.equal(result.profileOutcome, "created");

    const candidate = getCandidate(t.db, result.candidateId)!;
    assert.equal(candidate.fullName, "Jane Doe");
    assert.equal(candidate.email, "jane@example.com");
    assert.equal(candidate.phone, "07000 000000");
    assert.equal(candidate.location, "London");

    const document = getCvDocument(t.db, result.cvDocumentId)!;
    assert.equal(document.originalFilename, "cv.pdf");
    assert.equal(document.mimeType, "application/pdf");
    assert.equal(document.extractedText, "Jane Doe\nKotlin developer");
    assert.deepEqual(getCvDocumentFile(t.db, result.cvDocumentId), CV_A);

    const profile = result.profile;
    assert.equal(profile.version, 1);
    assert.equal(profile.isCurrent, true);
    assert.equal(profile.origin, "ai_extraction");
    assert.equal(profile.cvDocumentId, result.cvDocumentId);
    assert.equal(profile.experienceLevel, "Graduate");
    assert.equal(profile.model, "llama3.2:3b");
    assert.equal(profile.promptVersion, "analyse-and-extract/v1");
    assert.deepEqual(profile.analysis, upload().analysis);
    assert.deepEqual(profile.structuredCv, upload().structuredCv);
  });

  test("falls back to the name taken from the CV text when the structured CV has none", () => {
    const result = saveCvAnalysis(t.db, upload({ structuredCv: { name: "  " } }));
    const candidate = getCandidate(t.db, result.candidateId)!;
    assert.equal(candidate.fullName, "Jane Doe From Text");
    assert.equal(candidate.email, null);
    assert.equal(result.profile.experienceLevel, "Graduate");
  });
});

describe("saveCvAnalysis: re-uploads and versioning", () => {
  test("the same CV with the same extraction creates nothing new", () => {
    const first = saveCvAnalysis(t.db, upload());
    const before = profileRows();
    const second = saveCvAnalysis(t.db, upload({ originalFilename: "renamed.pdf" }));

    assert.equal(second.candidateCreated, false);
    assert.equal(second.documentCreated, false);
    assert.equal(second.profileOutcome, "unchanged");
    assert.equal(second.profile.id, first.profile.id);
    assert.equal(second.cvDocumentId, first.cvDocumentId);
    assert.equal(count(t.db, "candidates"), 1);
    assert.equal(count(t.db, "cv_documents"), 1);
    assert.deepEqual(profileRows(), before);
  });

  test("the same CV with a different extraction becomes a new current version; v1 is kept as it was", () => {
    const first = saveCvAnalysis(t.db, upload());
    const v1Before = profileRows()[0];
    const second = saveCvAnalysis(
      t.db,
      upload({ analysis: { ...upload().analysis, matchScore: 80 } })
    );

    assert.equal(second.profileOutcome, "created");
    assert.equal(second.documentCreated, false);
    assert.equal(second.profile.version, 2);
    assert.equal(second.profile.cvDocumentId, first.cvDocumentId);
    assert.equal(getCurrentProfile(t.db, first.candidateId)?.id, second.profile.id);
    assert.equal(listProfiles(t.db, first.candidateId).filter((p) => p.isCurrent).length, 1);

    // v1 is unchanged apart from no longer being current.
    assert.deepEqual(profileRows()[0], { ...(v1Before as object), is_current: 0 });
  });

  test("a different CV creates a new document and a new version", () => {
    const first = saveCvAnalysis(t.db, upload());
    const second = saveCvAnalysis(t.db, upload({ file: CV_B }));

    assert.equal(second.documentCreated, true);
    assert.notEqual(second.cvDocumentId, first.cvDocumentId);
    assert.equal(second.profileOutcome, "created");
    assert.equal(second.profile.version, 2);
    assert.equal(count(t.db, "cv_documents"), 2);
    assert.equal(count(t.db, "candidates"), 1);
  });

  test("going back to an earlier CV with the same extraction reactivates that version", () => {
    const a = saveCvAnalysis(t.db, upload());
    const b = saveCvAnalysis(t.db, upload({ file: CV_B, analysis: { other: true } }));
    const again = saveCvAnalysis(t.db, upload());

    assert.equal(again.profileOutcome, "reactivated");
    assert.equal(again.profile.id, a.profile.id);
    assert.equal(again.profile.isCurrent, true);
    assert.equal(getCurrentProfile(t.db, a.candidateId)?.id, a.profile.id);
    assert.equal(listProfiles(t.db, a.candidateId).find((p) => p.id === b.profile.id)?.isCurrent, false);
    assert.equal(count(t.db, "candidate_profiles"), 2);
    assert.equal(count(t.db, "candidate_profiles", "is_current = 1"), 1);
  });

  test("a different model or prompt version is a new version even with identical output", () => {
    saveCvAnalysis(t.db, upload());
    const newModel = saveCvAnalysis(t.db, upload({ model: "llama3.1:8b" }));
    const newPrompt = saveCvAnalysis(t.db, upload({ promptVersion: "analyse-and-extract/v2" }));

    assert.equal(newModel.profileOutcome, "created");
    assert.equal(newPrompt.profileOutcome, "created");
    assert.deepEqual(
      listProfiles(t.db, newModel.candidateId).map((p) => p.version),
      [3, 2, 1]
    );
  });

  test("a user-edited profile is never matched as an identical AI extraction", () => {
    const first = saveCvAnalysis(t.db, upload());
    const edit = createProfileVersion(t.db, {
      candidateId: first.candidateId,
      cvDocumentId: first.cvDocumentId,
      parentProfileId: first.profile.id,
      origin: "user_edit",
      analysis: { edited: true },
      structuredCv: { name: "Jane Doe" },
      model: "llama3.2:3b",
      promptVersion: "analyse-and-extract/v1",
    });
    const reupload = saveCvAnalysis(
      t.db,
      upload({ analysis: { edited: true }, structuredCv: { name: "Jane Doe" } })
    );

    assert.equal(reupload.profileOutcome, "created");
    assert.notEqual(reupload.profile.id, edit.id);
    assert.equal(reupload.profile.origin, "ai_extraction");
  });
});

describe("saveCvAnalysis: existing data", () => {
  test("existing candidate details are kept; only missing ones are filled in", () => {
    const existing = createCandidate(t.db, { fullName: "Stanley", email: "old@example.com" });
    const result = saveCvAnalysis(t.db, upload());

    assert.equal(result.candidateCreated, false);
    assert.equal(result.candidateId, existing.id);
    const candidate = getCandidate(t.db, existing.id)!;
    assert.equal(candidate.fullName, "Stanley");
    assert.equal(candidate.email, "old@example.com");
    assert.equal(candidate.phone, "07000 000000");
    assert.equal(candidate.location, "London");
  });

  test("an existing profile version is kept unmodified and the new one follows it", () => {
    const existing = createCandidate(t.db, { fullName: "Stanley" });
    createProfileVersion(t.db, {
      candidateId: existing.id,
      origin: "ai_extraction",
      analysis: { old: true },
      structuredCv: {},
    });
    const before = profileRows()[0];
    const result = saveCvAnalysis(t.db, upload());

    assert.equal(result.profile.version, 2);
    assert.deepEqual(profileRows()[0], { ...(before as object), is_current: 0 });
  });

  test("a failure part-way through leaves nothing behind", () => {
    assert.throws(() =>
      saveCvAnalysis(t.db, upload({ analysis: { bad: BigInt(1) } }))
    );
    assert.equal(count(t.db, "candidates"), 0);
    assert.equal(count(t.db, "cv_documents"), 0);
    assert.equal(count(t.db, "candidate_profiles"), 0);
  });

  test("two connections saving the same upload produce one document and one profile", () => {
    const other = openDatabase(t.file);
    try {
      const a = saveCvAnalysis(t.db, upload());
      const b = saveCvAnalysis(other, upload());
      assert.equal(b.profileOutcome, "unchanged");
      assert.equal(b.profile.id, a.profile.id);
      assert.equal(count(t.db, "cv_documents"), 1);
      assert.equal(count(t.db, "candidate_profiles"), 1);
    } finally {
      other.close();
    }
  });

  test("on a migrated legacy database, seen_jobs and the legacy tables are untouched", () => {
    const dir = makeTempDir();
    try {
      const file = createLegacyDbFile(dir, (db) => {
        seedSeenJobs(db, 167);
      });
      const db = quietly(() => openDatabase(file));
      try {
        const seenBefore = db.prepare("SELECT * FROM seen_jobs ORDER BY job_id").all();
        saveCvAnalysis(db, upload());
        assert.deepEqual(db.prepare("SELECT * FROM seen_jobs ORDER BY job_id").all(), seenBefore);
        assert.equal(count(db, "seen_jobs"), 167);
        assert.equal(count(db, "batch_runs"), 0);
        assert.equal(count(db, "batch_results"), 0);
        assert.deepEqual(db.pragma("foreign_key_check"), []);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
