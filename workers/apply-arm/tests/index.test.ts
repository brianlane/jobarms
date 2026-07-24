import { beforeEach, describe, expect, it, vi } from "vitest";

const updateRun = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../src/db", () => ({ updateRun }));

import worker from "../src/index";
import type { Env } from "../src/types";

const SECRET = "shared-secret";
const RUN_ID = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    ARM_WORKER_SHARED_SECRET: SECRET,
    APPLY_RUN: {
      create: vi.fn(async () => ({ id: "inst-1" })),
      get: vi.fn(async () => ({ sendEvent: vi.fn(async () => {}), terminate: vi.fn(async () => {}) }))
    },
    BROWSER: {},
    SUPABASE_URL: "https://db",
    SUPABASE_SECRET_KEY: "svc",
    ...over
  } as unknown as Env;
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`https://arm.example${path}`, init);
}
const auth = { authorization: `Bearer ${SECRET}` };

beforeEach(() => updateRun.mockClear());

describe("apply-arm HTTP surface", () => {
  it("GET /health is unauthenticated and reports arm readiness", async () => {
    const res = await worker.fetch(req("/health"), makeEnv());
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, service: "jobarms-apply-arm", arms: true });
  });

  it("rejects a missing/invalid bearer with 401", async () => {
    expect((await worker.fetch(req("/runs", { method: "POST" }), makeEnv())).status).toBe(401);
    expect(
      (await worker.fetch(req("/runs", { method: "POST", headers: { authorization: "Bearer nope" } }), makeEnv())).status
    ).toBe(401);
  });

  it("405 for a non-POST authorized request", async () => {
    expect((await worker.fetch(req("/runs", { headers: auth }), makeEnv())).status).toBe(405);
  });

  it("503 when the Workflows binding is missing", async () => {
    const res = await worker.fetch(req("/runs", { method: "POST", headers: auth }), makeEnv({ APPLY_RUN: undefined }));
    expect(res.status).toBe(503);
  });

  it("POST /runs starts a workflow instance", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      req("/runs", { method: "POST", headers: auth, body: JSON.stringify({ runId: RUN_ID, jobUrl: "https://x", ats: "lever" }) }),
      env
    );
    expect(res.status).toBe(202);
    expect((await res.json()).instance_id).toBe("inst-1");
  });

  it("POST /runs with an invalid body is 400", async () => {
    const res = await worker.fetch(req("/runs", { method: "POST", headers: auth, body: "{" }), makeEnv());
    expect(res.status).toBe(400);
  });

  it("POST /runs/:id/approve tolerates a malformed body (treats as no edits)", async () => {
    const sendEvent = vi.fn(async () => {});
    const env = makeEnv();
    (env.APPLY_RUN!.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sendEvent, terminate: vi.fn() });
    const res = await worker.fetch(req(`/runs/${RUN_ID}/approve`, { method: "POST", headers: auth, body: "{not json" }), env);
    expect(res.status).toBe(200);
    expect(sendEvent).toHaveBeenCalledWith({ type: "approval", payload: { answers: undefined } });
  });

  it("POST /runs/:id/approve forwards the approval event", async () => {
    const sendEvent = vi.fn(async () => {});
    const env = makeEnv();
    (env.APPLY_RUN!.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sendEvent, terminate: vi.fn() });
    const res = await worker.fetch(
      req(`/runs/${RUN_ID}/approve`, { method: "POST", headers: auth, body: JSON.stringify({ answers: [] }) }),
      env
    );
    expect(res.status).toBe(200);
    expect(sendEvent).toHaveBeenCalledWith({ type: "approval", payload: { answers: [] } });
  });

  it("POST /runs/:id/cancel terminates and marks canceled", async () => {
    const terminate = vi.fn(async () => {});
    const env = makeEnv();
    (env.APPLY_RUN!.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sendEvent: vi.fn(), terminate });
    const res = await worker.fetch(req(`/runs/${RUN_ID}/cancel`, { method: "POST", headers: auth }), env);
    expect(res.status).toBe(200);
    expect(terminate).toHaveBeenCalled();
    expect(updateRun).toHaveBeenCalledWith(env, RUN_ID, { status: "canceled" });
  });

  it("404 when the workflow instance is not found", async () => {
    const env = makeEnv();
    (env.APPLY_RUN!.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gone"));
    const res = await worker.fetch(req(`/runs/${RUN_ID}/approve`, { method: "POST", headers: auth, body: "{}" }), env);
    expect(res.status).toBe(404);
  });

  it("404 for an unknown authorized path", async () => {
    expect((await worker.fetch(req("/nope", { method: "POST", headers: auth }), makeEnv())).status).toBe(404);
  });

  it("treats a missing secret env as unauthorized", async () => {
    const res = await worker.fetch(req("/runs", { method: "POST", headers: auth }), makeEnv({ ARM_WORKER_SHARED_SECRET: undefined }));
    expect(res.status).toBe(401);
  });

  it("rejects a token longer than the secret (constant-time compare)", async () => {
    const res = await worker.fetch(
      req("/runs", { method: "POST", headers: { authorization: `Bearer ${SECRET}-and-then-some-extra` } }),
      makeEnv()
    );
    expect(res.status).toBe(401);
  });
});
