import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createServerClientMock = vi.fn();
const createBrowserClientMock = vi.fn();
const createClientMock = vi.fn(() => ({ svc: true }));
const cookieStore = {
  getAll: vi.fn(() => [{ name: "sb", value: "tok" }]),
  set: vi.fn()
};

vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore) }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (url: string, key: string, options: { cookies: { getAll: () => unknown; setAll: (c: unknown[]) => void } }) => {
    createServerClientMock(url, key, options);
    // Exercise the cookie-adapter closures the client defines.
    options.cookies.getAll();
    options.cookies.setAll([{ name: "sb", value: "new", options: {} }]);
    return { ok: true };
  },
  createBrowserClient: (url: string, key: string) => {
    createBrowserClientMock(url, key);
    return { ok: true };
  }
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => createClientMock(...(args as [])) 
}));

beforeEach(() => {
  createServerClientMock.mockClear();
  createBrowserClientMock.mockClear();
  createClientMock.mockClear();
  cookieStore.getAll.mockClear();
  cookieStore.set.mockReset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_mock";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_mock";
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  delete process.env.SUPABASE_SECRET_KEY;
});

describe("createSupabaseServiceClient", () => {
  it("builds a service-role client with session persistence off", async () => {
    const { createSupabaseServiceClient } = await import("@/lib/supabase/service");
    createSupabaseServiceClient();
    expect(createClientMock).toHaveBeenCalledWith(
      "https://mock.supabase.co",
      "sb_secret_mock",
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
  });
});

describe("createSupabaseServerClient", () => {
  it("wires cookie getAll/setAll and forwards to createServerClient", async () => {
    const { createSupabaseServerClient } = await import("@/lib/supabase/server");
    await createSupabaseServerClient();
    expect(createServerClientMock).toHaveBeenCalledTimes(1);
    expect(cookieStore.getAll).toHaveBeenCalled();
    expect(cookieStore.set).toHaveBeenCalledWith("sb", "new", {});
  });

  it("swallows cookie writes that throw (Server Component context)", async () => {
    cookieStore.set.mockImplementation(() => {
      throw new Error("cannot set cookies here");
    });
    const { createSupabaseServerClient } = await import("@/lib/supabase/server");
    await expect(createSupabaseServerClient()).resolves.toBeDefined();
  });
});

describe("createSupabaseBrowserClient", () => {
  it("builds a browser client from the publishable key", async () => {
    const { createSupabaseBrowserClient } = await import("@/lib/supabase/client");
    createSupabaseBrowserClient();
    expect(createBrowserClientMock).toHaveBeenCalledWith(
      "https://mock.supabase.co",
      "sb_publishable_mock"
    );
  });
});
