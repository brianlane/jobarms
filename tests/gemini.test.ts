import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.fn();
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
  }
}));

beforeEach(() => {
  generateContent.mockReset();
  process.env.GEMINI_API_KEY = "test-key";
});
afterEach(() => {
  vi.useRealTimers();
});

describe("extractJson", () => {
  it("parses plain JSON", async () => {
    const { extractJson } = await import("@/lib/gemini");
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("strips ```json fences", async () => {
    const { extractJson } = await import("@/lib/gemini");
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('```\n{"a":3}\n```')).toEqual({ a: 3 });
  });
});

describe("generateWithRetry", () => {
  it("returns text on the first successful call", async () => {
    generateContent.mockResolvedValueOnce({ text: "hello" });
    const { generateWithRetry } = await import("@/lib/gemini");
    expect(await generateWithRetry({ contents: [] })).toBe("hello");
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("returns empty string when the model yields no text", async () => {
    generateContent.mockResolvedValueOnce({});
    const { generateWithRetry } = await import("@/lib/gemini");
    expect(await generateWithRetry({ contents: [] })).toBe("");
  });

  it("throws immediately on a non-transient error (no retry)", async () => {
    generateContent.mockRejectedValueOnce(new Error("400 invalid request"));
    const { generateWithRetry } = await import("@/lib/gemini");
    await expect(generateWithRetry({ contents: [] })).rejects.toThrow("400 invalid request");
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("retries transient errors and falls back to the fallback model", async () => {
    vi.useFakeTimers();
    generateContent
      .mockRejectedValueOnce({ status: 503 })
      .mockRejectedValueOnce({ status: 429 })
      .mockRejectedValueOnce(new Error("model is overloaded"))
      .mockResolvedValueOnce({ text: "recovered" });
    const { generateWithRetry } = await import("@/lib/gemini");
    const p = generateWithRetry({ contents: [] });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("recovered");
    expect(generateContent).toHaveBeenCalledTimes(4);
  });

  it("throws the last error after exhausting both models", async () => {
    vi.useFakeTimers();
    generateContent.mockRejectedValue(new Error("RESOURCE_EXHAUSTED"));
    const { generateWithRetry } = await import("@/lib/gemini");
    const p = generateWithRetry({ contents: [] });
    const assertion = expect(p).rejects.toThrow("RESOURCE_EXHAUSTED");
    await vi.runAllTimersAsync();
    await assertion;
    expect(generateContent).toHaveBeenCalledTimes(6);
  });

  it("detects transience from a non-Error rejection's string form", async () => {
    vi.useFakeTimers();
    // A thrown string: status is undefined, so isTransient falls to String(err)
    // and matches the message regex ("overloaded").
    generateContent.mockRejectedValueOnce("service overloaded").mockResolvedValueOnce({ text: "ok" });
    const { generateWithRetry } = await import("@/lib/gemini");
    const p = generateWithRetry({ contents: [] });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
  });

  it("throws immediately on a non-Error, non-transient rejection", async () => {
    generateContent.mockRejectedValueOnce({ status: 418 });
    const { generateWithRetry } = await import("@/lib/gemini");
    await expect(generateWithRetry({ contents: [] })).rejects.toBeDefined();
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("wraps a non-Error transient rejection when all attempts fail", async () => {
    vi.useFakeTimers();
    generateContent.mockRejectedValue({ status: 503 });
    const { generateWithRetry } = await import("@/lib/gemini");
    const p = generateWithRetry({ contents: [] });
    const assertion = expect(p).rejects.toBeInstanceOf(Error);
    await vi.runAllTimersAsync();
    await assertion;
  });
});
