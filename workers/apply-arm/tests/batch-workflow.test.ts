import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BatchParams, Env } from "../src/types";

const render = vi.hoisted(() => ({
  ensureSession: vi.fn(),
  completeLoginCode: vi.fn(),
  extractForm: vi.fn(),
  fillForm: vi.fn(),
  searchJobs: vi.fn(),
  fetchResumeBase64: vi.fn(async () => null as string | null),
  decodeScreenshot: vi.fn(() => new Uint8Array([1]) as Uint8Array | null)
}));
const gemini = vi.hoisted(() => ({ generateAnswers: vi.fn(), diagnosePage: vi.fn() }));
const notify = vi.hoisted(() => ({ notifyReviewNeeded: vi.fn(async () => {}) }));
const db = vi.hoisted(() => ({
  updateRun: vi.fn(async () => {}),
  logStep: vi.fn(async () => {}),
  getPlaybook: vi.fn(async () => null as unknown),
  getFillTactics: vi.fn(async () => ({}) as Record<string, string>),
  recordFillTactic: vi.fn(async () => {}),
  recordFillTacticFailure: vi.fn(async () => {}),
  recordPlaybook: vi.fn(async () => {}),
  recordPlaybookFailure: vi.fn(async () => {}),
  uploadScreenshot: vi.fn(async (..._args: unknown[]) => "shot/path.png"),
  appendScreenshot: vi.fn(async () => {}),
  updateApplication: vi.fn(async () => {}),
  releaseArmRunSlot: vi.fn(async () => {}),
  updateBatch: vi.fn(async () => {}),
  settleBatchFailure: vi.fn(async () => true),
  upsertJob: vi.fn(async () => "job-1" as string | null),
  findApplication: vi.fn(async () => null as { id: string; status: string } | null),
  createApplication: vi.fn(async () => "app-1" as string | null),
  createRun: vi.fn(async () => "run-1" as string | null),
  releaseArmRuns: vi.fn(async () => {})
}));
vi.mock("../src/render", () => render);
vi.mock("../src/gemini", () => gemini);
vi.mock("../src/db", () => db);
vi.mock("../src/notify", () => notify);

import { applyToCard, BatchApplyWorkflow, batchPace } from "../src/workflow";
import type { JobCard } from "../src/render";

const env = { SUPABASE_URL: "https://db", RENDER_URL: "https://browser", RENDER_TOKEN: "t" } as Env;

const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (error: string, extra: Record<string, unknown> = {}) => ({
  ok: false as const,
  error,
  ...extra
});

function card(over: Partial<JobCard> = {}): JobCard {
  return {
    jobId: "123",
    url: "https://www.linkedin.com/jobs/view/123/",
    title: "Eng",
    company: "Acme",
    location: "Remote",
    ...over
  };
}

function batchParams(over: Partial<BatchParams> = {}): BatchParams {
  return {
    batchId: "b1",
    userId: "u1",
    keywords: "react engineer",
    location: "Denver",
    remote: true,
    reserved: 5,
    monthKey: "2026-07",
    profile: {},
    resume: { signedUrl: null, fileName: "r.pdf", mimeType: "application/pdf" },
    account: { email: "me@example.com", password: ["fixture", "v"].join("-") },
    ...over
  };
}

/** Mock WorkflowStep with sleep support (batches pace between applications). */
function makeStep(waitForEvent: (opts: { type: string }, name: string) => Promise<unknown>) {
  const doNames: string[] = [];
  const sleeps: string[] = [];
  return {
    doNames,
    sleeps,
    do: vi.fn(async (name: string, optsOrFn: unknown, maybeFn?: unknown) => {
      doNames.push(name);
      const fn = (typeof optsOrFn === "function" ? optsOrFn : maybeFn) as () => Promise<unknown>;
      return fn();
    }),
    sleep: vi.fn(async (name: string) => {
      sleeps.push(name);
    }),
    waitForEvent: vi.fn(async (name: string, opts: { type: string }) => waitForEvent(opts, name))
  };
}

let lastStep: ReturnType<typeof makeStep>;

function run(
  p: BatchParams,
  waitForEvent: (opts: { type: string }, name: string) => Promise<unknown> = async () => ({
    payload: { code: "112233" }
  })
) {
  const wf = new BatchApplyWorkflow({} as never, env);
  lastStep = makeStep(waitForEvent);
  return wf.run({ payload: p } as never, lastStep as never);
}

beforeEach(() => {
  // reset (not clear): several tests install PERSISTENT rejections to prove
  // best-effort bookkeeping cannot sink a card, and those must not leak.
  vi.resetAllMocks();
  render.decodeScreenshot.mockReturnValue(new Uint8Array([1]));
  render.fetchResumeBase64.mockResolvedValue(null);
  render.ensureSession.mockResolvedValue(ok({ status: "authenticated", screenshotBase64: "AA==" }));
  render.completeLoginCode.mockResolvedValue(ok({ status: "authenticated" }));
  render.searchJobs.mockResolvedValue(ok({ cards: [card()] }));
  render.extractForm.mockResolvedValue(
    ok({
      fields: [{ name: "email", label: "Email", type: "email", required: true, options: [] }],
      pages: 1,
      scope: "form",
      recovery: null,
      playbookFailed: false,
      screenshotBase64: "AA=="
    })
  );
  render.fillForm.mockResolvedValue(ok({ outcome: "submitted", pages: 1, screenshotBase64: "AA==" }));
  gemini.generateAnswers.mockResolvedValue([{ name: "email", label: "Email", value: "a@b.com" }]);
  db.uploadScreenshot.mockResolvedValue("shot/path.png");
  db.getPlaybook.mockResolvedValue(null);
  db.upsertJob.mockResolvedValue("job-1");
  db.findApplication.mockResolvedValue(null);
  db.createApplication.mockResolvedValue("app-1");
  db.createRun.mockResolvedValue("run-1");
  db.settleBatchFailure.mockResolvedValue(true);
});

describe("batchPace", () => {
  it("stays inside the 30-90 second window", () => {
    for (let i = 0; i < 50; i++) {
      const ms = batchPace();
      expect(ms).toBeGreaterThanOrEqual(30_000);
      expect(ms).toBeLessThanOrEqual(90_000);
    }
  });
});

describe("applyToCard", () => {
  it("applies end to end: rows created, filled with submit, marked applied", async () => {
    const outcome = await applyToCard(env, batchParams(), card());

    expect(outcome).toBe("applied");
    expect(db.createRun).toHaveBeenCalledWith(env, {
      applicationId: "app-1",
      userId: "u1",
      monthKey: "2026-07",
      batchId: "b1",
      tenantHost: "www.linkedin.com"
    });
    expect(render.fillForm.mock.calls[0][1]).toMatchObject({ submit: true, ats: "linkedin" });
    expect(db.updateRun).toHaveBeenCalledWith(env, "run-1", { status: "submitted", error: null });
    expect(db.updateApplication).toHaveBeenCalledWith(
      env,
      "app-1",
      expect.objectContaining({ status: "applied" })
    );
  });

  it("system-fails when the job row cannot be ensured (including a throw)", async () => {
    db.upsertJob.mockRejectedValueOnce(new Error("db down"));
    expect(await applyToCard(env, batchParams(), card())).toBe("system_failed");

    db.upsertJob.mockResolvedValueOnce(null);
    expect(await applyToCard(env, batchParams(), card())).toBe("system_failed");
  });

  it("skips a job the user already has a live application for", async () => {
    db.findApplication.mockResolvedValueOnce({ id: "app-9", status: "applied" });
    expect(await applyToCard(env, batchParams(), card())).toBe("skipped");
    expect(db.createRun).not.toHaveBeenCalled();
  });

  it("reuses a saved application row instead of creating a second one", async () => {
    db.findApplication.mockResolvedValueOnce({ id: "app-9", status: "saved" });
    const outcome = await applyToCard(env, batchParams(), card());
    expect(outcome).toBe("applied");
    expect(db.createApplication).not.toHaveBeenCalled();
    expect(db.createRun).toHaveBeenCalledWith(env, expect.objectContaining({ applicationId: "app-9" }));
  });

  it("survives a dedup-lookup failure and proceeds as a fresh application", async () => {
    db.findApplication.mockRejectedValueOnce(new Error("read failed"));
    expect(await applyToCard(env, batchParams(), card())).toBe("applied");
  });

  it("system-fails when the application or run row cannot be created", async () => {
    db.createApplication.mockRejectedValueOnce(new Error("insert failed"));
    expect(await applyToCard(env, batchParams(), card())).toBe("system_failed");

    db.createRun.mockRejectedValueOnce(new Error("insert failed"));
    expect(await applyToCard(env, batchParams(), card())).toBe("system_failed");
  });

  it("passes the user's memory through to answer generation when present", async () => {
    const memory = { answers: [{ label: "L", answer: "A", source: "user" }], lessons: ["x"] };
    await applyToCard(env, batchParams({ memory }), card());
    expect(gemini.generateAnswers.mock.calls[0][1]).toMatchObject({ memory });
  });

  it("counts a captcha wall as work done (slot consumed, job failed)", async () => {
    render.fillForm.mockResolvedValue(
      ok({ outcome: "captcha_blocked", pages: 1, screenshotBase64: "AA==" })
    );
    const outcome = await applyToCard(env, batchParams(), card());
    expect(outcome).toBe("work_done_failed");
    expect(db.updateRun).toHaveBeenCalledWith(
      env,
      "run-1",
      expect.objectContaining({ status: "failed", error: expect.stringContaining("captcha_blocked") })
    );
  });

  it("counts a read-back refusal as work done and names the fields", async () => {
    render.fillForm.mockResolvedValue(
      ok({
        outcome: "verification_failed",
        pages: 1,
        screenshotBase64: "AA==",
        mismatches: [{ name: "q1", label: "Years", expected: "5", actual: "" }]
      })
    );
    const outcome = await applyToCard(env, batchParams(), card());
    expect(outcome).toBe("work_done_failed");
    expect(db.updateRun).toHaveBeenCalledWith(
      env,
      "run-1",
      expect.objectContaining({
        error: expect.stringContaining("Years"),
        fill_mismatches: [expect.objectContaining({ name: "q1" })]
      })
    );
  });

  it("counts an unconfirmed submit as work done", async () => {
    render.fillForm.mockResolvedValue(ok({ outcome: "filled", pages: 1, screenshotBase64: "AA==" }));
    expect(await applyToCard(env, batchParams(), card())).toBe("work_done_failed");
  });

  it("tolerates a verification refusal that reports no mismatch details", async () => {
    render.fillForm.mockResolvedValue(
      ok({ outcome: "verification_failed", pages: 1, screenshotBase64: "AA==" })
    );
    expect(await applyToCard(env, batchParams(), card())).toBe("work_done_failed");
    expect(db.updateRun).toHaveBeenCalledWith(
      env,
      "run-1",
      expect.objectContaining({ fill_mismatches: [] })
    );
  });

  it("stringifies a non-Error failure into the run record", async () => {
    db.updateRun.mockRejectedValueOnce("weird string failure");
    expect(await applyToCard(env, batchParams(), card())).toBe("system_failed");
    expect(db.updateRun).toHaveBeenCalledWith(
      env,
      "run-1",
      expect.objectContaining({ status: "failed", error: "weird string failure" })
    );
  });

  it("system-fails when the sidecar fill dies, keeping the failure screenshot", async () => {
    render.fillForm.mockResolvedValue(fail("render_failed", { screenshotBase64: "AA==" }));
    // The failure screenshot is best-effort too: storage being down must not
    // change the outcome.
    db.uploadScreenshot.mockRejectedValue(new Error("storage down"));
    const outcome = await applyToCard(env, batchParams(), card());
    expect(outcome).toBe("system_failed");
    expect(db.updateRun).toHaveBeenCalledWith(
      env,
      "run-1",
      expect.objectContaining({ status: "failed", error: expect.stringContaining("render_failed") })
    );
  });

  it("system-fails when the form is unreachable, and the batch bookkeeping cannot mask it", async () => {
    render.extractForm.mockResolvedValue(fail("form_not_found", { screenshotBase64: null }));
    render.decodeScreenshot.mockReturnValue(null);
    // Even the failure bookkeeping writes dying must not throw out of the card.
    db.updateRun.mockRejectedValue(new Error("db down"));
    db.updateApplication.mockRejectedValue(new Error("db down"));
    expect(await applyToCard(env, batchParams(), card())).toBe("system_failed");
  });

  it("shrugs off best-effort bookkeeping failures on a successful application", async () => {
    db.uploadScreenshot.mockRejectedValue(new Error("storage down"));
    db.recordFillTactic.mockRejectedValueOnce(new Error("rpc down"));
    render.fillForm.mockResolvedValue(
      ok({
        outcome: "submitted",
        pages: 1,
        screenshotBase64: "AA==",
        tactics: [{ kind: "choice", tactic: "label" }]
      })
    );
    expect(await applyToCard(env, batchParams(), card())).toBe("applied");
  });
});

describe("BatchApplyWorkflow", () => {
  it("searches, applies to every card with pacing, and settles the meter", async () => {
    render.searchJobs.mockResolvedValue(
      ok({ cards: [card(), card({ jobId: "456", url: "https://www.linkedin.com/jobs/view/456/" })] })
    );
    // First card submits; second dies at the captcha wall.
    render.fillForm
      .mockResolvedValueOnce(ok({ outcome: "submitted", pages: 1, screenshotBase64: "AA==" }))
      .mockResolvedValueOnce(ok({ outcome: "captcha_blocked", pages: 1, screenshotBase64: "AA==" }));

    await run(batchParams({ reserved: 5 }));

    expect(render.searchJobs).toHaveBeenCalledWith(env, {
      userId: "u1",
      keywords: "react engineer",
      location: "Denver",
      remote: true,
      limit: 5
    });
    // Each card was pre-charged before it was driven, so a cancel racing an
    // in-flight application can never release a slot whose work happened.
    expect(db.updateBatch).toHaveBeenCalledWith(env, "b1", { consumed: 1 });
    expect(db.updateBatch).toHaveBeenCalledWith(env, "b1", { consumed: 2 });
    // Both consumed a slot (real work), so 3 of the 5 reserved go back.
    expect(db.releaseArmRuns).toHaveBeenCalledWith(env, "u1", "2026-07", 3);
    expect(db.updateBatch).toHaveBeenCalledWith(env, "b1", {
      status: "completed",
      processed: 2,
      applied: 1,
      failed: 1,
      consumed: 2
    });
    // Paced BETWEEN applications only: one sleep for two cards.
    expect(lastStep.sleeps).toEqual(["batch pace 0"]);
  });

  it("keeps going past skips and system failures, releasing their slots", async () => {
    render.searchJobs.mockResolvedValue(
      ok({ cards: [card(), card({ jobId: "456" }), card({ jobId: "789" })] })
    );
    db.findApplication
      .mockResolvedValueOnce({ id: "app-9", status: "applied" }) // card 0: skip
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    db.createRun
      .mockResolvedValueOnce(null) // card 1: system failure
      .mockResolvedValueOnce("run-3"); // card 2: applies

    await run(batchParams({ reserved: 3 }));

    // Only the one real application consumed a slot.
    expect(db.releaseArmRuns).toHaveBeenCalledWith(env, "u1", "2026-07", 2);
    expect(db.updateBatch).toHaveBeenCalledWith(env, "b1", {
      status: "completed",
      processed: 2,
      applied: 1,
      failed: 1,
      consumed: 1
    });
  });

  it("parks on a LinkedIn PIN, then resumes once the code is accepted", async () => {
    render.ensureSession.mockResolvedValue(
      ok({ status: "needs_login_code", checkpointUrl: "https://www.linkedin.com/checkpoint/1" })
    );

    await run(batchParams());

    expect(db.updateBatch).toHaveBeenCalledWith(env, "b1", { status: "needs_login_code" });
    expect(render.completeLoginCode).toHaveBeenCalledWith(env, {
      userId: "u1",
      tenantHost: "www.linkedin.com",
      code: "112233",
      checkpointUrl: "https://www.linkedin.com/checkpoint/1"
    });
    expect(db.updateBatch).toHaveBeenCalledWith(env, "b1", { status: "completed", processed: 1, applied: 1, failed: 0, consumed: 1 });
  });

  it("re-parks on a rejected code and resumes at the freshest checkpoint", async () => {
    render.ensureSession.mockResolvedValue(ok({ status: "needs_login_code" }));
    render.completeLoginCode
      .mockResolvedValueOnce(
        ok({ status: "needs_login_code", checkpointUrl: "https://www.linkedin.com/checkpoint/2" })
      )
      .mockResolvedValueOnce(ok({ status: "authenticated" }));

    await run(batchParams());

    // First attempt had no checkpoint URL (the ensure reply omitted it); the
    // second rides the one the rejection returned.
    expect(render.completeLoginCode.mock.calls[0][1]).not.toHaveProperty("checkpointUrl");
    expect(render.completeLoginCode.mock.calls[1][1]).toMatchObject({
      checkpointUrl: "https://www.linkedin.com/checkpoint/2"
    });
  });

  it("keeps the prior checkpoint when a rejection does not return a fresh one", async () => {
    render.ensureSession.mockResolvedValue(
      ok({ status: "needs_login_code", checkpointUrl: "https://www.linkedin.com/checkpoint/1" })
    );
    render.completeLoginCode
      .mockResolvedValueOnce(ok({ status: "needs_login_code" }))
      .mockResolvedValueOnce(ok({ status: "authenticated" }));

    await run(batchParams());

    expect(render.completeLoginCode.mock.calls[1][1]).toMatchObject({
      checkpointUrl: "https://www.linkedin.com/checkpoint/1"
    });
  });

  it("tolerates a code event without a payload", async () => {
    render.ensureSession.mockResolvedValue(ok({ status: "needs_login_code" }));

    await run(batchParams(), async () => ({}));

    expect(render.completeLoginCode.mock.calls[0][1]).toMatchObject({ code: "" });
  });

  it("fails the batch when LinkedIn rejects the sign-in outright", async () => {
    render.ensureSession.mockResolvedValue(ok({ status: "login_failed" }));
    await expect(run(batchParams())).rejects.toThrow(/ats_login_failed/);
    expect(db.settleBatchFailure).toHaveBeenCalledWith(
      env,
      "b1",
      expect.objectContaining({ error: expect.stringContaining("ats_login_failed") })
    );
    // Nothing was consumed, so everything reserved goes back.
    expect(db.releaseArmRuns).toHaveBeenCalledWith(env, "u1", "2026-07", 5);
  });

  it("leaves the release to the app when a cancel already settled the batch", async () => {
    render.ensureSession.mockResolvedValue(ok({ status: "login_failed" }));
    // The guarded write found the batch already canceled: the app's cancel
    // route released the unspent slots, so releasing here would double-credit.
    db.settleBatchFailure.mockResolvedValue(false);
    await expect(run(batchParams())).rejects.toThrow(/ats_login_failed/);
    expect(db.releaseArmRuns).not.toHaveBeenCalled();
  });

  it("fails the batch when the code is still rejected on the last attempt", async () => {
    render.ensureSession.mockResolvedValue(ok({ status: "needs_login_code" }));
    render.completeLoginCode.mockResolvedValue(ok({ status: "needs_login_code" }));

    await expect(run(batchParams())).rejects.toThrow(/ats_login_failed/);
    // Attempts are bounded: 3 submissions, then it gives up.
    expect(render.completeLoginCode).toHaveBeenCalledTimes(3);
  });

  it("fails the batch when the login-code wait times out", async () => {
    render.ensureSession.mockResolvedValue(ok({ status: "needs_login_code" }));
    await expect(
      run(batchParams(), async () => {
        throw new Error("timeout");
      })
    ).rejects.toThrow(/login_code_timeout/);
  });

  it("fails the batch when the code submission itself dies", async () => {
    render.ensureSession.mockResolvedValue(ok({ status: "needs_login_code" }));
    render.completeLoginCode.mockResolvedValue(fail("render_unreachable"));
    await expect(run(batchParams())).rejects.toThrow(/render_unreachable/);
  });

  it("fails the batch when the session cannot be established", async () => {
    render.ensureSession.mockResolvedValue(fail("render_unreachable", { detail: "down" }));
    await expect(run(batchParams())).rejects.toThrow(/render_unreachable/);
  });

  it("fails the batch when the search dies", async () => {
    render.searchJobs.mockResolvedValue(fail("render_failed"));
    await expect(run(batchParams())).rejects.toThrow(/render_failed/);
    expect(db.updateBatch).toHaveBeenCalledWith(env, "b1", { status: "searching" });
  });

  it("still dies with the ORIGINAL error when the failure bookkeeping also fails", async () => {
    render.ensureSession.mockResolvedValue(fail("render_unreachable"));
    db.settleBatchFailure.mockRejectedValue(new Error("db down"));
    await expect(run(batchParams())).rejects.toThrow(/render_unreachable/);
    expect(db.releaseArmRuns).not.toHaveBeenCalled();
  });

  it("handles a search that finds nothing: no applications, everything released", async () => {
    render.searchJobs.mockResolvedValue(ok({ cards: [] }));

    await run(batchParams({ reserved: 4 }));

    expect(render.fillForm).not.toHaveBeenCalled();
    expect(db.releaseArmRuns).toHaveBeenCalledWith(env, "u1", "2026-07", 4);
    expect(db.updateBatch).toHaveBeenCalledWith(env, "b1", {
      status: "completed",
      processed: 0,
      applied: 0,
      failed: 0,
      consumed: 0
    });
  });

  it("wraps a non-Error failure into the terminal record", async () => {
    render.ensureSession.mockRejectedValue("string failure");
    await expect(run(batchParams())).rejects.toBe("string failure");
    expect(db.settleBatchFailure).toHaveBeenCalledWith(
      env,
      "b1",
      expect.objectContaining({ error: "string failure" })
    );
  });
});
