// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { TailorPanel } from "@/components/TailorPanel";

beforeEach(() => router.refresh.mockClear());
afterEach(() => vi.unstubAllGlobals());

describe("TailorPanel", () => {
  it("shows an upgrade link for non-premium users", () => {
    render(<TailorPanel applicationId="a1" premium={false} hasCoverLetter={false} />);
    expect(screen.getByText("Upgrade to unlock")).toHaveAttribute("href", "/dashboard/billing");
  });

  it("tailors a resume and shows keywords + a download link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          resume_id: "r2",
          keywords: { incorporated: ["TypeScript"], missing: ["Go"] },
          download_url: "https://dl/x"
        })
      })
    );
    render(<TailorPanel applicationId="a1" premium hasCoverLetter={false} />);
    fireEvent.click(screen.getByText("Tailor resume"));
    expect(await screen.findByText(/Download tailored resume/)).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it("generates a cover letter (button label reflects existing letter)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cover_letter: "hi" }) }));
    render(<TailorPanel applicationId="a1" premium hasCoverLetter />);
    fireEvent.click(screen.getByText("Regenerate cover letter"));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it("handles a tailor result with no keywords or download URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ resume_id: "r3" }) }));
    render(<TailorPanel applicationId="a1" premium hasCoverLetter={false} />);
    fireEvent.click(screen.getByText("Tailor resume"));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(screen.queryByText(/Download tailored resume/)).not.toBeInTheDocument();
  });

  it("renders dashes when the keyword lists are empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ resume_id: "r4", keywords: { incorporated: [], missing: [] }, download_url: null })
      })
    );
    render(<TailorPanel applicationId="a1" premium hasCoverLetter={false} />);
    fireEvent.click(screen.getByText("Tailor resume"));
    expect(await screen.findAllByText("-")).toHaveLength(2);
  });

  it("shows an error when generation fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ hint: "AI busy" }) }));
    render(<TailorPanel applicationId="a1" premium hasCoverLetter={false} />);
    fireEvent.click(screen.getByText("Tailor resume"));
    expect(await screen.findByText("AI busy")).toBeInTheDocument();
  });

  it("falls back to a generic error when the response body is unparseable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => { throw new Error("bad"); } }));
    render(<TailorPanel applicationId="a1" premium hasCoverLetter={false} />);
    fireEvent.click(screen.getByText("Generate cover letter"));
    expect(await screen.findByText("Generation failed.")).toBeInTheDocument();
  });
});
