// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { SiteHeader } from "@/components/marketing/SiteHeader";

describe("SiteFooter", () => {
  it("renders brand, nav links, and the current year", () => {
    render(<SiteFooter />);
    expect(screen.getByRole("link", { name: "Pricing" })).toHaveAttribute("href", "/pricing");
    expect(screen.getByText(/hello@jobarms.com/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(String(new Date().getFullYear())))).toBeInTheDocument();
  });
});

describe("SiteHeader", () => {
  it("renders the home link and primary nav", () => {
    render(<SiteHeader />);
    expect(screen.getByRole("link", { name: "JobArms home" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Get started" })).toHaveAttribute("href", "/signup");
  });
});
