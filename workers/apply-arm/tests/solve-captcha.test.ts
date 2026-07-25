import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

vi.mock("../src/db", () => ({
  updateRun: vi.fn(async () => {}),
  recordAiSpend: vi.fn(async () => {})
}));

import worker from "../src/index";
import { recordAiSpend } from "../src/db";

const SOLVER_SECRET = "solver-secret";
const ARM_SECRET = "arm-secret";
const PNG = btoa("fake-png-bytes");

function env(over: Partial<Env> = {}): Env {
  return {
    ARM_WORKER_SHARED_SECRET: ARM_SECRET,
    SOLVER_SHARED_SECRET: SOLVER_SECRET,
    GEMINI_API_KEY: "k",
    SUPABASE_URL: "https://db",
    ...over
  } as Env;
}

function post(body: unknown, token: string | null = SOLVER_SECRET, method = "POST") {
  return new Request("https://arm.jobarms.com/internal/solve-captcha", {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: method === "POST" ? JSON.stringify(body) : undefined
  });
}

const grid = { imageBase64: PNG, instruction: "select all crosswalks", rows: 3, cols: 3 };

/** A Gemini reply carrying the given JSON text. */
const geminiJson = (payload: unknown) => ({
  ok: true,
  json: async () => ({
    candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
  })
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("POST /internal/solve-captcha", () => {
  it("returns the tiles the model picked", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiJson({ tiles: [0, 4, 8] })));

    const res = await worker.fetch(post(grid), env());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tiles: [0, 4, 8] });
  });

  it("attributes the model spend to the run that caused it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiJson({ tiles: [1] })));

    await worker.fetch(post({ ...grid, userId: "u1", runId: "r1" }), env());

    expect(recordAiSpend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "captcha_vision", userId: "u1", runId: "r1" })
    );
  });

  it("records unattributed spend when the sidecar sent no ids", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiJson({ tiles: [] })));
    await worker.fetch(post(grid), env());
    expect(recordAiSpend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "captcha_vision", userId: null, runId: null })
    );
  });

  it("drops tile indices outside the grid it was asked about", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiJson({ tiles: [0, 9, -1, "3"] })));
    const res = await worker.fetch(post(grid), env());
    expect(await res.json()).toEqual({ tiles: [0, 3] });
  });
});

describe("its own narrowly-scoped auth", () => {
  it("401s without a bearer, or with the wrong one", async () => {
    expect((await worker.fetch(post(grid, null), env())).status).toBe(401);
    expect((await worker.fetch(post(grid, "nope"), env())).status).toBe(401);
  });

  it("401s when the solver secret is not configured", async () => {
    expect(
      (await worker.fetch(post(grid), env({ SOLVER_SHARED_SECRET: undefined }))).status
    ).toBe(401);
  });

  it("REJECTS the app-to-worker secret, so the box cannot drive runs", async () => {
    // The whole point of a separate secret: a compromised sidecar can ask for
    // tile picks and nothing else.
    expect((await worker.fetch(post(grid, ARM_SECRET), env())).status).toBe(401);
  });

  it("405s a non-POST", async () => {
    expect((await worker.fetch(post(grid, SOLVER_SECRET, "GET"), env())).status).toBe(405);
  });

  it("does not require the Workflows binding", async () => {
    // Solving is pure inference; it must work even when arms are offline.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiJson({ tiles: [2] })));
    const res = await worker.fetch(post(grid), env({ APPLY_RUN: undefined }));
    expect(res.status).toBe(200);
  });
});

describe("payload validation", () => {
  it("400s a malformed or missing body", async () => {
    const bad = new Request("https://arm.jobarms.com/internal/solve-captcha", {
      method: "POST",
      headers: { authorization: `Bearer ${SOLVER_SECRET}` },
      body: "{not json"
    });
    expect((await worker.fetch(bad, env())).status).toBe(400);
  });

  it("400s missing image, missing instruction, or an absurd grid", async () => {
    for (const body of [
      { ...grid, imageBase64: "" },
      { ...grid, instruction: "" },
      { ...grid, rows: 1 },
      { ...grid, cols: 1 },
      { ...grid, rows: 9 },
      { ...grid, cols: 9 },
      { ...grid, rows: "3" },
      { ...grid, cols: null },
      { ...grid, imageBase64: 42 },
      { ...grid, instruction: 7 }
    ]) {
      expect((await worker.fetch(post(body), env())).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("400s an image that is not decodable or absurdly large", async () => {
    expect((await worker.fetch(post({ ...grid, imageBase64: "!!!!" }), env())).status).toBe(400);
    // An empty payload is rejected by the earlier presence check.
    expect((await worker.fetch(post({ ...grid, imageBase64: btoa("") }), env())).status).toBe(400);
    // Valid base64 that decodes just past the 4MB cap.
    const huge = btoa("x".repeat(4 * 1024 * 1024 + 1));
    expect((await worker.fetch(post({ ...grid, imageBase64: huge }), env())).status).toBe(400);
  });

  it("answers with no tiles rather than failing when the model is down", async () => {
    // A model outage must never fail the run; the sidecar falls back to blocked.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "" }));
    const res = await worker.fetch(post(grid), env());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tiles: [] });
  });
});
