// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
const auth = vi.hoisted(() => ({ signInWithPassword: vi.fn(), signOut: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => search.params
}));
vi.mock("@/lib/supabase/client", () => ({ createSupabaseBrowserClient: () => ({ auth }) }));

import { AdminLoginForm } from "@/components/admin/AdminLoginForm";

beforeEach(() => {
  router.push.mockClear();
  router.refresh.mockClear();
  search.params = new URLSearchParams();
  auth.signInWithPassword.mockReset();
  auth.signOut.mockReset().mockResolvedValue({ error: null });
});

function fill() {
  fireEvent.change(screen.getByPlaceholderText("admin@jobarms.com"), {
    target: { value: "ops@jobarms.com" }
  });
  fireEvent.change(screen.getByPlaceholderText("Password"), {
    target: { value: "correct horse battery" }
  });
}

describe("AdminLoginForm", () => {
  it("signs in and lands on the admin overview by default", async () => {
    auth.signInWithPassword.mockResolvedValueOnce({ error: null });
    render(<AdminLoginForm forceSignOut={false} adminConfigured />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/admin/dashboard"));
    expect(router.refresh).toHaveBeenCalled();
  });

  it("honors a safe next param", async () => {
    search.params = new URLSearchParams("next=/admin/system");
    auth.signInWithPassword.mockResolvedValueOnce({ error: null });
    render(<AdminLoginForm forceSignOut={false} adminConfigured />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/admin/system"));
  });

  it("surfaces a sign-in failure and stays put", async () => {
    auth.signInWithPassword.mockResolvedValueOnce({ error: { message: "Invalid login" } });
    render(<AdminLoginForm forceSignOut={false} adminConfigured />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Invalid login")).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("disables the form and explains when admin is unconfigured", () => {
    render(<AdminLoginForm forceSignOut={false} adminConfigured={false} />);
    expect(screen.getByText(/ADMIN_EMAIL is not configured/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
  });

  it("signs out a non-admin session and says so", async () => {
    render(<AdminLoginForm forceSignOut adminConfigured />);
    expect(await screen.findByText(/not authorized for admin access/)).toBeInTheDocument();
    expect(auth.signOut).toHaveBeenCalled();
  });

  it("still reports the refusal when the sign-out call fails", async () => {
    auth.signOut.mockRejectedValueOnce(new Error("offline"));
    render(<AdminLoginForm forceSignOut adminConfigured />);
    expect(await screen.findByText(/not authorized for admin access/)).toBeInTheDocument();
  });
});
