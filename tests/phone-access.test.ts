import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Phone use of the existing app: touch targets, installability and the local-only default.

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("phone access", () => {
  test("touch screens get 44px controls (buttons, form fields, button-styled links), the tab bar keeps 56px", () => {
    const css = read("app/globals.css");
    const block = /@media \(pointer: coarse\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    assert.match(block, /min-height: 44px/);
    for (const part of ["button", "summary", "select", "textarea", 'a[class*="min-h-"]:not([class*="min-h-14"])']) assert.ok(block.includes(part), part);
  });

  test("the apply-flow controls are at least 44px: Apply Now, the CV download and the logo link", () => {
    const apps = read("app/applications/page.tsx");
    assert.match(apps, /className="inline-flex min-h-11 items-center justify-center rounded-lg bg-indigo-600 px-6 py-2 font-semibold text-white hover:bg-indigo-500"/);
    assert.match(apps, /inline-flex min-h-11 items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold/);
    assert.match(read("app/components/AppNav.tsx"), /href="\/" className="flex min-h-11 items-center/);
  });

  test("it stays an installable, local-by-default app: manifest, viewport, bottom tab bar; server bound to 127.0.0.1", () => {
    assert.match(read("app/manifest.ts"), /display: "standalone"/);
    assert.match(read("app/layout.tsx"), /width: "device-width"/);
    assert.match(read("app/components/AppNav.tsx"), /fixed inset-x-0 bottom-0/);
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    assert.match(pkg.scripts.start, /-H 127\.0\.0\.1/);
    assert.match(pkg.scripts.dev, /-H 127\.0\.0\.1/);
  });
});
