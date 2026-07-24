// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProfileEditor, type ProfileData } from "@/components/ProfileEditor";

const initial: ProfileData = {
  full_name: "Jane",
  headline: "Engineer",
  location: "Phoenix",
  phone: "555",
  summary: "Builds things.",
  links: { linkedin: "https://li/jane" },
  work_history: [{ company: "Acme", title: "Eng", start: "2020", end: "Present", bullets: ["shipped"] }],
  education: [{ school: "ASU", degree: "BS", field: "CS", start: "2011", end: "2015" }],
  skills: ["ts", "react"]
};

beforeEach(() => vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true })));
afterEach(() => vi.unstubAllGlobals());

describe("ProfileEditor", () => {
  it("edits fields, adds/removes entries, and saves", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValueOnce("portfolio").mockReturnValueOnce(null);
    render(<ProfileEditor initial={initial} />);

    fireEvent.change(screen.getByPlaceholderText("Full name"), { target: { value: "Jane Doe" } });
    fireEvent.change(screen.getByPlaceholderText("Headline"), { target: { value: "Staff Eng" } });
    fireEvent.change(screen.getByPlaceholderText("Location"), { target: { value: "Tucson" } });
    fireEvent.change(screen.getByPlaceholderText("Phone"), { target: { value: "111" } });
    fireEvent.change(screen.getByPlaceholderText("Professional summary"), { target: { value: "New summary" } });
    // Work-history fields
    fireEvent.change(screen.getByPlaceholderText("Company"), { target: { value: "Acme Corp" } });
    fireEvent.change(screen.getByPlaceholderText("Title"), { target: { value: "Principal" } });
    fireEvent.change(screen.getByPlaceholderText("Start (MMM YYYY)"), { target: { value: "Jan 2019" } });
    fireEvent.change(screen.getByPlaceholderText("End (or Present)"), { target: { value: "Dec 2023" } });
    fireEvent.change(screen.getByPlaceholderText("Achievements, one per line"), {
      target: { value: "did a\ndid b" }
    });
    // Education fields
    fireEvent.change(screen.getByPlaceholderText("School"), { target: { value: "Arizona State" } });
    fireEvent.change(screen.getByPlaceholderText("Degree"), { target: { value: "MS" } });
    fireEvent.change(screen.getByPlaceholderText("Field"), { target: { value: "CE" } });
    fireEvent.change(screen.getByPlaceholderText("Start"), { target: { value: "2016" } });
    fireEvent.change(screen.getByPlaceholderText("End"), { target: { value: "2018" } });
    fireEvent.change(screen.getByPlaceholderText("Comma-separated skills"), {
      target: { value: "ts, go, " }
    });

    // Edit an existing link value
    fireEvent.change(screen.getByDisplayValue("https://li/jane"), { target: { value: "https://li/new" } });

    // Add link (prompt returns "portfolio"), then add link (prompt returns null -> no-op)
    fireEvent.click(screen.getByText("+ Add link"));
    fireEvent.click(screen.getByText("+ Add link"));
    expect(screen.getByText("portfolio")).toBeInTheDocument();

    // Work history add + remove
    fireEvent.click(screen.getByText("+ Add role"));
    fireEvent.click(screen.getAllByText("Remove role")[0]);

    // Education add
    fireEvent.click(screen.getByText("+ Add education"));

    fireEvent.click(screen.getByText("Save profile"));
    await waitFor(() => expect(screen.getByText("Saved ✓")).toBeInTheDocument());
    expect(promptSpy).toHaveBeenCalledTimes(2);
  });

  it("shows an error when saving fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    render(<ProfileEditor initial={initial} />);
    fireEvent.click(screen.getByText("Save profile"));
    expect(await screen.findByText("Save failed. Try again.")).toBeInTheDocument();
  });
});
