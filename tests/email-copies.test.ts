import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { EmailClient, EmailCopy } from "../lib/email-copies.ts";
import {
  coverLetterEmail,
  DEFAULT_RECIPIENT,
  emailCopiesEnabled,
  SENDER,
  sendEmailCopy,
  tailoredCvEmail,
} from "../lib/email-copies.ts";
import { quietly } from "./helpers.ts";

// No real email is ever sent here: every test that enables sending injects a
// fake client, and the others must not create a client at all.

type Sent = EmailCopy & { from: string; to: string };

function fakeClient(behaviour: "ok" | "throws" | "api-error" = "ok") {
  const sent: Sent[] = [];
  const keys: string[] = [];
  const createClient = (apiKey: string): EmailClient => {
    keys.push(apiKey);
    return {
      emails: {
        async send(payload) {
          sent.push(payload);
          if (behaviour === "throws") throw new Error("network down");
          return behaviour === "api-error" ? { data: null, error: { message: "invalid key" } } : { data: { id: "x" }, error: null };
        },
      },
    };
  };
  return { sent, keys, createClient };
}

const copy = coverLetterEmail({ title: "Junior Dev", company: "Acme" }, "Dear Acme");
const ENABLED = { EMAIL_COPIES_ENABLED: "true", RESEND_API_KEY: "re_test" };

describe("email copies are opt-in", () => {
  test("disabled by default: nothing is sent and no client is created, even with an API key", async () => {
    for (const env of [{}, { RESEND_API_KEY: "re_test" }, { EMAIL_COPIES_ENABLED: "false", RESEND_API_KEY: "re_test" }, { EMAIL_COPIES_ENABLED: "" }, { EMAIL_COPIES_ENABLED: "yes please" }]) {
      const fake = fakeClient();
      assert.equal(await sendEmailCopy(copy, { env, createClient: fake.createClient }), "disabled");
      assert.equal(fake.keys.length, 0);
      assert.equal(fake.sent.length, 0);
    }
  });

  test("only an explicit true/1 enables sending", () => {
    assert.equal(emailCopiesEnabled({}), false);
    assert.equal(emailCopiesEnabled({ EMAIL_COPIES_ENABLED: "true" }), true);
    assert.equal(emailCopiesEnabled({ EMAIL_COPIES_ENABLED: " TRUE " }), true);
    assert.equal(emailCopiesEnabled({ EMAIL_COPIES_ENABLED: "1" }), true);
    assert.equal(emailCopiesEnabled({ EMAIL_COPIES_ENABLED: "0" }), false);
    assert.equal(emailCopiesEnabled({ EMAIL_COPIES_ENABLED: "on" }), false);
  });

  test("the default setting comes from process.env (not enabled for this test run)", () => {
    // Only the setting is checked here; the real sender is never called.
    assert.equal(emailCopiesEnabled(), emailCopiesEnabled(process.env));
    assert.equal(emailCopiesEnabled(), false, "run the tests without EMAIL_COPIES_ENABLED set");
  });

  test("enabled without RESEND_API_KEY: nothing is sent, no client, no error", async () => {
    const fake = fakeClient();
    const outcome = await quietly(() => sendEmailCopy(copy, { env: { EMAIL_COPIES_ENABLED: "true" }, createClient: fake.createClient }));
    assert.equal(outcome, "not_configured");
    assert.equal(fake.keys.length, 0);
  });

  test("explicitly enabled: sends the email from the usual sender to the usual recipient", async () => {
    const fake = fakeClient();
    assert.equal(await sendEmailCopy(copy, { env: ENABLED, createClient: fake.createClient }), "sent");
    assert.deepEqual(fake.keys, ["re_test"]);
    assert.deepEqual(fake.sent, [{ ...copy, from: SENDER, to: DEFAULT_RECIPIENT }]);
    assert.equal(DEFAULT_RECIPIENT, "agyemangstanley1@gmail.com");
    assert.equal(SENDER, "onboarding@resend.dev");
  });

  test("EMAIL_COPIES_TO overrides the recipient", async () => {
    const fake = fakeClient();
    await sendEmailCopy(copy, { env: { ...ENABLED, EMAIL_COPIES_TO: "someone@example.com" }, createClient: fake.createClient });
    assert.equal(fake.sent[0].to, "someone@example.com");
  });

  test("a failing send never throws (generation is never affected)", async () => {
    for (const behaviour of ["throws", "api-error"] as const) {
      const fake = fakeClient(behaviour);
      const outcome = await quietly(() => sendEmailCopy(copy, { env: ENABLED, createClient: fake.createClient }));
      assert.equal(outcome, "failed");
    }
  });
});

describe("the emails themselves are unchanged", () => {
  test("cover letter", () => {
    assert.deepEqual(coverLetterEmail({ title: "Junior Dev", company: "Acme" }, "Dear Acme"), {
      subject: "Cover Letter — Junior Dev at Acme",
      text: "Here is your generated cover letter for Junior Dev at Acme:\n\nDear Acme",
    });
  });

  test("tailored CV as PDF and as the DOCX fallback", () => {
    const content = Buffer.from("%PDF");
    assert.deepEqual(tailoredCvEmail({ title: "Junior Dev", company: "Acme" }, { filename: "CV.pdf", content, format: "pdf" }), {
      subject: "Tailored CV — Junior Dev at Acme",
      text: "Your tailored CV for Junior Dev at Acme is attached as a PDF.",
      attachments: [{ filename: "CV.pdf", content: content.toString("base64") }],
    });
    const docx = tailoredCvEmail(null, { filename: "CV.docx", content: new Uint8Array([1, 2]), format: "docx" });
    assert.equal(docx.subject, "Tailored CV — Role at Company");
    assert.equal(docx.text, "Your tailored CV for Role at Company is attached.");
    assert.equal(docx.attachments![0].content, Buffer.from([1, 2]).toString("base64"));
  });
});

describe("every email path goes through the opt-in", () => {
  // Guards against a route constructing a Resend client directly again.
  const appDir = path.join(import.meta.dirname, "..", "app");
  const routeFiles = (fs.readdirSync(appDir, { recursive: true }) as string[])
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .map((file) => path.join(appDir, file));

  test("no app file imports or constructs Resend directly", () => {
    for (const file of routeFiles) {
      const source = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(source, /from ["']resend["']|new Resend\(|\.emails\.send\(/, file);
    }
  });

  test("the cover-letter and CV routes (used by single-job and batch preparation) send through sendEmailCopy", () => {
    const coverLetter = fs.readFileSync(path.join(appDir, "api", "cover-letter", "route.ts"), "utf8");
    const cv = fs.readFileSync(path.join(appDir, "api", "generate-cv-docx", "route.ts"), "utf8");
    assert.equal(coverLetter.match(/sendEmailCopy\(/g)?.length, 1);
    assert.equal(cv.match(/sendEmailCopy\(/g)?.length, 2); // PDF and DOCX fallback
  });
});
