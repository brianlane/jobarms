// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BillingActions } from "@/components/BillingActions";

beforeEach(() => {
  Object.defineProperty(window, "location", { value: { href: "" }, writable: true });
});
afterEach(() => vi.unstubAllGlobals());

function stubFetch(res: { ok: boolean; body: unknown }) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: res.ok, json: async () => res.body }));
}

describe("BillingActions", () => {
  it("free plan shows both upgrade buttons and starts checkout", async () => {
    stubFetch({ ok: true, body: { url: "https://checkout" } });
    render(<BillingActions plan="free" />);
    fireEvent.click(screen.getByText("Upgrade to Premium"));
    await waitFor(() => expect(window.location.href).toBe("https://checkout"));
    expect(fetch).toHaveBeenCalledWith("/api/billing/checkout", expect.objectContaining({ method: "POST" }));
  });

  it("free plan Go Max posts the max tier", async () => {
    stubFetch({ ok: true, body: { url: "https://max" } });
    render(<BillingActions plan="free" />);
    fireEvent.click(screen.getByText("Go Max"));
    await waitFor(() => expect(window.location.href).toBe("https://max"));
    expect(JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)).toEqual({ tier: "max" });
  });

  it("premium plan can upgrade to max", async () => {
    stubFetch({ ok: true, body: { url: "https://max" } });
    render(<BillingActions plan="premium" />);
    fireEvent.click(screen.getByText("Upgrade to Max"));
    await waitFor(() => expect(window.location.href).toBe("https://max"));
    expect(JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)).toEqual({ tier: "max" });
  });

  it("premium plan can open the portal", async () => {
    stubFetch({ ok: true, body: { url: "https://portal" } });
    render(<BillingActions plan="premium" />);
    fireEvent.click(screen.getByText("Manage subscription"));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/billing/portal", expect.any(Object)));
  });

  it("max plan shows only manage", () => {
    render(<BillingActions plan="max" />);
    expect(screen.getByText("Manage subscription")).toBeInTheDocument();
    expect(screen.queryByText("Upgrade to Max")).not.toBeInTheDocument();
  });

  it("surfaces a server error", async () => {
    stubFetch({ ok: false, body: { error: "no_customer" } });
    render(<BillingActions plan="max" />);
    fireEvent.click(screen.getByText("Manage subscription"));
    expect(await screen.findByText("no_customer")).toBeInTheDocument();
  });

  it("falls back to a generic error when the response omits one", async () => {
    stubFetch({ ok: false, body: {} });
    render(<BillingActions plan="max" />);
    fireEvent.click(screen.getByText("Manage subscription"));
    expect(await screen.findByText("Something went wrong.")).toBeInTheDocument();
  });

  it("shows a network error when the request throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<BillingActions plan="max" />);
    fireEvent.click(screen.getByText("Manage subscription"));
    expect(await screen.findByText("Network error.")).toBeInTheDocument();
  });
});
