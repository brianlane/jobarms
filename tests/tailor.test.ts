import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateWithRetry, extractJson } = vi.hoisted(() => ({
  generateWithRetry: vi.fn(),
  extractJson: vi.fn()
}));
vi.mock("@/lib/gemini", () => ({ generateWithRetry, extractJson }));

import { generateCoverLetter, tailorResume } from "@/lib/tailor";

const profile = { full_name: "Jane", skills: ["ts"] };

beforeEach(() => {
  generateWithRetry.mockReset();
  extractJson.mockReset();
});

describe("tailorResume", () => {
  it("returns the parsed resume + keyword analysis", async () => {
    generateWithRetry.mockResolvedValueOnce("<json>");
    extractJson.mockReturnValueOnce({
      resume: {
        full_name: "Jane",
        email: "",
        phone: "",
        location: "",
        headline: "",
        summary: "",
        links: {},
        work_history: [],
        education: [],
        skills: ["TypeScript"]
      },
      keywords: { incorporated: ["TypeScript"], missing: ["Go"] }
    });
    const result = await tailorResume(profile, "Engineer", "Acme", "desc");
    expect(result.keywords.incorporated).toContain("TypeScript");
    expect(result.resume.full_name).toBe("Jane");
    // prompt carries the job + profile
    expect(generateWithRetry.mock.calls[0][0].config.temperature).toBe(0.3);
  });
});

describe("generateCoverLetter", () => {
  it("trims and returns the letter", async () => {
    generateWithRetry.mockResolvedValueOnce("  Hi Acme team, ...  ");
    const letter = await generateCoverLetter(profile, "Engineer", "Acme", "desc");
    expect(letter).toBe("Hi Acme team, ...");
  });

  it("throws when the model returns an empty letter", async () => {
    generateWithRetry.mockResolvedValueOnce("   ");
    await expect(generateCoverLetter(profile, "Engineer", "Acme", "desc")).rejects.toThrow(
      "empty cover letter"
    );
  });
});
