import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { attachmentHeaders, safeDownloadName } from "../lib/download-headers.ts";
import { downloadFile, filenameFromDisposition, REVOKE_AFTER_MS } from "../lib/file-download-client.ts";
import type { DownloadEnv } from "../lib/file-download-client.ts";

// Tailored-CV downloads must be real downloads on phones too: always an
// attachment, with the file's own type and name.

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("CV download headers", () => {
  test("a PDF is an attachment with its own type and name, and cannot be sniffed into an inline preview", () => {
    const h = attachmentHeaders("Sam_Example_Acme_CV.pdf", PDF);
    assert.equal(h["Content-Type"], PDF);
    assert.match(h["Content-Disposition"], /^attachment; filename="Sam_Example_Acme_CV\.pdf"; filename\*=UTF-8''Sam_Example_Acme_CV\.pdf$/);
    assert.doesNotMatch(h["Content-Disposition"], /inline/);
    assert.equal(h["X-Content-Type-Options"], "nosniff");
    assert.equal(h["Cache-Control"], "private, no-store");
  });

  test("a DOCX keeps its type; an unknown type is a generic download, never inline", () => {
    assert.equal(attachmentHeaders("CV.docx", DOCX)["Content-Type"], DOCX);
    assert.equal(attachmentHeaders("CV.bin", null)["Content-Type"], "application/octet-stream");
  });

  test("unsafe characters in a name can't break the header; a missing name falls back", () => {
    assert.equal(safeDownloadName('Sam "O\'Neil"\r\nX: y/CV.pdf', "CV.pdf"), "Sam__O_Neil___X__y_CV.pdf");
    const h = attachmentHeaders('a"b\r\nSet-Cookie: x.pdf', PDF);
    assert.doesNotMatch(h["Content-Disposition"], /[\r\n]/);
    assert.equal(h["Content-Disposition"].split('"').length, 3, "exactly one quoted value");
    assert.match(attachmentHeaders("", PDF)["Content-Disposition"], /filename="CV\.pdf"/);
  });

  test("every CV file route builds its response with these headers (no hand-written Content-Disposition left)", () => {
    for (const file of ["app/api/applications/[id]/assets/[assetId]/route.ts", "app/api/generate-cv-docx/route.ts", "app/api/batch-results/[id]/route.ts"]) {
      const src = read(file);
      assert.match(src, /attachmentHeaders\(/, file);
      assert.doesNotMatch(src, /Content-Disposition/, file);
    }
  });

  test("the Download buttons use the client-side download flow (fetch, then share or save a blob), still real links", () => {
    for (const file of ["app/applications/page.tsx", "app/review/page.tsx"]) {
      const src = read(file);
      assert.ok(src.includes("<DownloadFileButton"), file);
      assert.ok(src.includes("/assets/${"), file);
      assert.ok(!/<a[ \n]+href=\{`\/api\/applications\/[^>]*download=/.test(src), file + " has no plain download link left");
    }
    const button = read("app/components/DownloadFileButton.tsx");
    assert.ok(button.includes("event.preventDefault()"));
    assert.ok(button.includes("downloadFile(href,"));
    assert.ok(/<a[ \n]+href=\{href\}[ \n]+download=/.test(button), "still a real link");
    assert.ok(!/window\.open|location\.(href|assign)|router\./.test(button));
  });
});

// ── The client-side flow (fakes only: no browser, no network) ──────────────

function fakeEnv(over: Partial<DownloadEnv> = {}, response?: Response) {
  const log: string[] = [];
  const saved: { url: string; filename: string }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const env: DownloadEnv = {
    fetch: async (url) => (log.push(`fetch ${url}`), response ?? new Response("%PDF-1.4", { status: 200, headers: { "Content-Type": PDF, "Content-Disposition": `attachment; filename="Sam_Acme_CV.pdf"; filename*=UTF-8''Sam_Acme_CV.pdf` } })),
    coarsePointer: false,
    createObjectURL: () => (log.push("create"), "blob:fake"),
    revokeObjectURL: (u) => void log.push(`revoke ${u}`),
    saveLink: (url, filename) => void saved.push({ url, filename }),
    later: (fn, ms) => void timers.push({ fn, ms }),
    ...over,
  };
  return { env, log, saved, timers };
}

describe("client-side download flow", () => {
  test("file names come from Content-Disposition (UTF-8 form first), are made safe, and fall back", () => {
    assert.equal(filenameFromDisposition(`attachment; filename="a.pdf"; filename*=UTF-8''b%20c.pdf`, "x.pdf"), "b_c.pdf");
    assert.equal(filenameFromDisposition('attachment; filename="Sam_Acme_CV.pdf"', "x.pdf"), "Sam_Acme_CV.pdf");
    assert.equal(filenameFromDisposition("attachment; filename=plain.docx", "x.pdf"), "plain.docx");
    assert.equal(filenameFromDisposition('attachment; filename="../../etc/passwd"', "x.pdf"), ".._.._etc_passwd");
    assert.equal(filenameFromDisposition(null, "CV.pdf"), "CV.pdf");
    assert.equal(filenameFromDisposition("attachment", "CV.pdf"), "CV.pdf");
    assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''%E0%A4%A", "CV.pdf"), "CV.pdf");
  });

  test("desktop: fetches the file, saves a temporary object URL under the server's name, and revokes it afterwards", async () => {
    const { env, log, saved, timers } = fakeEnv();
    assert.equal(await downloadFile("/api/applications/1/assets/2", "CV.pdf", env), "downloaded");
    assert.deepEqual(log, ["fetch /api/applications/1/assets/2", "create"]);
    assert.deepEqual(saved, [{ url: "blob:fake", filename: "Sam_Acme_CV.pdf" }]);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, REVOKE_AFTER_MS);
    assert.ok(!log.includes("revoke blob:fake"), "not revoked before the browser has started the save");
    timers[0].fn();
    assert.ok(log.includes("revoke blob:fake"));
  });

  test("phone: the file is handed to the system share sheet (Save to Files) with its name and type; nothing is navigated to", async () => {
    const shared: File[] = [];
    const { env, saved } = fakeEnv({
      coarsePointer: true,
      canShare: ({ files }) => files.length === 1,
      share: async ({ files }) => void shared.push(...files),
    });
    assert.equal(await downloadFile("/x", "CV.pdf", env), "shared");
    assert.deepEqual([shared[0].name, shared[0].type, shared[0].size], ["Sam_Acme_CV.pdf", PDF, 8]);
    assert.deepEqual(saved, []);
  });

  test("phone: cancelling the share sheet is not an error and does not start a second download", async () => {
    const { env, saved } = fakeEnv({ coarsePointer: true, canShare: () => true, share: async () => { throw Object.assign(new Error("x"), { name: "AbortError" }); } });
    assert.equal(await downloadFile("/x", "CV.pdf", env), "cancelled");
    assert.deepEqual(saved, []);
  });

  test("phone: sharing refused or unavailable falls back to the normal download (never a dead tap)", async () => {
    const refused = fakeEnv({ coarsePointer: true, canShare: () => true, share: async () => { throw Object.assign(new Error("x"), { name: "NotAllowedError" }); } });
    assert.equal(await downloadFile("/x", "CV.pdf", refused.env), "downloaded");
    assert.equal(refused.saved.length, 1);
    const cannot = fakeEnv({ coarsePointer: true, canShare: () => false, share: async () => assert.fail("must not share") });
    assert.equal(await downloadFile("/x", "CV.pdf", cannot.env), "downloaded");
    const none = fakeEnv({ coarsePointer: true });
    assert.equal(await downloadFile("/x", "CV.pdf", none.env), "downloaded");
  });

  test("a desktop never uses the share sheet, even if the browser has one", async () => {
    const { env } = fakeEnv({ coarsePointer: false, canShare: () => true, share: async () => assert.fail("must not share") });
    assert.equal(await downloadFile("/x", "CV.pdf", env), "downloaded");
  });

  test("a failed fetch is an error (and saves nothing); a missing header uses the fallback name and the blob's type", async () => {
    const bad = fakeEnv({}, new Response("no", { status: 404 }));
    await assert.rejects(() => downloadFile("/x", "CV.pdf", bad.env), /404/);
    assert.deepEqual(bad.saved, []);
    const bare = fakeEnv({}, new Response(new Blob(["d"], { type: DOCX }), { status: 200 }));
    await downloadFile("/x", "CV.docx", bare.env);
    assert.equal(bare.saved[0].filename, "CV.docx");
  });
});

