import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePage, loc } from "./helpers/fake-page";
import type { Env, RunParams } from "../src/types";

const launch = vi.hoisted(() => vi.fn());
vi.mock("@cloudflare/playwright", () => ({ launch }));

const adapter = vi.hoisted(() => ({
  formSelector: "form",
  openApplication: vi.fn(async () => {}),
  submit: vi.fn(async () => {}),
  confirmSubmitted: vi.fn(async () => true)
}));
vi.mock("../src/adapters", () => ({ ADAPTERS: { lever: adapter, greenhouse: adapter } }));

const db = vi.hoisted(() => ({ getPlaybook: vi.fn(async () => null), recordPlaybookFailure: vi.fn(async () => {}) }));
vi.mock("../src/db", () => db);

const gemini = vi.hoisted(() => ({ diagnosePage: vi.fn() }));
vi.mock("../src/gemini", () => gemini);

const captcha = vi.hoisted(() => ({
  detectInteractiveChallenge: vi.fn(async () => null),
  solveInteractiveChallenge: vi.fn(async () => false)
}));
vi.mock("../src/captcha-vision", () => captcha);

import { extractForm, fillAndMaybeSubmit, FormNotFoundError } from "../src/browser";

const env = { BROWSER: {} } as Env;
const REAL_FORM = [
  { name: "email", label: "Email", type: "email", required: true, options: [] },
  { name: "first_name", label: "First name", type: "text", required: true, options: [] }
];

function params(over: Partial<RunParams> = {}): RunParams {
  return {
    runId: "r1", applicationId: "a1", userId: "u1",
    jobUrl: "https://jobs.lever.co/acme/1", ats: "lever", autonomy: "review_gate",
    jobTitle: "Eng", jobCompany: "Acme", jobDescription: "d", profile: {},
    resume: { signedUrl: null, fileName: "r.pdf", mimeType: "application/pdf" },
    ...over
  } as RunParams;
}

/** Point launch at a specific fake page for the next withBrowser call. */
function usePage(page: unknown) {
  launch.mockResolvedValue({ newPage: async () => page, close: vi.fn(async () => {}) });
}

beforeEach(() => {
  vi.clearAllMocks();
  adapter.confirmSubmitted.mockResolvedValue(true);
  db.getPlaybook.mockResolvedValue(null);
  captcha.detectInteractiveChallenge.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllGlobals());

describe("withBrowser", () => {
  it("throws when the BROWSER binding is missing", async () => {
    await expect(extractForm({} as Env, params())).rejects.toThrow(/BROWSER binding/);
  });
});

describe("extractForm", () => {
  it("returns fields from the adapter scope on the happy path", async () => {
    const page = fakePage({ eval$$: () => REAL_FORM });
    usePage(page);
    const result = await extractForm(env, params());
    expect(result.recovery).toBeNull();
    expect(result.fields.map((f) => f.name)).toEqual(["email", "first_name"]);
  });

  it("recovers via a stored playbook", async () => {
    db.getPlaybook.mockResolvedValue({ action: "scroll" });
    let call = 0;
    const page = fakePage({ eval$$: () => (++call === 1 ? [] : REAL_FORM) });
    usePage(page);
    const result = await extractForm(env, params());
    expect(result.recovery).toEqual({ source: "playbook", strategy: { action: "scroll" }, domain: "jobs.lever.co" });
  });

  it("recovers via a playbook page-wide sweep", async () => {
    db.getPlaybook.mockResolvedValue({ action: "click", click_text: "Apply" });
    // adapter scope empty both times; body sweep succeeds
    const page = fakePage({
      eval$$: (selector) => (selector.startsWith("body") ? REAL_FORM : [])
    });
    usePage(page);
    const result = await extractForm(env, params());
    expect(result.scope ?? "body").toBeDefined();
    expect(result.recovery?.source).toBe("playbook");
  });

  it("recovers via vision when it sees a form and the body sweep succeeds", async () => {
    gemini.diagnosePage.mockResolvedValue({ form_visible: true, action: "none", reason: "form here" });
    const page = fakePage({ eval$$: (selector) => (selector.startsWith("body") ? REAL_FORM : []) });
    usePage(page);
    const result = await extractForm(env, params());
    expect(result.recovery?.source).toBe("vision");
  });

  it("recovers via vision with a click action", async () => {
    gemini.diagnosePage.mockResolvedValueOnce({ form_visible: false, action: "click", click_text: "Apply Now", reason: "button" });
    let call = 0;
    const page = fakePage({
      locators: { ':has-text("Apply Now")': loc({ count: async () => 1 }) },
      eval$$: () => (++call <= 1 ? [] : REAL_FORM)
    });
    usePage(page);
    const result = await extractForm(env, params());
    expect(result.recovery?.strategy.action).toBe("click");
  });

  it("throws FormNotFoundError when vision finds no path", async () => {
    gemini.diagnosePage.mockResolvedValue({ form_visible: false, action: "none", reason: "nothing here" });
    const page = fakePage({ eval$$: () => [] });
    usePage(page);
    await expect(extractForm(env, params())).rejects.toBeInstanceOf(FormNotFoundError);
  });

  it("throws FormNotFoundError when diagnosis itself fails", async () => {
    gemini.diagnosePage.mockRejectedValue(new Error("vision down"));
    const page = fakePage({ eval$$: () => [] });
    usePage(page);
    await expect(extractForm(env, params())).rejects.toBeInstanceOf(FormNotFoundError);
  });
});

describe("fillAndMaybeSubmit", () => {
  it("fills for review (no submit)", async () => {
    const page = fakePage({ eval$$: () => REAL_FORM });
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params(), [{ name: "email", label: "Email", value: "a@b.com" }], false);
    expect(res.outcome).toBe("filled");
  });

  it("submits and confirms", async () => {
    const page = fakePage({ eval$$: () => REAL_FORM });
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params(), [{ name: "email", label: "Email", value: "a@b.com" }], true);
    expect(res.outcome).toBe("submitted");
  });

  it("reports unconfirmed when no confirmation and no captcha", async () => {
    adapter.confirmSubmitted.mockResolvedValue(false);
    const page = fakePage({ eval$$: () => REAL_FORM });
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params(), [], true);
    expect(res.outcome).toBe("unconfirmed");
  });

  it("reports captcha_blocked when a challenge escalates and cannot be solved", async () => {
    adapter.confirmSubmitted.mockResolvedValue(false);
    captcha.detectInteractiveChallenge.mockResolvedValueOnce(null).mockResolvedValue("recaptcha_v2");
    const page = fakePage({ eval$$: () => REAL_FORM });
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params(), [], true);
    expect(res.outcome).toBe("captcha_blocked");
  });

  it("submits after solving an escalated challenge", async () => {
    adapter.confirmSubmitted.mockResolvedValueOnce(false).mockResolvedValue(true);
    captcha.detectInteractiveChallenge.mockResolvedValueOnce(null).mockResolvedValue("recaptcha_v2");
    captcha.solveInteractiveChallenge.mockResolvedValue(true);
    const page = fakePage({ eval$$: () => REAL_FORM });
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params(), [], true);
    expect(res.outcome).toBe("submitted");
  });

  it("solves a pre-submit challenge when present", async () => {
    captcha.detectInteractiveChallenge.mockResolvedValueOnce("hcaptcha").mockResolvedValue(null);
    const page = fakePage({ eval$$: () => REAL_FORM });
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params(), [], true);
    expect(captcha.solveInteractiveChallenge).toHaveBeenCalled();
    expect(res.outcome).toBe("submitted");
  });
});
