// Rate-limit-safe searching of one job site (reliability pass before the 06:30
// schedule). A site is searched one term at a time with a short pause, instead
// of firing every term at once (Adzuna answered a burst of 7 with HTTP 429).
// An HTTP 429 is retried once after a longer pause; if the site still refuses,
// the remaining searches of that site are skipped (hammering a rate-limited
// API only makes it worse) and the site is reported as partial. Nothing here
// hides a failure: the caller gets exact counts per site.

export type SourceName = "Adzuna" | "Reed";

export type SourceStatus = {
  source: SourceName;
  /** Searches planned for this site. */
  planned: number;
  /** Searches that returned results (possibly zero jobs). */
  succeeded: number;
  /** Searches that failed (network error, HTTP error, rate limit). */
  failed: number;
  /** Failed because the site answered HTTP 429, after one retry. */
  rateLimited: number;
  /** Never sent, because the site was still rate limiting. */
  skipped: number;
};

// Job-site payloads are untyped JSON; the route maps them to jobs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SearchResponse = { status: number | null; results: any[] };

export const SEARCH_PAUSE_MS = 400;
export const RATE_LIMIT_RETRY_MS = 2_500;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs one search per term, sequentially. `search` returns the HTTP status
 * (null = no response) and the parsed results; it must not throw for HTTP or
 * network failures (a throw is counted as a failed search).
 */
export async function searchSource(
  source: SourceName,
  terms: string[],
  search: (term: string) => Promise<SearchResponse>,
  options: { pauseMs?: number; retryMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<{ results: SearchResponse["results"]; status: SourceStatus }> {
  const sleep = options.sleep ?? wait;
  const pauseMs = options.pauseMs ?? SEARCH_PAUSE_MS;
  const retryMs = options.retryMs ?? RATE_LIMIT_RETRY_MS;
  const status: SourceStatus = { source, planned: terms.length, succeeded: 0, failed: 0, rateLimited: 0, skipped: 0 };
  const results: SearchResponse["results"] = [];

  const attempt = async (term: string): Promise<SearchResponse> => {
    try {
      return await search(term);
    } catch {
      return { status: null, results: [] };
    }
  };

  for (let i = 0; i < terms.length; i++) {
    if (i > 0) await sleep(pauseMs);
    let response = await attempt(terms[i]);
    if (response.status === 429) {
      await sleep(retryMs);
      response = await attempt(terms[i]);
    }
    if (response.status !== null && response.status >= 200 && response.status < 300) {
      status.succeeded++;
      results.push(...response.results);
      continue;
    }
    status.failed++;
    if (response.status === 429) {
      status.rateLimited++;
      status.skipped = terms.length - i - 1;
      break;
    }
  }
  return { results, status };
}

/** The plain-language problems in a set of site statuses (empty when every search worked). */
export function sourceWarnings(statuses: SourceStatus[]): string[] {
  const warnings: string[] = [];
  for (const s of statuses) {
    if (s.failed === 0 && s.skipped === 0) continue;
    const incomplete = s.failed + s.skipped;
    const why = s.rateLimited > 0 ? "rate-limited" : "unavailable";
    warnings.push(`source_partial: ${s.source} ${why} — ${incomplete} of ${s.planned} searches not completed`);
  }
  return warnings;
}

/** Header carrying the discovery report from /api/jobs (its body stays the plain job list). */
export const DISCOVERY_REPORT_HEADER = "x-discovery-report";

export type DiscoveryReport = {
  usedPreferences: boolean;
  terms: number;
  sources: SourceStatus[];
};

export function readDiscoveryReport(value: string | null): DiscoveryReport | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as DiscoveryReport;
    return parsed && Array.isArray(parsed.sources) && typeof parsed.usedPreferences === "boolean" ? parsed : null;
  } catch {
    return null;
  }
}
