import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendScreenshot,
  claimBatch,
  createApplication,
  createRun,
  findApplication,
  getFillTactics,
  getPlaybook,
  markBatchCanceled,
  settleBatchFailure,
  recordFillTactic,
  recordFillTacticFailure,
  logStep,
  recordPlaybook,
  recordPlaybookFailure,
  releaseArmRuns,
  releaseArmRunSlot,
  updateApplication,
  updateBatch,
  updateRun,
  uploadScreenshot,
  upsertJob
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

  it("counts a failure through its own RPC", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);
    await recordFillTacticFailure(env, "d.com", "greenhouse", "choice");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/rpc/record_fill_tactic_failure");
    expect(JSON.parse(init.body)).toEqual({
      p_domain: "d.com",
      p_ats: "greenhouse",
      p_kind: "choice"
    });
  });

  it("never lets a bookkeeping write break a finished application", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net")));
    await expect(
      recordFillTactic(env, "d.com", "greenhouse", "choice", "label")
    ).resolves.toBeUndefined();
    await expect(
      recordFillTacticFailure(env, "d.com", "greenhouse", "choice")
    ).resolves.toBeUndefined();
  });
});

describe("batch db helpers", () => {
  it("updateBatch PATCHes the batch and throws on failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);
    await updateBatch(env, "b1", { status: "running" });
    expect(fetchMock.mock.calls[0][0]).toContain("/rest/v1/apply_batches?id=eq.b1");
    expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bad()));
    await expect(updateBatch(env, "b1", {})).rejects.toThrow(/updateBatch/);
  });

  it("claimBatch wins queued/running rows only, reporting whether it landed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok([{ id: "b1" }]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await claimBatch(env, "b1")).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toContain("status=in.(queued,running)");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ status: "running" });

    // The app already gave up (row is failed): the claim loses.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok([])));
    expect(await claimBatch(env, "b1")).toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bad()));
    await expect(claimBatch(env, "b1")).rejects.toThrow(/claimBatch/);
  });

  it("settleBatchFailure flips live states only, reporting whether it landed", async () => {
    // A live batch: the guarded PATCH matches and returns the updated row.
    const fetchMock = vi.fn().mockResolvedValue(ok([{ id: "b1" }]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await settleBatchFailure(env, "b1", { error: "boom", consumed: 2 })).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toContain(
      "status=in.(queued,searching,running,needs_login_code)"
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      status: "failed",
      error: "boom"
    });

    // Already canceled/completed: nothing matched, so the failure did NOT land.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok([])));
    expect(await settleBatchFailure(env, "b1", {})).toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bad()));
    await expect(settleBatchFailure(env, "b1", {})).rejects.toThrow(/settleBatchFailure/);
  });

  it("markBatchCanceled only targets live states, and throws on failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);
    await markBatchCanceled(env, "b1");
    expect(fetchMock.mock.calls[0][0]).toContain(
      "status=in.(queued,searching,running,needs_login_code)"
    );

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bad()));
    await expect(markBatchCanceled(env, "b1")).rejects.toThrow(/markBatchCanceled/);
  });

  it("upsertJob inserts with ignore-duplicates, then reads back the winner's id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok()) // insert
      .mockResolvedValueOnce(ok([{ id: "job-1" }])); // read-back
    vi.stubGlobal("fetch", fetchMock);

    const id = await upsertJob(env, {
      url: "https://www.linkedin.com/jobs/view/123/",
      ats: "linkedin",
      company: "Acme",
      title: "Eng",
      location: "Remote"
    });

    expect(id).toBe("job-1");
    expect(fetchMock.mock.calls[0][0]).toContain("/rest/v1/jobs?on_conflict=url");
    expect(fetchMock.mock.calls[0][1].headers.Prefer).toBe("resolution=ignore-duplicates");
  });

  it("upsertJob survives an insert failure (conflict) and still resolves the id", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new Error("conflict"))
        .mockResolvedValueOnce(ok([{ id: "job-2" }]))
    );
    expect(
      await upsertJob(env, { url: "u", ats: "linkedin", company: "", title: "", location: "" })
    ).toBe("job-2");
  });

  it("upsertJob is null when the read-back fails or finds nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce(bad()));
    expect(
      await upsertJob(env, { url: "u", ats: "linkedin", company: "", title: "", location: "" })
    ).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok([])));
    expect(
      await upsertJob(env, { url: "u", ats: "linkedin", company: "", title: "", location: "" })
    ).toBeNull();
  });

  it("findApplication returns the user's row, null when absent or unreadable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok([{ id: "a1", status: "applied" }])));
    expect(await findApplication(env, "u1", "j1")).toEqual({ id: "a1", status: "applied" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok([])));
    expect(await findApplication(env, "u1", "j1")).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bad()));
    expect(await findApplication(env, "u1", "j1")).toBeNull();
  });

  it("createApplication returns the new id, null on failure or an empty reply", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok([{ id: "a1" }]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await createApplication(env, "u1", "j1")).toBe("a1");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      user_id: "u1",
      job_id: "j1",
      source: "arm"
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bad()));
    expect(await createApplication(env, "u1", "j1")).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok([])));
    expect(await createApplication(env, "u1", "j1")).toBeNull();
  });

  it("createRun returns the new id (full-auto, batch-tagged), null on failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok([{ id: "r1" }]));
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await createRun(env, {
        applicationId: "a1",
        userId: "u1",
        monthKey: "2026-07",
        batchId: "b1",
        tenantHost: "www.linkedin.com"
      })
    ).toBe("r1");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      autonomy: "full_auto",
      batch_id: "b1",
      status: "running"
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bad()));
    expect(
      await createRun(env, {
        applicationId: "a1",
        userId: "u1",
        monthKey: "2026-07",
        batchId: "b1",
        tenantHost: "www.linkedin.com"
      })
    ).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok([])));
    expect(
      await createRun(env, {
        applicationId: "a1",
        userId: "u1",
        monthKey: "2026-07",
        batchId: "b1",
        tenantHost: "www.linkedin.com"
      })
    ).toBeNull();
  });

  it("releaseArmRuns posts the count, skips zero, and never throws", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);
    await releaseArmRuns(env, "u1", "2026-07", 3);
    expect(fetchMock.mock.calls[0][0]).toContain("/rpc/release_arm_runs");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      p_user_id: "u1",
      p_month_key: "2026-07",
      p_count: 3
    });

    fetchMock.mockClear();
    await releaseArmRuns(env, "u1", "2026-07", 0);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    await expect(releaseArmRuns(env, "u1", "2026-07", 2)).resolves.toBeUndefined();
  });
});
