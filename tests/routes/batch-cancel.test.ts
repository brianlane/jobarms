import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, fakeFrom } from "../helpers/supabase";

const holder = vi.hoisted(() => ({ server: null as unknown, service: null as unknown }));
const cancelBatch = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: string })
);

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => holder.server)
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceClient: vi.fn(() => holder.service)
}));
vi.mock("@/lib/arm", () => ({
  cancelBatch: (...a: unknown[]) => cancelBatch(...(a as []))
}));

import { POST } from "@/app/api/batches/[id]/cancel/route";

const ctx = { params: Promise.resolve({ id: "b1" }) };
const post = () => new Request("http://x", { method: "POST" });

function servers(batchStatus: string | null, settled: unknown) {
  holder.server = fakeClient({
    user: { id: "u1" },
    from: fakeFrom({
      apply_batches: [{ data: batchStatus ? { id: "b1", status: batchStatus } : null }]
    })
  });
  holder.service = fakeClient({ from: fakeFrom({ apply_batches: [{ data: settled }] }) });
}

beforeEach(() => {
  cancelBatch.mockClear();
  cancelBatch.mockResolvedValue({ ok: true });
  servers("running", { status: "canceled", reserved: 5, consumed: 2, month_key: "2026-07" });
});

describe("POST /api/batches/[id]/cancel", () => {
  it("401 without a user", async () => {
    holder.server = fakeClient({ user: null });
    expect((await POST(post(), ctx)).status).toBe(401);
  });

  it("404 when the batch does not exist (or is not the user's)", async () => {
    servers(null, null);
    expect((await POST(post(), ctx)).status).toBe(404);
  });

  it("409 when the batch already settled", async () => {
    servers("completed", null);
    const res = await POST(post(), ctx);
    expect(res.status).toBe(409);
    expect(cancelBatch).not.toHaveBeenCalled();
  });

  it("503 when the worker will not cancel (nothing released)", async () => {
    cancelBatch.mockResolvedValue({ ok: false, reason: "arm_offline" });
    const res = await POST(post(), ctx);
    expect(res.status).toBe(503);
    const rpc = (holder.service as { rpc: ReturnType<typeof vi.fn> }).rpc;
    expect(rpc).not.toHaveBeenCalled();
  });

  it("cancels and releases everything the batch never spent", async () => {
    const res = await POST(post(), ctx);
    expect(res.status).toBe(200);
    expect(cancelBatch).toHaveBeenCalledWith("b1");
    const rpc = (holder.service as { rpc: ReturnType<typeof vi.fn> }).rpc;
    expect(rpc).toHaveBeenCalledWith("release_arm_runs", {
      p_user_id: "u1",
      p_month_key: "2026-07",
      p_count: 3
    });
  });

  it("releases nothing when the cancel lost the race to the batch's own settle", async () => {
    // The worker's guarded write left status "completed": the batch already
    // released its own remainder, so releasing again would double-credit.
    servers("running", { status: "completed", reserved: 5, consumed: 2, month_key: "2026-07" });
    expect((await POST(post(), ctx)).status).toBe(200);
    expect((holder.service as { rpc: ReturnType<typeof vi.fn> }).rpc).not.toHaveBeenCalled();
  });

  it("releases nothing when every reserved slot was already consumed", async () => {
    servers("running", { status: "canceled", reserved: 5, consumed: 5, month_key: "2026-07" });
    expect((await POST(post(), ctx)).status).toBe(200);
    expect((holder.service as { rpc: ReturnType<typeof vi.fn> }).rpc).not.toHaveBeenCalled();
  });

  it("tolerates the re-read finding nothing", async () => {
    servers("running", null);
    expect((await POST(post(), ctx)).status).toBe(200);
    expect((holder.service as { rpc: ReturnType<typeof vi.fn> }).rpc).not.toHaveBeenCalled();
  });
});
