import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getClaims = vi.hoisted(() => vi.fn());
vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    options: { cookies: { getAll: () => unknown; setAll: (c: unknown[]) => void } }
  ) => {
    // Exercise the cookie adapter closures proxy.ts defines.
    options.cookies.getAll();
    options.cookies.setAll([{ name: "sb", value: "v", options: {} }]);
    return { auth: { getClaims } };
  }
}));

import proxy from "@/proxy";

function req(path: string) {
  return new NextRequest(new URL(`https://jobarms.com${path}`));
}

beforeEach(() => {
  getClaims.mockReset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_mock";
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
});

describe("proxy (middleware)", () => {
  it("redirects an unauthenticated dashboard request to /login with a next param", async () => {
    getClaims.mockResolvedValueOnce({ data: null });
    const res = await proxy(req("/dashboard/applications"));
    expect(res.status).toBe(307);
    const loc = res.headers.get("location")!;
    expect(loc).toContain("/login");
    expect(loc).toContain("next=%2Fdashboard%2Fapplications");
  });

  it("lets an authenticated dashboard request through", async () => {
    getClaims.mockResolvedValueOnce({ data: { claims: { sub: "u1" } } });
    const res = await proxy(req("/dashboard"));
    expect(res.status).toBe(200);
  });

  it("bounces an authenticated user away from /login", async () => {
    getClaims.mockResolvedValueOnce({ data: { claims: { sub: "u1" } } });
    const res = await proxy(req("/login"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://jobarms.com/dashboard");
  });

  it("lets an unauthenticated user reach /signup", async () => {
    getClaims.mockResolvedValueOnce({ data: null });
    const res = await proxy(req("/signup"));
    expect(res.status).toBe(200);
  });

  it("redirects an unauthenticated onboarding request", async () => {
    getClaims.mockResolvedValueOnce({ data: { claims: {} } });
    const res = await proxy(req("/onboarding"));
    expect(res.headers.get("location")).toContain("/login");
  });
});
