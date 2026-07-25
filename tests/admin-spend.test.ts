import { describe, expect, it } from "vitest";
import {
  spendByDay,
  spendByKind,
  spendByModel,
  spendByUser,
  totalSpend,
  unitEconomics,
  type SpendEventRow
} from "@/lib/admin/spend";
import type { AdminSubscriptionRow } from "@/lib/admin/overview";

const NOW = new Date("2026-07-15T12:00:00Z");

function event(over: Partial<SpendEventRow> = {}): SpendEventRow {
  return {
    user_id: "u1",
    run_id: null,
    kind: "resume_parse",
    model: "gemini-3.6-flash",
    used_fallback: false,
    input_tokens: 1000,
    output_tokens: 200,
    cost_micros: 3000,
    day: "2026-07-15",
    created_at: "2026-07-15T10:00:00Z",
    ...over
  };
}

function sub(over: Partial<AdminSubscriptionRow> = {}): AdminSubscriptionRow {
  return {
    user_id: "u1",
    plan: "premium",
    status: "active",
    current_period_end: null,
    cancel_at_period_end: false,
    ...over
  };
}

describe("totalSpend", () => {
  it("sums cost and tokens and reports the fallback share", () => {
    const totals = totalSpend([
      event(),
      event({ used_fallback: true, cost_micros: 1000, input_tokens: 10, output_tokens: 5 })
    ]);
    expect(totals).toMatchObject({
      costMicros: 4000,
      inputTokens: 1010,
      outputTokens: 205,
      calls: 2,
      fallbackCalls: 1,
      fallbackRatePct: 50,
      hasEstimatedPricing: false
    });
  });

  it("flags when any call was priced with a stand-in rate", () => {
    expect(totalSpend([event({ model: "some-future-model" })]).hasEstimatedPricing).toBe(true);
  });

  it("is all zeroes with no ledger rows", () => {
    expect(totalSpend([])).toMatchObject({ costMicros: 0, calls: 0, fallbackRatePct: 0 });
  });
});

describe("grouping", () => {
  const rows = [
    event({ kind: "resume_parse", cost_micros: 1000 }),
    event({ kind: "arm_answers", cost_micros: 5000, model: "gemini-3.5-flash" }),
    event({ kind: "arm_answers", cost_micros: 500 }),
    event({ kind: "vision_recovery", cost_micros: 20, model: "" })
  ];

  it("groups by surface, priciest first", () => {
    expect(spendByKind(rows).map((group) => [group.key, group.costMicros])).toEqual([
      ["arm_answers", 5500],
      ["resume_parse", 1000],
      ["vision_recovery", 20]
    ]);
  });

  it("groups by model and names a blank model", () => {
    const groups = spendByModel(rows);
    expect(groups.map((group) => group.key)).toEqual([
      "gemini-3.5-flash",
      "gemini-3.6-flash",
      "unknown"
    ]);
    expect(groups[1].calls).toBe(2);
  });
});

describe("spendByDay", () => {
  it("returns a dense oldest-first series including empty days", () => {
    const series = spendByDay(
      [event({ day: "2026-07-15", cost_micros: 400 }), event({ day: "2026-07-13", cost_micros: 100 })],
      3,
      NOW
    );
    expect(series.map((day) => [day.key, day.costMicros])).toEqual([
      ["2026-07-13", 100],
      ["2026-07-14", 0],
      ["2026-07-15", 400]
    ]);
  });
});

describe("spendByUser", () => {
  it("compares cost against what each plan pays, priciest first", () => {
    const rows = spendByUser({
      rows: [
        event({ user_id: "premium-user", cost_micros: 2_000_000 }),
        event({ user_id: "free-user", cost_micros: 50_000 }),
        // Platform-level spend has no user to bill.
        event({ user_id: null, cost_micros: 900_000 })
      ],
      emailById: new Map([
        ["premium-user", "paid@x.com"],
        ["free-user", "free@x.com"]
      ]),
      subscriptions: [sub({ user_id: "premium-user" })]
    });

    expect(rows.map((row) => row.userId)).toEqual(["premium-user", "free-user"]);

    const paid = rows[0];
    // Premium is $19/month, which is 19,000,000 micros.
    expect(paid.revenueMicros).toBe(19_000_000);
    expect(paid.marginMicros).toBe(17_000_000);
    expect(paid.underwater).toBe(false);
    expect(paid.email).toBe("paid@x.com");

    // A free user pays nothing, so any cost puts them underwater by design.
    expect(rows[1]).toMatchObject({ plan: "free", revenueMicros: 0, underwater: true });
  });

  it("falls back to an empty email for an unknown user", () => {
    const rows = spendByUser({
      rows: [event({ user_id: "ghost" })],
      emailById: new Map(),
      subscriptions: []
    });
    expect(rows[0].email).toBe("");
  });
});

describe("unitEconomics", () => {
  it("divides spend by submitted runs and by paying users", () => {
    const economics = unitEconomics({
      rows: [
        event({ cost_micros: 600_000, user_id: "u1" }),
        event({ cost_micros: 400_000, user_id: "u2" }),
        event({ cost_micros: 0, user_id: null })
      ],
      submittedRuns: 4
    });
    expect(economics).toEqual({
      totalCostMicros: 1_000_000,
      submittedRuns: 4,
      costPerSubmittedMicros: 250_000,
      activeUsers: 2,
      costPerActiveUserMicros: 500_000
    });
  });

  it("refuses to claim a per-application cost with no successes", () => {
    const economics = unitEconomics({ rows: [event()], submittedRuns: 0 });
    expect(economics.costPerSubmittedMicros).toBeNull();
  });

  it("reports nothing per user when no call was attributed", () => {
    const economics = unitEconomics({ rows: [event({ user_id: null })], submittedRuns: 1 });
    expect(economics.costPerActiveUserMicros).toBeNull();
  });
});
