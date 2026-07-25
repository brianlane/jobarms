import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null
}));
vi.mock("@/lib/supabase/auth", () => ({ getAuthUser: vi.fn(async () => holder.user) }));

import { adminConfigured, adminEmails, getAdminUser, isAdminEmail } from "@/lib/admin/guard";

beforeEach(() => {
  holder.user = null;
  delete process.env.ADMIN_EMAIL;
});
afterEach(() => {
  delete process.env.ADMIN_EMAIL;
});

describe("adminEmails", () => {
  it("is empty when ADMIN_EMAIL is unset", () => {
    expect(adminEmails()).toEqual([]);
    expect(adminConfigured()).toBe(false);
  });

  it("lowercases, trims, and drops blanks", () => {
    process.env.ADMIN_EMAIL = " Ops@JobArms.com , , second@jobarms.com ";
    expect(adminEmails()).toEqual(["ops@jobarms.com", "second@jobarms.com"]);
    expect(adminConfigured()).toBe(true);
  });
});

describe("isAdminEmail", () => {
  it("rejects everything when unconfigured", () => {
    expect(isAdminEmail("ops@jobarms.com")).toBe(false);
  });

  it("matches case-insensitively and ignores surrounding space", () => {
    process.env.ADMIN_EMAIL = "ops@jobarms.com";
    expect(isAdminEmail(" OPS@jobarms.com ")).toBe(true);
    expect(isAdminEmail("someone@else.com")).toBe(false);
  });

  it("rejects a missing email", () => {
    process.env.ADMIN_EMAIL = "ops@jobarms.com";
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
    expect(isAdminEmail("")).toBe(false);
  });
});

describe("getAdminUser", () => {
  it("is null when nobody is signed in", async () => {
    process.env.ADMIN_EMAIL = "ops@jobarms.com";
    expect(await getAdminUser()).toBeNull();
  });

  it("is null for a signed-in non-admin", async () => {
    process.env.ADMIN_EMAIL = "ops@jobarms.com";
    holder.user = { id: "u1", email: "user@example.com" };
    expect(await getAdminUser()).toBeNull();
  });

  it("returns the admin identity for an allowlisted session", async () => {
    process.env.ADMIN_EMAIL = "ops@jobarms.com";
    holder.user = { id: "u1", email: "Ops@JobArms.com" };
    expect(await getAdminUser()).toEqual({ id: "u1", email: "Ops@JobArms.com" });
  });
});
