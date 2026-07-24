import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBucket, fakeClient, fakeFrom } from "../helpers/supabase";

const holder = vi.hoisted(() => ({ server: null as unknown, service: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => holder.server)
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceClient: vi.fn(() => holder.service)
}));

import { GET } from "@/app/api/runs/[id]/screenshots/route";

const ctx = { params: Promise.resolve({ id: "run-1" }) };

beforeEach(() => {
  holder.server = null;
  holder.service = null;
});

describe("GET /api/runs/[id]/screenshots", () => {
  it("401 without a user", async () => {
    holder.server = fakeClient({ user: null });
    const res = await GET(new Request("http://x"), ctx);
    expect(res.status).toBe(401);
  });

  it("404 when the run is not found (or not owned)", async () => {
    holder.server = fakeClient({ user: { id: "u1" }, from: fakeFrom({ application_runs: [{ data: null }] }) });
    const res = await GET(new Request("http://x"), ctx);
    expect(res.status).toBe(404);
  });

  it("returns signed URLs for each screenshot path", async () => {
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({ application_runs: [{ data: { id: "run-1", screenshots: ["u1/run-1/a.png", "u1/run-1/b.png"] } }] })
    });
    holder.service = fakeClient({});
    const res = await GET(new Request("http://x"), ctx);
    const body = await res.json();
    expect(body.screenshots).toHaveLength(2);
    expect(body.screenshots[0]).toEqual({ path: "u1/run-1/a.png", url: "https://signed.example/x" });
  });

  it("treats a non-array screenshots column as empty", async () => {
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({ application_runs: [{ data: { id: "run-1", screenshots: null } }] })
    });
    holder.service = fakeClient({});
    const res = await GET(new Request("http://x"), ctx);
    expect((await res.json()).screenshots).toEqual([]);
  });

  it("skips paths whose signing fails", async () => {
    holder.server = fakeClient({
      user: { id: "u1" },
      from: fakeFrom({ application_runs: [{ data: { id: "run-1", screenshots: ["u1/run-1/a.png"] } }] })
    });
    holder.service = fakeClient({
      bucket: fakeBucket({ createSignedUrl: vi.fn(async () => ({ data: null, error: { message: "no" } })) })
    });
    const res = await GET(new Request("http://x"), ctx);
    expect((await res.json()).screenshots).toEqual([]);
  });
});
