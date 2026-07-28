import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, fakeFrom } from "../helpers/supabase";

const holder = vi.hoisted(() => ({ server: null as unknown }));
const submitLoginCode = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: string }));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => holder.server)
}));
vi.mock("@/lib/arm", () => ({
  submitLoginCode: (...a: unknown[]) => submitLoginCode(...(a as []))
}));

import { POST } from "@/app/api/runs/[id]/login-code/route";

const ctx = { params: Promise.resolve({ id: "run-1" }) };
const post = (body: unknown) =>
  new Request("http://x", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  holder.server = null;
  submitLoginCode.mockClear();
  submitLoginCode.mockResolvedValue({ ok: true });
});

describe("POST /api/runs/[id]/login-code", () => {
  it("401 without a user", async () => {
    holder.server = fakeClient({ user: null });
    expect((await POST(post({ code: "483920" }), ctx)).status).toBe(401);
  });

  it("400 on a too-short or unparseable code", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    expect((await POST(post({ code: "12" }), ctx)).status).toBe(400);
    const bad = new Request("http://x", { method: "POST", body: "{" });
    expect((await POST(bad, ctx)).status).toBe(400);
  });

  it("404 when the run does not exist (or is not the user's)", async () => {
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({ application_runs: [{ data: null }] })
    });
    expect((await POST(post({ code: "483920" }), ctx)).status).toBe(404);
  });

  it("409 when the run is not waiting on a code", async () => {
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({ application_runs: [{ data: { id: "run-1", status: "running" } }] })
    });
    const res = await POST(post({ code: "483920" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_awaiting_code");
    expect(submitLoginCode).not.toHaveBeenCalled();
  });

  it("forwards the code to the worker and returns ok", async () => {
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({ application_runs: [{ data: { id: "run-1", status: "needs_login_code" } }] })
    });
    const res = await POST(post({ code: "483920" }), ctx);
    expect(res.status).toBe(200);
    expect(submitLoginCode).toHaveBeenCalledWith("run-1", "483920");
  });

  it("503 when the worker will not accept the event", async () => {
    submitLoginCode.mockResolvedValue({ ok: false, reason: "arm_offline" });
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({ application_runs: [{ data: { id: "run-1", status: "needs_login_code" } }] })
    });
    expect((await POST(post({ code: "483920" }), ctx)).status).toBe(503);
  });
});
