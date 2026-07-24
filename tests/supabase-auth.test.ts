import { beforeEach, describe, expect, it, vi } from "vitest";

const getClaims = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({ auth: { getClaims } }))
}));

beforeEach(() => {
  vi.resetModules();
  getClaims.mockReset();
});

describe("getAuthUser", () => {
  it("returns id + email from verified claims", async () => {
    getClaims.mockResolvedValueOnce({
      data: { claims: { sub: "user-1", email: "a@b.com" } },
      error: null
    });
    const { getAuthUser } = await import("@/lib/supabase/auth");
    expect(await getAuthUser()).toEqual({ id: "user-1", email: "a@b.com" });
  });

  it("defaults email to empty string when the claim is absent", async () => {
    getClaims.mockResolvedValueOnce({ data: { claims: { sub: "user-2" } }, error: null });
    const { getAuthUser } = await import("@/lib/supabase/auth");
    expect(await getAuthUser()).toEqual({ id: "user-2", email: "" });
  });

  it("returns null when getClaims errors", async () => {
    getClaims.mockResolvedValueOnce({ data: null, error: new Error("bad jwt") });
    const { getAuthUser } = await import("@/lib/supabase/auth");
    expect(await getAuthUser()).toBeNull();
  });

  it("returns null when there is no subject claim", async () => {
    getClaims.mockResolvedValueOnce({ data: { claims: {} }, error: null });
    const { getAuthUser } = await import("@/lib/supabase/auth");
    expect(await getAuthUser()).toBeNull();
  });
});
