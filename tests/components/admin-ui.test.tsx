// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const path = vi.hoisted(() => ({ current: "/admin/dashboard" }));
vi.mock("next/navigation", () => ({ usePathname: () => path.current }));

import {
  Badge,
  BarChart,
  Card,
  Empty,
  MeterRow,
  PageHeading,
  SectionTitle,
  Stat,
  Table,
  timeAgo,
  UserLink
} from "@/components/admin/ui";
import { AdminNav } from "@/components/admin/AdminNav";

const NOW = new Date("2026-07-15T12:00:00Z");

beforeEach(() => {
  path.current = "/admin/dashboard";
});

describe("admin primitives", () => {
  it("renders a card with and without extra classes", () => {
    const { container } = render(
      <>
        <Card>plain</Card>
        <Card className="lg:col-span-2">wide</Card>
      </>
    );
    expect(screen.getByText("plain")).toBeInTheDocument();
    expect(container.querySelector(".lg\\:col-span-2")).not.toBeNull();
  });

  it("renders a section title with and without a right slot", () => {
    render(
      <>
        <SectionTitle>Bare</SectionTitle>
        <SectionTitle right={<span>slot</span>}>With slot</SectionTitle>
      </>
    );
    expect(screen.getByText("Bare")).toBeInTheDocument();
    expect(screen.getByText("slot")).toBeInTheDocument();
  });

  it("renders every badge tone", () => {
    render(
      <>
        <Badge tone="good">good</Badge>
        <Badge tone="bad">bad</Badge>
        <Badge tone="warn">warn</Badge>
        <Badge tone="info">info</Badge>
        <Badge>default</Badge>
      </>
    );
    for (const label of ["good", "bad", "warn", "info", "default"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("renders every stat tone, with and without a hint", () => {
    render(
      <>
        <Stat label="Good" value={1} tone="good" hint="hint" />
        <Stat label="Bad" value={2} tone="bad" />
        <Stat label="Warn" value={3} tone="warn" />
        <Stat label="Plain" value={4} />
      </>
    );
    expect(screen.getByText("hint")).toBeInTheDocument();
    expect(screen.getByText("Warn")).toBeInTheDocument();
  });

  it("renders meter rows in every tone and guards a zero total", () => {
    render(
      <>
        <MeterRow label="free" count={1} total={4} />
        <MeterRow label="premium" count={2} total={4} tone="good" />
        <MeterRow label="max" count={1} total={4} tone="warn" />
        <MeterRow label="broken" count={1} total={4} tone="bad" />
        <MeterRow label="empty" count={0} total={0} />
      </>
    );
    expect(screen.getByText("2 · 50%")).toBeInTheDocument();
    expect(screen.getByText("0 · 0%")).toBeInTheDocument();
  });

  it("renders a bar chart, hiding zero labels", () => {
    render(
      <BarChart
        points={[
          { label: "Jun", count: 0 },
          { label: "Jul", count: 3 }
        ]}
      />
    );
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Jun")).toBeInTheDocument();
  });

  it("renders the empty state, headings, and tables", () => {
    render(
      <>
        <Empty>nothing here</Empty>
        <PageHeading title="Bare title" />
        <PageHeading title="Full title" subtitle="sub" right={<span>action</span>} />
        <Table head={<tr><th>Head</th></tr>}>
          <tr>
            <td>Body</td>
          </tr>
        </Table>
      </>
    );
    expect(screen.getByText("nothing here")).toBeInTheDocument();
    expect(screen.getByText("Bare title")).toBeInTheDocument();
    expect(screen.getByText("sub")).toBeInTheDocument();
    expect(screen.getByText("action")).toBeInTheDocument();
    expect(screen.getByText("Body")).toBeInTheDocument();
  });

  it("falls back to a short id when a user has no email", () => {
    render(
      <>
        <UserLink id="11111111-2222" email="who@example.com" />
        <UserLink id="abcdefgh-ijkl" email="" />
      </>
    );
    expect(screen.getByText("who@example.com")).toBeInTheDocument();
    expect(screen.getByText("abcdefgh")).toBeInTheDocument();
  });
});

describe("timeAgo", () => {
  it("covers every unit and the unknown cases", () => {
    expect(timeAgo(null, NOW)).toBe("never");
    expect(timeAgo(undefined, NOW)).toBe("never");
    expect(timeAgo("not-a-date", NOW)).toBe("unknown");
    expect(timeAgo("2026-07-15T11:59:30Z", NOW)).toBe("just now");
    expect(timeAgo("2026-07-15T11:30:00Z", NOW)).toBe("30m ago");
    expect(timeAgo("2026-07-15T00:00:00Z", NOW)).toBe("12h ago");
    expect(timeAgo("2026-07-05T12:00:00Z", NOW)).toBe("10d ago");
    expect(timeAgo("2026-01-01T12:00:00Z", NOW)).toBe("7mo ago");
  });

  it("defaults to the current instant", () => {
    expect(timeAgo(new Date().toISOString())).toBe("just now");
  });
});

describe("AdminNav", () => {
  it("marks the active item in both variants", () => {
    render(<AdminNav variant="sidebar" />);
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "System" })).not.toHaveAttribute("aria-current");
  });

  it("treats a nested path as active", () => {
    path.current = "/admin/system/anything";
    render(<AdminNav variant="topbar" />);
    expect(screen.getByRole("link", { name: "System" })).toHaveAttribute("aria-current", "page");
  });
});
