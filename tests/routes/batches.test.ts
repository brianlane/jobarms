import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, fakeFrom, fakeRpc } from "../helpers/supabase";

const holder = vi.hoisted(() => ({ server: null as unknown, service: null as unknown }));
const getLinkedInCredentials = vi.hoisted(() => vi.fn());
const createBatch = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => "batch-1" as string | null));
const buildAndDispatchBatch = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => ({ ok: true }) as { ok: boolean; reason?: string })
);

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => holder.server)
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceClient: vi.fn(() => holder.service)
}));
vi.mock("@/lib/linkedin", () => ({
  getLinkedInCredentials: (...a: unknown[]) => getLinkedInCredentials(...(a as []))
}));
vi.mock("@/lib/batch", () => ({
  createBatch: (...a: unknown[]) => createBatch(...(a as [])),
  buildAndDispatchBatch: (...a: unknown[]) => buildAndDispatchBatch(...(a as []))
}));

import { GET, POST } from "@/app/api/batches/route";

const post = (body: unknown) =>
  new Request("http://x/api/batches", { method: "POST", body: JSON.stringify(body) });
const goodBody = { keywords: "react engineer", location: "Denver", remote: true, count: 10 };

/** A service client for the happy path: paid plan, profile, resume, quota. */
function service(over: {
  sub?: unknown;
  profile?: unknown;
  resume?: unknown;
  granted?: unknown;
} = {}) {
  return fakeClient({
    from: fakeFrom({
      subscriptions: [{ data: over.sub === undefined ? { plan: "premium", status: "active" } : over.sub }],
      profiles: [{ data: over.profile === undefined ? { full_name: "Jane" } : over.profile }],
      resumes: [
        {
          data:
            over.resume === undefined
              ? { id: "res-1", file_name: "cv.pdf", storage_path: "u1/cv.pdf", mime_type: "application/pdf" }
              : over.resume
        }
      ]
    }),
    rpc: fakeRpc({
      try_reserve_arm_runs: [over.granted === undefined ? 10 : over.granted],
      release_arm_runs: [null, null]
    })
  });
}

beforeEach(() => {
  holder.server = fakeClient({ user: { id: "u1" } });
  holder.service = service();
  getLinkedInCredentials.mockReset();
  getLinkedInCredentials.mockResolvedValue({
    email: "me@example.com",
    password: ["fixture", "v"].join("-"),
    status: "verified"
  });
  createBatch.mockReset();
  createBatch.mockResolvedValue("batch-1");
  buildAndDispatchBatch.mockReset();
  buildAndDispatchBatch.mockResolvedValue({ ok: true });
});

describe("POST /api/batches", () => {
  it("401 without a user", async () => {
    holder.server = fakeClient({ user: null });
    expect((await POST(post(goodBody))).status).toBe(401);
  });

  it("400 on a bad body (short keywords, zero or oversized count, not JSON)", async () => {
    for (const body of [
      { ...goodBody, keywords: "x" },
      { ...goodBody, count: 0 },
      { ...goodBody, count: 26 }
    ]) {
      expect((await POST(post(body))).status).toBe(400);
    }
    const res = await POST(new Request("http://x", { method: "POST", body: "{" }));
    expect(res.status).toBe(400);
  });

  it("402 on the free plan: batches submit without a review stop", async () => {
    holder.service = service({ sub: null });
    const res = await POST(post(goodBody));
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("upgrade_required");
  });

  it("409 when LinkedIn is not connected", async () => {
    getLinkedInCredentials.mockResolvedValue(null);
    const res = await POST(post(goodBody));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("linkedin_not_connected");
  });

  it("422 when the LinkedIn account is locked", async () => {
    getLinkedInCredentials.mockResolvedValue({ email: "e", password: "p", status: "locked" });
    const res = await POST(post(goodBody));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("ats_account_locked");
  });

  it("400 when the profile is missing", async () => {
    holder.service = service({ profile: null });
    expect((await POST(post(goodBody))).status).toBe(400);
  });

  it("402 when metering grants nothing, with a plan-specific hint", async () => {
    holder.service = service({ granted: 0 });
    const res = await POST(post(goodBody));
    expect(res.status).toBe(402);
    expect((await res.json()).hint).toMatch(/200-run cap/);

    holder.service = service({ sub: { plan: "max", status: "active" }, granted: null });
    const res2 = await POST(post(goodBody));
    expect(res2.status).toBe(402);
    expect((await res2.json()).hint).toMatch(/tomorrow/);
  });

  it("caps the batch at what metering granted, not what was asked", async () => {
    holder.service = service({ granted: 3 });
    const res = await POST(post(goodBody));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ batch_id: "batch-1", reserved: 3 });
    expect(createBatch.mock.calls[0][2]).toMatchObject({ requested: 10, reserved: 3 });
    expect(buildAndDispatchBatch.mock.calls[0][1]).toMatchObject({ reserved: 3 });
  });

  it("releases the reservation and 500s when the batch row cannot be created", async () => {
    createBatch.mockResolvedValue(null);
    const res = await POST(post(goodBody));
    expect(res.status).toBe(500);
    const rpc = (holder.service as { rpc: ReturnType<typeof vi.fn> }).rpc;
    expect(rpc).toHaveBeenCalledWith("release_arm_runs", {
      p_user_id: "u1",
      p_month_key: expect.any(String),
      p_count: 10
    });
  });

  it("marks the batch failed and releases when dispatch fails, hinting by reason", async () => {
    buildAndDispatchBatch.mockResolvedValue({ ok: false, reason: "arm_offline" });
    const res = await POST(post(goodBody));
    expect(res.status).toBe(503);
    expect((await res.json()).hint).toMatch(/isn't available/);

    holder.service = service();
    buildAndDispatchBatch.mockResolvedValue({ ok: false, reason: "arm_error" });
    const res2 = await POST(post(goodBody));
    expect(res2.status).toBe(503);
    expect((await res2.json()).hint).toMatch(/couldn't start/);
  });

  it("dispatches with the vaulted credentials and a null resume when none is parsed", async () => {
    holder.service = service({ resume: null });
    const res = await POST(post(goodBody));
    expect(res.status).toBe(202);
    expect(buildAndDispatchBatch.mock.calls[0][1]).toMatchObject({
      account: { email: "me@example.com", password: ["fixture", "v"].join("-") },
      resume: null
    });
  });
});

describe("GET /api/batches", () => {
  it("401 without a user", async () => {
    holder.server = fakeClient({ user: null });
    expect((await GET()).status).toBe(401);
  });

  it("lists the user's batches under their own RLS", async () => {
    const rows = [{ id: "b1", status: "running", keywords: "react" }];
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({ apply_batches: [{ data: rows }] })
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ batches: rows });
  });

  it("returns an empty list when the read yields nothing", async () => {
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({ apply_batches: [{ data: null }] })
    });
    expect(await (await GET()).json()).toEqual({ batches: [] });
  });
});
