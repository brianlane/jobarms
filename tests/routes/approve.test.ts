import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, fakeFrom, fakeRpc } from "../helpers/supabase";

const holder = vi.hoisted(() => ({ server: null as unknown, service: null as unknown }));
const approveRun = vi.hoisted(() => vi.fn(async (): Promise<{ ok: boolean; reason?: string }> => ({ ok: true })));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => holder.server) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceClient: vi.fn(() => holder.service) }));
vi.mock("@/lib/arm", () => ({ approveRun }));

import { POST } from "@/app/api/runs/[id]/approve/route";

const ctx = { params: Promise.resolve({ id: "run-1" }) };
const post = (body?: unknown) =>
  new Request("http://x", { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

const reviewRun = (over = {}) => ({
  data: { id: "run-1", status: "needs_review", answers: [], form_fields: [], application_id: "app-1", ...over }
});

beforeEach(() => {
  holder.server = null;
  holder.service = null;
  approveRun.mockClear();
  approveRun.mockResolvedValue({ ok: true });
});

describe("POST /api/runs/[id]/approve", () => {
  it("401 without a user", async () => {
    holder.server = fakeClient({ user: null });
    expect((await POST(post({}), ctx)).status).toBe(401);
  });

  it("400 on an invalid body", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    expect((await POST(post({ answers: "nope" }), ctx)).status).toBe(400);
  });

  it("404 when the run is missing", async () => {
    holder.server = fakeClient({ user: { id: "u1" }, from: fakeFrom({ application_runs: [{ data: null }] }) });
    expect((await POST(post({}), ctx)).status).toBe(404);
  });

  it("409 when the run is not awaiting review", async () => {
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({ application_runs: [{ data: { id: "run-1", status: "running" } }] })
    });
    expect((await POST(post({}), ctx)).status).toBe(409);
  });

  it("503 when the worker rejects the approval", async () => {
    approveRun.mockResolvedValueOnce({ ok: false, reason: "arm_offline" });
    holder.server = fakeClient({ user: { id: "u1" }, from: fakeFrom({ application_runs: [reviewRun()] }) });
    holder.service = fakeClient({});
    expect((await POST(post({}), ctx)).status).toBe(503);
  });

  it("approves with edits and captures memory + platform stats", async () => {
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({
        application_runs: [
          reviewRun({
            answers: [{ name: "phone", label: "Phone", value: "old" }],
            form_fields: [{ name: "phone", label: "Phone", type: "text" }]
          })
        ]
      })
    });
    const rpc = fakeRpc({ record_answer_memory: [null], record_field_stats: [null] });
    holder.service = fakeClient({
      from: fakeFrom({ application_runs: [{ error: null }], applications: [{ data: { jobs: { ats: "greenhouse" } } }] }),
      rpc
    });
    const res = await POST(post({ answers: [{ name: "phone", label: "Phone", value: "555" }] }), ctx);
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("record_answer_memory", expect.objectContaining({ p_user_id: "u1" }));
    expect(rpc).toHaveBeenCalledWith("record_field_stats", expect.objectContaining({ p_ats: "greenhouse" }));
  });

  it("skips stats capture when the ATS is unknown", async () => {
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({
        application_runs: [reviewRun({ form_fields: [{ name: "x", label: "X", type: "text" }] })]
      })
    });
    const rpc = fakeRpc({});
    holder.service = fakeClient({ from: fakeFrom({ applications: [{ data: { jobs: null } }] }), rpc });
    const res = await POST(post({}), ctx);
    expect(res.status).toBe(200);
    expect(rpc).not.toHaveBeenCalledWith("record_field_stats", expect.anything());
  });

  it("treats a malformed JSON body as no edits and approves", async () => {
    holder.server = fakeClient({ user: { id: "u1" }, from: fakeFrom({ application_runs: [reviewRun()] }) });
    holder.service = fakeClient({});
    const bad = new Request("http://x", { method: "POST", body: "{" });
    expect((await POST(bad, ctx)).status).toBe(200);
  });

  it("handles null answers/form_fields columns without capturing", async () => {
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({ application_runs: [reviewRun({ answers: null, form_fields: null })] })
    });
    const rpc = fakeRpc({});
    holder.service = fakeClient({ rpc });
    const res = await POST(post({}), ctx);
    expect(res.status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("still succeeds if the best-effort capture throws", async () => {
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({
        application_runs: [reviewRun({ answers: [{ name: "phone", label: "Phone", value: "old" }] })]
      })
    });
    const rpc = vi.fn(async () => {
      throw new Error("db down");
    });
    holder.service = fakeClient({ from: fakeFrom({ application_runs: [{ error: null }] }), rpc });
    const res = await POST(post({ answers: [{ name: "phone", label: "Phone", value: "555" }] }), ctx);
    expect(res.status).toBe(200);
  });
});
