// Reed's job details API (Phase 3 checkpoint 3b-2). The search API returns
// only a ~450-character snippet; GET /api/1.0/jobs/{jobId} returns the full
// description as HTML. API only: Reed pages are never scraped.

export const REED_DETAILS_URL = "https://www.reed.co.uk/api/1.0/jobs/";
export const REED_DETAILS_TIMEOUT_MS = 10_000;

export type ReedDetailResult =
  | { status: "ok"; description: string }
  /** The job has expired or been removed (404/410). */
  | { status: "not_found"; httpStatus: number }
  /** Too many requests (429): stop asking for the rest of the run. */
  | { status: "rate_limited"; httpStatus: number }
  /** The key was refused (401/403): stop asking for the rest of the run. */
  | { status: "auth_failed"; httpStatus: number }
  /** Anything else: network error, timeout, 5xx, or an unusable response. */
  | { status: "error"; httpStatus?: number; error: string };

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Fetches one Reed job's full description. Never throws. */
export async function fetchReedJobDetail(
  externalId: string,
  apiKey: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
): Promise<ReedDetailResult> {
  if (!/^\d+$/.test(externalId)) {
    return { status: "error", error: "Not a Reed job ID" };
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(`${REED_DETAILS_URL}${externalId}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? REED_DETAILS_TIMEOUT_MS),
    });
  } catch (error) {
    // The URL holds only the public job ID and the key is in a header, but
    // keep the message to the error type, as for other source errors.
    const name = error instanceof Error ? error.name : "Error";
    return { status: "error", error: `Request failed (${name})` };
  }

  const httpStatus = response.status;
  if (httpStatus === 404 || httpStatus === 410) return { status: "not_found", httpStatus };
  if (httpStatus === 429) return { status: "rate_limited", httpStatus };
  if (httpStatus === 401 || httpStatus === 403) return { status: "auth_failed", httpStatus };
  if (!response.ok) return { status: "error", httpStatus, error: `HTTP ${httpStatus}` };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "error", httpStatus, error: "The response was not valid JSON" };
  }
  const detail = body as { jobId?: unknown; jobDescription?: unknown } | null;
  if (detail?.jobId !== undefined && String(detail.jobId) !== externalId) {
    return { status: "error", httpStatus, error: "The response was for a different job" };
  }
  const description = typeof detail?.jobDescription === "string" ? htmlToText(detail.jobDescription) : "";
  if (!description) {
    return { status: "error", httpStatus, error: "The response had no job description" };
  }
  return { status: "ok", description };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", bull: "•", pound: "£", euro: "€",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : entity;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? entity;
  });
}

/**
 * Reed's HTML description as plain text: paragraphs and line breaks kept,
 * list items as "- " lines, scripts/styles and all other tags removed.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/\s*\n\s*/g, " ") // source line breaks are not meaningful in HTML
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/?(p|div|ul|ol|h[1-6]|tr|table|section|article|blockquote)\b[^>]*>/gi, "\n\n")
    .replace(/<[^>]*>/g, "");

  return decodeEntities(text)
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
