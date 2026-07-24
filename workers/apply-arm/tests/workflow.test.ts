import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, RunParams } from "../src/types";

const browser = vi.hoisted(() => {
  class FormNotFoundError extends Error {}
  return { FormNotFoundError, extractForm: vi.fn(), fillAndMaybeSubmit: vi.fn() };
});
const gemini = vi.hoisted(() => ({ generateAnswers: vi.fn() }));
const db = vi.hoisted(() => ({
  updateRun: vi.fn(async () => {}),
  logStep: vi.fn(async () => {}),
  recordPlaybook: vi.fn(async () => {}),
  uploadScreenshot: vi.fn(async (..._args: unknown[]) => "shot/path.png"),
  appendScreenshot: vi.fn(async () => {}),
  updateApplication: vi.fn(async () => {}),
  releaseArmRunSlot: vi.fn(async () => {})
}));
vi.mock("../src/browser", () => browser);
vi.mock("../src/gemini", () => gemini);
vi.mock("../src/db", () => db);

import { ApplyRunWorkflow } from "../src/workflow";

const env = { SUPABASE_URL: "https://db" } as Env;

/** Mock WorkflowStep: runs each step body immediately; waitForEvent is set per test. */
function makeStep(waitForEvent: () => Promise<unknown>) {
  return {
    do: vi.fn(async (_name: string, optsOrFn: unknown, maybeFn?: unknown) => {
      const fn = (typeof optsOrFn === "function" ? optsOrFn : maybeFn) as () => Promise<unknown>;
      return fn();
    }),
    waitForEvent: vi.fn(waitForEvent)
  };
}

function params(over: Partial<RunParams> = {}): RunParams {
  return {
    runId: "r1",
    applicationId: "a1",
    userId: "u1",
    jobUrl: "https://x",
    ats: "lever",
    autonomy: "full_auto",
    jobTitle: "Eng",
    jobCompany: "Acme",
    jobDescription: "d",
    profile: {},
    resume: { signedUrl: null, fileName: "r.pdf", mimeType: "application/pdf" },
    ...over
  } as RunParams;
}

function run(p: RunParams, waitForEvent: () => Promise<unknown> = async () => ({ payload: {} })) {
  const wf = new ApplyRunWorkflow({} as never, env);
  return wf.run({ payload: p }, makeStep(waitForEvent) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  browser.extractForm.mockResolvedValue({ fields: [{ name: "email" }], screenshot: new Uint8Array(), recovery: null });
  gemini.generateAnswers.mockResolvedValue([{ name: "email", label: "Email", value: "a@b.com" }]);
  browser.fillAndMaybeSubmit.mockResolvedValue({ outcome: "submitted", screenshot: new Uint8Array() });
  db.uploadScreenshot.mockResolvedValue("shot/path.png");
});

describe("ApplyRunWorkflow", () => {
  it("full-auto: extract, answer, submit, finalize submitted", async () => {
    await run(params({ autonomy: "full_auto" }));
    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", { status: "submitted", error: null });
    expect(db.updateApplication).toHaveBeenCalledWith(env, "a1", { status: "applied", applied_at: expect.any(String) });
    expect(db.logStep).toHaveBeenCalledWith(env, "r1", "submitted", "confirmation detected");
  });

  it("records a vision recovery playbook", async () => {
    browser.extractForm.mockResolvedValueOnce({
      fields: [{ name: "email" }],
      screenshot: new Uint8Array(),
      recovery: { source: "vision", strategy: { action: "scroll" }, domain: "d.com" }
    });
    await run(params({ autonomy: "full_auto" }));
    expect(db.recordPlaybook).toHaveBeenCalledWith(env, "d.com", "lever", { action: "scroll" });
    expect(db.logStep).toHaveBeenCalledWith(env, "r1", "recovery_vision", "scroll");
  });

  it("records a playbook recovery", async () => {
    browser.extractForm.mockResolvedValueOnce({
      fields: [{ name: "email" }],
      screenshot: new Uint8Array(),
      recovery: { source: "playbook", strategy: { action: "click" }, domain: "d.com" }
    });
    await run(params({ autonomy: "full_auto" }));
    expect(db.logStep).toHaveBeenCalledWith(env, "r1", "recovery_playbook", "click");
  });

  it("review gate: waits, applies edited answers, then submits", async () => {
    await run(params({ autonomy: "review_gate" }), async () => ({ payload: { answers: [{ name: "email", label: "E", value: "edited" }] } }));
    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", { status: "needs_review", error: null });
    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", { status: "approved", answers: [{ name: "email", label: "E", value: "edited" }] });
  });

  it("review gate: keeps generated answers when approval carries none", async () => {
    await run(params({ autonomy: "review_gate" }), async () => ({ payload: {} }));
    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", { status: "approved", answers: [{ name: "email", label: "Email", value: "a@b.com" }] });
  });

  it("review gate timeout: marks canceled and stops (no submit)", async () => {
    await run(params({ autonomy: "review_gate" }), async () => {
      throw new Error("timeout");
    });
    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", {
      status: "canceled",
      error: "review_timeout: the review gate expired after 7 days"
    });
    expect(browser.fillAndMaybeSubmit).toHaveBeenCalledTimes(1); // only the review fill, never the submit
  });

  it("finalize captcha_blocked consumes the run", async () => {
    browser.fillAndMaybeSubmit.mockResolvedValue({ outcome: "captcha_blocked", screenshot: new Uint8Array() });
    await run(params({ autonomy: "full_auto" }));
    expect(db.logStep).toHaveBeenCalledWith(env, "r1", "captcha_blocked");
    expect(db.releaseArmRunSlot).not.toHaveBeenCalled();
  });

  it("finalize unconfirmed consumes the run", async () => {
    browser.fillAndMaybeSubmit.mockResolvedValue({ outcome: "unconfirmed", screenshot: new Uint8Array() });
    await run(params({ autonomy: "full_auto" }));
    expect(db.logStep).toHaveBeenCalledWith(env, "r1", "submit_unconfirmed");
  });

  it("form_not_found is non-retryable and refunds via the outer catch", async () => {
    browser.extractForm.mockRejectedValueOnce(new browser.FormNotFoundError("form_not_found: nothing"));
    await expect(run(params({ autonomy: "full_auto" }))).rejects.toThrow();
    expect(db.logStep).toHaveBeenCalledWith(env, "r1", "form_not_found", "form_not_found: nothing");
    expect(db.releaseArmRunSlot).toHaveBeenCalledWith(env, "r1");
  });

  it("a generic extraction error is refunded and rethrown", async () => {
    browser.extractForm.mockRejectedValueOnce(new Error("browser crashed"));
    await expect(run(params({ autonomy: "full_auto" }))).rejects.toThrow("browser crashed");
    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", { status: "failed", error: "browser crashed" });
    expect(db.releaseArmRunSlot).toHaveBeenCalledWith(env, "r1");
  });

  it("stringifies a non-Error terminal failure", async () => {
    browser.extractForm.mockRejectedValueOnce("string failure");
    await expect(run(params({ autonomy: "full_auto" }))).rejects.toBeDefined();
    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", { status: "failed", error: "string failure" });
  });

  it("submit is non-retryable and a post-submit screenshot failure never re-submits", async () => {
    // The application went through, then the proof-shot upload dies. That must
    // NOT fail (and re-run) the submit step: the arm would apply twice.
    db.uploadScreenshot.mockImplementation(async (...args: unknown[]) => {
      if (args[3] === "submitted") throw new Error("storage down");
      return "shot/path.png";
    });
    const step = makeStep(async () => ({ payload: {} }));
    const wf = new ApplyRunWorkflow({} as never, env);
    await wf.run({ payload: params({ autonomy: "full_auto" }) }, step as never);

    const submitCall = step.do.mock.calls.find((c) => c[0] === "submit");
    expect(submitCall?.[1]).toMatchObject({ retries: { limit: 0 } });
    expect(browser.fillAndMaybeSubmit).toHaveBeenCalledTimes(1);
    // Finalize still ran on the real outcome despite the lost screenshot.
    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", { status: "submitted", error: null });
    expect(db.releaseArmRunSlot).not.toHaveBeenCalled();
  });
});
