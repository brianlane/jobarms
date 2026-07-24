// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/font/google", () => ({
  Inter: () => ({ variable: "--font-inter" }),
  Space_Grotesk: () => ({ variable: "--font-grotesk" }),
  JetBrains_Mono: () => ({ variable: "--font-jbmono" })
}));
vi.mock("@vercel/speed-insights/next", () => ({ SpeedInsights: () => null }));
const ogCtor = vi.hoisted(() => vi.fn());
vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(el: unknown, opts: unknown) {
      ogCtor(el, opts);
    }
  }
}));

import RootLayout from "@/app/layout";
import DashboardLoading from "@/app/dashboard/loading";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import OgImage, { size, contentType, alt, runtime } from "@/app/opengraph-image";

describe("RootLayout", () => {
  it("renders children and mounts SpeedInsights", () => {
    render(RootLayout({ children: "hello world" }));
    expect(screen.getByText("hello world")).toBeInTheDocument();
  });

  it("uses an https NEXT_PUBLIC_APP_URL as the metadataBase", async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_APP_URL = "https://custom.example";
    const mod = await import("@/app/layout");
    expect(String(mod.metadata.metadataBase)).toContain("custom.example");
    delete process.env.NEXT_PUBLIC_APP_URL;
    vi.resetModules();
  });
});

describe("DashboardLoading", () => {
  it("renders the skeleton", () => {
    const { container } = render(<DashboardLoading />);
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });
});

describe("robots + sitemap", () => {
  it("robots disallows private areas and points at the sitemap", () => {
    const r = robots();
    expect(r.rules).toBeTruthy();
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    expect(rule.disallow).toContain("/dashboard");
    expect(r.sitemap).toContain("sitemap.xml");
  });

  it("sitemap lists the public routes", () => {
    const s = sitemap();
    expect(s).toHaveLength(4);
    expect(s[0].url).toContain("jobarms.com");
  });
});

describe("opengraph image", () => {
  it("builds an ImageResponse with the configured size", () => {
    OgImage();
    expect(ogCtor).toHaveBeenCalled();
    expect(ogCtor.mock.calls[0][1]).toEqual(size);
    expect(contentType).toBe("image/png");
    expect(alt).toContain("JobArms");
    expect(runtime).toBe("edge");
  });
});
