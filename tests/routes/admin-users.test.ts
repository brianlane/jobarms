import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFrom, type Result } from "../helpers/supabase";

const holder = vi.hoisted(() => ({
  admin: { id: "admin-1", email: "ops@jobarms.com" } as { id: string; email: string } | null,
  from: null as unknown,
  deleteUser: null as unknown,
  list: null as unknown,
  remove: null as unknown,
  impact: {
    applications: 1,
    runs: 2,
    resumes: 1,
    emails: 0,
    memory: 3,
    siteAccounts: 1,
    activeSubscriptionId: null as string | null
  },
  welcomeSent: true
}));

vi.mock("@/lib/admin/guard", () => ({ getAdminUser: vi.fn(async () => holder.admin) }));
const logAdminAction = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/admin/audit", () => ({ logAdminAction }));
vi.mock("@/lib/admin/user-detail", () => ({
  loadDeletionImpact: vi.fn(async () => holder.impact)
}));
const sendWelcomeEmail = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/email", () => ({ sendWelcomeEmail }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceClient: vi.fn(() => ({
    from: holder.from,
    auth: { admin: { deleteUser: holder.deleteUser } },
    storage: {
      from: vi.fn(() => ({ list: holder.list, remove: holder.remove }))
    }
  }))
}));

import { POST as setPlan } from "@/app/api/admin/users/[id]/plan/route";
import { POST as resendWelcome } from "@/app/api/admin/users/[id]/welcome-email/route";
import { DELETE as deleteUserRoute } from "@/app/api/admin/users/[id]/route";

const ctx = (id = "u1") => ({ params: Promise.resolve({ id }) });
const jsonReq = (body: unknown) =>
  new Request("http://x", { method: "POST", body: JSON.stringify(body) });
const emptyReq = () => new Request("http://x", { method: "POST" });

function tables(map: Record<string, Result[]>) {
  holder.from = fakeFrom(map);
}

beforeEach(() => {
  holder.admin = { id: "admin-1", email: "ops@jobarms.com" };
  holder.from = fakeFrom({});
  holder.deleteUser = vi.fn(async () => ({ error: null }));
  holder.list = vi.fn(async () => ({ data: [] }));
  holder.remove = vi.fn(async () => ({ error: null }));
  holder.impact = {
    applications: 1,
    runs: 2,
    resumes: 1,
    emails: 0,
    memory: 3,
    siteAccounts: 1,
    activeSubscriptionId: null
  };
  logAdminAction.mockClear();
  sendWelcomeEmail.mockReset().mockResolvedValue(true);
});

describe("POST /api/admin/users/[id]/plan", () => {
  it("403 for anyone who is not an admin", async () => {
    holder.admin = null;
    expect((await setPlan(jsonReq({ plan: "premium" }), ctx())).status).toBe(403);
  });

  it("400 on an unparseable body", async () => {
    const bad = new Request("http://x", { method: "POST", body: "not json" });
    expect((await setPlan(bad, ctx())).status).toBe(400);
  });

  it("400 on a plan we do not comp", async () => {
    expect((await setPlan(jsonReq({ plan: "enterprise" }), ctx())).status).toBe(400);
    expect((await setPlan(jsonReq({}), ctx())).status).toBe(400);
  });

  it("409 when Stripe owns the subscription", async () => {
    tables({ subscriptions: [{ data: { user_id: "u1", stripe_subscription_id: "sub_1" } }] });
    const response = await setPlan(jsonReq({ plan: "max" }), ctx());
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("stripe_managed");
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  it("comps a plan and audits it", async () => {
    const from = fakeFrom({
      subscriptions: [
        { data: { user_id: "u1", stripe_subscription_id: null, plan: "free" } },
        { data: null, error: null }
      ]
    });
    holder.from = from;
    const response = await setPlan(jsonReq({ plan: "premium" }), ctx());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, plan: "premium", status: "active" });

    const upsert = (from.mock.results[1].value as Record<string, ReturnType<typeof vi.fn>>).upsert;
    expect(upsert).toHaveBeenCalledWith(
      { user_id: "u1", plan: "premium", status: "active" },
      { onConflict: "user_id" }
    );
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "comp_plan", targetUserId: "u1" })
    );
  });

  it("revokes to free with status none", async () => {
    tables({ subscriptions: [{ data: null }, { data: null, error: null }] });
    const response = await setPlan(jsonReq({ plan: "free" }), ctx());
    expect(await response.json()).toEqual({ ok: true, plan: "free", status: "none" });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "revoke_plan" })
    );
  });

  it("500 when the write fails", async () => {
    tables({
      subscriptions: [{ data: null }, { data: null, error: { message: "denied" } }]
    });
    expect((await setPlan(jsonReq({ plan: "max" }), ctx())).status).toBe(500);
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/users/[id]/welcome-email", () => {
  it("403 for a non-admin", async () => {
    holder.admin = null;
    expect((await resendWelcome(emptyReq(), ctx())).status).toBe(403);
  });

  it("404 when the profile has no email", async () => {
    tables({ profiles: [{ data: null }] });
    expect((await resendWelcome(emptyReq(), ctx())).status).toBe(404);
  });

  it("sends, marks welcome_sent, and audits", async () => {
    const from = fakeFrom({
      profiles: [{ data: { email: "u1@x.com", full_name: "One User" } }, { data: null }]
    });
    holder.from = from;
    const response = await resendWelcome(emptyReq(), ctx());
    expect(response.status).toBe(200);
    expect(sendWelcomeEmail).toHaveBeenCalledWith("u1@x.com", "One");

    const update = (from.mock.results[1].value as Record<string, ReturnType<typeof vi.fn>>).update;
    expect(update).toHaveBeenCalledWith({ welcome_sent: true });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "resend_welcome_email", detail: { sent: true } })
    );
  });

  it("handles a profile with no name", async () => {
    tables({ profiles: [{ data: { email: "u1@x.com", full_name: null } }, { data: null }] });
    await resendWelcome(emptyReq(), ctx());
    expect(sendWelcomeEmail).toHaveBeenCalledWith("u1@x.com", "");
  });

  it("502 without flipping welcome_sent when email is unconfigured", async () => {
    sendWelcomeEmail.mockResolvedValueOnce(false);
    const from = fakeFrom({ profiles: [{ data: { email: "u1@x.com", full_name: "One" } }] });
    holder.from = from;
    const response = await resendWelcome(emptyReq(), ctx());
    expect(response.status).toBe(502);
    expect(from.mock.results).toHaveLength(1);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { sent: false } })
    );
  });
});

describe("DELETE /api/admin/users/[id]", () => {
  const req = () => new Request("http://x", { method: "DELETE" });

  it("403 for a non-admin", async () => {
    holder.admin = null;
    expect((await deleteUserRoute(req(), ctx())).status).toBe(403);
  });

  it("409 rather than locking the operator out of their own account", async () => {
    const response = await deleteUserRoute(req(), ctx("admin-1"));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("cannot_delete_self");
  });

  it("409 while Stripe is still billing", async () => {
    holder.impact = { ...holder.impact, activeSubscriptionId: "sub_live" };
    const response = await deleteUserRoute(req(), ctx());
    expect(response.status).toBe(409);
    expect((await response.json()).subscriptionId).toBe("sub_live");
    expect(holder.deleteUser).not.toHaveBeenCalled();
  });

  it("removes stored files, deletes the auth user, and audits the impact", async () => {
    holder.list = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ name: "resume.pdf" }] })
      .mockResolvedValueOnce({ data: [] });
    const response = await deleteUserRoute(req(), ctx());
    expect(response.status).toBe(200);
    expect(holder.remove).toHaveBeenCalledWith(["u1/resume.pdf"]);
    expect(holder.remove).toHaveBeenCalledTimes(1);
    expect(holder.deleteUser).toHaveBeenCalledWith("u1");
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "delete_user",
        targetUserId: null,
        detail: expect.objectContaining({ deletedUserId: "u1", runs: 2 })
      })
    );
  });

  it("tolerates a bucket listing that returns nothing", async () => {
    holder.list = vi.fn(async () => ({ data: null }));
    expect((await deleteUserRoute(req(), ctx())).status).toBe(200);
    expect(holder.remove).not.toHaveBeenCalled();
  });

  it("500 when the auth delete fails", async () => {
    holder.deleteUser = vi.fn(async () => ({ error: { message: "nope" } }));
    expect((await deleteUserRoute(req(), ctx())).status).toBe(500);
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});
