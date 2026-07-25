import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateWithUsage, extractJson } = vi.hoisted(() => ({
  generateWithUsage: vi.fn(),
  extractJson: vi.fn()
}));
vi.mock("@/lib/gemini", () => ({
  generateWithUsage,
  extractJson,
  GEMINI_TEXT_MODEL: "test-model",
  GEMINI_FALLBACK_MODEL: "test-fallback"
}));

import { generateCoverLetter, tailorResume } from "@/lib/tailor";

const profile = { full_name: "Jane", skills: ["ts"] };

const usage = {
  model: "test-model",
  inputTokens: 100,
  outputTokens: 40,
  usedFallback: false
};

beforeEach(() => {
  generateWithUsage.mockReset();
  extractJson.mockReset();
});

describe("tailorResume", () => {
  it("returns the parsed resume + keyword analysis", async () => {
    generateWithUsage.mockResolvedValueOnce({ text: "<json>", usage });
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
    expect(generateWithUsage.mock.calls[0][0].config.temperature).toBe(0.3);
  });
});

describe("generateCoverLetter", () => {
  it("trims and returns the letter", async () => {
    generateWithUsage.mockResolvedValueOnce({ text: "  Hi Acme team, ...  ", usage });
    const letter = await generateCoverLetter(profile, "Engineer", "Acme", "desc");
    expect(letter).toBe("Hi Acme team, ...");
  });

  it("throws when the model returns an empty letter", async () => {
    generateWithUsage.mockResolvedValueOnce({ text: "   ", usage });
    await expect(generateCoverLetter(profile, "Engineer", "Acme", "desc")).rejects.toThrow(
      "empty cover letter"
    );
  });
});
