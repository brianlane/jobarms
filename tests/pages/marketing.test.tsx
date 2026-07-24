// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/"
}));
vi.mock("@/lib/supabase/client", () => ({
  createSupabaseBrowserClient: () => ({ auth: {} })
}));

import LandingPage from "@/app/page";
import PricingPage from "@/app/pricing/page";
import LoginPage from "@/app/login/page";
import SignupPage from "@/app/signup/page";
import OnboardingPage from "@/app/onboarding/page";

describe("marketing + auth pages", () => {
  it("landing page renders hero, JSON-LD, and FAQ", () => {
    const { container } = render(<LandingPage />);
    expect(screen.getByText(/Grow arms\./)).toBeInTheDocument();
    expect(container.querySelector('script[type="application/ld+json"]')).not.toBeNull();
    expect(screen.getByText(/The things everyone asks first/)).toBeInTheDocument();
  });

  it("pricing page renders all three tiers", () => {
    render(<PricingPage />);
    expect(screen.getByText("Simple pricing, honest free plan")).toBeInTheDocument();
    expect(screen.getByText("Go Premium")).toBeInTheDocument();
    expect(screen.getByText("Go Max")).toBeInTheDocument();
  });

  it("login page mounts the login form", () => {
    render(<LoginPage />);
    expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
  });

  it("signup page mounts the signup form", () => {
    render(<SignupPage />);
    expect(screen.getByRole("button", { name: "Sign up" })).toBeInTheDocument();
  });

  it("onboarding page mounts the wizard", () => {
    render(<OnboardingPage />);
    expect(screen.getByText("Upload your resume")).toBeInTheDocument();
  });
});
