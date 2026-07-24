import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/redirect";

describe("safeNextPath", () => {
  it("allows plain internal paths", () => {
    expect(safeNextPath("/dashboard")).toBe("/dashboard");
    expect(safeNextPath("/onboarding")).toBe("/onboarding");
    expect(safeNextPath("/dashboard/applications/123?tab=runs")).toBe(
      "/dashboard/applications/123?tab=runs"
    );
  });

  it("falls back when missing", () => {
    expect(safeNextPath(null)).toBe("/dashboard");
    expect(safeNextPath(undefined)).toBe("/dashboard");
    expect(safeNextPath("")).toBe("/dashboard");
  });

  it("rejects absolute and protocol-relative URLs", () => {
    expect(safeNextPath("https://evil.com")).toBe("/dashboard");
    expect(safeNextPath("//evil.com")).toBe("/dashboard");
  });

  it("rejects backslash smuggling (URL parsers treat \\ as /)", () => {
    // new URL("/\\evil.com", origin) resolves to https://evil.com/
    expect(safeNextPath("/\\evil.com")).toBe("/dashboard");
    expect(safeNextPath("\\/evil.com")).toBe("/dashboard");
    expect(safeNextPath("/\\\\evil.com")).toBe("/dashboard");
  });

  it("honors a custom fallback", () => {
    expect(safeNextPath("//evil.com", "/onboarding")).toBe("/onboarding");
  });
});
