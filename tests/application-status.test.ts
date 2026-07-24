import { describe, expect, it } from "vitest";
import {
  APPLICATION_STATUSES,
  isApplicationStatus,
  MANUAL_STATUSES,
  STATUS_LABELS,
  STATUS_STYLES
} from "@/lib/application-status";

describe("application status metadata", () => {
  it("every status has a label and a style", () => {
    for (const s of APPLICATION_STATUSES) {
      expect(STATUS_LABELS[s]).toBeTruthy();
      expect(STATUS_STYLES[s]).toBeTruthy();
    }
  });

  it("manual statuses are a subset of all statuses", () => {
    for (const s of MANUAL_STATUSES) {
      expect(APPLICATION_STATUSES).toContain(s);
    }
  });

  it("isApplicationStatus is a type guard", () => {
    expect(isApplicationStatus("applied")).toBe(true);
    expect(isApplicationStatus("needs_review")).toBe(true);
    expect(isApplicationStatus("not_a_status")).toBe(false);
    expect(isApplicationStatus("")).toBe(false);
  });
});
