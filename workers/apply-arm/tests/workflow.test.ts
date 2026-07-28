import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, RunParams } from "../src/types";

const render = vi.hoisted(() => ({
  ensureSession: vi.fn(),
  completeLoginCode: vi.fn(),
  extractForm: vi.fn(),
  fillForm: vi.fn(),
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
  releaseArmRunSlot: vi.fn(async () => {})
}));
vi.mock("../src/render", () => render);
vi.mock("../src/gemini", () => gemini);
vi.mock("../src/db", () => db);
vi.mock("../src/notify", () => notify);

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
 * Mock WorkflowStep: runs each step body immediately.
 *
 * Names are RECORDED, not ignored. A step name is the real Workflows cache key,
 * so two steps sharing one name make the second return the first's cached result,
 * which in production looks like a step that silently did not run. Recording them
 * is the only way a test here can see that.
 *
 * The wait handler receives the step NAME as well as the event options, because
 * every wait in this workflow listens for the same `approval` event type and the
 * name is the only thing that tells them apart.
 */
function makeStep(waitForEvent: (opts: { type: string }, name: string) => Promise<unknown>) {
  const doNames: string[] = [];
  const waitNames: string[] = [];
  return {
    doNames,
    waitNames,
    do: vi.fn(async (name: string, optsOrFn: unknown, maybeFn?: unknown) => {
      doNames.push(name);
      const fn = (typeof optsOrFn === "function" ? optsOrFn : maybeFn) as () => Promise<unknown>;
      return fn();
    }),
    waitForEvent: vi.fn(async (name: string, opts: { type: string }) => {
      waitNames.push(name);
      return waitForEvent(opts, name);
    })
  };
}

/** The harness from the most recent `run()`, for asserting on step names. */
let lastStep: ReturnType<typeof makeStep>;

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
  waitForEvent: (opts: { type: string }, name: string) => Promise<unknown> = async () => ({
    payload: {}
  })
) {
  const wf = new ApplyRunWorkflow({} as never, env);
  lastStep = makeStep(waitForEvent);
  return wf.run({ payload: p }, lastStep as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  render.decodeScreenshot.mockReturnValue(new Uint8Array([1]));
  render.fetchResumeBase64.mockResolvedValue(null);
  render.ensureSession.mockResolvedValue(
    ok({ status: "authenticated", accountRequired: true, screenshotBase64: "AA==" })
  );
  render.completeLoginCode.mockResolvedValue(ok({ status: "authenticated", screenshotBase64: "AA==" }));
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

  it("generic: full_auto is forced down to the review gate (defense in depth)", async () => {
    render.fillForm
      .mockResolvedValueOnce(ok({ outcome: "filled", pages: 1, screenshotBase64: "AA==" }))
      .mockResolvedValueOnce(ok({ outcome: "submitted", pages: 1, screenshotBase64: "AA==" }));

    await run(
      params({ ats: "generic", jobUrl: "https://careers.example.com/jobs/1", autonomy: "full_auto" })
    );

    // An untuned board never submits without a human look, whatever the app
    // sent: the first fill is the review fill, not a direct submit.
    expect(render.fillForm.mock.calls[0][1].submit).toBe(false);
    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", {
      status: "needs_review",
      error: null,
      fill_mismatches: []
    });
  });

  it("review gate: fills without submitting, parks, then submits on approval", async () => {
    render.fillForm
      .mockResolvedValueOnce(ok({ outcome: "filled", pages: 1, screenshotBase64: "AA==" }))
      .mockResolvedValueOnce(ok({ outcome: "submitted", pages: 1, screenshotBase64: "AA==" }));

    await run(params({ autonomy: "review_gate" }), async () => ({ payload: {} }));

    expect(render.fillForm.mock.calls[0][1].submit).toBe(false);
    expect(render.fillForm.mock.calls[1][1].submit).toBe(true);
    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", {
      status: "needs_review",
      error: null,
      fill_mismatches: []
    });
  });

  const SANCTIONS = [
    {
      name: "q[]",
      label: "Sanctions and export controls",
      kind: "choice",
      expected: "None of the above",
      actual: "Ordinarily a resident of Cuba"
    }
  ];
  const refused = () =>
    ok({ outcome: "verification_failed", pages: 1, mismatches: SANCTIONS });

  it("asks a full-auto user to fix a refused answer instead of failing the run", async () => {
    // The interlock refused to send a wrong answer. The fill is done and the
    // application is one edit from correct, so the run parks rather than dying.
    render.fillForm.mockResolvedValueOnce(refused());

    await run(params(), async () => ({ payload: {} }));

    const parked = db.updateRun.mock.calls.find(
      (c: unknown[]) => (c[2] as { status?: string })?.status === "needs_review"
    )?.[2] as { fill_mismatches: unknown[] };
    expect(parked.fill_mismatches).toHaveLength(1);
    expect(db.updateApplication).toHaveBeenCalledWith(env, "a1", { status: "needs_review" });
    // Named by LABEL, since the field name means nothing to a person.
    expect(db.logStep).toHaveBeenCalledWith(
      env,
      "r1",
      "review_requested",
      expect.stringContaining("Sanctions and export controls")
    );
    // A full-auto user is not watching for a review request.
    expect(notify.notifyReviewNeeded).toHaveBeenCalledWith(env, expect.anything(), SANCTIONS);
  });

  it("submits the corrected answers, and only asks once", async () => {
    render.fillForm.mockResolvedValueOnce(refused());
    const corrected = [{ name: "q[]", label: "Sanctions", value: "None of the above" }];

    await run(params(), async () => ({ payload: { answers: corrected } }));

    expect(render.fillForm).toHaveBeenCalledTimes(2);
    expect(render.fillForm.mock.calls[1][1].answers).toEqual(corrected);
    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", { status: "submitted", error: null });
    // One ask, so a form that keeps disagreeing cannot loop the user forever.
    expect(lastStep.waitNames).toEqual(["await correction"]);
  });

  it("gives up when the corrected answers are refused too", async () => {
    render.fillForm.mockResolvedValueOnce(refused()).mockResolvedValueOnce(refused());

    await run(params(), async () => ({ payload: {} }));

    const patch = db.updateRun.mock.calls.find(
      (c: unknown[]) => (c[2] as { status?: string })?.status === "failed"
    )?.[2] as { error: string };
    expect(patch.error).toContain("verification_failed:");
    expect(patch.error).toContain("nothing was submitted");
    expect(db.releaseArmRunSlot).not.toHaveBeenCalled();
  });

  it("closes the run where it would have ended if the fix never comes", async () => {
    // Ignoring the mail lands exactly where the run landed before it was ever
    // asked, so being asked is never worse than not being asked.
    render.fillForm.mockResolvedValueOnce(refused());

    await run(params(), async () => {
      throw new Error("timeout");
    });

    const patch = db.updateRun.mock.calls.find(
      (c: unknown[]) => (c[2] as { status?: string })?.status === "failed"
    )?.[2] as { error: string };
    expect(patch.error).toContain("verification_failed:");
    expect(patch.error).toContain("never made");
    expect(db.updateApplication).toHaveBeenCalledWith(env, "a1", { status: "failed" });
    // Real work happened, so the run is CONSUMED.
    expect(db.releaseArmRunSlot).not.toHaveBeenCalled();
    // Nothing was sent: the second attempt never ran.
    expect(render.fillForm).toHaveBeenCalledTimes(1);
  });

  it("does not send a corrected submit built from nothing", async () => {
    // Approval with no edits reuses the answers already held, rather than
    // submitting an empty list.
    render.fillForm.mockResolvedValueOnce(refused());

    await run(params(), async () => ({ payload: { answers: [] } }));

    expect(render.fillForm.mock.calls[1][1].answers).toEqual(
      render.fillForm.mock.calls[0][1].answers
    );
  });

  it("never reuses a step name, because a name is a cache key", async () => {
    // Two steps sharing a name make the second return the FIRST one's cached
    // result, so a duplicate reads as a step that silently did not run. This is
    // the run with the most steps, including both submits.
    render.fillForm.mockResolvedValueOnce(refused());

    await run(params(), async () => ({ payload: {} }));

    expect(lastStep.doNames).toContain("submit");
    expect(lastStep.doNames).toContain("submit after correction");
    expect(new Set(lastStep.doNames).size).toBe(lastStep.doNames.length);
    expect(new Set(lastStep.waitNames).size).toBe(lastStep.waitNames.length);
  });

  it("summarizes rather than listing every rejected field", async () => {
    const many = ["One", "Two", "Three", "Four", "Five"].map((label) => ({
      name: label,
      label,
      kind: "choice",
      expected: "x",
      actual: "y"
    }));
    render.fillForm.mockResolvedValueOnce(
      ok({ outcome: "verification_failed", pages: 1, mismatches: many })
    );

    await run(params(), async () => {
      throw new Error("timeout");
    });

    const patch = db.updateRun.mock.calls.find(
      (c: unknown[]) => (c[2] as { status?: string })?.status === "failed"
    )?.[2] as { error: string };
    expect(patch.error).toContain("One, Two, Three and 2 more");
  });

  it("leaves a review-gate refusal as a single honest failure", async () => {
    // That user already reviewed these answers and the sidecar already tried the
    // other tactic, so asking again would spend another week to reach the same
    // place.
    render.fillForm
      .mockResolvedValueOnce(ok({ outcome: "filled", pages: 1 }))
      .mockResolvedValueOnce(refused());

    await run(params({ autonomy: "review_gate" }), async () => ({ payload: {} }));

    const patch = db.updateRun.mock.calls.find(
      (c: unknown[]) => (c[2] as { status?: string })?.status === "failed"
    )?.[2] as { error: string };
    expect(patch.error).toContain("verification_failed:");
    expect(render.fillForm).toHaveBeenCalledTimes(2);
    expect(lastStep.waitNames).toEqual(["await approval"]);
  });

  it("flags a review-gate fill the form disagreed with, without blocking it", async () => {
    render.fillForm
      .mockResolvedValueOnce(
        ok({
          outcome: "filled",
          pages: 1,
          mismatches: [{ name: "q[]", label: "Sanctions", expected: "None", actual: "(nothing)" }]
        })
      )
      .mockResolvedValueOnce(ok({ outcome: "submitted", pages: 1 }));

    await run(params({ autonomy: "review_gate" }), async () => ({ payload: {} }));

    expect(db.logStep).toHaveBeenCalledWith(
      env,
      "r1",
      "fill_mismatch",
      expect.stringContaining("Sanctions")
    );
    // Stored alongside the run so the review screen can mark the field itself.
    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", {
      status: "needs_review",
      error: null,
      fill_mismatches: [
        { name: "q[]", label: "Sanctions", expected: "None", actual: "(nothing)" }
      ]
    });
  });

  it("names a rejected field by its raw name when it has no label", async () => {
    render.fillForm.mockResolvedValueOnce(
      ok({
        outcome: "verification_failed",
        pages: 1,
        mismatches: [{ name: "question_99[]", label: "  ", kind: "choice", expected: "x", actual: "y" }]
      })
    );

    await run(params(), async () => {
      throw new Error("timeout");
    });

    const patch = db.updateRun.mock.calls.find(
      (c: unknown[]) => (c[2] as { status?: string })?.status === "failed"
    )?.[2] as { error: string };
    expect(patch.error).toContain("question_99[]");
  });

  it("remembers the tactic that worked, and leads with it next time", async () => {
    db.getFillTactics.mockResolvedValueOnce({ choice: "label" });
    render.fillForm.mockResolvedValueOnce(
      ok({ outcome: "submitted", pages: 1, tactics: [{ kind: "text", tactic: "set" }] })
    );

    await run(params(), async () => ({ payload: {} }));

    // What we already knew went in...
    expect(render.fillForm).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ tactics: { choice: "label" } })
    );
    // ...and what this run discovered came back out.
    expect(db.recordFillTactic).toHaveBeenCalledWith(
      env,
      "jobs.lever.co",
      "lever",
      "text",
      "set"
    );
  });

  it("records a tactic only once per fill", async () => {
    render.fillForm
      .mockResolvedValueOnce(ok({ outcome: "filled", pages: 1, tactics: [{ kind: "choice", tactic: "label" }] }))
      .mockResolvedValueOnce(ok({ outcome: "submitted", pages: 1 }));

    await run(params({ autonomy: "review_gate" }), async () => ({ payload: {} }));

    // Learning twice would inflate success_count and quietly corrupt the ranking.
    expect(db.recordFillTactic).toHaveBeenCalledTimes(1);
  });

  it("counts a remembered tactic against itself once it stops working", async () => {
    // Without this the staleness rule is decoration: failure_count could only
    // ever be zero, so a dead tactic would be applied forever.
    db.getFillTactics.mockResolvedValueOnce({ choice: "label" });
    render.fillForm.mockResolvedValueOnce(
      ok({
        outcome: "submitted",
        pages: 1,
        mismatches: [{ name: "q[]", label: "Q", kind: "choice", expected: "a", actual: "b" }]
      })
    );

    await run(params(), async () => ({ payload: {} }));

    expect(db.recordFillTacticFailure).toHaveBeenCalledWith(env, "jobs.lever.co", "lever", "choice");
  });

  it("does not blame a tactic for a kind that came out right", async () => {
    db.getFillTactics.mockResolvedValueOnce({ choice: "label" });
    render.fillForm.mockResolvedValueOnce(
      ok({
        outcome: "submitted",
        pages: 1,
        mismatches: [{ name: "email", label: "Email", kind: "text", expected: "a", actual: "" }]
      })
    );

    await run(params(), async () => ({ payload: {} }));

    // Only the choice tactic was remembered, and choices were fine.
    expect(db.recordFillTacticFailure).not.toHaveBeenCalled();
  });

  it("learns nothing from a run where the defaults just worked", async () => {
    render.fillForm.mockResolvedValueOnce(ok({ outcome: "submitted", pages: 1 }));
    await run(params(), async () => ({ payload: {} }));
    expect(db.recordFillTactic).not.toHaveBeenCalled();
  });

  it("tells the reviewer when the resume never attached", async () => {
    // A required field left empty is exactly what the review gate exists to
    // catch, and it can only catch what the run says out loud.
    render.fillForm
      .mockResolvedValueOnce(ok({ outcome: "filled", pages: 1, resume: "failed" }))
      .mockResolvedValueOnce(ok({ outcome: "submitted", pages: 1 }));

    await run(params({ autonomy: "review_gate" }), async () => ({ payload: {} }));

    expect(db.logStep).toHaveBeenCalledWith(
      env,
      "r1",
      "resume_not_attached",
      expect.stringContaining("attach it yourself")
    );
  });

  it("stays quiet about the resume when it did attach", async () => {
    render.fillForm
      .mockResolvedValueOnce(ok({ outcome: "filled", pages: 1, resume: "attached" }))
      .mockResolvedValueOnce(ok({ outcome: "submitted", pages: 1 }));

    await run(params({ autonomy: "review_gate" }), async () => ({ payload: {} }));

    expect(db.logStep).not.toHaveBeenCalledWith(
      env,
      "r1",
      "resume_not_attached",
      expect.anything()
    );
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

  const LI = {
    ats: "linkedin" as const,
    jobUrl: "https://www.linkedin.com/jobs/view/4442245127/",
    account: { email: "me@example.com", password: ["li", "v"].join("-") }
  };

  it("parks for a LinkedIn PIN, then resumes once the user enters the code", async () => {
    render.ensureSession.mockResolvedValue(
      ok({
        status: "needs_login_code",
        accountRequired: true,
        checkpointUrl: "https://www.linkedin.com/checkpoint/1"
      })
    );
    const waited: string[] = [];

    await run(params({ ...LI, autonomy: "full_auto" }), async (opts) => {
      waited.push(opts.type);
      return { payload: { code: "483920" } };
    });

    expect(db.updateRun).toHaveBeenCalledWith(env, "r1", { status: "needs_login_code" });
    expect(waited).toContain("login-code");
    expect(render.completeLoginCode).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        code: "483920",
        checkpointUrl: "https://www.linkedin.com/checkpoint/1",
        tenantHost: "www.linkedin.com"
      })
    );
    // Resumed all the way to a submit.
    expect(render.fillForm).toHaveBeenCalled();
  });

  it("fails and refunds when the login code is never entered", async () => {
    render.ensureSession.mockResolvedValue(ok({ status: "needs_login_code", accountRequired: true }));

    await expect(
      run(params({ ...LI, autonomy: "full_auto" }), async (opts) => {
        if (opts.type === "login-code") throw new Error("timeout");
        return { payload: {} };
      })
    ).rejects.toThrow(/login_code_timeout/);

    expect(db.releaseArmRunSlot).toHaveBeenCalledWith(env, "r1");
  });

  it("fails permanently when the entered code is rejected", async () => {
    render.ensureSession.mockResolvedValue(ok({ status: "needs_login_code", accountRequired: true }));
    render.completeLoginCode.mockResolvedValue(ok({ status: "login_failed" }));

    await expect(
      run(params({ ...LI, autonomy: "full_auto" }), async () => ({ payload: { code: "000000" } }))
    ).rejects.toThrow(/ats_login_failed/);
    expect(db.logStep).toHaveBeenCalledWith(env, "r1", "account_login_failed");
  });

  it("propagates a sidecar outage while submitting the code", async () => {
    render.ensureSession.mockResolvedValue(ok({ status: "needs_login_code", accountRequired: true }));
    render.completeLoginCode.mockResolvedValue(fail("render_unreachable", { detail: "tunnel down" }));

    await expect(
      run(params({ ...LI, autonomy: "full_auto" }), async () => ({ payload: { code: "1" } }))
    ).rejects.toThrow(/render_unreachable during login code/);
  });

  it("submits an empty code when the resume event carried none", async () => {
    render.ensureSession.mockResolvedValue(ok({ status: "needs_login_code", accountRequired: true }));

    await run(params({ ...LI, autonomy: "full_auto" }), async () => ({ payload: {} }));

    expect(render.completeLoginCode).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ code: "" })
    );
  });

  it("re-parks for another PIN when LinkedIn re-prompts, then resumes", async () => {
    render.ensureSession.mockResolvedValue(
      ok({ status: "needs_login_code", accountRequired: true, checkpointUrl: "https://li/checkpoint/1" })
    );
    // First code is not accepted and LinkedIn moves the challenge; second is.
    render.completeLoginCode
      .mockResolvedValueOnce(ok({ status: "needs_login_code", checkpointUrl: "https://li/checkpoint/2" }))
      .mockResolvedValueOnce(ok({ status: "authenticated" }));

    await run(params({ ...LI, autonomy: "full_auto" }), async () => ({ payload: { code: "0" } }));

    expect(render.completeLoginCode).toHaveBeenCalledTimes(2);
    // First attempt uses the ensureSession checkpoint; the retry follows the
    // challenge to the URL the re-prompt moved it to.
    expect(render.completeLoginCode.mock.calls[0][1]).toMatchObject({
      checkpointUrl: "https://li/checkpoint/1"
    });
    expect(render.completeLoginCode.mock.calls[1][1]).toMatchObject({
      checkpointUrl: "https://li/checkpoint/2"
    });
    expect(db.logStep).toHaveBeenCalledWith(env, "r1", "login_code_retry");
    expect(render.fillForm).toHaveBeenCalled();
  });

  it("gives up after the PIN attempt cap", async () => {
    render.ensureSession.mockResolvedValue(ok({ status: "needs_login_code", accountRequired: true }));
    render.completeLoginCode.mockResolvedValue(ok({ status: "needs_login_code" }));

    await expect(
      run(params({ ...LI, autonomy: "full_auto" }), async () => ({ payload: { code: "0" } }))
    ).rejects.toThrow(/ats_login_failed/);
    expect(render.completeLoginCode).toHaveBeenCalledTimes(3);
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
