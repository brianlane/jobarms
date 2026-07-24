// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
const auth = vi.hoisted(() => ({
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  signInWithOtp: vi.fn()
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => search.params
}));
vi.mock("@/lib/supabase/client", () => ({ createSupabaseBrowserClient: () => ({ auth }) }));

import { AuthForm } from "@/components/AuthForm";

beforeEach(() => {
  router.push.mockClear();
  router.refresh.mockClear();
  search.params = new URLSearchParams();
  auth.signUp.mockReset();
  auth.signInWithPassword.mockReset();
  auth.signInWithOtp.mockReset();
});
afterEach(() => vi.restoreAllMocks());

function fill() {
  fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "a@b.com" } });
  fireEvent.change(screen.getByPlaceholderText(/Password/), { target: { value: "password123" } });
}

describe("AuthForm login", () => {
  it("signs in and navigates to next", async () => {
    search.params = new URLSearchParams("next=/dashboard/billing");
    auth.signInWithPassword.mockResolvedValueOnce({ error: null });
    render(<AuthForm mode="login" />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/dashboard/billing"));
  });

  it("shows an error on bad credentials", async () => {
    auth.signInWithPassword.mockResolvedValueOnce({ error: { message: "Invalid login" } });
    render(<AuthForm mode="login" />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByText("Invalid login")).toBeInTheDocument();
  });
});

describe("AuthForm signup", () => {
  it("shows a confirmation message after sign up", async () => {
    auth.signUp.mockResolvedValueOnce({ error: null });
    render(<AuthForm mode="signup" />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
    expect(await screen.findByText(/Check your email to confirm/)).toBeInTheDocument();
  });

  it("surfaces a sign up error", async () => {
    auth.signUp.mockResolvedValueOnce({ error: { message: "already registered" } });
    render(<AuthForm mode="signup" />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Sign up" }));
    expect(await screen.findByText("already registered")).toBeInTheDocument();
  });
});

describe("AuthForm magic link", () => {
  it("requires an email first", async () => {
    render(<AuthForm mode="login" />);
    fireEvent.click(screen.getByText("Email me a magic link instead"));
    expect(await screen.findByText("Enter your email first.")).toBeInTheDocument();
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
  });

  it("sends a magic link", async () => {
    auth.signInWithOtp.mockResolvedValueOnce({ error: null });
    render(<AuthForm mode="login" />);
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "a@b.com" } });
    fireEvent.click(screen.getByText("Email me a magic link instead"));
    expect(await screen.findByText(/Magic link sent/)).toBeInTheDocument();
  });

  it("shows an error when the magic link fails", async () => {
    auth.signInWithOtp.mockResolvedValueOnce({ error: { message: "rate limited" } });
    render(<AuthForm mode="login" />);
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "a@b.com" } });
    fireEvent.click(screen.getByText("Email me a magic link instead"));
    expect(await screen.findByText("rate limited")).toBeInTheDocument();
  });
});
