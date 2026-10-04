import path from "node:path";
import { Resend } from "resend";

// Email copies of generated documents (a tailored CV, a cover letter), sent
// to the candidate's own inbox through Resend.
//
// OFF by default. Enable deliberately with EMAIL_COPIES_ENABLED=true (and
// RESEND_API_KEY). Optional: EMAIL_COPIES_TO overrides the recipient.
// When disabled, no Resend client is created and RESEND_API_KEY is not
// needed. Sending never throws and never blocks or fails the generation.
//
// Safety guard: even when enabled, nothing is ever sent from a test or
// scratch run (see emailBlockedReason) — a test runner, a server pointed at a
// database other than the live .data/jobs.db (every scratch, acceptance and
// benchmark server uses JOB_AGENT_DB_PATH), or JOB_AGENT_NO_EMAIL=1.

export const DEFAULT_RECIPIENT = "agyemangstanley1@gmail.com";
export const SENDER = "onboarding@resend.dev";

export type EmailCopy = {
  subject: string;
  text: string;
  attachments?: { filename: string; content: string }[];
};

export type EmailClient = {
  emails: { send(payload: EmailCopy & { from: string; to: string }): Promise<unknown> };
};

export type SendOutcome = "disabled" | "blocked" | "not_configured" | "sent" | "failed";

type Env = Record<string, string | undefined>;

export function emailCopiesEnabled(env: Env = process.env): boolean {
  const value = env.EMAIL_COPIES_ENABLED?.trim().toLowerCase();
  return value === "true" || value === "1";
}

/** The live database location (the default when JOB_AGENT_DB_PATH is not set). */
const LIVE_DB_PATH = path.join(process.cwd(), ".data", "jobs.db");

/**
 * Why email must not be sent from this process, or null when it may be.
 * Test and scratch runs can never send, whatever EMAIL_COPIES_ENABLED says.
 */
export function emailBlockedReason(env: Env = process.env, liveDbPath: string = LIVE_DB_PATH): string | null {
  const off = env.JOB_AGENT_NO_EMAIL?.trim().toLowerCase();
  if (off === "1" || off === "true") return "JOB_AGENT_NO_EMAIL is set";
  if (env.NODE_ENV === "test" || env.NODE_TEST_CONTEXT) return "running under a test runner";
  const custom = env.JOB_AGENT_DB_PATH?.trim();
  if (custom && path.resolve(custom).toLowerCase() !== path.resolve(liveDbPath).toLowerCase()) {
    return "using a scratch database (JOB_AGENT_DB_PATH is not the live database)";
  }
  return null;
}

const defaultClient = (apiKey: string): EmailClient => new Resend(apiKey) as unknown as EmailClient;

/**
 * Sends an email copy if (and only if) email copies are enabled and an API
 * key is configured. Never throws.
 */
export async function sendEmailCopy(
  copy: EmailCopy,
  options: { env?: Env; createClient?: (apiKey: string) => EmailClient } = {}
): Promise<SendOutcome> {
  const env = options.env ?? process.env;
  if (!emailCopiesEnabled(env)) return "disabled";
  const blocked = emailBlockedReason(env);
  if (blocked) {
    console.warn(`Email copies are enabled but blocked (${blocked}); no email sent.`);
    return "blocked";
  }

  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    console.warn("Email copies are enabled but RESEND_API_KEY is not set; no email sent.");
    return "not_configured";
  }
  try {
    const client = (options.createClient ?? defaultClient)(apiKey);
    const result = (await client.emails.send({
      ...copy,
      from: SENDER,
      to: env.EMAIL_COPIES_TO?.trim() || DEFAULT_RECIPIENT,
    })) as { error?: { message?: string } | null } | undefined;
    // The Resend SDK reports API errors in the result rather than throwing.
    if (result?.error) {
      console.error("Resend email failed:", result.error);
      return "failed";
    }
    return "sent";
  } catch (error) {
    console.error("Resend email failed:", error);
    return "failed";
  }
}

// ── The emails the app sends (unchanged content) ───────────────────────────

export function coverLetterEmail(job: { title?: string; company?: string }, coverLetter: string): EmailCopy {
  return {
    subject: `Cover Letter — ${job.title} at ${job.company}`,
    text: `Here is your generated cover letter for ${job.title} at ${job.company}:\n\n${coverLetter}`,
  };
}

export function tailoredCvEmail(
  job: { title?: string; company?: string } | null | undefined,
  file: { filename: string; content: Buffer | Uint8Array; format: "pdf" | "docx" }
): EmailCopy {
  const jobTitle = job?.title || "Role";
  const jobCompany = job?.company || "Company";
  return {
    subject: `Tailored CV — ${jobTitle} at ${jobCompany}`,
    text:
      file.format === "pdf"
        ? `Your tailored CV for ${jobTitle} at ${jobCompany} is attached as a PDF.`
        : `Your tailored CV for ${jobTitle} at ${jobCompany} is attached.`,
    attachments: [{ filename: file.filename, content: Buffer.from(file.content).toString("base64") }],
  };
}
