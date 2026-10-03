// Safe descriptions of errors for server logs.
//
// Errors from outbound HTTP calls can carry the request URL, and the Adzuna
// URL includes app_id and app_key in its query string. Logs therefore get the
// error's type, code and message with any URL removed and key-like
// parameters redacted — never the raw error object.

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>)]+/gi;
const SECRET_PARAM = /\b(app_key|app_id|api_key|apikey|key|token|access_token|password|secret)=([^&\s"']+)/gi;

export function redactSecrets(text: string): string {
  return text.replace(URL_PATTERN, "[url]").replace(SECRET_PARAM, "$1=[redacted]");
}

/** "TypeError (ECONNREFUSED): fetch failed" — safe to log. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return redactSecrets(String(error));
  const cause = (error as Error & { cause?: unknown }).cause;
  const code =
    (error as Error & { code?: unknown }).code ??
    (cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined);
  const name = error.name || "Error";
  return redactSecrets(`${name}${typeof code === "string" ? ` (${code})` : ""}: ${error.message}`);
}
