import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, fakeFrom } from "../helpers/supabase";

const holder = vi.hoisted(() => ({ server: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => holder.server) }));

import { PATCH } from "@/app/api/applications/[id]/route";

const ctx = { params: Promise.resolve({ id: "a1" }) };
const patch = (body: unknown) =>
  new Request("http://x", { method: "PATCH", body: JSON.stringify(body) });

beforeEach(() => {
  holder.server = null;
});

describe("PATCH /api/applications/[id]", () => {
  it("401 without a user", async () => {
    holder.server = fakeClient({ user: null });
    expect((await PATCH(patch({ status: "applied" }), ctx)).status).toBe(401);
  });

  it("400 on an invalid status", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    expect((await PATCH(patch({ status: "needs_review" }), ctx)).status).toBe(400);
  });

  it("400 on an empty patch", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    expect((await PATCH(patch({}), ctx)).status).toBe(400);
  });

  it("400 when the JSON body is malformed", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    const bad = new Request("http://x", { method: "PATCH", body: "{" });
    expect((await PATCH(bad, ctx)).status).toBe(400);
  });

  it("sets applied_at when moving to applied", async () => {
    const from = fakeFrom({ applications: [{ error: null }] });
    holder.server = fakeClient({ user: { id: "u1" }, from });
    const res = await PATCH(patch({ status: "applied" }), ctx);
    expect((await res.json()).ok).toBe(true);
    const updateArg = from.mock.results[0].value.update.mock.calls[0][0];
    expect(updateArg.status).toBe("applied");
    expect(updateArg.applied_at).toBeTruthy();
  });

  it("updates notes only", async () => {
    const from = fakeFrom({ applications: [{ error: null }] });
    holder.server = fakeClient({ user: { id: "u1" }, from });
    const res = await PATCH(patch({ notes: "call back friday" }), ctx);
    expect((await res.json()).ok).toBe(true);
    expect(from.mock.results[0].value.update.mock.calls[0][0]).toEqual({ notes: "call back friday" });
  });

  it("500 when the update errors", async () => {
    holder.server = fakeClient({ user: { id: "u1" }, from: fakeFrom({ applications: [{ error: { message: "no" } }] }) });
    expect((await PATCH(patch({ status: "offer" }), ctx)).status).toBe(500);
  });
});
