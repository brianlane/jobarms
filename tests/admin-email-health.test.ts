import { describe, expect, it } from "vitest";
import {
  RECENT_FAILURE_CAP,
  summarizeInboundEmail,
  type InboundEmailRow
} from "@/lib/admin/email-health";

const NOW = new Date("2026-07-15T12:00:00Z");

/** `hoursAgo` from NOW, so window boundaries are explicit in each test. */
function mail(hoursAgo: number, forwarded: boolean, fromDomain = "myworkday.com"): InboundEmailRow {
  return {
    created_at: new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000).toISOString(),
    from_domain: fromDomain,
    forwarded
  };
}

describe("summarizeInboundEmail", () => {
  it("is all zeros with no mail at all", () => {
    expect(summarizeInboundEmail([], NOW)).toEqual({
      received24h: 0,
      received7d: 0,
      failed24h: 0,
      failed7d: 0,
      failureRatePct: 0,
      recentFailures: []
    });
  });

  it("counts each window separately", () => {
    const rows = [mail(1, true), mail(30, true), mail(100, true)];
    const health = summarizeInboundEmail(rows, NOW);
    expect(health.received24h).toBe(1);
    expect(health.received7d).toBe(3);
    expect(health.failed7d).toBe(0);
  });

  it("separates a failed forward from a delivered one", () => {
    const rows = [mail(2, false), mail(3, true), mail(40, false)];
    const health = summarizeInboundEmail(rows, NOW);

    expect(health).toMatchObject({
      received24h: 2,
      received7d: 3,
      failed24h: 1,
      failed7d: 2,
      failureRatePct: 67
    });
  });

  it("ignores anything older than the 7 day window", () => {
    expect(summarizeInboundEmail([mail(24 * 8, false)], NOW)).toMatchObject({
      received7d: 0,
      failed7d: 0,
      recentFailures: []
    });
  });

  it("skips a row whose timestamp cannot be read rather than guessing a window", () => {
    const rows = [{ created_at: "nonsense", from_domain: "x.com", forwarded: false }, mail(1, true)];
    expect(summarizeInboundEmail(rows, NOW)).toMatchObject({ received7d: 1, failed7d: 0 });
  });

  it("lists failures newest first", () => {
    const rows = [mail(50, false, "old.com"), mail(2, false, "new.com"), mail(20, false, "mid.com")];
    expect(summarizeInboundEmail(rows, NOW).recentFailures.map((f) => f.fromDomain)).toEqual([
      "new.com",
      "mid.com",
      "old.com"
    ]);
  });

  it("caps the failure list so the panel shows a pattern, not a dump", () => {
    const rows = Array.from({ length: RECENT_FAILURE_CAP + 6 }, (_, i) => mail(i + 1, false));
    const health = summarizeInboundEmail(rows, NOW);

    expect(health.failed7d).toBe(RECENT_FAILURE_CAP + 6);
    expect(health.recentFailures).toHaveLength(RECENT_FAILURE_CAP);
  });

  it("honors an explicit cap", () => {
    const rows = Array.from({ length: 5 }, (_, i) => mail(i + 1, false));
    expect(summarizeInboundEmail(rows, NOW, 2).recentFailures).toHaveLength(2);
  });

  it("labels a sender with no recorded domain rather than showing a blank", () => {
    expect(summarizeInboundEmail([mail(1, false, "")], NOW).recentFailures[0].fromDomain).toBe(
      "unknown"
    );
  });

  it("carries no subject or body, since this is an operator screen", () => {
    const health = summarizeInboundEmail([mail(1, false)], NOW);
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain("subject");
    expect(serialized).not.toContain("body");
    expect(Object.keys(health.recentFailures[0])).toEqual(["at", "fromDomain"]);
  });
});
