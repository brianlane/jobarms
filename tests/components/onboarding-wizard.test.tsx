// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { OnboardingWizard } from "@/components/OnboardingWizard";

function uploadFile() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array(10)], "resume.pdf", { type: "application/pdf" });
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  router.push.mockClear();
  router.refresh.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OnboardingWizard", () => {
  it("walks upload -> review -> preferences -> done", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ parsed: { full_name: "Jane", skills: ["ts"] } }) }) // upload
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // saveReview
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // savePreferences
    vi.stubGlobal("fetch", fetchMock);

    render(<OnboardingWizard />);
    uploadFile();
    expect(await screen.findByText("Review your profile")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Jane")).toBeInTheDocument();

    // Edit review-step fields (draft onChange handlers).
    fireEvent.change(screen.getByDisplayValue("Jane"), { target: { value: "Jane Doe" } });
    fireEvent.change(screen.getByPlaceholderText(/Headline/), { target: { value: "Engineer" } });
    fireEvent.change(screen.getByPlaceholderText("Location"), { target: { value: "Phoenix" } });
    fireEvent.change(screen.getByPlaceholderText("Phone"), { target: { value: "555" } });
    fireEvent.change(screen.getByPlaceholderText(/Professional summary/), { target: { value: "Builds." } });

    fireEvent.click(screen.getByText(/Looks right/));
    expect(await screen.findByText(/Preferences/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Minimum salary/), { target: { value: "120000" } });
    fireEvent.change(screen.getByPlaceholderText(/Preferred locations/), { target: { value: "Phoenix, Remote" } });
    // Toggle both preference checkboxes.
    fireEvent.click(screen.getByLabelText(/Open to remote/));
    fireEvent.click(screen.getByLabelText(/visa sponsorship/));
    vi.useFakeTimers();
    fireEvent.click(screen.getByText("Finish setup"));
    await vi.waitFor(() => expect(screen.getByText(/You&apos;re set|You're set/)).toBeInTheDocument());
    await vi.advanceTimersByTimeAsync(1300);
    expect(router.push).toHaveBeenCalledWith("/dashboard");
  });

  it("animates the progress ticker through its three label stages", async () => {
    let resolveUpload!: (v: unknown) => void;
    const pending = new Promise((r) => {
      resolveUpload = r;
    });
    vi.stubGlobal("fetch", vi.fn(() => pending));
    vi.useFakeTimers();
    render(<OnboardingWizard />);
    uploadFile();
    await vi.advanceTimersByTimeAsync(300);
    expect(screen.getByText("Uploading your resume...")).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(5000);
    expect(screen.getByText("Reading your resume...")).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(30000);
    expect(screen.getByText("Building your profile...")).toBeInTheDocument();
    resolveUpload({ ok: true, json: async () => ({ parsed: { full_name: "Jane" } }) });
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();
    expect(await screen.findByText("Review your profile")).toBeInTheDocument();
  });

  it("uses body.error then a generic fallback when the upload is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ error: "parse_failed" }) }));
    render(<OnboardingWizard />);
    uploadFile();
    expect(await screen.findByText("parse_failed")).toBeInTheDocument();
  });

  it("falls back to a generic message when the rejection has no detail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({}) }));
    render(<OnboardingWizard />);
    uploadFile();
    expect(await screen.findByText("Upload failed. Try again.")).toBeInTheDocument();
  });

  it("shows the server's message when the upload is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ hint: "That doesn't look like a resume." }) }));
    render(<OnboardingWizard />);
    uploadFile();
    expect(await screen.findByText("That doesn't look like a resume.")).toBeInTheDocument();
  });

  it("handles a network error during upload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("offline")));
    render(<OnboardingWizard />);
    uploadFile();
    expect(await screen.findByText("Network error. Try again.")).toBeInTheDocument();
  });

  it("defaults every draft field when the parse returns no values", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ parsed: {} }) }));
    render(<OnboardingWizard />);
    uploadFile();
    expect(await screen.findByText("Review your profile")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Full name")).toHaveValue("");
  });

  it("ignores a file input change with no file selected", () => {
    render(<OnboardingWizard />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [] } });
    // still on the upload step, no crash
    expect(screen.getByText("Upload your resume")).toBeInTheDocument();
  });

  it("lets the user skip straight to manual entry", () => {
    render(<OnboardingWizard />);
    fireEvent.click(screen.getByText(/Skip and fill my profile manually/));
    expect(screen.getByText("Review your profile")).toBeInTheDocument();
  });

  it("shows an error if saving the review step fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    render(<OnboardingWizard />);
    fireEvent.click(screen.getByText(/Skip and fill my profile manually/));
    fireEvent.click(screen.getByText(/Looks right/));
    expect(await screen.findByText("Could not save. Try again.")).toBeInTheDocument();
  });

  it("shows an error if saving preferences fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    render(<OnboardingWizard />);
    fireEvent.click(screen.getByText(/Skip and fill my profile manually/));
    // saveReview will fail first; make it pass once then fail preferences
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) }).mockResolvedValue({ ok: false, json: async () => ({}) })
    );
    fireEvent.click(screen.getByText(/Looks right/));
    await screen.findByText(/Preferences/);
    fireEvent.click(screen.getByText("Finish setup"));
    expect(await screen.findByText("Could not save. Try again.")).toBeInTheDocument();
  });
});
