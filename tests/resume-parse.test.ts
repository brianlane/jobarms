import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateWithRetry, extractJson } = vi.hoisted(() => ({
  generateWithRetry: vi.fn(),
  extractJson: vi.fn()
}));
vi.mock("@/lib/gemini", () => ({ generateWithRetry, extractJson }));

import { NotAResumeError, normalizeParsedResume, parseResume } from "@/lib/resume-parse";

beforeEach(() => {
  generateWithRetry.mockReset();
  extractJson.mockReset();
  generateWithRetry.mockResolvedValue("<model text>");
});

describe("parseResume", () => {
  it("throws NotAResumeError when the model flags a non-resume", async () => {
    extractJson.mockReturnValueOnce({ not_a_resume: true });
    await expect(parseResume(new Uint8Array([1]), "application/pdf")).rejects.toBeInstanceOf(
      NotAResumeError
    );
  });

  it("parses + normalizes a real resume", async () => {
    extractJson.mockReturnValueOnce({
      full_name: "BRIAN LANE",
      email: "BRIAN@EXAMPLE.COM",
      phone: "6026866672",
      headline: "SENIOR SOFTWARE ENGINEER",
      skills: ["typescript"]
    });
    const parsed = await parseResume(new Uint8Array([1]), "application/pdf");
    expect(parsed.full_name).toBe("Brian Lane");
    expect(parsed.email).toBe("brian@example.com");
    expect(parsed.phone).toBe("(602) 686-6672");
    expect(parsed.headline).toBe("Senior Software Engineer");
  });
});

describe("normalizeParsedResume", () => {
  it("fixes shouty fields, email, phone, and nested history/education", () => {
    const out = normalizeParsedResume({
      full_name: "JANE DOE",
      email: "Jane@Example.com",
      phone: "1 (602) 686-6672",
      location: "PHOENIX, AZ",
      headline: "STAFF ENGINEER",
      summary: "BUILT SQL PIPELINES.",
      links: {},
      work_history: [
        { company: "ACME CORP", title: "SENIOR ENGINEER", start: "2020", end: "Present", bullets: ["SHIPPED FAST."] }
      ],
      education: [{ school: "ARIZONA STATE", degree: "BS", field: "COMPUTER SCIENCE", start: "2013", end: "2017" }],
      skills: ["TYPESCRIPT", "react"]
    });
    expect(out.full_name).toBe("Jane Doe");
    expect(out.email).toBe("jane@example.com");
    expect(out.phone).toBe("+1 (602) 686-6672");
    expect(out.location).toBe("Phoenix, Az"); // AZ isn't in the acronym set
    expect(out.work_history[0].company).toBe("Acme Corp");
    expect(out.work_history[0].bullets[0]).toBe("Shipped fast.");
    expect(out.education[0].field).toBe("Computer Science");
    expect(out.skills[0]).toBe("Typescript");
  });
});
