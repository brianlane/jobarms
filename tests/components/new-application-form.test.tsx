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
    fireEvent.change(screen.getByPlaceholderText(/greenhouse/), { target: { value: "https://boards.greenhouse.io/x/jobs/1" } });
    fireEvent.click(screen.getByText("Start the arm"));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/dashboard/applications/app1"));
  });

  it("switches to track-only mode", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ application_id: "app2" }) }));
    render(<NewApplicationForm />);
    fireEvent.change(screen.getByPlaceholderText(/greenhouse/), { target: { value: "https://boards.greenhouse.io/x/jobs/1" } });
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
    fireEvent.change(screen.getByPlaceholderText(/greenhouse/), { target: { value: "https://boards.greenhouse.io/x/jobs/1" } });
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
    fireEvent.change(screen.getByPlaceholderText(/greenhouse/), { target: { value: "https://boards.greenhouse.io/x/jobs/1" } });
    fireEvent.click(screen.getByText("Start the arm"));
    await vi.runAllTimersAsync();
    expect(router.push).toHaveBeenCalledWith("/dashboard/applications/app5");
    vi.useRealTimers();
  });

  it("shows an error when the request fails outright", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "invalid_url" }) }));
    render(<NewApplicationForm />);
    fireEvent.change(screen.getByPlaceholderText(/greenhouse/), { target: { value: "https://boards.greenhouse.io/x/jobs/1" } });
    fireEvent.click(screen.getByText("Start the arm"));
    expect(await screen.findByText("invalid_url")).toBeInTheDocument();
  });

  it("shows a generic error when the failure has no hint or error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    render(<NewApplicationForm />);
    fireEvent.change(screen.getByPlaceholderText(/greenhouse/), { target: { value: "https://boards.greenhouse.io/x/jobs/1" } });
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
    fireEvent.change(screen.getByPlaceholderText(/greenhouse/), { target: { value: "https://boards.greenhouse.io/x/jobs/1" } });
    fireEvent.click(screen.getByText("Start the arm"));
    expect(await screen.findByText("Tailoring resume and starting the arm...")).toBeInTheDocument();
    // body carries tailor: true (premium && arm && tailor)
    expect(JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body).tailor).toBe(true);
    resolveReq({ ok: true, json: async () => ({ application_id: "app9" }) });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/dashboard/applications/app9"));
  });

  it("gates an untuned board behind the best-effort acknowledgment", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ application_id: "app7" }) }));
    render(<NewApplicationForm />);
    fireEvent.change(screen.getByPlaceholderText(/greenhouse/), { target: { value: "https://careers.example.com/jobs/1" } });

    // The warning is visible and the submit is disabled until acknowledged.
    expect(screen.getByText(/isn't one we've tuned the arm for/)).toBeInTheDocument();
    const submit = screen.getByText("Start the arm").closest("button")!;
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByText(/I understand this may fail/));
    expect(submit).not.toBeDisabled();

    fireEvent.click(submit);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/dashboard/applications/app7"));
    const body = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.accept_best_effort).toBe(true);
  });

  it("hides the best-effort warning for tuned boards, track-only mode, and half-typed URLs", () => {
    render(<NewApplicationForm />);
    const input = screen.getByPlaceholderText(/greenhouse/);

    fireEvent.change(input, { target: { value: "https://careers.example" } });
    expect(screen.getByText(/isn't one we've tuned the arm for/)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "not a url yet" } });
    expect(screen.queryByText(/isn't one we've tuned the arm for/)).not.toBeInTheDocument();

    // Plain http parses too: boards on legacy career sites still get the warning.
    fireEvent.change(input, { target: { value: "http://careers.example.com/jobs/1" } });
    expect(screen.getByText(/isn't one we've tuned the arm for/)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "https://jobs.lever.co/acme/1" } });
    expect(screen.queryByText(/isn't one we've tuned the arm for/)).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "https://careers.example.com/jobs/1" } });
    fireEvent.click(screen.getByText("Track only"));
    expect(screen.queryByText(/isn't one we've tuned the arm for/)).not.toBeInTheDocument();
  });

  it("resets the acknowledgment when the URL changes", () => {
    render(<NewApplicationForm />);
    const input = screen.getByPlaceholderText(/greenhouse/);
    fireEvent.change(input, { target: { value: "https://careers.example.com/jobs/1" } });
    fireEvent.click(screen.getByText(/I understand this may fail/));
    expect(screen.getByText("Start the arm").closest("button")).not.toBeDisabled();

    // A different link is a different decision: the checkbox must clear.
    fireEvent.change(input, { target: { value: "https://careers.other.com/jobs/2" } });
    expect(screen.getByText("Start the arm").closest("button")).toBeDisabled();
  });

  it("stays on the form when the server asks for the best-effort acknowledgment", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        error: "best_effort_ack_required",
        application_id: "app8",
        hint: "Confirm to continue."
      })
    }));
    render(<NewApplicationForm />);
    const input = screen.getByPlaceholderText(/greenhouse/);
    fireEvent.change(input, { target: { value: "https://careers.example.com/jobs/1" } });
    fireEvent.click(screen.getByText(/I understand this may fail/));
    fireEvent.click(screen.getByText("Start the arm"));

    expect(await screen.findByText("Confirm to continue.")).toBeInTheDocument();
    // Unlike other saved-to-tracker errors, this one must NOT navigate away.
    expect(router.push).not.toHaveBeenCalled();
  });

  it("falls back to the default message when the ack response has no hint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "best_effort_ack_required" })
    }));
    render(<NewApplicationForm />);
    const input = screen.getByPlaceholderText(/greenhouse/);
    fireEvent.change(input, { target: { value: "https://careers.example.com/jobs/1" } });
    fireEvent.click(screen.getByText(/I understand this may fail/));
    fireEvent.click(screen.getByText("Start the arm"));
    expect(await screen.findByText("Confirm the best-effort terms to continue.")).toBeInTheDocument();
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
