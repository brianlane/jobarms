import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient } from "../helpers/supabase";

const holder = vi.hoisted(() => ({
  server: null as unknown,
  user: null as { id: string; email: string } | null
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => holder.server) }));
// The landing route only needs the identity, not a whole session client.
vi.mock("@/lib/supabase/auth", () => ({ getAuthUser: vi.fn(async () => holder.user) }));

import { GET as callback } from "@/app/auth/callback/route";
import { GET as landing } from "@/app/auth/landing/route";
import { POST as signout } from "@/app/auth/signout/route";

beforeEach(() => {
  holder.server = null;
  holder.user = null;
  delete process.env.ADMIN_EMAIL;
});

describe("GET /auth/landing", () => {
  const go = () => landing(new Request("https://jobarms.com/auth/landing"));

  it("sends an operator to the console", async () => {
    process.env.ADMIN_EMAIL = "ops@jobarms.com";
    holder.user = { id: "admin-1", email: "ops@jobarms.com" };

    const res = await go();
    expect(res.headers.get("location")).toBe("https://jobarms.com/admin/dashboard");
  });

  it("sends a normal user to their own dashboard", async () => {
    process.env.ADMIN_EMAIL = "ops@jobarms.com";
    holder.user = { id: "u1", email: "someone@else.com" };

    expect((await go()).headers.get("location")).toBe("https://jobarms.com/dashboard");
  });

  it("sends the operator address to the dashboard when admin is unconfigured", async () => {
    // An unset ADMIN_EMAIL disables the console rather than degrading open, so
    // there is nowhere else to send them.
    holder.user = { id: "admin-1", email: "ops@jobarms.com" };
    expect((await go()).headers.get("location")).toBe("https://jobarms.com/dashboard");
  });
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
