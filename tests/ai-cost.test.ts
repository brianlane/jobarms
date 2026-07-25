import { beforeEach, describe, expect, it, vi } from "vitest";

const generateWithUsage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/gemini", () => ({
  generateWithUsage,
  GEMINI_TEXT_MODEL: "gemini-3.6-flash",
  GEMINI_FALLBACK_MODEL: "gemini-3.5-flash-lite"
}));

import {
  costMicros,
  CONFIGURED_MODELS,
  formatMicros,
  generateMetered,
  isEstimatedPrice,
  microsToUsd,
  priceFor,
  PRIMARY_MODEL_PRICE,
  recordAiSpend
} from "@/lib/ai-cost";

function client(over: { error?: unknown; throws?: boolean } = {}) {
  const rpc = vi.fn(async () => {
    if (over.throws) throw new Error("network");
    return { error: over.error ?? null };
  });
  return { client: { rpc }, rpc };
}

beforeEach(() => {
  generateWithUsage.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("pricing", () => {
  it("uses a known rate when we have one", () => {
    const { price, exact } = priceFor("gemini-3.6-flash");
    expect(exact).toBe(true);
    expect(price).toEqual(PRIMARY_MODEL_PRICE);
    expect(isEstimatedPrice("gemini-3.6-flash")).toBe(false);
  });

  it("prices an unknown model at the primary rate and says so", () => {
    const { price, exact } = priceFor("some-future-model");
    expect(exact).toBe(false);
    expect(price).toEqual(PRIMARY_MODEL_PRICE);
    expect(isEstimatedPrice("some-future-model")).toBe(true);
  });

  it("charges dollars per million tokens as micros per token", () => {
    // 1M input at $1.50 and 1M output at $7.50 is $9.00, which is 9,000,000 micros.
    expect(costMicros("gemini-3.6-flash", 1_000_000, 1_000_000)).toBe(9_000_000);
    expect(costMicros("gemini-3.6-flash", 1000, 500)).toBe(1500 + 3750);
  });

  it("never charges for negative tokens", () => {
    expect(costMicros("gemini-3.6-flash", -5, -5)).toBe(0);
  });

  it("uses the other known model rate where it differs", () => {
    expect(costMicros("gemini-3.5-flash", 0, 1_000_000)).toBe(9_000_000);
  });
});

describe("money formatting", () => {
  it("scales from sub-cent to dollars", () => {
    expect(formatMicros(0)).toBe("$0");
    expect(formatMicros(500)).toBe("<$0.01");
    expect(formatMicros(1_234_000)).toBe("$1.23");
    expect(formatMicros(250_000_000)).toBe("$250");
  });

  it("converts micros to dollars", () => {
    expect(microsToUsd(1_500_000)).toBe(1.5);
  });

  it("exposes the configured models", () => {
    expect(CONFIGURED_MODELS).toEqual({
      primary: "gemini-3.6-flash",
      fallback: "gemini-3.5-flash-lite"
    });
  });
});

describe("recordAiSpend", () => {
  const usage = {
    model: "gemini-3.6-flash",
    inputTokens: 1000,
    outputTokens: 500,
    usedFallback: false
  };

  it("writes the row with a computed cost", async () => {
    const { client: db, rpc } = client();
    await recordAiSpend(db, { ...usage, kind: "resume_parse", userId: "u1", runId: "r1" });
    expect(rpc).toHaveBeenCalledWith("record_ai_spend", {
      p_user_id: "u1",
      p_run_id: "r1",
      p_kind: "resume_parse",
      p_model: "gemini-3.6-flash",
      p_used_fallback: false,
      p_input_tokens: 1000,
      p_output_tokens: 500,
      p_cost_micros: 5250
    });
  });

  it("nulls absent attribution", async () => {
    const { client: db, rpc } = client();
    await recordAiSpend(db, { ...usage, kind: "vision_recovery" });
    expect(rpc).toHaveBeenCalledWith(
      "record_ai_spend",
      expect.objectContaining({ p_user_id: null, p_run_id: null })
    );
  });

  it("swallows a write error so the model call still counts as a success", async () => {
    const { client: db } = client({ error: { message: "denied" } });
    await expect(
      recordAiSpend(db, { ...usage, kind: "resume_parse" })
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("swallows a thrown client failure", async () => {
    const { client: db } = client({ throws: true });
    await expect(
      recordAiSpend(db, { ...usage, kind: "resume_parse" })
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});

describe("generateMetered", () => {
  it("returns the text and bills the call when a meter is present", async () => {
    generateWithUsage.mockResolvedValueOnce({
      text: "answer",
      usage: {
        model: "gemini-3.6-flash",
        inputTokens: 10,
        outputTokens: 20,
        usedFallback: true
      }
    });
    const { client: db, rpc } = client();
    const text = await generateMetered("cover_letter", { contents: [] }, { client: db, userId: "u1" });
    expect(text).toBe("answer");
    expect(rpc).toHaveBeenCalledWith(
      "record_ai_spend",
      expect.objectContaining({ p_used_fallback: true, p_kind: "cover_letter", p_run_id: null })
    );
  });

  it("records platform-level cost when the meter carries no user", async () => {
    generateWithUsage.mockResolvedValueOnce({
      text: "answer",
      usage: { model: "m", inputTokens: 1, outputTokens: 1, usedFallback: false }
    });
    const { client: db, rpc } = client();
    await generateMetered("vision_recovery", { contents: [] }, { client: db });
    expect(rpc).toHaveBeenCalledWith(
      "record_ai_spend",
      expect.objectContaining({ p_user_id: null, p_run_id: null })
    );
  });

  it("works unmetered, so scripts and tests need no database", async () => {
    generateWithUsage.mockResolvedValueOnce({
      text: "answer",
      usage: { model: "m", inputTokens: 0, outputTokens: 0, usedFallback: false }
    });
    expect(await generateMetered("resume_parse", { contents: [] })).toBe("answer");
  });
});
