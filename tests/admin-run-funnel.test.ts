import { describe, expect, it } from "vitest";
import {
  formatDuration,
  phaseDurations,
  runFunnel,
  runSteps,
  FUNNEL_STEPS
} from "@/lib/admin/run-stats";

function steps(...entries: [string, string][]) {
  return entries.map(([step, at]) => ({ step, at }));
}

describe("runSteps", () => {
  it("only trusts an array", () => {
    expect(runSteps([{ step: "navigate" }])).toHaveLength(1);
    expect(runSteps(null)).toEqual([]);
    expect(runSteps("nope")).toEqual([]);
  });
});

describe("runFunnel", () => {
  it("counts how far each run got and where runs stopped", () => {
    const stages = runFunnel([
      {
        autonomy: "review_gate",
        steps: steps(
          ["navigate", "2026-07-15T10:00:00Z"],
          ["form_extracted", "2026-07-15T10:00:30Z"],
          ["answers_generated", "2026-07-15T10:01:00Z"],
          ["review_requested", "2026-07-15T10:01:10Z"],
          ["approved", "2026-07-15T11:00:00Z"],
          ["submitted", "2026-07-15T11:00:40Z"]
        )
      },
      {
        autonomy: "review_gate",
        steps: steps(["navigate", "2026-07-15T10:00:00Z"], ["form_extracted", "2026-07-15T10:00:20Z"])
      },
      { autonomy: "review_gate", steps: steps(["navigate", "2026-07-15T10:00:00Z"]) },
      { autonomy: "review_gate", steps: null }
    ]);

    const byStep = new Map(stages.map((stage) => [stage.step, stage]));
    expect(byStep.get("navigate")).toMatchObject({ reached: 3, reachedPct: 75, droppedHere: 1 });
    expect(byStep.get("form_extracted")).toMatchObject({ reached: 2, droppedHere: 1 });
    expect(byStep.get("submitted")).toMatchObject({ reached: 1, droppedHere: 0 });
    expect(stages.map((stage) => stage.step)).toEqual(FUNNEL_STEPS.map((stage) => stage.step));
  });

  it("measures the review stages against review-gate runs only", () => {
    const stages = runFunnel([
      {
        autonomy: "full_auto",
        steps: steps(
          ["navigate", "2026-07-15T10:00:00Z"],
          ["form_extracted", "2026-07-15T10:00:30Z"],
          ["answers_generated", "2026-07-15T10:01:00Z"],
          ["submitted", "2026-07-15T10:02:00Z"]
        )
      },
      {
        autonomy: "review_gate",
        steps: steps(
          ["navigate", "2026-07-15T10:00:00Z"],
          ["form_extracted", "2026-07-15T10:00:30Z"],
          ["answers_generated", "2026-07-15T10:01:00Z"],
          ["review_requested", "2026-07-15T10:01:10Z"]
        )
      }
    ]);

    const review = stages.find((stage) => stage.step === "review_requested")!;
    // One of one review-gate run parked: a full-auto fleet must not read as a
    // total review drop-off.
    expect(review).toMatchObject({ reached: 1, reachedPct: 100 });
  });

  it("counts a full-auto run that WAS sent to review", () => {
    // The interlock can refuse to submit a full-auto run and hand it back to its
    // owner. Judging eligibility on autonomy alone dropped those from the count
    // while they sat in the timeline, understating a stage they plainly reached.
    const stages = runFunnel([
      {
        autonomy: "full_auto",
        steps: steps(
          ["navigate", "2026-07-15T10:00:00Z"],
          ["review_requested", "2026-07-15T10:01:10Z"],
          ["approved", "2026-07-15T11:00:00Z"]
        )
      },
      // A full-auto run that was never asked stays out of the denominator, so
      // this still cannot read as a review drop-off.
      { autonomy: "full_auto", steps: steps(["submitted", "2026-07-15T10:02:00Z"]) }
    ]);

    const byStep = new Map(stages.map((stage) => [stage.step, stage]));
    expect(byStep.get("review_requested")).toMatchObject({ reached: 1, reachedPct: 100 });
    expect(byStep.get("approved")).toMatchObject({ reached: 1, reachedPct: 100 });
  });

  it("reports zeroes with no runs at all", () => {
    const stages = runFunnel([]);
    expect(stages.every((stage) => stage.reached === 0 && stage.reachedPct === 0)).toBe(true);
  });

  it("treats a missing autonomy as review gate", () => {
    const stages = runFunnel([{ steps: steps(["review_requested", "2026-07-15T10:00:00Z"]) }]);
    expect(stages.find((stage) => stage.step === "review_requested")!.reached).toBe(1);
  });
});

describe("phaseDurations", () => {
  it("computes median and p95 per phase across runs that logged both ends", () => {
    const phases = phaseDurations([
      {
        steps: steps(
          ["navigate", "2026-07-15T10:00:00Z"],
          ["form_extracted", "2026-07-15T10:00:10Z"]
        )
      },
      {
        steps: steps(
          ["navigate", "2026-07-15T10:00:00Z"],
          ["form_extracted", "2026-07-15T10:00:30Z"]
        )
      },
      {
        steps: steps(
          ["navigate", "2026-07-15T10:00:00Z"],
          ["form_extracted", "2026-07-15T10:01:40Z"]
        )
      },
      // Out-of-order timestamps are ignored rather than counted as negative.
      {
        steps: steps(
          ["navigate", "2026-07-15T10:05:00Z"],
          ["form_extracted", "2026-07-15T10:00:00Z"]
        )
      },
      // Unparseable and missing timestamps drop out.
      { steps: steps(["navigate", "nonsense"], ["form_extracted", "2026-07-15T10:00:05Z"]) },
      { steps: [{ step: "navigate" }, { step: "form_extracted" }] },
      { steps: null }
    ]);

    const first = phases[0];
    expect(first.samples).toBe(3);
    expect(first.medianSeconds).toBe(30);
    expect(first.p95Seconds).toBe(100);

    // No run logged the later phases, so they report nothing rather than zero.
    expect(phases[1]).toMatchObject({ medianSeconds: null, p95Seconds: null, samples: 0 });
  });
});

describe("formatDuration", () => {
  it("scales the unit to the magnitude", () => {
    expect(formatDuration(null)).toBe("-");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(90)).toBe("2m");
    expect(formatDuration(7200)).toBe("2h");
  });
});
