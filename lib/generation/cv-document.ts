import { exec } from "child_process";
import { promisify } from "util";
import { tmpdir } from "os";
import { join } from "path";
import { writeFile, readFile, unlink } from "fs/promises";
import {
  Document, Packer, Paragraph, TextRun, AlignmentType,
  BorderStyle, convertInchesToTwip,
} from "docx";

// The tailored CV document (PDF via LibreOffice, or DOCX if the conversion
// fails), moved unchanged from app/api/generate-cv-docx/route.ts (3c) so the
// route and server-side preparation share it. It never sends email: only the
// route sends its (opt-in) email copy.

/* eslint-disable @typescript-eslint/no-explicit-any -- free-form tailored CV data, as in the original route */
const execAsync = promisify(exec);

// ── Skill categories ──────────────────────────────────────────────────────────
const SKILL_CATEGORIES: Record<string, string[]> = {
  "Languages": ["Kotlin", "Java", "JavaScript", "HTML", "CSS", "XML", "SQL"],
  "Mobile": ["Android Studio", "Jetpack", "App Remote SDK", "Material Design", "MVVM"],
  "Backend / Web": ["Firebase Firestore", "Firebase Auth", "Spotify Web API", "REST APIs", "Node.js", "Node.js (basic)"],
  "Tools": ["Git", "GitHub", "GitHub Pages", "IntelliJ", "Eclipse", "Figma", "Figma (basic)"],
};

function categoriseSkills(skills: string[]) {
  const used = new Set<string>();
  const result: Record<string, string[]> = {};

  for (const [cat, keywords] of Object.entries(SKILL_CATEGORIES)) {
    const matched = skills.filter(s =>
      keywords.some(k => s.toLowerCase().includes(k.toLowerCase()))
    );
    if (matched.length > 0) {
      result[cat] = matched;
      matched.forEach(s => used.add(s));
    }
  }

  const misc = skills.filter(s => !used.has(s));
  if (misc.length > 0) result["Other"] = misc;

  return result;
}

// ── File naming ───────────────────────────────────────────────────────────────
// Header values must be plain ASCII; company names can contain characters
// (en dashes, quotes, accents, emoji) that would break Content-Disposition.
function safeFilenamePart(text: string) {
  return (text || "")
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, "")
    .trim()
    .replace(/\s+/g, "_") || "Unknown";
}

function buildFileName(name: string | undefined, company: string, ext: "pdf" | "docx") {
  return `${safeFilenamePart(name || "CV")}_${safeFilenamePart(company)}_CV.${ext}`;
}

// ── Style constants ───────────────────────────────────────────────────────────
const FONT = "Calibri";
const BLACK = "000000";
const MARGIN = convertInchesToTwip(0.6);
const SIZE_NAME = 32;
const SIZE_BODY = 20;
const SIZE_HEAD = 22;

// ── Paragraph builders ────────────────────────────────────────────────────────
function namePara(text: string) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 0 },
    children: [new TextRun({ text, font: FONT, size: SIZE_NAME, bold: true, color: BLACK })],
  });
}

function subtitlePara(text: string) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 40 },
    children: [new TextRun({ text, font: FONT, size: SIZE_BODY, color: BLACK })],
  });
}

function contactPara(text: string) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 120 },
    children: [new TextRun({ text, font: FONT, size: SIZE_BODY, color: BLACK })],
  });
}

function sectionHeader(text: string) {
  return new Paragraph({
    spacing: { before: 160, after: 40 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: BLACK } },
    children: [new TextRun({ text, font: FONT, size: SIZE_HEAD, bold: true, color: BLACK })],
  });
}

function entryHeader(title: string, right?: string) {
  return new Paragraph({
    spacing: { before: 100, after: 0 },
    tabStops: [{ type: "right", position: convertInchesToTwip(7.3) }],
    children: [
      new TextRun({ text: title, font: FONT, size: SIZE_BODY, bold: true, color: BLACK }),
      right ? new TextRun({ text: `\t${right}`, font: FONT, size: SIZE_BODY, italics: true, color: BLACK }) : new TextRun(""),
    ],
  });
}

function subLine(text: string) {
  return new Paragraph({
    spacing: { before: 0, after: 0 },
    children: [new TextRun({ text, font: FONT, size: SIZE_BODY, italics: true, color: BLACK })],
  });
}

function bullet(text: string) {
  return new Paragraph({
    spacing: { before: 0, after: 40 },
    indent: { left: convertInchesToTwip(0.25), hanging: convertInchesToTwip(0.15) },
    children: [
      new TextRun({ text: "● ", font: FONT, size: SIZE_BODY, color: BLACK }),
      new TextRun({ text, font: FONT, size: SIZE_BODY, color: BLACK }),
    ],
  });
}

function skillLine(label: string, value: string) {
  return new Paragraph({
    spacing: { before: 0, after: 40 },
    children: [
      new TextRun({ text: `${label}: `, font: FONT, size: SIZE_BODY, bold: true, color: BLACK }),
      new TextRun({ text: value, font: FONT, size: SIZE_BODY, color: BLACK }),
    ],
  });
}

function plain(text: string) {
  return new Paragraph({
    spacing: { before: 0, after: 60 },
    children: [new TextRun({ text, font: FONT, size: SIZE_BODY, color: BLACK })],
  });
}

// ── Build document ────────────────────────────────────────────────────────────
function buildCV(cv: any) {
  const children: Paragraph[] = [];

  // Header
  children.push(namePara(cv.name || ""));
  children.push(subtitlePara("Software Engineering Graduate • Android • Web • Full Stack"));
  const contact = [cv.email, cv.phone, cv.location, "agyemstan4.github.io"].filter(Boolean).join(" • ");
  children.push(contactPara(contact));

  // Personal Profile
  if (cv.summary) {
    children.push(sectionHeader("PERSONAL PROFILE"));
    children.push(plain(cv.summary));
  }

  // Technical Skills
  const categorised = categoriseSkills(cv.skills || []);
  if (Object.keys(categorised).length > 0) {
    children.push(sectionHeader("TECHNICAL SKILLS"));
    for (const [cat, skills] of Object.entries(categorised)) {
      children.push(skillLine(cat, skills.join(" • ")));
    }
  }

  // Projects
  if (cv.projects?.length) {
    children.push(sectionHeader("PROJECTS"));
    for (const project of cv.projects) {
      children.push(entryHeader(project.name || "", project.date || ""));
      if (Array.isArray(project.bullets)) {
        for (const b of project.bullets) {
          children.push(bullet(b));
        }
      } else if (project.description) {
        // Fallback for any old-shape data still floating around
        const lines = project.description.split(". ").filter(Boolean);
        for (const line of lines) {
          children.push(bullet(line.endsWith(".") ? line : line + "."));
        }
      }
      if (project.skillsUsed?.length) {
        const skills = Array.isArray(project.skillsUsed)
          ? project.skillsUsed.join(", ")
          : project.skillsUsed;
        children.push(new Paragraph({
          spacing: { before: 0, after: 40 },
          children: [new TextRun({ text: `Skills: ${skills}`, font: FONT, size: SIZE_BODY, italics: true, color: BLACK })],
        }));
      }
    }
  }

  // Work Experience
  if (cv.experience?.length) {
    children.push(sectionHeader("WORK EXPERIENCE"));
    for (const job of cv.experience) {
      const hasRealCompany = job.company && job.company.trim().toLowerCase() !== "n/a";
      const title = hasRealCompany ? `${job.title} — ${job.company}` : job.title;
      children.push(entryHeader(title, job.dates || ""));
      for (const b of job.bullets || []) {
        children.push(bullet(b));
      }
    }
  }

  // Education
  if (cv.education?.length) {
    children.push(sectionHeader("EDUCATION"));
    for (const edu of cv.education) {
      children.push(entryHeader(edu.degree || "", edu.dates || ""));
      if (edu.institution) children.push(subLine(edu.institution));
      if (edu.notes) children.push(bullet(edu.notes));
    }
  }

  // Interests
  children.push(sectionHeader("INTERESTS"));
  children.push(plain("Music production and sound engineering • Football and gym • Android app development • AI and software trends"));

  // References
  children.push(sectionHeader("REFERENCES"));
  children.push(plain("Available on request."));

  return new Document({
    sections: [{
      properties: {
        page: { margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } },
      },
      children,
    }],
  });
}

// ── Render ──────────────────────────────────────────────────────────────────
export type CvDocumentFile = {
  buffer: Buffer;
  filename: string;
  format: "pdf" | "docx";
  mimeType: string;
  /** Milliseconds spent building the DOCX and converting it to PDF (for performance logging). */
  timings?: { docxMs: number; pdfMs: number };
};

export const PDF_MIME = "application/pdf";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Builds the DOCX and converts it to PDF; falls back to the DOCX if LibreOffice fails. */
export async function renderCvDocument(tailoredCV: any, job: any): Promise<CvDocumentFile> {
    const docxStart = Date.now();
    const doc = buildCV(tailoredCV);
    const docxBuffer = await Packer.toBuffer(doc);
    const docxMs = Date.now() - docxStart;
    const jobCompany = job?.company || "Company";

    // Convert to PDF via LibreOffice
    const tmpDocx = join(tmpdir(), `cv_${Date.now()}_${Math.random().toString(36).slice(2)}.docx`);
    const tmpPdf = tmpDocx.replace(".docx", ".pdf");

    await writeFile(tmpDocx, docxBuffer);

    const pdfStart = Date.now();
    try {
      await execAsync(
  `"C:\\Program Files\\LibreOffice\\program\\soffice.exe" --headless --convert-to pdf --outdir "${tmpdir()}" "${tmpDocx}"`
);
    } catch (e) {
      console.error("LibreOffice conversion failed:", e);
      // Fall back to the DOCX if LibreOffice fails
      await unlink(tmpDocx).catch(() => {});
      return { buffer: docxBuffer, filename: buildFileName(tailoredCV.name, jobCompany, "docx"), format: "docx", mimeType: DOCX_MIME, timings: { docxMs, pdfMs: Date.now() - pdfStart } };
    }

    const pdfBuffer = await readFile(tmpPdf);

    // Cleanup temp files
    await Promise.all([
      unlink(tmpDocx).catch(() => {}),
      unlink(tmpPdf).catch(() => {}),
    ]);

    return { buffer: pdfBuffer, filename: buildFileName(tailoredCV.name, jobCompany, "pdf"), format: "pdf", mimeType: PDF_MIME, timings: { docxMs, pdfMs: Date.now() - pdfStart } };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
