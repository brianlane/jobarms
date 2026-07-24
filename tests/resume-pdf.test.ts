import { describe, expect, it } from "vitest";
import { renderResumePdf } from "@/lib/resume-pdf";
import type { ParsedResume } from "@/lib/resume-parse";

const longBullet =
  "Led a large cross functional team delivering a high throughput distributed system " +
  "with rigorous testing and observability across many services and regions worldwide.";

const full: ParsedResume = {
  full_name: "Jane Doe",
  email: "jane@example.com",
  phone: "(602) 686-6672",
  location: "Phoenix, AZ",
  headline: "Staff Software Engineer",
  summary: longBullet + " " + longBullet,
  links: { github: "https://github.com/jane", linkedin: "https://linkedin.com/in/jane" },
  work_history: Array.from({ length: 12 }, (_, i) => ({
    company: `Company ${i}`,
    title: `Role ${i}`,
    start: "Jan 2015",
    end: "Present",
    bullets: [longBullet, longBullet, ""]
  })),
  education: [{ school: "Arizona State", degree: "BS", field: "CS", start: "2011", end: "2015" }],
  skills: ["TypeScript", "React", "Node", "Postgres"]
};

const minimal: ParsedResume = {
  full_name: "",
  email: "",
  phone: "",
  location: "",
  headline: "",
  summary: "",
  links: {},
  work_history: [],
  education: [],
  skills: []
};

describe("renderResumePdf", () => {
  it("renders a multi-page PDF for a rich resume", async () => {
    const bytes = await renderResumePdf(full);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
  });

  it("renders a minimal resume without throwing", async () => {
    const bytes = await renderResumePdf(minimal);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
  });

  it("handles sparse/partial entries and an unbroken long token", async () => {
    // Exercises the empty-field branches: role with no title/company/dates,
    // education with no degree/field/dates, and a word longer than the line
    // width (wrap's first-word branch).
    const sparse: ParsedResume = {
      full_name: "",
      email: "",
      phone: "",
      location: "",
      headline: "",
      summary: "x".repeat(400), // single unbroken token exceeds the line width
      links: {},
      work_history: [
        { company: "", title: "", start: "", end: "", bullets: [] },
        { company: "Beta", title: "", start: "2019", end: "", bullets: [""] }
      ],
      education: [{ school: "Solo University", degree: "", field: "", start: "", end: "" }],
      skills: []
    };
    const bytes = await renderResumePdf(sparse);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
  });
});
