import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, RunParams } from "../src/types";

const render = vi.hoisted(() => ({
  ensureSession: vi.fn(),
  extractForm: vi.fn(),
  fillForm: vi.fn(),
  fetchResumeBase64: vi.fn(async () => null as string | null),
  decodeScreenshot: vi.fn(() => new Uint8Array([1]) as Uint8Array | null)
}));
const gemini = vi.hoisted(() => ({ generateAnswers: vi.fn(), diagnosePage: vi.fn() }));
const db = vi.hoisted(() => ({
  updateRun: vi.fn(async () => {}),
  logStep: vi.fn(async () => {}),
  getPlaybook: vi.fn(async () => null as unknown),
  recordPlaybook: vi.fn(async () => {}),
  recordPlaybookFailure: vi.fn(async () => {}),
  uploadScreenshot: vi.fn(async (..._args: unknown[]) => "shot/path.png"),
  appendScreenshot: vi.fn(async () => {}),
  updateApplication: vi.fn(async () => {}),
  releaseArmRunSlot: vi.fn(async () => {})
}));
vi.mock("../src/render", () => render);
vi.mock("../src/gemini", () => gemini);
vi.mock("../src/db", () => db);

import { ApplyRunWorkflow } from "../src/workflow";

const env = { SUPABASE_URL: "https://db", RENDER_URL: "https://browser", RENDER_TOKEN: "t" } as Env;

/** A successful sidecar reply. */
const ok = <T,>(data: T) => ({ ok: true as const, data });
/** A structured sidecar failure. */
const fail = (error: string, extra: Record<string, unknown> = {}) => ({
  ok: false as const,
  error,
  ...extra
});

/**
 * Mock WorkflowStep: runs each step body immediately. `waitForEvent(name, opts)`
 * takes the event options as its SECOND argument, so the per-test handler is
 * given `opts` and can branch on which wait it is.
 */
function makeStep(waitForEvent: (opts: { type: string }) => Promise<unknown>) {
  return {
    do: vi.fn(async (_name: string, optsOrFn: unknown, maybeFn?: unknown) => {
      const fn = (typeof optsOrFn === "function" ? optsOrFn : maybeFn) as () => Promise<unknown>;
      return fn();
    }),
    waitForEvent: vi.fn(async (_name: string, opts: { type: string }) => waitForEvent(opts))
  };
}

function params(over: Partial<RunParams> = {}): RunParams {
  return {
    runId: "r1",
    applicationId: "a1",
    userId: "u1",
    jobUrl: "https://jobs.lever.co/acme/1",
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

const WD = {
  ats: "workday" as const,
  jobUrl: "https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/Remote/Eng_JR1",
  account: { email: "a-abcdefghjk@jobarms.com", password: ["fixture", "v"].join("-") }
};

function run(
  p: RunParams,
  waitForEvent: (opts: { type: string }) => Promise<unknown> = async () => ({ payload: {} })
) {
  const wf = new ApplyRunWorkflow({} as never, env);
  return wf.run({ payload: p }, makeStep(waitForEvent) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  render.decodeScreenshot.mockReturnValue(new Uint8Array([1]));
  render.fetchResumeBase64.mockResolvedValue(null);
  render.ensureSession.mockResolvedValue(
    ok({ status: "authenticated", accountRequired: true, screenshotBase64: "AA==" })
  );
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
});

describe("the happy paths", () => {
  it("full-auto: extract, answer, submit, finalize submitted", async () => {
    await run(params({ autonomy: "full_auto" }));

    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", { status: "submitted", error: null });
    expect(db.updateApplication).toHaveBeenCalledWith(
      env,
      "a1",
      expect.objectContaining({ status: "applied" })
    );
    // Full-auto never fills for review, so there is exactly ONE fill call and it
    // is the submitting one.
    expect(render.fillForm).toHaveBeenCalledTimes(1);
    expect(render.fillForm.mock.calls[0][1].submit).toBe(true);
  });

  it("review gate: fills without submitting, parks, then submits on approval", async () => {
    render.fillForm
      .mockResolvedValueOnce(ok({ outcome: "filled", pages: 1, screenshotBase64: "AA==" }))
      .mockResolvedValueOnce(ok({ outcome: "submitted", pages: 1, screenshotBase64: "AA==" }));

    await run(params({ autonomy: "review_gate" }), async () => ({ payload: {} }));

    expect(render.fillForm.mock.calls[0][1].submit).toBe(false);
    expect(render.fillForm.mock.calls[1][1].submit).toBe(true);
    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", { status: "needs_review", error: null });
  });

  it("submits the user's edited answers, not the generated ones", async () => {
    const edited = [{ name: "email", label: "Email", value: "edited@b.com" }];
    render.fillForm
      .mockResolvedValueOnce(ok({ outcome: "filled", pages: 1 }))
      .mockResolvedValueOnce(ok({ outcome: "submitted", pages: 1 }));

    await run(params({ autonomy: "review_gate" }), async () => ({ payload: { answers: edited } }));

    expect(render.fillForm.mock.calls[1][1].answers).toEqual(edited);
    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", {
      status: "approved",
      answers: edited
    });
  });

  it("sends the resume as bytes so the sidecar fetches nothing", async () => {
    render.fetchResumeBase64.mockResolvedValue("UERG");
    await run(params({ autonomy: "full_auto" }));
    expect(render.fillForm.mock.calls[0][1].resume).toEqual({
      contentBase64: "UERG",
      fileName: "r.pdf",
      mimeType: "application/pdf"
    });
  });
});

describe("candidate accounts", () => {
  it("skips account setup entirely for an ATS that needs none", async () => {
    await run(params({ autonomy: "full_auto" }));
    expect(render.ensureSession).not.toHaveBeenCalled();
  });

  it("ensures the account before extracting on an account-gated ATS", async () => {
    await run(params({ ...WD, autonomy: "full_auto" }));

    expect(render.ensureSession).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ ats: "workday", account: WD.account })
    );
    expect(db.logStep).toHaveBeenCalledWith(env, "r1", "account_ready");
  });

  it("omits credentials when the dispatch carried none", async () => {
    await run(params({ ...WD, account: undefined, autonomy: "full_auto" }));
    expect("account" in render.ensureSession.mock.calls[0][1]).toBe(false);
  });

  it("parks for verification, then resumes when the app releases it", async () => {
    render.ensureSession.mockResolvedValue(
      ok({ status: "needs_email_verification", accountRequired: true })
    );
    const waited: string[] = [];

    await run(params({ ...WD, autonomy: "full_auto" }), async (opts) => {
      waited.push(opts.type);
      return { payload: {} };
    });

    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", {
      status: "needs_account_verification"
    });
    expect(waited).toContain("account-verified");
    expect(db.logStep).toHaveBeenCalledWith(env, "r1", "account_verified");
    // The run continued all the way to a submit.
    expect(render.fillForm).toHaveBeenCalled();
  });

  it("fails and refunds when the verification email never arrives", async () => {
    render.ensureSession.mockResolvedValue(
      ok({ status: "needs_email_verification", accountRequired: true })
    );

    await expect(
      run(params({ ...WD, autonomy: "full_auto" }), async (opts) => {
        if (opts.type === "account-verified") throw new Error("timeout");
        return { payload: {} };
      })
    ).rejects.toThrow(/account_verification_timeout/);

    // Nothing was submitted and the user did nothing wrong, so the slot returns.
    expect(db.releaseArmRunSlot).toHaveBeenCalledWith(env, "r1");
  });

  it("still proceeds when the account phase returns no screenshot", async () => {
    render.ensureSession.mockResolvedValue(
      ok({ status: "authenticated", accountRequired: true, screenshotBase64: null })
    );
    render.decodeScreenshot.mockImplementation((b: unknown) => (b ? new Uint8Array([1]) : null));

    await run(params({ ...WD, autonomy: "full_auto" }));

    expect(db.logStep).toHaveBeenCalledWith(env, "r1", "account_ready");
  });

  it("fails permanently when the tenant rejects the account", async () => {
    render.ensureSession.mockResolvedValue(
      ok({ status: "login_failed", accountRequired: true })
    );
    await expect(run(params({ ...WD, autonomy: "full_auto" }))).rejects.toThrow(/ats_login_failed/);
    expect(db.logStep).toHaveBeenCalledWith(env, "r1", "account_login_failed");
  });

  it("propagates a sidecar outage during account setup", async () => {
    render.ensureSession.mockResolvedValue(fail("render_unreachable", { detail: "tunnel down" }));
    await expect(run(params({ ...WD, autonomy: "full_auto" }))).rejects.toThrow(
      /render_unreachable during account setup: tunnel down/
    );
  });
});

describe("reaching the form", () => {
  it("records a playbook the sidecar reports as the winning recovery", async () => {
    render.extractForm.mockResolvedValue(
      ok({
        fields: [{ name: "email" }],
        pages: 1,
        scope: "body",
        recovery: { source: "playbook", strategy: { action: "scroll" }, domain: "jobs.lever.co" },
        playbookFailed: false
      })
    );

    await run(params({ autonomy: "full_auto" }));

    expect(db.recordPlaybook).toHaveBeenCalledWith(env, "jobs.lever.co", "lever", {
      action: "scroll"
    });
    expect(db.logStep).toHaveBeenCalledWith(env, "r1", "recovery_playbook", "scroll");
  });

  it("logs a vision recovery distinctly from a playbook one", async () => {
    render.extractForm.mockResolvedValue(
      ok({
        fields: [{ name: "email" }],
        pages: 1,
        scope: "body",
        recovery: { source: "vision", strategy: { action: "click" }, domain: "jobs.lever.co" },
        playbookFailed: false
      })
    );

    await run(params({ autonomy: "full_auto" }));

    expect(db.logStep).toHaveBeenCalledWith(env, "r1", "recovery_vision", "click");
  });

  it("decays a stored playbook the sidecar says no longer works", async () => {
    render.extractForm.mockResolvedValue(
      ok({ fields: [{ name: "email" }], pages: 1, scope: "body", recovery: null, playbookFailed: true })
    );
    await run(params({ autonomy: "full_auto" }));
    expect(db.recordPlaybookFailure).toHaveBeenCalledWith(env, "jobs.lever.co", "lever");
  });

  it("uses vision on form_not_found and records the strategy that worked", async () => {
    render.extractForm
      .mockResolvedValueOnce(fail("form_not_found", { detail: "no fields", screenshotBase64: "AA==" }))
      .mockResolvedValueOnce(ok({ fields: [{ name: "email" }], pages: 1, scope: "form", recovery: null, playbookFailed: false }));
    gemini.diagnosePage.mockResolvedValue({ action: "click", click_text: "Apply now" });

    await run(params({ autonomy: "full_auto" }));

    // The vision strategy is passed back as the playbook to apply first.
    expect(render.extractForm.mock.calls[1][1].playbook).toEqual({
      action: "click",
      click_text: "Apply now"
    });
    expect(db.recordPlaybook).toHaveBeenCalledWith(env, "jobs.lever.co", "lever", {
      action: "click",
      click_text: "Apply now"
    });
  });

  it("omits click_text when vision did not supply one", async () => {
    render.extractForm
      .mockResolvedValueOnce(fail("form_not_found", { screenshotBase64: "AA==" }))
      .mockResolvedValueOnce(ok({ fields: [{ name: "email" }], pages: 1, scope: "form", recovery: null, playbookFailed: false }));
    gemini.diagnosePage.mockResolvedValue({ action: "scroll" });

    await run(params({ autonomy: "full_auto" }));

    expect(render.extractForm.mock.calls[1][1].playbook).toEqual({ action: "scroll" });
  });

  it("gives vision at most two rounds, then fails honestly", async () => {
    render.extractForm.mockResolvedValue(fail("form_not_found", { screenshotBase64: "AA==" }));
    gemini.diagnosePage.mockResolvedValue({ action: "scroll" });

    await expect(run(params({ autonomy: "full_auto" }))).rejects.toThrow(/form_not_found/);

    expect(gemini.diagnosePage).toHaveBeenCalledTimes(2);
    expect(db.logStep).toHaveBeenCalledWith(env, "r1", "form_not_found", expect.any(String));
  });

  it("stops when vision says there is nothing to try", async () => {
    render.extractForm.mockResolvedValue(fail("form_not_found", { screenshotBase64: "AA==" }));
    gemini.diagnosePage.mockResolvedValue({ action: "none", reason: "behind a login wall" });

    await expect(run(params({ autonomy: "full_auto" }))).rejects.toThrow(/behind a login wall/);
    expect(gemini.diagnosePage).toHaveBeenCalledTimes(1);
  });

  it("stops when vision itself is unavailable", async () => {
    render.extractForm.mockResolvedValue(fail("form_not_found", { screenshotBase64: "AA==" }));
    gemini.diagnosePage.mockRejectedValue(new Error("model down"));
    await expect(run(params({ autonomy: "full_auto" }))).rejects.toThrow(/form_not_found/);
  });

  it("cannot run vision without a screenshot to look at", async () => {
    render.extractForm.mockResolvedValue(fail("form_not_found", { detail: "no shot" }));
    render.decodeScreenshot.mockReturnValue(null);
    await expect(run(params({ autonomy: "full_auto" }))).rejects.toThrow(/form_not_found/);
    expect(gemini.diagnosePage).not.toHaveBeenCalled();
  });

  it("decays the stored playbook when the first attempt cannot find the form", async () => {
    db.getPlaybook.mockResolvedValue({ action: "scroll" });
    render.extractForm.mockResolvedValue(fail("form_not_found", { detail: "gone" }));
    render.decodeScreenshot.mockReturnValue(null);

    await expect(run(params({ autonomy: "full_auto" }))).rejects.toThrow(/form_not_found/);

    expect(db.recordPlaybookFailure).toHaveBeenCalledWith(env, "jobs.lever.co", "lever");
  });

  it("treats a non-form_not_found extraction error as retryable", async () => {
    render.extractForm.mockResolvedValue(fail("render_failed", { detail: "segfault" }));
    await expect(run(params({ autonomy: "full_auto" }))).rejects.toThrow(
      /render_failed during form extraction: segfault/
    );
  });

  it("surfaces a sidecar failure on the vision retry", async () => {
    render.extractForm
      .mockResolvedValueOnce(fail("form_not_found", { screenshotBase64: "AA==" }))
      .mockResolvedValueOnce(fail("render_failed", { detail: "died" }));
    gemini.diagnosePage.mockResolvedValue({ action: "scroll" });
    await expect(run(params({ autonomy: "full_auto" }))).rejects.toThrow(/render_failed/);
  });

  it("skips the screenshot when the sidecar sent none", async () => {
    render.extractForm.mockResolvedValue(
      ok({ fields: [{ name: "email" }], pages: 2, scope: "form", recovery: null, playbookFailed: false })
    );
    render.decodeScreenshot.mockReturnValue(null);
    await run(params({ autonomy: "full_auto" }));
    expect(db.appendScreenshot).not.toHaveBeenCalled();
    expect(db.logStep).toHaveBeenCalledWith(
      env,
      "r1",
      "form_extracted",
      "1 fields across 2 page(s)"
    );
  });

  it("keys playbooks off an empty host when the job URL is unparseable", async () => {
    await run(params({ autonomy: "full_auto", jobUrl: "not-a-url" }));
    expect(db.getPlaybook).toHaveBeenCalledWith(env, "", "lever");
  });
});

describe("outcomes", () => {
  it("captcha_blocked consumes the run and explains what to do", async () => {
    render.fillForm.mockResolvedValue(ok({ outcome: "captcha_blocked", pages: 1 }));
    await run(params({ autonomy: "full_auto" }));
    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", {
      status: "failed",
      error: expect.stringMatching(/^captcha_blocked:/)
    });
    // Real work was done, so the slot is NOT refunded.
    expect(db.releaseArmRunSlot).not.toHaveBeenCalled();
  });

  it("unconfirmed consumes the run and says to verify manually", async () => {
    render.fillForm.mockResolvedValue(ok({ outcome: "unconfirmed", pages: 1 }));
    await run(params({ autonomy: "full_auto" }));
    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", {
      status: "failed",
      error: expect.stringMatching(/^submit_unconfirmed/)
    });
    expect(db.releaseArmRunSlot).not.toHaveBeenCalled();
  });

  it("a review-gate timeout cancels WITHOUT a refund", async () => {
    render.fillForm.mockResolvedValue(ok({ outcome: "filled", pages: 1 }));

    await run(params({ autonomy: "review_gate" }), async (opts) => {
      if (opts.type === "approval") throw new Error("timeout");
      return { payload: {} };
    });

    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", {
      status: "canceled",
      error: expect.stringMatching(/^review_timeout/)
    });
    expect(db.updateApplication).toHaveBeenCalledWith(env, "a1", { status: "saved" });
    // The user walked away; compute was spent on their behalf.
    expect(db.releaseArmRunSlot).not.toHaveBeenCalled();
  });

  it("keeps the submitted outcome when storing the proof shot fails", async () => {
    // Only the post-submit shot fails; the extract shot still stores, so this
    // isolates the best-effort bookkeeping rather than breaking extraction.
    db.uploadScreenshot.mockImplementation(async (..._args: unknown[]) => {
      if (_args[3] === "submitted") throw new Error("storage down");
      return "shot/path.png";
    });
    await run(params({ autonomy: "full_auto" }));
    // A missing proof shot is cosmetic; a failed step is not.
    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", { status: "submitted", error: null });
  });

  it("fails and refunds when the submit phase cannot reach the sidecar", async () => {
    render.fillForm.mockResolvedValue(fail("render_unreachable", { detail: "gone" }));
    await expect(run(params({ autonomy: "full_auto" }))).rejects.toThrow(
      /render_unreachable during submit/
    );
    expect(db.releaseArmRunSlot).toHaveBeenCalledWith(env, "r1");
  });

  it("fails and refunds when the review fill cannot reach the sidecar", async () => {
    render.fillForm.mockResolvedValue(fail("render_failed", { detail: "boom" }));
    await expect(run(params({ autonomy: "review_gate" }))).rejects.toThrow(
      /render_failed during fill for review/
    );
    expect(db.releaseArmRunSlot).toHaveBeenCalledWith(env, "r1");
  });

  it("records a non-Error thrown value honestly", async () => {
    render.extractForm.mockRejectedValue("string failure");
    await expect(run(params({ autonomy: "full_auto" }))).rejects.toBeDefined();
    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", {
      status: "failed",
      error: "string failure"
    });
  });

  it("omits a detail suffix when the sidecar gave none", async () => {
    render.fillForm.mockResolvedValue(fail("render_failed"));
    await expect(run(params({ autonomy: "full_auto" }))).rejects.toThrow(
      /^render_failed during submit$/
    );
  });
});
