// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { UserActions } from "@/components/admin/UserActions";

const impact = {
  applications: 4,
  runs: 9,
  resumes: 2,
  emails: 1,
  memory: 30,
  siteAccounts: 3,
  activeSubscriptionId: null as string | null
};

function renderActions(over: Partial<Parameters<typeof UserActions>[0]> = {}) {
  return render(
    <UserActions
      userId="u1"
      email="one@x.com"
      plan="free"
      stripeManaged={false}
      impact={impact}
      {...over}
    />
  );
}

function ok(payload: unknown = { ok: true }) {
  return vi.fn(async () => ({ ok: true, json: async () => payload }));
}

beforeEach(() => {
  router.push.mockClear();
  router.refresh.mockClear();
  vi.unstubAllGlobals();
});

describe("UserActions plan controls", () => {
  it("comps a plan and refreshes", async () => {
    const fetchMock = ok();
    vi.stubGlobal("fetch", fetchMock);
    renderActions();
    fireEvent.click(screen.getByRole("button", { name: "premium" }));

    await waitFor(() => expect(screen.getByText("Comped to premium.")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/users/u1/plan",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ plan: "premium" }) })
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it("says revoked when dropping to free", async () => {
    vi.stubGlobal("fetch", ok());
    renderActions({ plan: "premium" });
    fireEvent.click(screen.getByRole("button", { name: "free" }));
    await waitFor(() => expect(screen.getByText("Plan revoked to free.")).toBeInTheDocument());
  });

  it("disables the current plan and every control while Stripe owns billing", () => {
    renderActions({ plan: "max", stripeManaged: true });
    expect(screen.getByRole("button", { name: "max" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "premium" })).toBeDisabled();
    expect(screen.getByText(/billed through Stripe/)).toBeInTheDocument();
  });

  it("surfaces the hint from a refused request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ hint: "Cancel it in Stripe first." }) }))
    );
    renderActions();
    fireEvent.click(screen.getByRole("button", { name: "premium" }));
    expect(await screen.findByText("Cancel it in Stripe first.")).toBeInTheDocument();
  });

  it("falls back to the error code, then to a generic message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "invalid_plan" }) }))
    );
    const { unmount } = renderActions();
    fireEvent.click(screen.getByRole("button", { name: "premium" }));
    expect(await screen.findByText("invalid_plan")).toBeInTheDocument();
    unmount();

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    renderActions();
    fireEvent.click(screen.getByRole("button", { name: "premium" }));
    expect(await screen.findByText("Request failed")).toBeInTheDocument();
  });

  it("handles a body that is not JSON and a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => {
          throw new Error("not json");
        }
      }))
    );
    const { unmount } = renderActions();
    fireEvent.click(screen.getByRole("button", { name: "premium" }));
    expect(await screen.findByText("Request failed")).toBeInTheDocument();
    unmount();

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    renderActions();
    fireEvent.click(screen.getByRole("button", { name: "premium" }));
    expect(await screen.findByText("Request failed")).toBeInTheDocument();
  });
});

describe("UserActions welcome email", () => {
  it("resends and reports success", async () => {
    const fetchMock = ok();
    vi.stubGlobal("fetch", fetchMock);
    renderActions();
    fireEvent.click(screen.getByRole("button", { name: "Resend welcome email" }));
    await waitFor(() => expect(screen.getByText("Welcome email sent.")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/users/u1/welcome-email",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("reports a refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ hint: "Email is unconfigured." }) }))
    );
    renderActions();
    fireEvent.click(screen.getByRole("button", { name: "Resend welcome email" }));
    expect(await screen.findByText("Email is unconfigured.")).toBeInTheDocument();
  });
});

describe("UserActions delete", () => {
  it("requires the exact email before the delete button works", async () => {
    const fetchMock = ok();
    vi.stubGlobal("fetch", fetchMock);
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    expect(screen.getByText("4 applications")).toBeInTheDocument();
    expect(screen.getByText("9 arm runs, with their screenshots")).toBeInTheDocument();

    const confirm = screen.getByRole("button", { name: "Delete permanently" });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "wrong@x.com" } });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: " One@X.com " } });
    expect(confirm).toBeEnabled();

    fireEvent.click(confirm);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/admin/users"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/users/u1",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("calls out a live subscription in the preview", () => {
    renderActions({ impact: { ...impact, activeSubscriptionId: "sub_live" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    expect(screen.getByText(/sub_live/)).toBeInTheDocument();
  });

  it("closes the panel again and stays put when the delete is refused", async () => {
    renderActions();
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    expect(screen.getByRole("button", { name: "Delete permanently" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    expect(screen.queryByRole("button", { name: "Delete permanently" })).not.toBeInTheDocument();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ hint: "Cancel Stripe first." }) }))
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "one@x.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    expect(await screen.findByText("Cancel Stripe first.")).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });
});
