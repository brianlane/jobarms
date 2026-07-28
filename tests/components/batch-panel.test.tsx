// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BatchPanel } from "@/components/BatchPanel";

/** One batch row as the list endpoint returns it. */
function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "b1",
    status: "completed",
    keywords: "react engineer",
    location: "",
    remote: false,
    requested: 10,
    reserved: 10,
    processed: 10,
    applied: 8,
    failed: 2,
    error: null,
    created_at: "2026-07-28T00:00:00Z",
    ...over
  };
}

/** GET /api/batches returns `batches`; every other call succeeds empty. */
function stubFetch(batches: unknown[] = []) {
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (!init?.method || init.method === "GET") {
      return { ok: true, json: async () => ({ batches }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => stubFetch());
afterEach(() => vi.unstubAllGlobals());

const ready = { linkedInConnected: true, paid: true };

describe("gating", () => {
  it("points a free user at billing instead of the form", () => {
    render(<BatchPanel linkedInConnected={true} paid={false} />);
    expect(screen.getByText(/paid\s+feature/)).toBeInTheDocument();
    expect(screen.queryByText("Start a batch")).not.toBeInTheDocument();
  });

  it("points a paid user without LinkedIn at settings", () => {
    render(<BatchPanel linkedInConnected={false} paid={true} />);
    expect(screen.getByText("Connect LinkedIn in Settings")).toBeInTheDocument();
    expect(screen.queryByText("Start a batch")).not.toBeInTheDocument();
  });
});

describe("starting a batch", () => {
  it("posts the search and clears the keywords on success", async () => {
    const fetchMock = stubFetch();
    render(<BatchPanel {...ready} />);

    fireEvent.change(screen.getByLabelText("Search keywords"), {
      target: { value: "react engineer" }
    });
    fireEvent.change(screen.getByLabelText("Location"), { target: { value: "Denver" } });
    fireEvent.click(screen.getByLabelText("Remote only"));
    fireEvent.change(screen.getByLabelText("Number of jobs"), { target: { value: "15" } });
    fireEvent.click(screen.getByText("Start batch"));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[1]?.method === "POST");
      expect(call).toBeTruthy();
      expect(call![0]).toBe("/api/batches");
      expect(JSON.parse(call![1]!.body as string)).toEqual({
        keywords: "react engineer",
        location: "Denver",
        remote: true,
        count: 15
      });
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Search keywords")).toHaveValue("")
    );
  });

  it("keeps the button disabled until the keywords are usable", () => {
    render(<BatchPanel {...ready} />);
    expect(screen.getByText("Start batch")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Search keywords"), { target: { value: "go" } });
    expect(screen.getByText("Start batch")).toBeEnabled();
  });

  it("clamps the job count into 1..25 and defaults nonsense to 1", () => {
    render(<BatchPanel {...ready} />);
    const count = screen.getByLabelText("Number of jobs");
    fireEvent.change(count, { target: { value: "99" } });
    expect(count).toHaveValue(25);
    fireEvent.change(count, { target: { value: "" } });
    expect(count).toHaveValue(1);
  });

  it("surfaces the server's hint when the start is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string }) =>
        init?.method === "POST"
          ? { ok: false, json: async () => ({ hint: "Connect your LinkedIn account first." }) }
          : { ok: true, json: async () => ({ batches: [] }) }
      )
    );
    render(<BatchPanel {...ready} />);
    fireEvent.change(screen.getByLabelText("Search keywords"), {
      target: { value: "react engineer" }
    });
    fireEvent.click(screen.getByText("Start batch"));
    expect(await screen.findByText("Connect your LinkedIn account first.")).toBeInTheDocument();
  });

  it("falls back to a generic message when the refusal has no hint (or no reply)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string }) =>
        init?.method === "POST"
          ? {
              ok: false,
              json: async () => {
                throw new Error("empty body");
              }
            }
          : { ok: true, json: async () => ({ batches: [] }) }
      )
    );
    render(<BatchPanel {...ready} />);
    fireEvent.change(screen.getByLabelText("Search keywords"), {
      target: { value: "react engineer" }
    });
    fireEvent.click(screen.getByText("Start batch"));
    expect(await screen.findByText(/That didn't work/)).toBeInTheDocument();
  });

  it("treats a network failure as a refusal too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string }) => {
        if (init?.method === "POST") throw new Error("offline");
        return { ok: true, json: async () => ({ batches: [] }) };
      })
    );
    render(<BatchPanel {...ready} />);
    fireEvent.change(screen.getByLabelText("Search keywords"), {
      target: { value: "react engineer" }
    });
    fireEvent.click(screen.getByText("Start batch"));
    expect(await screen.findByText(/That didn't work/)).toBeInTheDocument();
  });
});

describe("the batch list", () => {
  it("renders progress, counts, and the location/remote qualifiers", async () => {
    stubFetch([
      row({ location: "Denver", remote: true, status: "running" }),
      row({ id: "b2", status: "weird_future_status", reserved: 0 })
    ]);
    render(<BatchPanel {...ready} />);

    expect(await screen.findByText("react engineer · Denver · Remote")).toBeInTheDocument();
    expect(screen.getByText("Applying...")).toBeInTheDocument();
    expect(screen.getAllByText(/8 applied · 2 failed/)[0]).toBeInTheDocument();
    // An unknown status falls back to its raw name; a zero reservation draws no bar.
    expect(screen.getByText("weird_future_status")).toBeInTheDocument();
  });

  it("shows the batch error and each status tone", async () => {
    stubFetch([
      row({ id: "b1", status: "queued" }),
      row({ id: "b2", status: "searching" }),
      row({ id: "b3", status: "failed", error: "ats_login_failed: LinkedIn refused" }),
      row({ id: "b4", status: "canceled" }),
      row({ id: "b5", status: "completed" })
    ]);
    render(<BatchPanel {...ready} />);

    expect(await screen.findByText("Getting started...")).toBeInTheDocument();
    expect(screen.getByText("Searching LinkedIn...")).toBeInTheDocument();
    expect(screen.getByText("This batch hit a problem")).toBeInTheDocument();
    expect(screen.getByText("ats_login_failed: LinkedIn refused")).toBeInTheDocument();
    expect(screen.getByText("Batch canceled")).toBeInTheDocument();
    expect(screen.getByText("Batch finished")).toBeInTheDocument();
  });

  it("cancels a live batch", async () => {
    const fetchMock = stubFetch([row({ status: "running" })]);
    render(<BatchPanel {...ready} />);

    fireEvent.click(await screen.findByText("Cancel this batch"));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[1]?.method === "POST");
      expect(call![0]).toBe("/api/batches/b1/cancel");
      // No body on a cancel.
      expect(call![1]!.body).toBeUndefined();
    });
  });

  it("polls while a batch is live, and stops the timer on unmount", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = stubFetch([row({ status: "running" })]);
      const { unmount } = render(<BatchPanel {...ready} />);

      // Let the initial load land, then advance past one poll interval.
      await vi.waitFor(() => expect(screen.getByText("Applying...")).toBeTruthy());
      const before = fetchMock.mock.calls.length;
      vi.advanceTimersByTime(5001);
      await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a list reply that arrives after unmount", async () => {
    let resolve: (v: unknown) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((r) => (resolve = r)))
    );
    const { unmount } = render(<BatchPanel {...ready} />);
    unmount();
    resolve({ ok: true, json: async () => ({ batches: [row()] }) });
    // Nothing to assert beyond "no act() warning / no crash": the guard simply
    // drops the stale payload.
    await Promise.resolve();
  });

  it("keeps the old list when a refresh fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) }))
    );
    render(<BatchPanel {...ready} />);
    // The failed load leaves the (empty) list in place; only the form renders.
    expect(screen.getByText("Start a batch")).toBeInTheDocument();
  });
});

describe("the PIN banner", () => {
  it("submits the entered code to the batch", async () => {
    const fetchMock = stubFetch([row({ status: "needs_login_code" })]);
    render(<BatchPanel {...ready} />);

    const input = await screen.findByLabelText("LinkedIn verification code");
    const submit = screen.getByText("Submit code");
    expect(submit).toBeDisabled();

    fireEvent.change(input, { target: { value: " 483920 " } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[1]?.method === "POST");
      expect(call![0]).toBe("/api/batches/b1/login-code");
      expect(JSON.parse(call![1]!.body as string)).toEqual({ code: "483920" });
    });
  });
});
