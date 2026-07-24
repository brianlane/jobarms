import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, fakeFrom, fakeRpc } from "../helpers/supabase";

const holder = vi.hoisted(() => ({ server: null as unknown, service: null as unknown }));
const cancelRun = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => holder.server) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceClient: vi.fn(() => holder.service) }));
vi.mock("@/lib/arm", () => ({ cancelRun }));

import { POST } from "@/app/api/runs/[id]/cancel/route";

const ctx = { params: Promise.resolve({ id: "run-1" }) };
const req = () => new Request("http://x", { method: "POST" });

beforeEach(() => {
  holder.server = null;
  holder.service = null;
  cancelRun.mockClear();
});

describe("POST /api/runs/[id]/cancel", () => {
  it("401 without a user", async () => {
    holder.server = fakeClient({ user: null });
    expect((await POST(req(), ctx)).status).toBe(401);
  });

  it("404 when the run is missing", async () => {
    holder.server = fakeClient({ user: { id: "u1" }, from: fakeFrom({ application_runs: [{ data: null }] }) });
    expect((await POST(req(), ctx)).status).toBe(404);
  });

  it("409 for a non-cancellable status", async () => {
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({ application_runs: [{ data: { id: "run-1", status: "submitted", answers: [], application_id: "a1" } }] })
    });
    expect((await POST(req(), ctx)).status).toBe(409);
  });

  it("consumes the slot when canceling working machinery (no refund)", async () => {
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({ application_runs: [{ data: { id: "run-1", status: "running", answers: null, application_id: "a1" } }] })
    });
    const rpc = fakeRpc({});
    holder.service = fakeClient({ rpc });
    const res = await POST(req(), ctx);
    expect((await res.json()).refunded).toBe(false);
    expect(cancelRun).toHaveBeenCalledWith("run-1");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refunds when canceling a dead-ended junk review", async () => {
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({
        application_runs: [
          { data: { id: "run-1", status: "needs_review", answers: [{ value: "", skipped: true }], application_id: "a1" } }
        ]
      })
    });
    const rpc = fakeRpc({ refund_arm_run: [true] });
    holder.service = fakeClient({ rpc });
    const res = await POST(req(), ctx);
    expect((await res.json()).refunded).toBe(true);
    expect(rpc).toHaveBeenCalledWith("refund_arm_run", { p_run_id: "run-1" });
  });
});
