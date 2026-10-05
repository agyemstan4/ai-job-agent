"use client";

import { useState } from "react";
import { browserDownloadEnv, downloadFile } from "@/lib/file-download-client";

// A download link that saves the file instead of navigating to it (see
// lib/file-download-client.ts). It is still a real link: with scripting
// unavailable, or if the fetch fails, the plain link works as before.
export default function DownloadFileButton({
  href,
  filename,
  className,
  children,
}: {
  href: string;
  filename: string | null;
  className: string;
  children: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <a
        href={href}
        download={filename ?? undefined}
        className={className}
        aria-busy={busy}
        onClick={async (event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; // keep "open in new tab" etc.
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError(null);
          try {
            await downloadFile(href, filename ?? "CV.pdf", browserDownloadEnv());
          } catch {
            setError("The file couldn't be saved. Try again, or open it with the link below.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Saving…" : children}
      </a>
      {error && (
        <p role="alert" className="mt-2 text-sm text-rose-800">
          {error} <a href={href} className="font-semibold underline">Open file</a>
        </p>
      )}
    </>
  );
}
