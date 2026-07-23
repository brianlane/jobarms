import { describe, expect, it } from "vitest";
import {
  aiCallQuota,
  armRunQuota,
  canFullAuto,
  canTailor,
  effectivePlan,
  FREE_ARM_RUNS_PER_MONTH,
  FREE_RESUME_PARSES_LIFETIME,
  MAX_ARM_RUNS_PER_DAY,
  meterKey,
  monthKey,
  PREMIUM_ARM_RUNS_PER_MONTH
} from "@/lib/plans";

describe("effectivePlan", () => {
  it("null subscription is free", () => {
    expect(effectivePlan(null)).toBe("free");
  });

  it("active paid rows map to their tier", () => {
    expect(effectivePlan({ plan: "premium", status: "active" })).toBe("premium");
    expect(effectivePlan({ plan: "premium", status: "trialing" })).toBe("premium");
    expect(effectivePlan({ plan: "max", status: "active" })).toBe("max");
    expect(effectivePlan({ plan: "max", status: "past_due" })).toBe("max");
  });

  it("canceled/incomplete paid rows fall back to free", () => {
    expect(effectivePlan({ plan: "premium", status: "canceled" })).toBe("free");
    expect(effectivePlan({ plan: "max", status: "incomplete_expired" })).toBe("free");
  });

  it("free plan row is free regardless of status", () => {
    expect(effectivePlan({ plan: "free", status: "active" })).toBe("free");
  });
});

describe("armRunQuota", () => {
  it("free: 3 per month", () => {
    expect(armRunQuota("free")).toEqual({ limit: FREE_ARM_RUNS_PER_MONTH, window: "month" });
    expect(FREE_ARM_RUNS_PER_MONTH).toBe(3);
  });

  it("premium: 200 per month", () => {
    expect(armRunQuota("premium")).toEqual({
      limit: PREMIUM_ARM_RUNS_PER_MONTH,
      window: "month"
    });
    expect(PREMIUM_ARM_RUNS_PER_MONTH).toBe(200);
  });

  it("max: 100 per DAY", () => {
    expect(armRunQuota("max")).toEqual({ limit: MAX_ARM_RUNS_PER_DAY, window: "day" });
    expect(MAX_ARM_RUNS_PER_DAY).toBe(100);
  });
});

describe("feature gates", () => {
  it("tailoring and full-auto are paid features", () => {
    expect(canTailor("free")).toBe(false);
    expect(canFullAuto("free")).toBe(false);
    expect(canTailor("premium")).toBe(true);
    expect(canFullAuto("premium")).toBe(true);
    expect(canTailor("max")).toBe(true);
    expect(canFullAuto("max")).toBe(true);
  });
});

describe("aiCallQuota", () => {
  it("free parses are a LIFETIME allowance of 2; no tailoring", () => {
    expect(aiCallQuota("free", "resume_parse")).toEqual({
      limit: FREE_RESUME_PARSES_LIFETIME,
      window: "lifetime"
    });
    expect(FREE_RESUME_PARSES_LIFETIME).toBe(2);
    expect(aiCallQuota("free", "tailor_resume").limit).toBe(0);
    expect(aiCallQuota("free", "cover_letter").limit).toBe(0);
  });

  it("paid tiers get monthly fair-use ceilings, never unlimited", () => {
    expect(aiCallQuota("premium", "resume_parse")).toEqual({ limit: 100, window: "month" });
    expect(aiCallQuota("premium", "tailor_resume")).toEqual({ limit: 100, window: "month" });
    expect(aiCallQuota("max", "resume_parse")).toEqual({ limit: 300, window: "month" });
    expect(aiCallQuota("max", "cover_letter")).toEqual({ limit: 300, window: "month" });
  });
});

describe("meterKey", () => {
  const jan15 = new Date(Date.UTC(2026, 0, 15));

  it("month window: UTC YYYY-MM", () => {
    expect(meterKey("month", jan15)).toBe("2026-01");
    expect(monthKey(new Date(Date.UTC(2026, 11, 1)))).toBe("2026-12");
  });

  it("day window: UTC YYYY-MM-DD", () => {
    expect(meterKey("day", jan15)).toBe("2026-01-15");
    expect(meterKey("day", new Date(Date.UTC(2026, 8, 3)))).toBe("2026-09-03");
  });

  it("lifetime window: constant key", () => {
    expect(meterKey("lifetime", jan15)).toBe("lifetime");
  });
});
