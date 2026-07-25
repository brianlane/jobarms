// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { RunActions } from "@/components/admin/RunActions";

beforeEach(() => {
  router.refresh.mockClear();
  vi.unstubAllGlobals();
});

function stubOk(payload: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => payload })));
}

describe("RunActions", () => {
  it("cancels a live run and reports the refund outcome", async () => {
    stubOk({ ok: true, refunded: true });
    render(<RunActions runId="r1" cancellable alreadyRefunded={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    await waitFor(() =>
      expect(screen.getByText("Run canceled and the slot refunded.")).toBeInTheDocument()
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it("says the slot stays consumed when policy does not refund", async () => {
    stubOk({ ok: true, refunded: false });
    render(<RunActions runId="r1" cancellable alreadyRefunded={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    await waitFor(() =>
      expect(screen.getByText("Run canceled. The slot stays consumed.")).toBeInTheDocument()
    );
  });

  it("refunds a slot and reports an idempotent second press", async () => {
    stubOk({ ok: true, refunded: true });
    const { unmount } = render(<RunActions runId="r1" cancellable alreadyRefunded={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Refund slot" }));
    await waitFor(() => expect(screen.getByText("Slot refunded.")).toBeInTheDocument());
    unmount();

    stubOk({ ok: true, refunded: false });
    render(<RunActions runId="r1" cancellable alreadyRefunded />);
    fireEvent.click(screen.getByRole("button", { name: "Refund again" }));
    await waitFor(() =>
      expect(screen.getByText("Already refunded; the counter did not move.")).toBeInTheDocument()
    );
  });

  it("explains why cancel is unavailable on a finished run", () => {
    render(<RunActions runId="r1" cancellable={false} alreadyRefunded={false} />);
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeDisabled();
    expect(screen.getByText(/already finished/)).toBeInTheDocument();
  });

  it("surfaces a hint, then an error code, then a generic failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ hint: "Nothing to cancel." }) }))
    );
    const first = render(<RunActions runId="r1" cancellable alreadyRefunded={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(await screen.findByText("Nothing to cancel.")).toBeInTheDocument();
    first.unmount();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "not_cancellable" }) }))
    );
    const second = render(<RunActions runId="r1" cancellable alreadyRefunded={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(await screen.findByText("not_cancellable")).toBeInTheDocument();
    second.unmount();

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const third = render(<RunActions runId="r1" cancellable alreadyRefunded={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(await screen.findByText("Request failed")).toBeInTheDocument();
    third.unmount();

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    const fourth = render(<RunActions runId="r1" cancellable alreadyRefunded={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(await screen.findByText("Request failed")).toBeInTheDocument();
    fourth.unmount();

    // A refusal whose body is not JSON at all.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => {
          throw new Error("not json");
        }
      }))
    );
    render(<RunActions runId="r1" cancellable alreadyRefunded={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(await screen.findByText("Request failed")).toBeInTheDocument();
  });
});
