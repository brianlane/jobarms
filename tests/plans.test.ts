import { describe, expect, it } from "vitest";
import {
  armRunLimit,
  canTailor,
  effectivePlan,
  FREE_ARM_RUNS_PER_MONTH,
  monthKey
} from "@/lib/plans";

describe("effectivePlan", () => {
  it("null subscription is free", () => {
    expect(effectivePlan(null)).toBe("free");
  });

  it("active premium is premium", () => {
    expect(effectivePlan({ plan: "premium", status: "active" })).toBe("premium");
    expect(effectivePlan({ plan: "premium", status: "trialing" })).toBe("premium");
    expect(effectivePlan({ plan: "premium", status: "past_due" })).toBe("premium");
  });

  it("canceled/incomplete premium falls back to free", () => {
    expect(effectivePlan({ plan: "premium", status: "canceled" })).toBe("free");
    expect(effectivePlan({ plan: "premium", status: "incomplete_expired" })).toBe("free");
  });

  it("free plan row is free regardless of status", () => {
    expect(effectivePlan({ plan: "free", status: "active" })).toBe("free");
  });
});

describe("armRunLimit / canTailor", () => {
  it("free tier gets the metered allowance", () => {
    expect(armRunLimit("free")).toBe(FREE_ARM_RUNS_PER_MONTH);
    expect(canTailor("free")).toBe(false);
  });

  it("premium gets the 300/month fair-use cap and can tailor", () => {
    expect(armRunLimit("premium")).toBe(300);
    expect(canTailor("premium")).toBe(true);
  });
});

describe("aiCallLimit", () => {
  it("free tier: enough parses to onboard, no tailoring", async () => {
    const { aiCallLimit } = await import("@/lib/plans");
    expect(aiCallLimit("free", "resume_parse")).toBe(5);
    expect(aiCallLimit("free", "tailor_resume")).toBe(0);
    expect(aiCallLimit("free", "cover_letter")).toBe(0);
  });

  it("premium tier: generous fair-use ceilings, never unlimited", async () => {
    const { aiCallLimit } = await import("@/lib/plans");
    expect(aiCallLimit("premium", "resume_parse")).toBe(100);
    expect(aiCallLimit("premium", "tailor_resume")).toBe(100);
    expect(aiCallLimit("premium", "cover_letter")).toBe(100);
  });
});

describe("monthKey", () => {
  it("formats UTC YYYY-MM with zero padding", () => {
    expect(monthKey(new Date(Date.UTC(2026, 0, 15)))).toBe("2026-01");
    expect(monthKey(new Date(Date.UTC(2026, 11, 1)))).toBe("2026-12");
  });
});
