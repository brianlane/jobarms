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
import { phase } from "./helpers/phase";

const TOKEN = CONFIG.token;
const JOB_URL = "https://jobs.lever.co/acme/1/apply";
const WD_URL = "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/1";
const LI_URL = "https://www.linkedin.com/jobs/view/4442245127/";

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

  it("reports an unknown job id as a structured error the worker can retry", async () => {
    const { app } = appWith(formPage());
    const res = await auth(request(app).get("/jobs/00000000-0000-0000-0000-000000000000"));
    // 200 with a code, not a 404: the tunnel would keep the status but this is
    // the shape every other sidecar failure uses.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ error: "job_not_found" });
  });
});

describe("DELETE /session", () => {
  it("400s when either the userId or tenantHost is missing", async () => {
    const { app } = appWith(formPage());
    // No body at all (req.body undefined), then each half missing on its own.
    const res = await auth(request(app).delete("/session"));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_body" });
    for (const body of [{ userId: "u1" }, { tenantHost: "www.linkedin.com" }]) {
      expect((await auth(request(app).delete("/session").send(body))).status).toBe(400);
    }
  });

  it("forgets the session and reports ok", async () => {
    const { app } = appWith(formPage());
    const res = await auth(
      request(app).delete("/session").send({ userId: "u1", tenantHost: "www.linkedin.com" })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("requires the bearer", async () => {
    const { app } = appWith(formPage());
    if (!TOKEN) return;
    const res = await request(app).delete("/session").send({ userId: "u1", tenantHost: "h" });
    expect(res.status).toBe(401);
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
      const res = await phase(app, "/extract", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toEqual({ error: "invalid_body" });
    }
  });

  it("refuses an unsafe URL with a 200-wrapped structured error", async () => {
    const { app } = appWith(formPage());
    const res = await phase(app, "/extract", { userId: "u1", jobUrl: "http://127.0.0.1/", ats: "lever" });
    // 200 on purpose: a Tunnel would replace a 5xx body and hide the code.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ error: "invalid_or_unsafe_url" });
  });

  it("validates /fill's answers array", async () => {
    const { app } = appWith(formPage());
    const res = await phase(app, "/fill", { userId: "u1", jobUrl: JOB_URL, ats: "lever" });
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
    const res = await phase(app, "/session/ensure", { userId: "u1", jobUrl: JOB_URL, ats: "lever" });
    expect(res.body).toEqual({ status: "authenticated", accountRequired: false });
    // No browser work at all for Greenhouse/Lever.
    expect(runPhase).not.toHaveBeenCalled();
  });

  it("requires credentials for an account-gated ATS", async () => {
    const { app } = appWith(formPage());
    const res = await phase(app, "/session/ensure", { userId: "u1", jobUrl: WD_URL, ats: "workday" });
    expect(res.status).toBe(400);
  });

  it("reports the account status and a screenshot", async () => {
    // No credentials form on the page, so the session is already authenticated.
    const page = fakePage({ url: WD_URL, evaluate: () => "" });
    const { app } = appWith(page);
    const res = await phase(app, "/session/ensure", {
          userId: "u1",
          jobUrl: WD_URL,
          ats: "workday",
          account: TEST_CREDS
        });
    expect(res.body).toMatchObject({ status: "authenticated", accountRequired: true });
    expect(res.body.screenshotBase64).toBe(Buffer.from([1]).toString("base64"));
  });

  it("wraps a browser crash as render_failed", async () => {
    const runPhase = vi.fn(async () => {
      throw new Error("browser died");
    });
    const app = createApp({ runPhase } as unknown as AppDeps);
    const res = await phase(app, "/session/ensure", {
          userId: "u1",
          jobUrl: WD_URL,
          ats: "workday",
          account: TEST_CREDS
        });
    expect(res.status).toBe(200);
    expect(res.body.error).toBe("render_failed");
    expect(res.body.detail).toContain("browser died");
  });

  it("signs in to LinkedIn with the user's own login", async () => {
    // A fresh page with no login form reads as an already-valid session.
    const page = fakePage({ url: "https://www.linkedin.com/feed/", evaluate: () => "" });
    const { app } = appWith(page);
    const res = await phase(app, "/session/ensure", {
      userId: "u1",
      jobUrl: LI_URL,
      ats: "linkedin",
      account: TEST_CREDS
    });
    expect(res.body).toMatchObject({ status: "authenticated", accountRequired: true });
    expect(res.body.checkpointUrl).toBeUndefined();
  });

  it("returns needs_login_code with the checkpoint URL on a PIN challenge", async () => {
    const page = fakePage({
      locators: {
        "#username": loc({ count: vi.fn(async () => 1) }),
        "#password": loc({ count: vi.fn(async () => 1) }),
        'input[type="password"]': loc({ count: vi.fn(async () => 1) }),
        'button[type="submit"]': loc({ count: vi.fn(async () => 1) }),
        'input[name="pin"]': loc({ count: vi.fn(async () => 1) })
      }
    });
    page.goto = vi.fn(async () => {});
    page.url = vi.fn(() => "https://www.linkedin.com/checkpoint/challenge/9");
    const { app } = appWith(page);

    const res = await phase(app, "/session/ensure", {
      userId: "u1",
      jobUrl: LI_URL,
      ats: "linkedin",
      account: TEST_CREDS
    });

    expect(res.body).toMatchObject({
      status: "needs_login_code",
      accountRequired: true,
      checkpointUrl: "https://www.linkedin.com/checkpoint/challenge/9"
    });
  });
});

describe("POST /login-code", () => {
  it("400s without a userId, tenantHost, and code", async () => {
    const { app } = appWith(formPage());
    // No body at all (req.body undefined), then each field missing on its own.
    expect((await auth(request(app).post("/login-code"))).status).toBe(400);
    for (const body of [
      { tenantHost: "www.linkedin.com", code: "483920" },
      { userId: "u1", code: "483920" },
      { userId: "u1", tenantHost: "www.linkedin.com" }
    ]) {
      expect((await auth(request(app).post("/login-code").send(body))).status).toBe(400);
    }
  });

  it("submits the code (with the checkpoint URL) and reports the status", async () => {
    const page = fakePage({
      locators: { 'input[name="pin"]': loc({ count: vi.fn(async () => 1) }) },
      evaluate: () => ""
    });
    // The code clears the challenge and the session lands on the feed.
    page.goto = vi.fn(async () => {});
    page.url = vi.fn(() => "https://www.linkedin.com/feed/");
    const { app } = appWith(page);
    const res = await auth(
      request(app).post("/login-code").send({
        userId: "u1",
        tenantHost: "www.linkedin.com",
        code: "483920",
        checkpointUrl: "https://www.linkedin.com/checkpoint/challenge/1"
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("authenticated");
    // The code-entry step resumed at the captured checkpoint URL.
    expect((page.goto as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "https://www.linkedin.com/checkpoint/challenge/1"
    );
  });

  it("hands back the new checkpoint URL when LinkedIn re-prompts", async () => {
    const page = fakePage({
      locators: { 'input[name="pin"]': loc({ count: vi.fn(async () => 1) }) },
      evaluate: () => ""
    });
    page.goto = vi.fn(async () => {});
    page.url = vi.fn(() => "https://www.linkedin.com/checkpoint/challenge/2");
    const { app } = appWith(page);
    const res = await auth(
      request(app)
        .post("/login-code")
        .send({ userId: "u1", tenantHost: "www.linkedin.com", code: "000000" })
    );
    expect(res.body.status).toBe("needs_login_code");
    expect(res.body.checkpointUrl).toBe("https://www.linkedin.com/checkpoint/challenge/2");
  });

  it("wraps a browser crash as render_failed", async () => {
    const runPhase = vi.fn(async () => {
      throw new Error("browser died");
    });
    const app = createApp({ runPhase } as unknown as AppDeps);
    const res = await auth(
      request(app)
        .post("/login-code")
        .send({ userId: "u1", tenantHost: "www.linkedin.com", code: "483920" })
    );
    expect(res.body.error).toBe("render_failed");
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

describe("POST /search", () => {
  const RAW = [
    {
      href: "https://www.linkedin.com/jobs/view/4442245127/?refId=z",
      title: "Frontend Eng",
      company: "Acme",
      location: "Remote"
    }
  ];

  it("400s without a userId or a positive limit (or any body at all)", async () => {
    const { app } = appWith(fakePage());
    expect((await auth(request(app).post("/search"))).status).toBe(400);
    for (const body of [
      { keywords: "react", limit: 5 },
      { userId: "u1", keywords: "react" },
      { userId: "u1", keywords: "react", limit: 0 },
      { userId: "u1", keywords: "react", limit: "five" }
    ]) {
      const res = await auth(request(app).post("/search").send(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toEqual({ error: "invalid_body" });
    }
  });

  it("searches in the held LinkedIn session and returns the cards", async () => {
    const page = fakePage({ evaluate: () => RAW });
    const { app, runPhase } = appWith(page);

    const res = await phase(app, "/search", {
      userId: "u1",
      keywords: "react",
      location: "Denver",
      remote: true,
      // A fractional limit is floored, not rejected.
      limit: 2.9
    });

    expect(res.body).toEqual({
      cards: [
        {
          jobId: "4442245127",
          url: "https://www.linkedin.com/jobs/view/4442245127/",
          title: "Frontend Eng",
          company: "Acme",
          location: "Remote"
        }
      ]
    });
    // The session is keyed to LinkedIn itself, not any job URL.
    expect(runPhase.mock.calls[0][1]).toBe("www.linkedin.com");
  });

  it("defaults the optional fields and wraps a dead browser as render_failed", async () => {
    const runPhase = vi.fn(async () => {
      throw new Error("browser crashed");
    });
    const { app } = appWith(fakePage(), { runPhase: runPhase as never });

    const res = await phase(app, "/search", { userId: "u1", limit: 3 });

    expect(res.body).toMatchObject({ error: "render_failed" });
    expect(String(res.body.detail)).toContain("browser crashed");
  });
});

describe("POST /extract", () => {
  it("returns the filtered field set, scope, and a screenshot", async () => {
    const { app } = appWith(formPage());
    const res = await phase(app, "/extract", { userId: "u1", jobUrl: JOB_URL, ats: "lever" });
    expect(res.status).toBe(200);
    // The file input is dropped: attachResume owns it, so it is not a question.
    expect(res.body.fields.map((f: { name: string }) => f.name)).toEqual(["name", "email"]);
    expect(res.body).toMatchObject({ pages: 1, scope: "form", recovery: null });
    expect(res.body.screenshotBase64).toBeTruthy();
  });

  it("reports form_not_found with a screenshot so the caller can run vision", async () => {
    const { app } = appWith(fakePage({ url: JOB_URL, eval$$: () => [] }));
    const res = await phase(app, "/extract", { userId: "u1", jobUrl: JOB_URL, ats: "lever" });
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
    const res = await phase(app, "/extract", { userId: "u1", jobUrl: JOB_URL, ats: "lever" });
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
    const res = await phase(app, "/extract", { userId: "u1", jobUrl: JOB_URL, ats: "lever", playbook: { action: "scroll" } });
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

    const res = await phase(app, "/extract", { userId: "u1", jobUrl: WD_URL, ats: "workday" });

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
    const res = await phase(app, "/extract", { userId: "u1", jobUrl: WD_URL, ats: "workday" });
    expect(res.body.pages).toBe(CONFIG.maxWizardPages);
  });

  it("still returns answers when the screenshot fails", async () => {
    const { app } = appWith(formPage({ screenshotThrows: true }));
    const res = await phase(app, "/extract", { userId: "u1", jobUrl: JOB_URL, ats: "lever" });
    expect(res.body.screenshotBase64).toBeNull();
    expect(res.body.fields).toHaveLength(2);
  });

  it("wraps an unexpected crash as render_failed", async () => {
    const runPhase = vi.fn(async () => {
      throw new Error("chromium segfault");
    });
    const app = createApp({ runPhase } as unknown as AppDeps);
    const res = await phase(app, "/extract", { userId: "u1", jobUrl: JOB_URL, ats: "lever" });
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

    const res = await phase(app, "/fill", {
        userId: "u1",
        jobUrl: JOB_URL,
        ats: "lever",
        answers,
        resume: {
          contentBase64: Buffer.from("%PDF-1.7 fake").toString("base64"),
          fileName: "cv.pdf",
          mimeType: "application/pdf"
        }
      });

    expect(res.body).toMatchObject({ outcome: "filled", pages: 1 });
    expect(fileInput.setInputFiles).toHaveBeenCalled();
    expect(field.pressSequentially).toHaveBeenCalledWith("Brian", expect.anything());
  });

  it("defaults to no resume when none is supplied", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { app } = appWith(formPage());
    const res = await phase(app, "/fill", { userId: "u1", jobUrl: JOB_URL, ats: "lever", answers });
    expect(res.body.outcome).toBe("filled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * The interlock. `$$eval` answers both the field collector and the read-back,
   * so the stub hands out fields first and the form's state afterwards.
   */
  function disagreeingPage(checked: string[]) {
    let call = 0;
    return fakePage({
      url: JOB_URL,
      eval$$: () =>
        call++ === 0
          ? [
              { name: "name", label: "Full name", type: "text", required: true, options: [] },
              { name: "email", label: "Email", type: "email", required: true, options: [] },
              { name: "q[]", label: "Sanctions", type: "checkbox", required: true, options: [] }
            ]
          : [
              { name: "name", kind: "text", checked: [], value: "Brian", count: 1 },
              { name: "q[]", kind: "choice", checked, value: "", count: 4 }
            ],
      locators: { "text=/": loc() }
    });
  }
  const choiceAnswers = [
    { name: "name", label: "Full name", value: "Brian" },
    { name: "q[]", label: "Sanctions", value: "None of the above" }
  ];

  it("refuses to submit when a choice field disagrees with the approved answer", async () => {
    // Exactly what shipped once: a sanctions box ticked opposite to the answer.
    // Submitting that sends a false statement, so the arm must not.
    const { app } = appWith(disagreeingPage(["Ordinarily a resident of Cuba"]));
    const res = await phase(app, "/fill", {
      userId: "u1",
      jobUrl: JOB_URL,
      ats: "lever",
      answers: choiceAnswers,
      submit: true
    });

    expect(res.body.outcome).toBe("verification_failed");
    expect(res.body.mismatches).toHaveLength(1);
    expect(res.body.mismatches[0]).toMatchObject({
      name: "q[]",
      expected: "None of the above"
    });
  });

  it("discards the LinkedIn modal rather than leave a draft when it refuses", async () => {
    // Same interlock, but on LinkedIn the abandoned Easy Apply modal would sit
    // open as a saved draft, so the adapter's discard runs before returning.
    const { app } = appWith(disagreeingPage(["Ordinarily a resident of Cuba"]));
    const res = await phase(app, "/fill", {
      userId: "u1",
      jobUrl: LI_URL,
      ats: "linkedin",
      answers: choiceAnswers,
      submit: true
    });

    expect(res.body.outcome).toBe("verification_failed");
  });

  it("still refuses even if discarding the modal throws", async () => {
    // The discard is best-effort: a modal that vanished mid-teardown must not
    // turn a refusal into a crash.
    let call = 0;
    const page = fakePage({
      url: LI_URL,
      eval$$: () =>
        call++ === 0
          ? [
              { name: "name", label: "Full name", type: "text", required: true, options: [] },
              { name: "q[]", label: "Sanctions", type: "checkbox", required: true, options: [] }
            ]
          : [{ name: "q[]", kind: "choice", checked: ["Ordinarily a resident of Cuba"], value: "", count: 4 }],
      locators: {
        "text=/": loc(),
        'button[aria-label="Dismiss"]': loc({
          count: vi.fn(async () => {
            throw new Error("modal gone");
          })
        })
      }
    });
    const { app } = appWith(page);
    const res = await phase(app, "/fill", {
      userId: "u1",
      jobUrl: LI_URL,
      ats: "linkedin",
      answers: choiceAnswers,
      submit: true
    });
    expect(res.body.outcome).toBe("verification_failed");
  });

  it("submits normally when the read-back agrees", async () => {
    const { app } = appWith(disagreeingPage(["None of the above"]));
    const res = await phase(app, "/fill", {
      userId: "u1",
      jobUrl: JOB_URL,
      ats: "lever",
      answers: choiceAnswers,
      submit: true
    });

    expect(res.body.outcome).toBe("submitted");
    expect(res.body.mismatches).toEqual([]);
  });

  it("reports mismatches on a review fill without refusing anything", async () => {
    // Review gate never submits, so the interlock has nothing to stop; the point
    // is that the disagreement still reaches the user.
    const { app } = appWith(disagreeingPage([]));
    const res = await phase(app, "/fill", {
      userId: "u1",
      jobUrl: JOB_URL,
      ats: "lever",
      answers: choiceAnswers
    });

    expect(res.body.outcome).toBe("filled");
    expect(res.body.mismatches[0].actual).toBe("(nothing)");
  });

  describe("trying the other way when a field does not take", () => {
    /** Fields first, then a read-back that disagrees until the retry lands. */
    function stubbornPage(fixedOnRetry: boolean) {
      let call = 0;
      return fakePage({
        url: JOB_URL,
        eval$$: () => {
          call++;
          if (call === 1) {
            // Must look like a real application form or reachForm keeps looking,
            // which would consume the reads this stub is counting.
            return [
              ...goodFields(),
              { name: "q[]", label: "Sanctions", type: "checkbox", required: true, options: [] }
            ];
          }
          // call 2 = first read-back (wrong), call 3 = after the retry.
          const checked = call >= 3 && fixedOnRetry ? ["None of the above"] : [];
          return [{ name: "q[]", kind: "choice", checked, value: "", count: 4 }];
        },
        locators: { "text=/": loc() }
      });
    }
    const choiceAnswer = [{ name: "q[]", label: "Sanctions", value: "None of the above" }];

    it("reports which way worked, so the site can be remembered", async () => {
      const { app } = appWith(stubbornPage(true));
      const res = await phase(app, "/fill", {
        userId: "u1",
        jobUrl: JOB_URL,
        ats: "lever",
        answers: choiceAnswer
      });

      expect(res.body.mismatches).toEqual([]);
      // The default drives the input; clicking the label is the other way.
      expect(res.body.tactics).toEqual([{ kind: "choice", tactic: "label" }]);
    });

    it("learns the text tactic too, not just the choice one", async () => {
      let call = 0;
      const page = fakePage({
        url: JOB_URL,
        eval$$: () => {
          call++;
          if (call === 1) return goodFields();
          // The email never takes until the retry sets it in one go.
          const value = call >= 3 ? "a@b.com" : "";
          return [{ name: "email", kind: "text", checked: [], value, count: 1 }];
        }
      });
      const { app } = appWith(page);

      const res = await phase(app, "/fill", {
        userId: "u1",
        jobUrl: JOB_URL,
        ats: "lever",
        answers: [{ name: "email", label: "Email", value: "a@b.com" }]
      });

      expect(res.body.mismatches).toEqual([]);
      expect(res.body.tactics).toEqual([{ kind: "text", tactic: "set" }]);
    });

    it("teaches nothing while a field of that kind is wrong on another page", async () => {
      // The regression: judging a win from the CURRENT page's read-back let a
      // clean second page teach a tactic while page one was still broken, which
      // is how you learn the wrong lesson confidently.
      let call = 0;
      const page = fakePage({
        url: WD_URL,
        eval$$: () => {
          call++;
          if (call === 1) {
            return [
              ...goodFields(),
              { name: "q1", label: "One", type: "checkbox", required: true, options: [] }
            ];
          }
          // Page one never comes right; page two is clean from the start.
          const onPageTwo = call >= 4;
          return onPageTwo
            ? [{ name: "q2", kind: "choice", checked: ["Yes"], value: "", count: 2 }]
            : [{ name: "q1", kind: "choice", checked: [], value: "", count: 2 }];
        }
      });
      let advanced = false;
      page.getByRole = vi.fn(() => loc({ count: vi.fn(async () => (advanced ? 0 : 1)) }));

      const { app } = appWith(page);
      const res = await phase(app, "/fill", {
        userId: "u1",
        jobUrl: WD_URL,
        ats: "workday",
        answers: [
          { name: "q1", label: "One", value: "None of the above" },
          { name: "q2", label: "Two", value: "Yes" }
        ]
      });
      advanced = true;

      expect(res.body.mismatches.map((m: { name: string }) => m.name)).toEqual(["q1"]);
      expect(res.body.tactics).toEqual([]);
    });

    it("teaches nothing when the other way did not work either", async () => {
      const { app } = appWith(stubbornPage(false));
      const res = await phase(app, "/fill", {
        userId: "u1",
        jobUrl: JOB_URL,
        ats: "lever",
        answers: choiceAnswer
      });

      expect(res.body.mismatches).toHaveLength(1);
      expect(res.body.tactics).toEqual([]);
    });

    it("leads with the tactic the caller already learned", async () => {
      const { app } = appWith(formPage());
      const res = await phase(app, "/fill", {
        userId: "u1",
        jobUrl: JOB_URL,
        ats: "lever",
        answers,
        tactics: { choice: "label", text: "set" }
      });

      // Nothing disagreed, so nothing new was learned and nothing was retried.
      expect(res.body.outcome).toBe("filled");
      expect(res.body.tactics).toEqual([]);
    });
  });

  it("lets a later page's read-back supersede an earlier failure", async () => {
    // A Workday-style wizard where a control could not be driven on the first
    // pass and was driven correctly on the second. Appending every page's
    // findings would refuse to submit a form that is actually right.
    const fields = [
      { name: "q[]", label: "Sanctions", type: "checkbox", required: true, options: [] }
    ];
    let call = 0;
    const page = fakePage({
      url: WD_URL,
      eval$$: () => {
        call++;
        if (call === 1) return fields;
        // First read-back: empty. Second, after advancing: correct.
        const checked = call === 2 ? [] : ["None of the above"];
        return [{ name: "q[]", kind: "choice", checked, value: "", count: 4 }];
      },
      locators: { "text=/": loc() }
    });
    // A Workday page that can advance exactly once.
    let advanced = false;
    page.getByRole = vi.fn(() => loc({ count: vi.fn(async () => (advanced ? 0 : 1)) }));

    const { app } = appWith(page);
    const res = await phase(app, "/fill", {
      userId: "u1",
      jobUrl: WD_URL,
      ats: "workday",
      answers: [{ name: "q[]", label: "Sanctions", value: "None of the above" }],
      submit: false
    });
    advanced = true;

    // The verdict that counts is the last one, so nothing is reported.
    expect(res.body.outcome).toBe("filled");
    expect(res.body.mismatches).toEqual([]);
  });

  it("submits and reports a confirmed submission", async () => {
    const page = fakePage({
      url: JOB_URL,
      eval$$: () => goodFields(),
      // Lever confirms on a text= locator resolving.
      locators: { "text=/": loc() }
    });
    const { app } = appWith(page);
    const res = await phase(app, "/fill", { userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true });
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

    const res = await phase(app, "/fill", { userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true });

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

    const res = await phase(app, "/fill", { userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true });

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

    const res = await phase(app, "/fill", { userId: "u1", runId: "run-1", jobUrl: JOB_URL, ats: "lever", answers, submit: true });

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

    const res = await phase(app, "/fill", { userId: "u1", runId: "run-1", jobUrl: JOB_URL, ats: "lever", answers, submit: true });

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

    await phase(app, "/fill", { userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true });

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

    const res = await phase(app, "/fill", { userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true });

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

    const res = await phase(app, "/fill", { userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true });

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

    const res = await phase(app, "/fill", { userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true });

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

    const res = await phase(app, "/fill", { userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true });

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

    const res = await phase(app, "/fill", { userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true });

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
    const res = await phase(app, "/fill", { userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true });
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
    const res = await phase(app, "/fill", { userId: "u1", jobUrl: JOB_URL, ats: "lever", answers, submit: true });
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

    const res = await phase(app, "/fill", { userId: "u1", jobUrl: WD_URL, ats: "workday", answers });

    expect(res.body.pages).toBe(2);
    // Once per page.
    expect(field.pressSequentially).toHaveBeenCalledTimes(2);
  });

  it("wraps a crash as render_failed", async () => {
    const runPhase = vi.fn(async () => {
      throw new Error("oom");
    });
    const app = createApp({ runPhase } as unknown as AppDeps);
    const res = await phase(app, "/fill", { userId: "u1", jobUrl: JOB_URL, ats: "lever", answers });
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
        phase(app, "/extract", { userId: "u1", jobUrl: JOB_URL, ats: "lever" })
      )
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(peak).toBeLessThanOrEqual(CONFIG.maxConcurrency);
  });
});
