import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, fakeFrom } from "../helpers/supabase";

const holder = vi.hoisted(() => ({ server: null as unknown, service: null as unknown }));
const setLinkedInCredentials = vi.hoisted(() => vi.fn(async () => {}));
const deleteLinkedInAccount = vi.hoisted(() => vi.fn(async () => {}));
const clearRenderSession = vi.hoisted(() => vi.fn(async () => ({ ok: true, data: { ok: true } })));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => holder.server)
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceClient: vi.fn(() => holder.service)
}));
vi.mock("@/lib/linkedin", () => ({
  LINKEDIN_TENANT_HOST: "www.linkedin.com",
  setLinkedInCredentials: (...a: unknown[]) => setLinkedInCredentials(...(a as [])),
  deleteLinkedInAccount: (...a: unknown[]) => deleteLinkedInAccount(...(a as []))
}));
vi.mock("@/lib/render", () => ({
  clearRenderSession: (...a: unknown[]) => clearRenderSession(...(a as []))
}));

import { DELETE, POST } from "@/app/api/linkedin/account/route";

const post = (body: unknown) =>
  new Request("http://x", { method: "POST", body: JSON.stringify(body) });

const validBody = { email: "me@example.com", password: "pw", consent: true };

beforeEach(() => {
  holder.server = null;
  holder.service = fakeClient({ from: fakeFrom({ profiles: [{ error: null }] }) });
  setLinkedInCredentials.mockClear();
  deleteLinkedInAccount.mockClear();
  clearRenderSession.mockClear();
});

describe("POST /api/linkedin/account", () => {
  it("401 without a user", async () => {
    holder.server = fakeClient({ user: null });
    expect((await POST(post(validBody))).status).toBe(401);
  });

  it("400 when the JSON is unparseable", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    const bad = new Request("http://x", { method: "POST", body: "{" });
    expect((await POST(bad)).status).toBe(400);
  });

  it("400 without explicit consent", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    expect((await POST(post({ ...validBody, consent: false }))).status).toBe(400);
  });

  it("400 on a malformed email", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    expect((await POST(post({ ...validBody, email: "not-an-email" }))).status).toBe(400);
  });

  it("400 on an empty password", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    expect((await POST(post({ ...validBody, password: "" }))).status).toBe(400);
  });

  it("vaults the credentials, records consent, and returns the email", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: "me@example.com" });
    expect(setLinkedInCredentials).toHaveBeenCalledWith(
      holder.service,
      "u1",
      "me@example.com",
      "pw"
    );
    // Re-connecting must not ride a session opened under the old password.
    expect(clearRenderSession).toHaveBeenCalledWith({
      userId: "u1",
      tenantHost: "www.linkedin.com"
    });
  });
});

describe("DELETE /api/linkedin/account", () => {
  it("401 without a user", async () => {
    holder.server = fakeClient({ user: null });
    expect((await DELETE()).status).toBe(401);
  });

  it("drops the credentials, clears consent, and forgets the session", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(deleteLinkedInAccount).toHaveBeenCalledWith(holder.service, "u1");
    expect(clearRenderSession).toHaveBeenCalledWith({
      userId: "u1",
      tenantHost: "www.linkedin.com"
    });
  });
});
