// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const usePathname = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ usePathname }));

import { DashboardNav } from "@/components/DashboardNav";

beforeEach(() => usePathname.mockReset());

describe("DashboardNav", () => {
  it("sidebar marks the exact overview route active", () => {
    usePathname.mockReturnValue("/dashboard");
    render(<DashboardNav variant="sidebar" />);
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Applications" })).not.toHaveAttribute("aria-current");
  });

  it("sidebar marks a nested route active via startsWith", () => {
    usePathname.mockReturnValue("/dashboard/applications/123");
    render(<DashboardNav variant="sidebar" />);
    expect(screen.getByRole("link", { name: "Applications" })).toHaveAttribute("aria-current", "page");
    // overview is exact-match only, so it stays inactive on a nested path
    expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });

  it("topbar variant renders the same items", () => {
    usePathname.mockReturnValue("/dashboard/billing");
    render(<DashboardNav variant="topbar" />);
    expect(screen.getByRole("link", { name: "Billing" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Discover" })).not.toHaveAttribute("aria-current");
  });
});
