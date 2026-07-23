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

  it("premium is unlimited and can tailor", () => {
    expect(armRunLimit("premium")).toBe(-1);
    expect(canTailor("premium")).toBe(true);
  });
});

describe("monthKey", () => {
  it("formats UTC YYYY-MM with zero padding", () => {
    expect(monthKey(new Date(Date.UTC(2026, 0, 15)))).toBe("2026-01");
    expect(monthKey(new Date(Date.UTC(2026, 11, 1)))).toBe("2026-12");
  });
});
