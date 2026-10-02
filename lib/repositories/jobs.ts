import type { DB } from "./shared.ts";
import {
  fingerprintV1,
  FINGERPRINT_VERSION,
  legacySeenKey,
  nowIso,
  sha256,
  toJson,
} from "./shared.ts";

export type JobStatus = "active" | "expired" | "closed";

export type Job = {
  id: number;
  fingerprint: string;
  fingerprintVersion: number;
  title: string;
  company: string;
  location: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryIsPredicted: boolean | null;
  contractType: string | null;
  contractTime: string | null;
  postedAt: string | null;
  expiresAt: string | null;
  status: JobStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
};

type JobRow = {
  id: number;
  fingerprint: string;
  fingerprint_version: number;
  title: string;
  company: string;
  location: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_is_predicted: number | null;
  contract_type: string | null;
  contract_time: string | null;
  posted_at: string | null;
  expires_at: string | null;
  status: JobStatus;
  first_seen_at: string;
  last_seen_at: string;
  updated_at: string;
};

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    fingerprintVersion: row.fingerprint_version,
    title: row.title,
    company: row.company,
    location: row.location,
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
    salaryIsPredicted: row.salary_is_predicted === null ? null : row.salary_is_predicted === 1,
    contractType: row.contract_type,
    contractTime: row.contract_time,
    postedAt: row.posted_at,
    expiresAt: row.expires_at,
    status: row.status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
  };
}

export type JobListing = {
  id: number;
  jobId: number;
  sourceId: string;
  externalId: string;
  url: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  postedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
};

type ListingRow = {
  id: number;
  job_id: number;
  source_id: string;
  external_id: string;
  url: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  salary_min: number | null;
  salary_max: number | null;
  posted_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
};

function toListing(row: ListingRow): JobListing {
  return {
    id: row.id,
    jobId: row.job_id,
    sourceId: row.source_id,
    externalId: row.external_id,
    url: row.url,
    title: row.title,
    company: row.company,
    location: row.location,
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
    postedAt: row.posted_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

const LISTING_COLUMNS =
  "id, job_id, source_id, external_id, url, title, company, location, salary_min, salary_max, posted_at, first_seen_at, last_seen_at";

export type JobDescription = {
  id: number;
  jobId: number;
  jobListingId: number | null;
  kind: "snippet" | "full";
  content: string;
  contentSha256: string;
  charCount: number;
  fetchedAt: string;
};

type DescriptionRow = {
  id: number;
  job_id: number;
  job_listing_id: number | null;
  kind: "snippet" | "full";
  content: string;
  content_sha256: string;
  char_count: number;
  fetched_at: string;
};

function toDescription(row: DescriptionRow): JobDescription {
  return {
    id: row.id,
    jobId: row.job_id,
    jobListingId: row.job_listing_id,
    kind: row.kind,
    content: row.content,
    contentSha256: row.content_sha256,
    charCount: row.char_count,
    fetchedAt: row.fetched_at,
  };
}

export type JobListingInput = {
  sourceId: string;
  externalId: string;
  title: string;
  company: string;
  url?: string | null;
  location?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryIsPredicted?: boolean | null;
  contractType?: string | null;
  contractTime?: string | null;
  postedAt?: string | null;
  description?: string | null;
  descriptionKind?: "snippet" | "full";
  raw?: unknown;
  runId?: number | null;
};

export type RecordListingResult = {
  jobId: number;
  listingId: number;
  jobCreated: boolean;
  listingCreated: boolean;
  descriptionId: number | null;
};

/**
 * Records one source listing and links it to its canonical job.
 *
 * Deduplication: (1) the same source + external ID is the same listing;
 * (2) otherwise listings whose fingerprint (normalised company + title)
 * matches an existing job are merged into it, across Adzuna and Reed.
 */
export function recordJobListing(db: DB, input: JobListingInput): RecordListingResult {
  return db.transaction((): RecordListingResult => {
    const now = nowIso();
    const existingListing = db
      .prepare("SELECT id, job_id FROM job_listings WHERE source_id = ? AND external_id = ?")
      .get(input.sourceId, input.externalId) as { id: number; job_id: number } | undefined;

    let jobId: number;
    let jobCreated = false;
    let listingId: number;
    let listingCreated = false;

    if (existingListing) {
      jobId = existingListing.job_id;
      listingId = existingListing.id;
      db.prepare(
        `UPDATE job_listings
         SET url = COALESCE(?, url), title = ?, company = ?, location = COALESCE(?, location),
             salary_min = COALESCE(?, salary_min), salary_max = COALESCE(?, salary_max),
             posted_at = COALESCE(?, posted_at), raw_json = COALESCE(?, raw_json),
             last_seen_run_id = COALESCE(?, last_seen_run_id), last_seen_at = ?
         WHERE id = ?`
      ).run(
        input.url ?? null,
        input.title,
        input.company,
        input.location ?? null,
        input.salaryMin ?? null,
        input.salaryMax ?? null,
        input.postedAt ?? null,
        toJson(input.raw),
        input.runId ?? null,
        now,
        listingId
      );
    } else {
      const fingerprint = fingerprintV1(input);
      const existingJob = db.prepare("SELECT id FROM jobs WHERE fingerprint = ?").get(fingerprint) as
        | { id: number }
        | undefined;

      if (existingJob) {
        jobId = existingJob.id;
      } else {
        jobId = Number(
          db
            .prepare(
              `INSERT INTO jobs
                 (fingerprint, fingerprint_version, title, company, location, salary_min, salary_max,
                  salary_is_predicted, contract_type, contract_time, posted_at,
                  first_seen_at, last_seen_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              fingerprint,
              FINGERPRINT_VERSION,
              input.title,
              input.company,
              input.location ?? null,
              input.salaryMin ?? null,
              input.salaryMax ?? null,
              input.salaryIsPredicted === undefined || input.salaryIsPredicted === null
                ? null
                : input.salaryIsPredicted
                  ? 1
                  : 0,
              input.contractType ?? null,
              input.contractTime ?? null,
              input.postedAt ?? null,
              now,
              now,
              now
            ).lastInsertRowid
        );
        jobCreated = true;
      }

      listingId = Number(
        db
          .prepare(
            `INSERT INTO job_listings
               (job_id, source_id, external_id, url, title, company, location, salary_min, salary_max,
                posted_at, raw_json, first_seen_run_id, last_seen_run_id, first_seen_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            jobId,
            input.sourceId,
            input.externalId,
            input.url ?? null,
            input.title,
            input.company,
            input.location ?? null,
            input.salaryMin ?? null,
            input.salaryMax ?? null,
            input.postedAt ?? null,
            toJson(input.raw),
            input.runId ?? null,
            input.runId ?? null,
            now,
            now
          ).lastInsertRowid
      );
      listingCreated = true;
    }

    if (!jobCreated) {
      // Fill gaps on the canonical job; a real salary replaces a predicted one.
      const hasRealSalary =
        input.salaryIsPredicted === false && (input.salaryMin != null || input.salaryMax != null);
      db.prepare(
        `UPDATE jobs
         SET location = COALESCE(location, ?),
             contract_type = COALESCE(contract_type, ?),
             contract_time = COALESCE(contract_time, ?),
             posted_at = COALESCE(posted_at, ?),
             salary_min = CASE WHEN ? OR salary_min IS NULL THEN COALESCE(?, salary_min) ELSE salary_min END,
             salary_max = CASE WHEN ? OR salary_max IS NULL THEN COALESCE(?, salary_max) ELSE salary_max END,
             salary_is_predicted = CASE WHEN ? THEN 0 ELSE salary_is_predicted END,
             last_seen_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        input.location ?? null,
        input.contractType ?? null,
        input.contractTime ?? null,
        input.postedAt ?? null,
        hasRealSalary ? 1 : 0,
        input.salaryMin ?? null,
        hasRealSalary ? 1 : 0,
        input.salaryMax ?? null,
        hasRealSalary ? 1 : 0,
        now,
        now,
        jobId
      );
    }

    const descriptionId = input.description?.trim()
      ? addJobDescription(db, {
          jobId,
          jobListingId: listingId,
          kind: input.descriptionKind ?? "snippet",
          content: input.description,
        }).id
      : null;

    return { jobId, listingId, jobCreated, listingCreated, descriptionId };
  })();
}

/** Stores a description; identical text for the same job is stored once. */
export function addJobDescription(
  db: DB,
  input: { jobId: number; jobListingId?: number | null; kind: "snippet" | "full"; content: string }
): JobDescription {
  const hash = sha256(input.content);
  db.prepare(
    `INSERT OR IGNORE INTO job_descriptions (job_id, job_listing_id, kind, content, content_sha256, char_count)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(input.jobId, input.jobListingId ?? null, input.kind, input.content, hash, input.content.length);
  const row = db
    .prepare("SELECT * FROM job_descriptions WHERE job_id = ? AND content_sha256 = ?")
    .get(input.jobId, hash) as DescriptionRow;
  return toDescription(row);
}

/** Full text beats a snippet; otherwise the longest text wins. */
export function getBestDescription(db: DB, jobId: number): JobDescription | null {
  const row = db
    .prepare(
      `SELECT * FROM job_descriptions WHERE job_id = ?
       ORDER BY (kind = 'full') DESC, char_count DESC, id DESC LIMIT 1`
    )
    .get(jobId) as DescriptionRow | undefined;
  return row ? toDescription(row) : null;
}

export function getJob(db: DB, id: number): Job | null {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  return row ? toJob(row) : null;
}

export function getListingsForJob(db: DB, jobId: number): JobListing[] {
  return (
    db
      .prepare(`SELECT ${LISTING_COLUMNS} FROM job_listings WHERE job_id = ? ORDER BY id`)
      .all(jobId) as ListingRow[]
  ).map(toListing);
}

export function getListingBySourceId(db: DB, sourceId: string, externalId: string): JobListing | null {
  const row = db
    .prepare(`SELECT ${LISTING_COLUMNS} FROM job_listings WHERE source_id = ? AND external_id = ?`)
    .get(sourceId, externalId) as ListingRow | undefined;
  return row ? toListing(row) : null;
}

/** True if any of these legacy-format IDs ("adzuna_123") is in seen_jobs. */
export function isLegacySeen(db: DB, legacyIds: string[]): boolean {
  const check = db.prepare("SELECT 1 FROM seen_jobs WHERE job_id = ?");
  return legacyIds.some((id) => check.get(id) !== undefined);
}

/**
 * A job counts as processed for a profile version once it has been scored or
 * filtered out for that version — or if any of its listings is in the legacy
 * seen_jobs table (the 167 pre-Phase-1 IDs keep blocking their jobs).
 * Failed matches do not count, so they are retried.
 */
export function isJobProcessed(db: DB, jobId: number, candidateProfileId: number): boolean {
  const matched = db
    .prepare(
      `SELECT 1 FROM matches
       WHERE job_id = ? AND candidate_profile_id = ? AND outcome IN ('scored', 'filtered_out')`
    )
    .get(jobId, candidateProfileId);
  if (matched) return true;

  return isLegacySeen(
    db,
    getListingsForJob(db, jobId).map((listing) => legacySeenKey(listing.sourceId, listing.externalId))
  );
}

export function setJobStatus(db: DB, jobId: number, status: JobStatus): void {
  db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), jobId);
}
