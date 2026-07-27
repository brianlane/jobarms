import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fakeClient, fakeFrom } from "./helpers/supabase";
import { decryptPassword } from "@/lib/site-accounts";
import {
  deleteLinkedInAccount,
  getLinkedInAccount,
  LINKEDIN_TENANT_HOST,
  setLinkedInCredentials
} from "@/lib/linkedin";

const KEY = "a".repeat(64);
const SECRET = ["linkedin", "fixture"].join("-");

beforeEach(() => {
  process.env.SITE_ACCOUNT_ENC_KEY = KEY;
});
afterEach(() => {
  delete process.env.SITE_ACCOUNT_ENC_KEY;
});

describe("setLinkedInCredentials", () => {
  it("upserts an encrypted password keyed to the LinkedIn host", async () => {
    const client = fakeClient({ from: fakeFrom({ site_accounts: [{ data: null }] }) });
    await setLinkedInCredentials(
      client as unknown as SupabaseClient,
      "u1",
      "me@example.com",
      SECRET
    );

    const upsertArg = client.from.mock.results
      .map((r) => r.value)
      .find((q) => q.upsert.mock.calls.length)!.upsert.mock.calls[0][0];

    expect(upsertArg.tenant_host).toBe(LINKEDIN_TENANT_HOST);
    expect(upsertArg.ats).toBe("linkedin");
    expect(upsertArg.email).toBe("me@example.com");
    // Never a plaintext password column, and the ciphertext round-trips.
    expect(Object.keys(upsertArg)).not.toContain("password");
    expect(upsertArg.password_encrypted).toMatch(/^v1:/);
    expect(decryptPassword(upsertArg.password_encrypted)).toBe(SECRET);
    // Reconnecting starts fresh: unlocked, unverified.
    expect(upsertArg.status).toBe("pending_verification");
    expect(upsertArg.login_failures).toBe(0);
    expect(upsertArg.verified_at).toBeNull();

    const [, opts] = client.from.mock.results
      .map((r) => r.value)
      .find((q) => q.upsert.mock.calls.length)!.upsert.mock.calls[0];
    expect(opts).toEqual({ onConflict: "user_id,tenant_host" });
  });
});

describe("getLinkedInAccount", () => {
  function service(data: unknown) {
    return fakeClient({
      from: fakeFrom({ site_accounts: [{ data }] })
    }) as unknown as SupabaseClient;
  }

  it("returns the email and status when connected", async () => {
    expect(
      await getLinkedInAccount(service({ email: "me@example.com", status: "verified" }), "u1")
    ).toEqual({ email: "me@example.com", status: "verified" });
  });

  it("returns null when no account is connected", async () => {
    expect(await getLinkedInAccount(service(null), "u1")).toBeNull();
  });
});

describe("deleteLinkedInAccount", () => {
  it("deletes the row scoped to the user and the LinkedIn host", async () => {
    const client = fakeClient({ from: fakeFrom({ site_accounts: [{ data: null }] }) });
    await deleteLinkedInAccount(client as unknown as SupabaseClient, "u1");

    const builder = client.from.mock.results
      .map((r) => r.value)
      .find((q) => q.delete.mock.calls.length)!;
    expect(builder.delete).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith("user_id", "u1");
    expect(builder.eq).toHaveBeenCalledWith("tenant_host", LINKEDIN_TENANT_HOST);
  });
});
