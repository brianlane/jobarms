import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFrom, fakeRpc, type Result } from "../helpers/supabase";

const holder = vi.hoisted(() => ({
  admin: { id: "admin-1", email: "ops@jobarms.com" } as { id: string; email: string } | null,
  from: null as unknown,
  rpc: null as unknown
}));

vi.mock("@/lib/admin/guard", () => ({ getAdminUser: vi.fn(async () => holder.admin) }));
const logAdminAction = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/admin/audit", () => ({ logAdminAction }));
const cancelRun = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/lib/arm", () => ({ cancelRun }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceClient: vi.fn(() => ({ from: holder.from, rpc: holder.rpc }))
}));

import { POST as refundRun } from "@/app/api/admin/runs/[id]/refund/route";
import { POST as cancelRoute } from "@/app/api/admin/runs/[id]/cancel/route";

const ctx = { params: Promise.resolve({ id: "r1" }) };
const req = () => new Request("http://x", { method: "POST" });

function tables(map: Record<string, Result[]>) {
  holder.from = fakeFrom(map);
}

beforeEach(() => {
  holder.admin = { id: "admin-1", email: "ops@jobarms.com" };
  holder.from = fakeFrom({});
  holder.rpc = fakeRpc({});
  logAdminAction.mockClear();
  cancelRun.mockClear();
});

describe("POST /api/admin/runs/[id]/refund", () => {
  it("403 for a non-admin", async () => {
    holder.admin = null;
    expect((await refundRun(req(), ctx)).status).toBe(403);
  });

  it("404 for an unknown run", async () => {
    tables({ application_runs: [{ data: null }] });
    expect((await refundRun(req(), ctx)).status).toBe(404);
  });

  it("refunds the slot and audits it", async () => {
    tables({ application_runs: [{ data: { id: "r1", user_id: "u1", slot_refunded: false } }] });
    const rpc = fakeRpc({ refund_arm_run: [true] });
    holder.rpc = rpc;

    const response = await refundRun(req(), ctx);
    expect(await response.json()).toEqual({ ok: true, refunded: true });
    expect(rpc).toHaveBeenCalledWith("refund_arm_run", { p_run_id: "r1" });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "force_refund_run",
        targetUserId: "u1",
        targetRunId: "r1",
        detail: { alreadyRefunded: false, moved: true }
      })
    );
  });

  it("reports that a second refund did not move the counter", async () => {
    tables({ application_runs: [{ data: { id: "r1", user_id: "u1", slot_refunded: true } }] });
    holder.rpc = fakeRpc({ refund_arm_run: [false] });
    const response = await refundRun(req(), ctx);
    expect(await response.json()).toEqual({ ok: true, refunded: false });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { alreadyRefunded: true, moved: false } })
    );
  });

  it("500 when the RPC errors", async () => {
    tables({ application_runs: [{ data: { id: "r1", user_id: "u1" } }] });
    holder.rpc = vi.fn(async () => ({ data: null, error: { message: "denied" } }));
    expect((await refundRun(req(), ctx)).status).toBe(500);
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/runs/[id]/cancel", () => {
  it("403 for a non-admin", async () => {
    holder.admin = null;
    expect((await cancelRoute(req(), ctx)).status).toBe(403);
  });

  it("404 for an unknown run", async () => {
    tables({ application_runs: [{ data: null }] });
    expect((await cancelRoute(req(), ctx)).status).toBe(404);
  });

  it("409 for a run that already finished", async () => {
    tables({ application_runs: [{ data: { id: "r1", status: "submitted", user_id: "u1" } }] });
    const response = await cancelRoute(req(), ctx);
    expect(response.status).toBe(409);
    expect((await response.json()).status).toBe("submitted");
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it("cancels working machinery without refunding, stamped as a system cancel", async () => {
    const from = fakeFrom({
      application_runs: [
        { data: { id: "r1", status: "running", answers: null, application_id: "a1", user_id: "u1" } },
        { data: null }
      ],
      applications: [{ data: null }]
    });
    holder.from = from;
    const rpc = fakeRpc({});
    holder.rpc = rpc;

    const response = await cancelRoute(req(), ctx);
    expect(await response.json()).toEqual({ ok: true, refunded: false });
    expect(cancelRun).toHaveBeenCalledWith("r1");
    expect(rpc).not.toHaveBeenCalled();

    const update = (from.mock.results[1].value as Record<string, ReturnType<typeof vi.fn>>).update;
    expect(update).toHaveBeenCalledWith({ status: "canceled", canceled_by: "system" });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cancel_run",
        detail: { previousStatus: "running", refunded: false }
      })
    );
  });

  it("refunds a dead-ended review with nothing reviewable", async () => {
    tables({
      application_runs: [
        {
          data: {
            id: "r1",
            status: "needs_review",
            answers: [{ value: "", skipped: true }],
            application_id: "a1",
            user_id: "u1"
          }
        },
        { data: null }
      ],
      applications: [{ data: null }]
    });
    const rpc = fakeRpc({ refund_arm_run: [true] });
    holder.rpc = rpc;

    const response = await cancelRoute(req(), ctx);
    expect(await response.json()).toEqual({ ok: true, refunded: true });
    expect(rpc).toHaveBeenCalledWith("refund_arm_run", { p_run_id: "r1" });
  });
});
