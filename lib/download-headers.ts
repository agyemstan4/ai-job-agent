// Response headers for a file the user downloads (the tailored CV). Always an
// attachment, so mobile browsers save the file instead of previewing it. The
// type is the file's real type (never rewritten); the name is sent both as a
// plain ASCII fallback and as RFC 5987 UTF-8 (`filename*`), which phones prefer.
// `nosniff` stops a browser second-guessing the type and opening the file
// inline; `no-store` keeps a private CV out of shared caches.

/** Letters, digits, dot, dash and underscore only (everything else becomes "_"). */
export function safeDownloadName(name: string | null | undefined, fallback: string): string {
  const cleaned = String(name || fallback).replace(/[^\w.-]/g, "_");
  return cleaned || fallback;
}

export function attachmentHeaders(filename: string, mimeType: string | null | undefined, fallbackName = "CV.pdf"): Record<string, string> {
  const name = safeDownloadName(filename, fallbackName);
  return {
    "Content-Type": mimeType || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  };
}
