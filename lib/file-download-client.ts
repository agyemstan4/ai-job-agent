// Saving a file from the browser (the tailored CV), for phones as well as desktops.
//
// Tapping a plain link to a PDF makes many mobile browsers open it in their own
// viewer even when the server says "attachment" — and a viewer tab has no Save
// button on some phones. So the file is fetched first and then handed over:
//   1. phone/tablet (touch screen) with the Web Share API for files: the system
//      share sheet ("Save to Files", Drive, …) — the native save experience;
//   2. everywhere else (and if sharing is unavailable or fails): a download of a
//      temporary object URL, revoked afterwards.
// The user cancelling the share sheet is not an error. Browsers differ: the
// share sheet and the download prompt look different on iOS, Android and
// desktop, and a browser may still show a saved file in its own viewer.

export type DownloadOutcome = "shared" | "downloaded" | "cancelled";

export type DownloadEnv = {
  fetch: (url: string) => Promise<Response>;
  /** A touch screen (phone or tablet) — where the share sheet is the better save. */
  coarsePointer: boolean;
  canShare?: (data: { files: File[] }) => boolean;
  share?: (data: { files: File[]; title?: string }) => Promise<void>;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  /** Starts the download of an object URL under a file name. */
  saveLink: (url: string, filename: string) => void;
  later: (fn: () => void, ms: number) => void;
};

/** Revoke the object URL after the browser has had time to start the save. */
export const REVOKE_AFTER_MS = 30_000;

const SAFE = /[^\w.-]/g;

/** The file name from a Content-Disposition header (UTF-8 `filename*` first), made safe; or the fallback. */
export function filenameFromDisposition(header: string | null | undefined, fallback: string): string {
  const value = header ?? "";
  let name: string | null = null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value);
  if (star) {
    try {
      name = decodeURIComponent(star[1].trim());
    } catch {
      name = null;
    }
  }
  if (!name) name = /filename\s*=\s*"([^"]+)"/i.exec(value)?.[1] ?? /filename\s*=\s*([^;\s]+)/i.exec(value)?.[1] ?? null;
  const cleaned = (name ?? "").replace(SAFE, "_");
  return cleaned.replace(/^_+$/, "") || fallback;
}

export async function downloadFile(url: string, fallbackName: string, env: DownloadEnv): Promise<DownloadOutcome> {
  const response = await env.fetch(url);
  if (!response.ok) throw new Error(`The file could not be fetched (${response.status}).`);
  const blob = await response.blob();
  const filename = filenameFromDisposition(response.headers.get("Content-Disposition"), fallbackName);
  const type = blob.type || response.headers.get("Content-Type") || "application/octet-stream";

  if (env.coarsePointer && env.share && env.canShare) {
    const file = new File([blob], filename, { type });
    if (env.canShare({ files: [file] })) {
      try {
        await env.share({ files: [file], title: filename });
        return "shared";
      } catch (error) {
        if ((error as { name?: string })?.name === "AbortError") return "cancelled";
        // Not allowed (for example the tap is too old) or unsupported: fall back to a normal download.
      }
    }
  }

  const objectUrl = env.createObjectURL(blob.type === type ? blob : new Blob([blob], { type }));
  try {
    env.saveLink(objectUrl, filename);
  } finally {
    env.later(() => env.revokeObjectURL(objectUrl), REVOKE_AFTER_MS);
  }
  return "downloaded";
}

/** The real browser environment (client side only). */
export function browserDownloadEnv(): DownloadEnv {
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean; share?: (data: ShareData) => Promise<void> };
  return {
    fetch: (url) => fetch(url, { credentials: "same-origin" }),
    coarsePointer: window.matchMedia?.("(pointer: coarse)").matches ?? false,
    canShare: nav.canShare ? (data) => nav.canShare!(data) : undefined,
    share: nav.share ? (data) => nav.share!(data) : undefined,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    saveLink: (url, filename) => {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
    later: (fn, ms) => void setTimeout(fn, ms),
  };
}
