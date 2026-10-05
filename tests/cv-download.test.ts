import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { attachmentHeaders, safeDownloadName } from "../lib/download-headers.ts";

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

  test("the Download buttons are plain same-origin links with a download name (no new tab, so phones save the file)", () => {
    for (const file of ["app/applications/page.tsx", "app/review/page.tsx"]) {
      const src = read(file);
      const link = /<a\s+href=\{`\/api\/applications\/\$\{[^}]+\}\/assets\/[^`]+`\}\s+download=\{[^}]+\}([^>]*)>/.exec(src);
      assert.ok(link, file);
      assert.doesNotMatch(link[1], /target=/, file);
    }
  });
});
