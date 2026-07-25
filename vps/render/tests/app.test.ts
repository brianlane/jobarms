import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Page } from "playwright";

// The app imports sessions (which imports playwright) at module load, so stub the
// browser even though every test injects its own phase runner.
vi.mock("playwright", () => ({
  chromium: { launch: vi.fn(async () => ({ newContext: vi.fn(), close: vi.fn() })) }
}));

import { createApp, type AppDeps } from "../src/app";
import { CONFIG } from "../src/config";
import { fakePage, goodFields, loc, TEST_CREDS } from "./helpers/fake-page";

const TOKEN = CONFIG.token;
const JOB_URL = "https://jobs.lever.co/acme/1/apply";
const WD_URL = "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/1";

/**
 * Build the app with a phase runner that hands every phase the SAME fake page,
 * so a test can assert on what the phase did to it.
 */
function appWith(page: ReturnType<typeof fakePage>, over: Partial<AppDeps> = {}) {
  const runPhase = vi.fn(
    async <T>(_u: string, _h: string, fn: (ctx: never) => Promise<T>): Promise<T> =>
      fn({ page: page as unknown as Page, context: {}, key: "k" } as never)
  );
  return { app: createApp({ runPhase, ...over } as AppDeps), runPhase };
}

/** A page whose extraction yields a valid form on the first look. */
function formPage(over = {}) {
  return fakePage({ url: JOB_URL, eval$$: () => goodFields(), ...over });
}

const auth = (r: request.Test) => (TOKEN ? r.set("authorization", `Bearer ${TOKEN}`) : r);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("health and auth", () => {
  it("serves /health without a bearer", async () => {
    const { app } = appWith(formPage());
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it("rejects a missing or wrong bearer on every other route", async () => {
    const { app } = appWith(formPage());
    // CONFIG.token is read at import; skip when the env leaves it unset.
    if (!TOKEN) return;
    expect((await request(app).post("/extract").send({})).status).toBe(401);
    expect(
      (await request(app).post("/extract").set("authorization", "Bearer nope").send({})).status
    ).toBe(401);
  });
});

describe("request validation", () => {
  it("400s on a body with no userId or a bad ats", async () => {
    const { app } = appWith(formPage());
    for (const body of [
      { jobUrl: JOB_URL, ats: "lever" },
      { userId: "u1", jobUrl: JOB_URL },
      { userId: "u1", jobUrl: JOB_URL, ats: "taleo" }
    ]) {
      const res = await auth(request(app).post("/extract").send(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toEqual({ error: "invalid_body" });
    }
  });

  it("refuses an unsafe URL with a 200-wrapped structured error", async () => {
    const { app } = appWith(formPage());
    const res = await auth(
      request(app).post("/extract").send({ userId: "u1", jobUrl: "http://127.0.0.1/", ats: "lever" })
    );
    // 200 on purpose: a Tunnel would replace a 5xx body and hide the code.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ error: "invalid_or_unsafe_url" });
  });

  it("validates /fill's answers array", async () => {
    const { app } = appWith(formPage());
    const res = await auth(
      request(app).post("/fill").send({ userId: "u1", jobUrl: JOB_URL, ats: "lever" })
    );
    expect(res.status).toBe(400);
  });

  it("validates /verify's inputs", async () => {
    const { app } = appWith(formPage());
    for (const body of [
      { tenantHost: "acme.com", link: "https://x/verify" },
      { userId: "u1", link: "https://x/verify" },
      { userId: "u1", tenantHost: "acme.com" }
    ]) {
      expect((await auth(request(app).post("/verify").send(body))).status).toBe(400);
    }
  });
});

describe("POST /session/ensure", () => {
  it("short-circuits for an ATS that needs no account", async () => {
    const { app, runPhase } = appWith(formPage());
    const res = await auth(
      request(app).post("/session/ensure").send({ userId: "u1", jobUrl: JOB_URL, ats: "lever" })
    );
    expect(res.body).toEqual({ status: "authenticated", accountRequired: false });
    // No browser work at all for Greenhouse/Lever.
    expect(runPhase).not.toHaveBeenCalled();
  });

  it("requires credentials for an account-gated ATS", async () => {
    const { app } = appWith(formPage());
    const res = await auth(
      request(app).post("/session/ensure").send({ userId: "u1", jobUrl: WD_URL, ats: "workday" })
    );
    expect(res.status).toBe(400);
  });

  it("reports the account status and a screenshot", async () => {
    // No credentials form on the page, so the session is already authenticated.
    const page = fakePage({ url: WD_URL, evaluate: () => "" });
    const { app } = appWith(page);
    const res = await auth(
      request(app)
        .post("/session/ensure")
        .send({
          userId: "u1",
          jobUrl: WD_URL,
          ats: "workday",
          account: TEST_CREDS
        })
    );
    expect(res.body).toMatchObject({ status: "authenticated", accountRequired: true });
    expect(res.body.screenshotBase64).toBe(Buffer.from([1]).toString("base64"));
  });

  it("wraps a browser crash as render_failed", async () => {
    const runPhase = vi.fn(async () => {
      throw new Error("browser died");
    });
    const app = createApp({ runPhase } as unknown as AppDeps);
    const res = await auth(
      request(app)
        .post("/session/ensure")
        .send({
          userId: "u1",
          jobUrl: WD_URL,
          ats: "workday",
          account: TEST_CREDS
        })
    );
    expect(res.status).toBe(200);
    expect(res.body.error).toBe("render_failed");
    expect(res.body.detail).toContain("browser died");
  });
});

describe("POST /verify", () => {
  it("visits a verification link in the held session", async () => {
    const page = fakePage({ evaluate: () => "" });
    const { app } = appWith(page);
    const res = await auth(
      request(app)
        .post("/verify")
        .send({ userId: "u1", tenantHost: "acme.wd1.myworkdayjobs.com", link: "https://acme.wd1.myworkdayjobs.com/verify?t=1" })
    );
    expect(res.body.status).toBe("authenticated");
  });

  it("rejects an unsafe verification link", async () => {
    const { app } = appWith(fakePage());
    const res = await auth(
      request(app)
        .post("/verify")
        .send({ userId: "u1", tenantHost: "acme.com", link: "http://169.254.169.254/" })
    );
    // The link fails the SSRF guard, leaving neither link nor code.
    expect(res.status).toBe(400);
  });

  it("navigates to the tenant root when given only a code", async () => {
    const page = fakePage({
      locators: { '[data-automation-id="verificationCode"]': loc({ count: vi.fn(async () => 1) }) },
      evaluate: () => ""
    });
    const { app } = appWith(page);
    const res = await auth(
      request(app)
        .post("/verify")
        .send({ userId: "u1", tenantHost: "acme.wd1.myworkdayjobs.com", code: "483920" })
    );
    expect(page.goto).toHaveBeenCalledWith("https://acme.wd1.myworkdayjobs.com/", {
      waitUntil: "domcontentloaded"
    });
    expect(res.body.status).toBe("authenticated");
  });

  it("wraps a crash as render_failed", async () => {
    const runPhase = vi.fn(async () => {
      throw new Error("nav exploded");
    });
    const app = createApp({ runPhase } as unknown as AppDeps);
    const res = await auth(
      request(app)
        .post("/verify")
        .send({ userId: "u1", tenantHost: "acme.com", code: "1234" })
    );
    expect(res.body.error).toBe("render_failed");
  });
});

describe("POST /extract", () => {
  it("returns the filtered field set, scope, and a screenshot", async () => {
    const { app } = appWith(formPage());
    const res = await auth(
      request(app).post("/extract").send({ userId: "u1", jobUrl: JOB_URL, ats: "lever" })
    );
    expect(res.status).toBe(200);
    // The file input is dropped: attachResume owns it, so it is not a question.
    expect(res.body.fields.map((f: { name: string }) => f.name)).toEqual(["name", "email"]);
    expect(res.body).toMatchObject({ pages: 1, scope: "form", recovery: null });
    expect(res.body.screenshotBase64).toBeTruthy();
  });

  it("reports form_not_found with a screenshot so the caller can run vision", async () => {
    const { app } = appWith(fakePage({ url: JOB_URL, eval$$: () => [] }));
    const res = await auth(
      request(app).post("/extract").send({ userId: "u1", jobUrl: JOB_URL, ats: "lever" })
    );
    expect(res.status).toBe(200);
    expect(res.body.error).toBe("form_not_found");
    expect(res.body.detail).toContain("no fields extracted");
    // The caller owns the vision model, so it needs the picture.
    expect(res.body.screenshotBase64).toBe(Buffer.from([1]).toString("base64"));
  });

  it("omits the screenshot when the page could not be captured", async () => {
    const { app } = appWith(
      fakePage({ url: JOB_URL, eval$$: () => [], screenshotThrows: true })
    );
    const res = await auth(
      request(app).post("/extract").send({ userId: "u1", jobUrl: JOB_URL, ats: "lever" })
    );
    expect(res.body.error).toBe("form_not_found");
    expect(res.body.screenshotBase64).toBeUndefined();
  });

  it("passes a stored playbook through and reports whether it still works", async () => {
    let call = 0;
    const page = fakePage({
      url: JOB_URL,
      // First look fails, so the playbook runs and the second look succeeds.
      eval$$: () => (call++ === 0 ? [] : goodFields())
    });
    const { app } = appWith(page);
    const res = await auth(
      request(app)
        .post("/extract")
        .send({ userId: "u1", jobUrl: JOB_URL, ats: "lever", playbook: { action: "scroll" } })
    );
    expect(res.body.recovery).toMatchObject({ source: "playbook" });
    expect(res.body.playbookFailed).toBe(false);
  });

  it("walks a Workday wizard, accumulating every page's fields once", async () => {
    let page$ = 0;
    // Page 1 has name/email; page 2 adds a new question and repeats email.
    const pages = [
      goodFields(),
      [
        { name: "email", label: "Email", type: "email", required: true, options: [] },
        { name: "why", label: "Why us?", type: "textarea", required: false, options: [] }
      ]
    ];
    const next = loc({ count: vi.fn(async () => 1), isEnabled: vi.fn(async () => true) });
    let advanced = 0;
    next.click = vi.fn(async () => {
      advanced++;
    });
    const wd = fakePage({
      url: WD_URL,
      eval$$: () => pages[Math.min(page$++, pages.length - 1)],
      locators: {
        '[data-automation-id="pageFooterNextButton"]': next,
        // Becomes the last page after one advance, ending the walk.
        '[data-automation-id="pageFooterSubmitButton"]': loc({
          count: vi.fn(async () => (advanced >= 1 ? 1 : 0))
        })
      }
    });
    const { app } = appWith(wd);

    const res = await auth(
      request(app).post("/extract").send({ userId: "u1", jobUrl: WD_URL, ats: "workday" })
    );

    expect(res.body.pages).toBe(2);
    // "email" appears on both pages but is asked once.
    expect(res.body.fields.map((f: { name: string }) => f.name)).toEqual(["name", "email", "why"]);
  });

  it("stops the wizard walk at the page cap", async () => {
    const next = loc({ count: vi.fn(async () => 1), isEnabled: vi.fn(async () => true) });
    const wd = fakePage({
      url: WD_URL,
      eval$$: () => goodFields(),
      locators: { '[data-automation-id="pageFooterNextButton"]': next }
    });
    const { app } = appWith(wd);
    const res = await auth(
      request(app).post("/extract").send({ userId: "u1", jobUrl: WD_URL, ats: "workday" })
    );
    expect(res.body.pages).toBe(CONFIG.maxWizardPages);
  });

  it("still returns answers when the screenshot fails", async () => {
    const { app } = appWith(formPage({ screenshotThrows: true }));
    const res = await auth(
      request(app).post("/extract").send({ userId: "u1", jobUrl: JOB_URL, ats: "lever" })
    );
    expect(res.body.screenshotBase64).toBeNull();
    expect(res.body.fields).toHaveLength(2);
  });

  it("wraps an unexpected crash as render_failed", async () => {
    const runPhase = vi.fn(async () => {
      throw new Error("chromium segfault");
    });
    const app = createApp({ runPhase } as unknown as AppDeps);
    const res = await auth(
      request(app).post("/extract").send({ userId: "u1", jobUrl: JOB_URL, ats: "lever" })
    );
    expect(res.body.error).toBe("render_failed");
  });
});

describe("POST /fill", () => {
  const answers = [{ name: "name", label: "Full name", value: "Brian" }];

  it("attaches the resume, fills, and stops short of submitting", async () => {
    const fileInput = loc({ count: vi.fn(async () => 1) });
    const field = loc({
      count: vi.fn(async () => 1),
      evaluate: vi.fn(async () => ({ tag: "input", type: "text", cls: "", role: "", autocomplete: "" }))
    });
    const page = fakePage({
      url: JOB_URL,
      eval$$: () => goodFields(),
      locators: { 'input[type="file"]': fileInput, "[name=": field }
    });
    const { app } = appWith(page);

    const res = await auth(
      request(app).post("/fill").send({
        userId: "u1",
        jobUrl: JOB_URL,
        ats: "lever",
        answers,
        resume: {
          contentBase64: Buffer.from("%PDF-1.7 fake").toString("base64"),
          fileName: "cv.pdf",
          mimeType: "application/pdf"
        }
      })
    );

    expect(res.body).toMatchObject({ outcome: "filled", pages: 1 });
    expect(fileInput.setInputFiles).toHaveBeenCalled();
    expect(field.pressSequentially).toHaveBeenCalledWith("Brian", expect.anything());
  });

  it("defaults to no resume when none is supplied", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { app } = appWith(formPage());
    const res = await auth(
      request(app).post("/fill").send({ userId: "u1", jobUrl: JOB_URL, ats: "lever", answers })
    );
    expect(res.body.outcome).toBe("filled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits and reports a confirmed submission", async () => {
    const page = fakePage({
      url: JOB_URL,
      eval$$: () => goodFields(),
      // Lever confirms on a text= locator resolving.
      locators: { "text=/": loc() }
    });
    const { app } = appWith(page);
    const res = await auth(
      request(app)
        .post("/fill")
        .send({ userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true })
    );
    expect(res.body.outcome).toBe("submitted");
  });

  /**
   * A page carrying a real-shaped reCAPTCHA v2 widget: the anchor iframe the
   * detector looks for, plus the bframe grid the solver drives. `markSolved`
   * flips the checkbox to checked, which is how the solver decides it worked.
   */
  function challengedPage(
    opts: { confirmAfterSolve?: boolean; confirmOnAttempt?: number } = {}
  ) {
    let solved = false;
    let confirmAttempts = 0;
    const confirmation = loc({
      waitFor: vi.fn(async () => {
        confirmAttempts++;
        // `confirmOnAttempt` models the real shape: the first submit shows
        // nothing, and only the post-solve resubmit confirms.
        if (opts.confirmOnAttempt && confirmAttempts >= opts.confirmOnAttempt) return;
        if (!(solved && opts.confirmAfterSolve)) throw new Error("timeout");
      })
    });
    const tiles = loc({ count: vi.fn(async () => 9) });
    tiles.nth = vi.fn(() => loc());
    const page = fakePage({
      url: JOB_URL,
      eval$$: () => goodFields(),
      locators: {
        "text=/": confirmation,
        'iframe[src*="recaptcha/api2/anchor"]': loc({ count: vi.fn(async () => 1) })
      },
      frames: {
        "recaptcha/api2/anchor": {
          "#recaptcha-anchor": loc({
            count: vi.fn(async () => 1),
            getAttribute: vi.fn(async () => (solved ? "true" : "false"))
          })
        },
        "recaptcha/api2/bframe": {
          ".rc-imageselect-instructions": loc({
            textContent: vi.fn(async () => "Select all crosswalks")
          }),
          "table td[role='button']": tiles,
          ".rc-imageselect-payload": loc({
            screenshot: vi.fn(async () => Buffer.from("grid"))
          }),
          "#recaptcha-reload-button": loc(),
          "#recaptcha-verify-button": loc()
        }
      }
    });
    return { page, markSolved: () => (solved = true) };
  }

  it("clears a challenge and resubmits, reporting a real submission", async () => {
    const { page, markSolved } = challengedPage({ confirmAfterSolve: true });
    const askSolver = vi.fn(async () => {
      markSolved();
      return [0];
    });
    const runPhase = vi.fn(
      async <T,>(_u: string, _h: string, fn: (c: never) => Promise<T>): Promise<T> =>
        fn({ page: page as unknown as Page, context: {}, key: "k" } as never)
    );
    // The solver is injected here; in production it is httpSolver(), which asks
    // the worker because the vision model lives there.
    const app = createApp({ runPhase, askSolver } as unknown as AppDeps);

    const res = await auth(
      request(app)
        .post("/fill")
        .send({ userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true })
    );

    expect(askSolver).toHaveBeenCalled();
    expect(res.body.outcome).toBe("submitted");
  });

  it("reports captcha_blocked when the challenge cannot be cleared", async () => {
    const { page } = challengedPage({ confirmAfterSolve: false });
    const askSolver = vi.fn(async () => []);
    const runPhase = vi.fn(
      async <T,>(_u: string, _h: string, fn: (c: never) => Promise<T>): Promise<T> =>
        fn({ page: page as unknown as Page, context: {}, key: "k" } as never)
    );
    const app = createApp({ runPhase, askSolver } as unknown as AppDeps);

    const res = await auth(
      request(app)
        .post("/fill")
        .send({ userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true })
    );

    expect(res.body.outcome).toBe("captcha_blocked");
  });

  it("clears a challenge that escalated ON submit, then resubmits and confirms", async () => {
    // The realistic shape: the first submit shows nothing and forces a puzzle,
    // we clear it, send again, and only then does the ATS confirm.
    const { page, markSolved } = challengedPage({ confirmOnAttempt: 2 });
    const askSolver = vi.fn(async () => {
      markSolved();
      return [0];
    });
    const runPhase = vi.fn(
      async <T,>(_u: string, _h: string, fn: (c: never) => Promise<T>): Promise<T> =>
        fn({ page: page as unknown as Page, context: {}, key: "k" } as never)
    );
    const app = createApp({ runPhase, askSolver } as unknown as AppDeps);

    const res = await auth(
      request(app)
        .post("/fill")
        .send({ userId: "u1", runId: "run-1", jobUrl: JOB_URL, ats: "lever", answers, submit: true })
    );

    expect(res.body.outcome).toBe("submitted");
  });

  it("falls back to the configured HTTP solver, attributing the spend to the run", async () => {
    // No askSolver injected: the real httpSolver() is built and asks the edge.
    // Here the edge is unreachable, so nothing is solved.
    const fetchMock = vi.fn().mockRejectedValue(new Error("edge unreachable"));
    vi.stubGlobal("fetch", fetchMock);
    const { page } = challengedPage();
    const runPhase = vi.fn(
      async <T,>(_u: string, _h: string, fn: (c: never) => Promise<T>): Promise<T> =>
        fn({ page: page as unknown as Page, context: {}, key: "k" } as never)
    );
    const app = createApp({ runPhase } as unknown as AppDeps);

    const res = await auth(
      request(app)
        .post("/fill")
        .send({ userId: "u1", runId: "run-1", jobUrl: JOB_URL, ats: "lever", answers, submit: true })
    );

    expect(res.body.outcome).toBe("captcha_blocked");
    expect(fetchMock.mock.calls[0][0]).toBe(CONFIG.solverUrl);
    // The model spend lands on the run that caused it, not on platform cost.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      userId: "u1",
      runId: "run-1"
    });
  });

  it("omits the run attribution when the caller sent none", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("edge unreachable"));
    vi.stubGlobal("fetch", fetchMock);
    const { page } = challengedPage();
    const runPhase = vi.fn(
      async <T,>(_u: string, _h: string, fn: (c: never) => Promise<T>): Promise<T> =>
        fn({ page: page as unknown as Page, context: {}, key: "k" } as never)
    );
    const app = createApp({ runPhase } as unknown as AppDeps);

    await auth(
      request(app)
        .post("/fill")
        .send({ userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true })
    );

    expect("runId" in JSON.parse(fetchMock.mock.calls[0][1].body)).toBe(false);
  });

  it("tolerates the solve attempt itself exploding", async () => {
    // frameLocator throwing makes solveChallenge reject outright, which both the
    // pre-submit and post-submit attempts have to absorb.
    const page = fakePage({
      url: JOB_URL,
      eval$$: () => goodFields(),
      locators: {
        "text=/": loc({
          waitFor: vi.fn(async () => {
            throw new Error("timeout");
          })
        }),
        'iframe[src*="recaptcha/api2/anchor"]': loc({ count: vi.fn(async () => 1) })
      }
    });
    page.frameLocator = vi.fn(() => {
      throw new Error("frame gone");
    });
    const runPhase = vi.fn(
      async <T,>(_u: string, _h: string, fn: (c: never) => Promise<T>): Promise<T> =>
        fn({ page: page as unknown as Page, context: {}, key: "k" } as never)
    );
    const app = createApp({
      runPhase,
      askSolver: vi.fn(async () => [0])
    } as unknown as AppDeps);

    const res = await auth(
      request(app)
        .post("/fill")
        .send({ userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true })
    );

    expect(res.body.outcome).toBe("captcha_blocked");
  });

  it("tolerates the resubmit and its confirmation throwing after a solve", async () => {
    let submits = 0;
    const submitBtn = loc({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => {
        // The first submit works; the post-solve resubmit is refused.
        if (++submits > 1) throw new Error("detached");
      })
    });
    const page = fakePage({
      url: JOB_URL,
      eval$$: () => goodFields(),
      locators: {
        "button[type=": submitBtn,
        "text=/": loc({
          waitFor: vi.fn(async () => {
            throw new Error("timeout");
          })
        }),
        'iframe[src*="recaptcha/api2/anchor"]': loc({ count: vi.fn(async () => 1) })
      },
      // Already checked, so the solve reports success without a grid.
      frames: {
        "recaptcha/api2/anchor": {
          "#recaptcha-anchor": loc({
            count: vi.fn(async () => 1),
            getAttribute: vi.fn(async () => "true")
          })
        }
      }
    });
    // After the resubmit, reading the page throws, so confirmSubmitted rejects.
    page.url = vi.fn(() => {
      if (submits > 1) throw new Error("page crashed");
      return JOB_URL;
    });
    const runPhase = vi.fn(
      async <T,>(_u: string, _h: string, fn: (c: never) => Promise<T>): Promise<T> =>
        fn({ page: page as unknown as Page, context: {}, key: "k" } as never)
    );
    const app = createApp({
      runPhase,
      askSolver: vi.fn(async () => [0])
    } as unknown as AppDeps);

    const res = await auth(
      request(app)
        .post("/fill")
        .send({ userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true })
    );

    expect(res.body.outcome).toBe("captcha_blocked");
  });

  it("reports captcha_blocked when the solve worked but the ATS still never confirms", async () => {
    // Cleared the puzzle and resubmitted, and the employer still showed nothing.
    // Honest outcome: everything is filled, finish it on their site.
    const { page, markSolved } = challengedPage({ confirmAfterSolve: false });
    const askSolver = vi.fn(async () => {
      markSolved();
      return [0];
    });
    const runPhase = vi.fn(
      async <T,>(_u: string, _h: string, fn: (c: never) => Promise<T>): Promise<T> =>
        fn({ page: page as unknown as Page, context: {}, key: "k" } as never)
    );
    const app = createApp({ runPhase, askSolver } as unknown as AppDeps);

    const res = await auth(
      request(app)
        .post("/fill")
        .send({ userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true })
    );

    expect(res.body.outcome).toBe("captcha_blocked");
  });

  it("survives a solver that throws during the pre-submit attempt", async () => {
    const { page } = challengedPage();
    const askSolver = vi.fn(async () => {
      throw new Error("edge down");
    });
    const runPhase = vi.fn(
      async <T,>(_u: string, _h: string, fn: (c: never) => Promise<T>): Promise<T> =>
        fn({ page: page as unknown as Page, context: {}, key: "k" } as never)
    );
    const app = createApp({ runPhase, askSolver } as unknown as AppDeps);

    const res = await auth(
      request(app)
        .post("/fill")
        .send({ userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true })
    );

    expect(res.body.outcome).toBe("captcha_blocked");
  });

  it("reports captcha_blocked when a challenge is on screen and nothing confirmed", async () => {
    const missing = loc({
      waitFor: vi.fn(async () => {
        throw new Error("timeout");
      })
    });
    const page = fakePage({
      url: JOB_URL,
      eval$$: () => goodFields(),
      locators: {
        "text=/": missing,
        // The anti-bot widget the employer put in front of the submit.
        'iframe[src*="recaptcha/api2/anchor"]': loc({ count: vi.fn(async () => 1) })
      }
    });
    const { app } = appWith(page);

    const res = await auth(
      request(app)
        .post("/fill")
        .send({ userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true })
    );

    // A specific, honest outcome: the application was filled, an anti-bot check
    // stopped the send, and metering treats that as work done.
    expect(res.body.outcome).toBe("captcha_blocked");
  });

  it("reports unconfirmed rather than claiming success", async () => {
    const missing = loc({
      waitFor: vi.fn(async () => {
        throw new Error("timeout");
      })
    });
    const page = fakePage({
      url: JOB_URL,
      eval$$: () => goodFields(),
      locators: { "text=/": missing }
    });
    const { app } = appWith(page);
    const res = await auth(
      request(app)
        .post("/fill")
        .send({ userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true })
    );
    expect(res.body.outcome).toBe("unconfirmed");
  });

  it("reports unconfirmed when confirmation itself crashes, never a false success", async () => {
    let submitted = false;
    const submitBtn = loc({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => {
        submitted = true;
      })
    });
    const page = fakePage({
      url: JOB_URL,
      eval$$: () => goodFields(),
      locators: {
        "button[type=": submitBtn,
        // No confirmation element appears, so the adapter falls back to the URL.
        "text=/": loc({
          waitFor: vi.fn(async () => {
            throw new Error("timeout");
          })
        })
      }
    });
    // Once submitted, reading the page throws, so confirmSubmitted REJECTS. The
    // phase must still answer honestly instead of letting the error escape.
    page.url = vi.fn(() => {
      if (submitted) throw new Error("page crashed");
      return JOB_URL;
    });

    const { app } = appWith(page);
    const res = await auth(
      request(app)
        .post("/fill")
        .send({ userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true })
    );
    expect(res.body.outcome).toBe("unconfirmed");
  });

  it("fills each page of a Workday wizard", async () => {
    const next = loc({ count: vi.fn(async () => 1), isEnabled: vi.fn(async () => true) });
    let advanced = 0;
    next.click = vi.fn(async () => {
      advanced++;
    });
    const field = loc({
      count: vi.fn(async () => 1),
      evaluate: vi.fn(async () => ({ tag: "input", type: "text", cls: "", role: "", autocomplete: "" }))
    });
    const wd = fakePage({
      url: WD_URL,
      eval$$: () => goodFields(),
      locators: {
        '[data-automation-id="pageFooterNextButton"]': next,
        '[data-automation-id="pageFooterSubmitButton"]': loc({
          count: vi.fn(async () => (advanced >= 1 ? 1 : 0))
        }),
        "[name=": field
      }
    });
    const { app } = appWith(wd);

    const res = await auth(
      request(app).post("/fill").send({ userId: "u1", jobUrl: WD_URL, ats: "workday", answers })
    );

    expect(res.body.pages).toBe(2);
    // Once per page.
    expect(field.pressSequentially).toHaveBeenCalledTimes(2);
  });

  it("wraps a crash as render_failed", async () => {
    const runPhase = vi.fn(async () => {
      throw new Error("oom");
    });
    const app = createApp({ runPhase } as unknown as AppDeps);
    const res = await auth(
      request(app).post("/fill").send({ userId: "u1", jobUrl: JOB_URL, ats: "lever", answers })
    );
    expect(res.body.error).toBe("render_failed");
  });
});

describe("concurrency gate", () => {
  it("queues browser work past the configured limit instead of failing it", async () => {
    let active = 0;
    let peak = 0;
    const runPhase = vi.fn(async <T>(_u: string, _h: string, fn: (c: never) => Promise<T>) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      const out = await fn({ page: formPage() as unknown as Page, context: {}, key: "k" } as never);
      active--;
      return out;
    });
    const app = createApp({ runPhase } as unknown as AppDeps);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        auth(request(app).post("/extract").send({ userId: "u1", jobUrl: JOB_URL, ats: "lever" }))
      )
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(peak).toBeLessThanOrEqual(CONFIG.maxConcurrency);
  });
});
