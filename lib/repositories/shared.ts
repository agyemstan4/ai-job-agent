import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

export type DB = Database.Database;

// ── Errors ──────────────────────────────────────────────────────────────────

export class PersistenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
  }
}

// ── Hashing ─────────────────────────────────────────────────────────────────

export function sha256(data: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Hash of an application's current asset set. Approval snapshots this value,
 * and submission requires it to still match. Order-independent.
 */
export function assetSetHash(
  assets: { kind: string; version: number; sha256: string }[]
): string {
  const lines = assets
    .map((asset) => `${asset.kind}:${asset.version}:${asset.sha256}`)
    .sort();
  return sha256(lines.join("\n"));
}

// ── Job fingerprints ────────────────────────────────────────────────────────
//
// FROZEN: fingerprintV1 is used by migration 003 and stored in jobs.fingerprint.
// Never change its output. A new algorithm must be added as fingerprintV2 with
// jobs.fingerprint_version = 2.

const UNKNOWN_COMPANIES = new Set(["", "unknown", "n a", "not specified", "confidential"]);

const COMPANY_SUFFIXES = /\b(ltd|limited|plc|llp|llc|inc|uk|group|holdings)\b/g;

const TITLE_NOISE = [
  // "(Hybrid)", "(Remote - London)", "(Contract)" …
  /\((?:hybrid|remote|on-?site|office|contract|permanent|temporary|full[- ]time|part[- ]time)[^)]*\)/g,
  // " - Remote", " | Hybrid" … through to the end of the title
  /\s[-–|]\s*(?:hybrid|remote|on-?site)\b.*$/g,
  // salary text: "£30,000 - £35,000", "£35k"
  /£\s?\d[\d,.]*k?(?:\s*(?:-|to)\s*£?\s?\d[\d,.]*k?)?/g,
];

function normaliseText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normaliseCompanyV1(company: string): string {
  return normaliseText(company || "")
    .replace(COMPANY_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normaliseTitleV1(title: string): string {
  let text = (title || "").toLowerCase();
  for (const pattern of TITLE_NOISE) {
    text = text.replace(pattern, " ");
  }
  return normaliseText(text);
}

export const FINGERPRINT_VERSION = 1;

/**
 * Cross-source identity of a vacancy: normalised company + normalised title
 * (the same rule /api/jobs uses today, made tolerant of formatting noise).
 * Listings with no real company are never merged with anything else.
 */
export function fingerprintV1(input: {
  title: string;
  company: string;
  sourceId: string;
  externalId: string;
}): string {
  const company = normaliseCompanyV1(input.company);
  const title = normaliseTitleV1(input.title);
  if (UNKNOWN_COMPANIES.has(normaliseText(input.company || "")) || !company || !title) {
    return `v1:unmerged:${input.sourceId}:${input.externalId}`;
  }
  return `v1:${company}|${title}`;
}

/** The ID format /api/jobs has always used, and seen_jobs stores ("adzuna_123"). */
export function legacySeenKey(sourceId: string, externalId: string): string {
  return `${sourceId}_${externalId}`;
}

// ── JSON helpers ────────────────────────────────────────────────────────────

export function toJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function fromJson<T>(value: string | null | undefined): T | null {
  return value === null || value === undefined ? null : (JSON.parse(value) as T);
}

export function nowIso(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function mimeTypeForFilename(filename: string | null | undefined): string {
  const lower = (filename || "").toLowerCase();
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}
