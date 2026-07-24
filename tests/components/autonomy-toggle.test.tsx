// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AutonomyToggle } from "@/components/AutonomyToggle";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => vi.unstubAllGlobals());

describe("AutonomyToggle", () => {
  it("saves the chosen mode and shows a confirmation", async () => {
    render(<AutonomyToggle initial="review_gate" />);
    fireEvent.click(screen.getByText("Full auto"));
    await waitFor(() => expect(screen.getByText("Saved ✓")).toBeInTheDocument());
    const body = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body).toEqual({ arm_autonomy: "full_auto" });
  });

  it("does not confirm when the save fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    render(<AutonomyToggle initial="full_auto" />);
    fireEvent.click(screen.getByText("Review gate (recommended)"));
    await waitFor(() =>
      expect((fetch as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
    );
    expect(screen.queryByText("Saved ✓")).not.toBeInTheDocument();
  });
});
