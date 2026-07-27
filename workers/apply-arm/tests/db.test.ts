import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendScreenshot,
  getFillTactics,
  getPlaybook,
  recordFillTactic,
  logStep,
  recordPlaybook,
  recordPlaybookFailure,
  releaseArmRunSlot,
  updateApplication,
  updateRun,
  uploadScreenshot
} from "../src/db";
import type { Env } from "../src/types";

const env = { SUPABASE_URL: "https://db.example", SUPABASE_SECRET_KEY: "svc" } as Env;
const ok = (body: unknown = {}) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
const bad = (status = 500) => ({ ok: false, status, json: async () => ({}), text: async () => "boom" });

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("db writes", () => {
  it("updateRun PATCHes the run and throws on failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);
    await updateRun(env, "r1", { status: "running" });
    expect(fetchMock.mock.calls[0][0]).toContain("/rest/v1/application_runs?id=eq.r1");
    expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bad()));
    await expect(updateRun(env, "r1", {})).rejects.toThrow(/updateRun/);
  });

  it("updateApplication PATCHes and throws on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok()));
    await updateApplication(env, "a1", { status: "applied" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bad()));
    await expect(updateApplication(env, "a1", {})).rejects.toThrow(/updateApplication/);
  });

  it("logStep posts to the append RPC and throws on failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);
    await logStep(env, "r1", "navigate", "url");
    expect(fetchMock.mock.calls[0][0]).toContain("/rpc/append_run_step");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bad()));
    await expect(logStep(env, "r1", "x")).rejects.toThrow(/logStep/);
  });

  it("uploadScreenshot returns a keyed path and throws on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok()));
    const path = await uploadScreenshot(env, "u1", "r1", "form", new Uint8Array([1]));
    expect(path).toMatch(/^u1\/r1\/\d+-form\.png$/);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bad()));
    await expect(uploadScreenshot(env, "u1", "r1", "form", new Uint8Array())).rejects.toThrow(/screenshot upload/);
  });

  it("appendScreenshot posts to the RPC and throws on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok()));
    await appendScreenshot(env, "r1", "u1/r1/x.png");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bad()));
    await expect(appendScreenshot(env, "r1", "p")).rejects.toThrow(/appendScreenshot/);
  });

  it("releaseArmRunSlot is best-effort (never throws)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    await expect(releaseArmRunSlot(env, "r1")).resolves.toBeUndefined();
  });

  it("getPlaybook returns a usable strategy, null when stale/missing/erroring", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok([{ strategy: { action: "click" }, success_count: 3, failure_count: 1 }])));
    expect(await getPlaybook(env, "d.com", "greenhouse")).toEqual({ action: "click" });

    // stale: failures exceed successes
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok([{ strategy: { action: "iframe" }, success_count: 1, failure_count: 5 }])));
    expect(await getPlaybook(env, "d.com", "greenhouse")).toBeNull();

    // no rows
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok([])));
    expect(await getPlaybook(env, "d.com", "greenhouse")).toBeNull();

    // non-2xx
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bad(404)));
    expect(await getPlaybook(env, "d.com", "greenhouse")).toBeNull();

    // throws
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net")));
    expect(await getPlaybook(env, "d.com", "greenhouse")).toBeNull();
  });

  it("defaults the service key header when SUPABASE_SECRET_KEY is unset", async () => {
    const noKey = { SUPABASE_URL: "https://db.example" } as Env;
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);
    await updateRun(noKey, "r1", {});
    await uploadScreenshot(noKey, "u1", "r1", "form", new Uint8Array([1]));
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).apikey).toBe("");
    expect((fetchMock.mock.calls[1][1].headers as Record<string, string>).authorization).toBe("Bearer ");
  });

  it("recordPlaybook + failure are best-effort", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);
    await recordPlaybook(env, "d.com", "lever", { action: "scroll" });
    await recordPlaybookFailure(env, "d.com", "lever");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // swallow rejections
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("x")));
    await expect(recordPlaybook(env, "d", "lever", { action: "scroll" })).resolves.toBeUndefined();
    await expect(recordPlaybookFailure(env, "d", "lever")).resolves.toBeUndefined();
  });
});

describe("fill tactics", () => {
  const row = (kind: string, tactic: string, ok = true) => ({
    kind,
    tactic,
    success_count: ok ? 3 : 1,
    failure_count: ok ? 0 : 9
  });

  it("returns what has worked on this site", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ok([row("choice", "label"), row("text", "set")]))
    );
    expect(await getFillTactics(env, "d.com", "greenhouse")).toEqual({
      choice: "label",
      text: "set"
    });
  });

  it("drops a tactic that keeps failing, same rule as playbooks", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok([row("choice", "label", false)])));
    expect(await getFillTactics(env, "d.com", "greenhouse")).toEqual({});
  });

  it("ignores a row it does not recognise rather than trusting it", async () => {
    // A value outside what the filler understands would otherwise be handed
    // straight to the sidecar.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ok([row("choice", "telepathy"), row("text", "telepathy")]))
    );
    expect(await getFillTactics(env, "d.com", "greenhouse")).toEqual({});
  });

  it("falls back to knowing nothing when the read fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bad(404)));
    expect(await getFillTactics(env, "d.com", "greenhouse")).toEqual({});

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net")));
    expect(await getFillTactics(env, "d.com", "greenhouse")).toEqual({});
  });

  it("records a winning tactic through the RPC", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);
    await recordFillTactic(env, "d.com", "greenhouse", "choice", "label");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/rpc/record_fill_tactic");
    expect(JSON.parse(init.body)).toEqual({
      p_domain: "d.com",
      p_ats: "greenhouse",
      p_kind: "choice",
      p_tactic: "label"
    });
  });

  it("never lets a bookkeeping write break a finished application", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net")));
    await expect(
      recordFillTactic(env, "d.com", "greenhouse", "choice", "label")
    ).resolves.toBeUndefined();
  });
});
