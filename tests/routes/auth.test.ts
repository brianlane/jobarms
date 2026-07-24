import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient } from "../helpers/supabase";

const holder = vi.hoisted(() => ({ server: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => holder.server) }));

import { GET as callback } from "@/app/auth/callback/route";
import { POST as signout } from "@/app/auth/signout/route";

beforeEach(() => {
  holder.server = null;
});

describe("GET /auth/callback", () => {
  it("exchanges a code and redirects to a safe next path", async () => {
    holder.server = fakeClient({});
    const res = await callback(new Request("https://jobarms.com/auth/callback?code=abc&next=/dashboard/billing"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://jobarms.com/dashboard/billing");
  });

  it("sanitizes a malicious next path back to /dashboard", async () => {
    holder.server = fakeClient({});
    const res = await callback(new Request("https://jobarms.com/auth/callback?code=abc&next=/\\evil.com"));
    expect(res.headers.get("location")).toBe("https://jobarms.com/dashboard");
  });

  it("redirects to /login?error=auth when the exchange fails", async () => {
    const client = fakeClient({});
    client.auth.exchangeCodeForSession.mockResolvedValueOnce({ error: { message: "bad code" } });
    holder.server = client;
    const res = await callback(new Request("https://jobarms.com/auth/callback?code=abc"));
    expect(res.headers.get("location")).toBe("https://jobarms.com/login?error=auth");
  });

  it("redirects to /login?error=auth when there is no code", async () => {
    const res = await callback(new Request("https://jobarms.com/auth/callback"));
    expect(res.headers.get("location")).toBe("https://jobarms.com/login?error=auth");
  });
});

describe("POST /auth/signout", () => {
  it("signs out and redirects home", async () => {
    holder.server = fakeClient({});
    const res = await signout(new Request("https://jobarms.com/auth/signout", { method: "POST" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://jobarms.com/");
  });
});
