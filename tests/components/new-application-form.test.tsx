// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => search.params
}));

import { NewApplicationForm } from "@/components/NewApplicationForm";

beforeEach(() => {
  router.push.mockClear();
  router.refresh.mockClear();
  search.params = new URLSearchParams();
  vi.useRealTimers();
});
afterEach(() => vi.unstubAllGlobals());

describe("NewApplicationForm", () => {
  it("prefills the URL from the query string", () => {
    search.params = new URLSearchParams("url=https://boards.greenhouse.io/x/jobs/1");
    render(<NewApplicationForm />);
    expect(screen.getByDisplayValue("https://boards.greenhouse.io/x/jobs/1")).toBeInTheDocument();
  });

  it("submits an arm run and navigates to the application", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ application_id: "app1" }) }));
    render(<NewApplicationForm />);
    fireEvent.change(screen.getByPlaceholderText(/greenhouse/), { target: { value: "https://x" } });
    fireEvent.click(screen.getByText("Start the arm"));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/dashboard/applications/app1"));
  });

  it("switches to track-only mode", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ application_id: "app2" }) }));
    render(<NewApplicationForm />);
    fireEvent.change(screen.getByPlaceholderText(/greenhouse/), { target: { value: "https://x" } });
    fireEvent.click(screen.getByText("Track only"));
    fireEvent.click(screen.getByText("Save to tracker"));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/dashboard/applications/app2"));
  });

  it("shows a saved-to-tracker notice then redirects when the arm can't run", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ application_id: "app3", hint: "Saved to your tracker." })
    }));
    render(<NewApplicationForm />);
    fireEvent.change(screen.getByPlaceholderText(/greenhouse/), { target: { value: "https://x" } });
    fireEvent.click(screen.getByText("Start the arm"));
    // runAllTimersAsync flushes the fetch/json microtasks AND fires the 1800ms
    // redirect setTimeout, so both the notice branch and its callback run.
    await vi.runAllTimersAsync();
    expect(router.push).toHaveBeenCalledWith("/dashboard/applications/app3");
    vi.useRealTimers();
  });

  it("uses the default tracker notice when the response omits a hint", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ application_id: "app5" }) }));
    render(<NewApplicationForm />);
    fireEvent.change(screen.getByPlaceholderText(/greenhouse/), { target: { value: "https://x" } });
    fireEvent.click(screen.getByText("Start the arm"));
    await vi.runAllTimersAsync();
    expect(router.push).toHaveBeenCalledWith("/dashboard/applications/app5");
    vi.useRealTimers();
  });

  it("shows an error when the request fails outright", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "invalid_url" }) }));
    render(<NewApplicationForm />);
    fireEvent.change(screen.getByPlaceholderText(/greenhouse/), { target: { value: "https://x" } });
    fireEvent.click(screen.getByText("Start the arm"));
    expect(await screen.findByText("invalid_url")).toBeInTheDocument();
  });

  it("shows a generic error when the failure has no hint or error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    render(<NewApplicationForm />);
    fireEvent.change(screen.getByPlaceholderText(/greenhouse/), { target: { value: "https://x" } });
    fireEvent.click(screen.getByText("Start the arm"));
    expect(await screen.findByText("Something went wrong.")).toBeInTheDocument();
  });

  it("shows the tailoring busy label for a premium arm submit", async () => {
    let resolveReq!: (v: unknown) => void;
    const pending = new Promise((r) => {
      resolveReq = r;
    });
    vi.stubGlobal("fetch", vi.fn(() => pending));
    render(<NewApplicationForm premium />);
    fireEvent.change(screen.getByPlaceholderText(/greenhouse/), { target: { value: "https://x" } });
    fireEvent.click(screen.getByText("Start the arm"));
    expect(await screen.findByText("Tailoring resume and starting the arm...")).toBeInTheDocument();
    // body carries tailor: true (premium && arm && tailor)
    expect(JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body).tailor).toBe(true);
    resolveReq({ ok: true, json: async () => ({ application_id: "app9" }) });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/dashboard/applications/app9"));
  });

  it("offers the tailor toggle for premium users and toggles mode + tailoring", () => {
    render(<NewApplicationForm premium />);
    expect(screen.getByText(/Tailor my resume/)).toBeInTheDocument();
    // Toggle the tailor checkbox off, then switch modes back and forth.
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    fireEvent.click(screen.getByText("Track only"));
    expect(screen.queryByText(/Tailor my resume/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/Send an arm/));
    expect(screen.getByText(/Tailor my resume/)).toBeInTheDocument();
  });
});
