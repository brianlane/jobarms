import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { ParsedResume } from "@/lib/resume-parse";

const PAGE_W = 612; // US Letter
const PAGE_H = 792;
const MARGIN = 54;
const BODY = 10;
const ACCENT = rgb(0.05, 0.55, 0.51);
const INK = rgb(0.1, 0.12, 0.16);
const GRAY = rgb(0.4, 0.44, 0.5);

/** Render a clean single-column resume PDF from structured data. */
export async function renderResumePdf(resume: ParsedResume): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const ensureRoom = (needed: number) => {
    if (y - needed < MARGIN) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };

  const wrap = (text: string, f: PDFFont, size: number, width: number): string[] => {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const attempt = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(attempt, size) > width && line) {
        lines.push(line);
        line = word;
      } else {
        line = attempt;
      }
    }
    if (line) lines.push(line);
    return lines;
  };

  const draw = (text: string, f: PDFFont, size: number, color = INK, indent = 0) => {
    const width = PAGE_W - MARGIN * 2 - indent;
    for (const line of wrap(text, f, size, width)) {
      ensureRoom(size + 4);
      (page as PDFPage).drawText(line, { x: MARGIN + indent, y, size, font: f, color });
      y -= size + 4;
    }
  };

  const heading = (text: string) => {
    y -= 8;
    ensureRoom(24);
    draw(text.toUpperCase(), bold, 11, ACCENT);
    y -= 2;
  };

  // Header
  draw(resume.full_name || "Resume", bold, 22);
  if (resume.headline) draw(resume.headline, font, 12, GRAY);
  const contact = [resume.email, resume.phone, resume.location, ...Object.values(resume.links)]
    .filter(Boolean)
    .join("  ·  ");
  if (contact) draw(contact, font, 9, GRAY);

  if (resume.summary) {
    heading("Summary");
    draw(resume.summary, font, BODY);
  }

  if (resume.work_history.length > 0) {
    heading("Experience");
    for (const role of resume.work_history) {
      ensureRoom(30);
      draw(`${role.title}${role.title && role.company ? " - " : ""}${role.company}`, bold, 11);
      const dates = [role.start, role.end].filter(Boolean).join(" – ");
      if (dates) draw(dates, font, 9, GRAY);
      for (const bullet of role.bullets.filter(Boolean)) {
        draw(`•  ${bullet}`, font, BODY, INK, 10);
      }
      y -= 4;
    }
  }

  if (resume.education.length > 0) {
    heading("Education");
    for (const ed of resume.education) {
      const line1 = [ed.degree, ed.field].filter(Boolean).join(", ");
      draw(`${ed.school}${line1 ? ` - ${line1}` : ""}`, bold, 11);
      const dates = [ed.start, ed.end].filter(Boolean).join(" – ");
      if (dates) draw(dates, font, 9, GRAY);
      y -= 2;
    }
  }

  if (resume.skills.length > 0) {
    heading("Skills");
    draw(resume.skills.join("  ·  "), font, BODY);
  }

  return doc.save();
}
