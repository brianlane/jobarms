// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { StatusControls } from "@/components/StatusControls";

beforeEach(() => {
  router.refresh.mockClear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => vi.unstubAllGlobals());

describe("StatusControls", () => {
  it("patches a status change and refreshes", async () => {
    render(<StatusControls applicationId="a1" current="saved" notes="" />);
    fireEvent.click(screen.getByText("Applied"));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith("/api/applications/a1", expect.objectContaining({ method: "PATCH" }));
    expect(screen.getByText("Saved ✓")).toBeInTheDocument();
  });

  it("disables the current status button", () => {
    render(<StatusControls applicationId="a1" current="applied" notes="" />);
    expect(screen.getByText("Applied")).toBeDisabled();
  });

  it("saves notes", async () => {
    render(<StatusControls applicationId="a1" current="saved" notes="old" />);
    const box = screen.getByPlaceholderText(/Notes/);
    fireEvent.change(box, { target: { value: "new note" } });
    fireEvent.click(screen.getByText("Save notes"));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)).toEqual({ notes: "new note" });
  });

  it("does not refresh when the patch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    render(<StatusControls applicationId="a1" current="saved" notes="" />);
    fireEvent.click(screen.getByText("Save notes"));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
