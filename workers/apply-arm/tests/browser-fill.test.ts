import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePage, loc } from "./helpers/fake-page";
import type { Answer, Env, RunParams } from "../src/types";

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
const captcha = vi.hoisted(() => ({ detectInteractiveChallenge: vi.fn(async () => null), solveInteractiveChallenge: vi.fn(async () => false) }));
vi.mock("../src/captcha-vision", () => captcha);

import { extractForm, fillAndMaybeSubmit } from "../src/browser";

const env = { BROWSER: {} } as Env;
const REAL_FORM = [
  { name: "email", label: "Email", type: "email", required: true, options: [] },
  { name: "first_name", label: "First name", type: "text", required: true, options: [] }
];
function params(over: Partial<RunParams> = {}): RunParams {
  return {
    runId: "r1", applicationId: "a1", userId: "u1", jobUrl: "https://jobs.lever.co/acme/1",
    ats: "lever", autonomy: "review_gate", jobTitle: "E", jobCompany: "A", jobDescription: "d",
    profile: {}, resume: { signedUrl: null, fileName: "r.pdf", mimeType: "application/pdf" }, ...over
  } as RunParams;
}
function usePage(page: unknown) {
  launch.mockResolvedValue({ newPage: async () => page, close: vi.fn(async () => {}) });
}
/** A field locator with count 1, a box, and a configurable evaluate(info). */
function field(info: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return loc({
    count: async () => 1,
    evaluate: async () => info,
    boundingBox: async () => ({ x: 0, y: 0, width: 20, height: 10 }),
    ...over
  });
}
const textInfo = { tag: "input", type: "text", cls: "", role: "", autocomplete: "" };

async function fillOne(answer: Answer, locators: Record<string, ReturnType<typeof loc>>, extra: Record<string, unknown> = {}) {
  const page = fakePage({ eval$$: () => REAL_FORM, locators, ...extra });
  usePage(page);
  return fillAndMaybeSubmit(env, params(), [answer], false);
}

beforeEach(() => {
  vi.clearAllMocks();
  adapter.submit.mockReset();
  adapter.submit.mockResolvedValue(undefined);
  adapter.confirmSubmitted.mockReset();
  adapter.confirmSubmitted.mockResolvedValue(true);
  captcha.detectInteractiveChallenge.mockReset();
  captcha.detectInteractiveChallenge.mockResolvedValue(null);
  captcha.solveInteractiveChallenge.mockReset();
  captcha.solveInteractiveChallenge.mockResolvedValue(false);
  db.getPlaybook.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllGlobals());

describe("fillField dispatch", () => {
  it("types a short text value char-by-char", async () => {
    const f = field(textInfo);
    const res = await fillOne({ name: "msg", label: "M", value: "hi" }, { 'name="msg"': f });
    expect(f.pressSequentially).toHaveBeenCalled();
    expect(res.outcome).toBe("filled");
  });

  it("fills a long text value instantly", async () => {
    const f = field(textInfo);
    await fillOne({ name: "bio", label: "B", value: "x".repeat(60) }, { 'name="bio"': f });
    expect(f.fill).toHaveBeenCalledWith("x".repeat(60));
  });

  it("selects an option, falling back to value when label fails", async () => {
    const f = field({ ...textInfo, tag: "select" }, {
      selectOption: vi.fn().mockRejectedValueOnce(new Error("no label")).mockResolvedValue(undefined)
    });
    await fillOne({ name: "yrs", label: "Years", value: "2" }, { 'name="yrs"': f });
    expect(f.selectOption).toHaveBeenCalledTimes(2);
  });

  it("skips file inputs (handled by attachResume)", async () => {
    const f = field({ ...textInfo, type: "file" });
    await fillOne({ name: "resume", label: "R", value: "x" }, { 'name="resume"': f });
    expect(f.fill).not.toHaveBeenCalled();
  });

  it("uses the page-wide fallback when the scoped selector misses", async () => {
    const scoped = loc({ count: async () => 0 });
    const wide = field(textInfo);
    // first locator() (scoped) returns count 0; the fallback [name=..] returns the field
    let n = 0;
    const page = fakePage({ eval$$: () => REAL_FORM });
    page.locator = vi.fn(() => (++n === 1 ? scoped : wide)) as never;
    usePage(page);
    await fillAndMaybeSubmit(env, params(), [{ name: "q", label: "Q", value: "a" }], false);
    expect(wide.pressSequentially).toHaveBeenCalled();
  });

  it("returns early when the field is nowhere on the page", async () => {
    const res = await fillOne({ name: "ghost", label: "G", value: "x" }, { 'name="ghost"': loc({ count: async () => 0 }) });
    expect(res.outcome).toBe("filled");
  });

  it("ticks the matching checkbox in a group and clears the rest (in-page label resolution)", async () => {
    (globalThis as unknown as { CSS?: unknown }).CSS = { escape: (s: string) => s };
    // box0 resolves its label via label[for=id]; box1 via a wrapping <label>.
    const box0 = loc({
      evaluate: async (fn: (n: unknown) => unknown) =>
        fn({ id: "ck1", ownerDocument: { querySelector: () => ({ textContent: "TypeScript" }) }, closest: () => null, getAttribute: () => null })
    });
    const box1 = loc({
      evaluate: async (fn: (n: unknown) => unknown) =>
        fn({ id: "", ownerDocument: { querySelector: () => null }, closest: () => ({ textContent: "Go" }), getAttribute: () => null })
    });
    const boxes = loc({ count: async () => 2, nth: vi.fn((i: number) => (i === 0 ? box0 : box1)) });
    const f = field({ ...textInfo, type: "checkbox" });
    await fillOne({ name: "skills", label: "S", value: "TypeScript" }, { 'input[type="checkbox"]': boxes, 'name="skills"': f });
    expect(box0.check).toHaveBeenCalled();
    expect(box1.uncheck).toHaveBeenCalled();
  });

  it("treats a checkbox label-evaluate failure as an empty label (unchecks)", async () => {
    const box0 = loc({ evaluate: async () => { throw new Error("x"); } });
    const boxes = loc({ count: async () => 2, nth: vi.fn(() => box0) });
    const f = field({ ...textInfo, type: "checkbox" });
    await fillOne({ name: "skills", label: "S", value: "TypeScript" }, { 'input[type="checkbox"]': boxes, 'name="skills"': f });
    expect(box0.uncheck).toHaveBeenCalled();
  });

  it("resolves a checkbox label via aria-label when there is no <label>", async () => {
    (globalThis as unknown as { CSS?: unknown }).CSS = undefined; // exercise the escape fallback
    const box0 = loc({
      evaluate: async (fn: (n: unknown) => unknown) =>
        fn({ id: "", ownerDocument: { querySelector: () => null }, closest: () => null, getAttribute: (k: string) => (k === "aria-label" ? "Remote" : null) })
    });
    const boxes = loc({ count: async () => 2, nth: vi.fn(() => box0) });
    const f = field({ ...textInfo, type: "checkbox" });
    await fillOne({ name: "loc", label: "L", value: "Remote" }, { 'input[type="checkbox"]': boxes, 'name="loc"': f });
    expect(box0.check).toHaveBeenCalled();
  });

  it("checks a lone boolean consent checkbox on a truthy value", async () => {
    const boxes = loc({ count: async () => 1 });
    const f = field({ ...textInfo, type: "checkbox" });
    await fillOne({ name: "agree", label: "Agree", value: "true" }, { 'input[type="checkbox"]': boxes, 'name="agree"': f });
    expect(boxes.check).toHaveBeenCalled();
  });

  it("selects the matching radio by label", async () => {
    const radio = loc({ getAttribute: async () => "rid" });
    const radios = loc({ count: async () => 1, nth: vi.fn(() => radio) });
    const f = field({ ...textInfo, type: "radio" });
    await fillOne(
      { name: "gender", label: "G", value: "Yes" },
      { 'input[type="radio"]': radios, 'label[for="rid"]': loc({ textContent: async () => "Yes" }), 'name="gender"': f }
    );
    expect(radio.check).toHaveBeenCalled();
  });
});

const comboInfo = { tag: "input", type: "text", cls: "select__input", role: "combobox", autocomplete: "list" };

describe("fillCombobox", () => {
  it("opens, clicks the exact option, and confirms the value committed", async () => {
    const evaluate = vi.fn().mockResolvedValueOnce(comboInfo).mockResolvedValue(true); // info, then committed
    const f = field(comboInfo, { evaluate });
    const option = loc({ count: async () => 1 });
    const page = fakePage({ eval$$: () => REAL_FORM, locators: { 'name="country"': f }, getByRole: vi.fn(() => option) });
    usePage(page);
    await fillAndMaybeSubmit(env, params(), [{ name: "country", label: "Country", value: "United States" }], false);
    expect(option.click).toHaveBeenCalled();
  });

  it("types to filter, uses the Enter fallback, retries, then commits", async () => {
    const evaluate = vi.fn().mockResolvedValueOnce(comboInfo).mockResolvedValueOnce(false).mockResolvedValue(true);
    const f = field(comboInfo, { evaluate });
    const emptyOption = loc({ count: async () => 0, filter: vi.fn(() => loc({ count: async () => 0 })) });
    const page = fakePage({ eval$$: () => REAL_FORM, locators: { 'name="country"': f }, getByRole: vi.fn(() => emptyOption) });
    usePage(page);
    await fillAndMaybeSubmit(env, params(), [{ name: "country", label: "Country", value: "Canada" }], false);
    expect(f.pressSequentially).toHaveBeenCalled();
  });

  it("skips a whitespace-only combobox value", async () => {
    const evaluate = vi.fn().mockResolvedValueOnce(comboInfo);
    const f = field(comboInfo, { evaluate });
    // value "" is skipped before fillField; a whitespace-only value reaches
    // fillCombobox, which bails before opening the menu.
    const page = fakePage({ eval$$: () => REAL_FORM, locators: { 'name="country"': f }, getByRole: vi.fn(() => loc()) });
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params(), [{ name: "country", label: "C", value: " " }], false);
    expect(res.outcome).toBe("filled");
    expect(f.click).not.toHaveBeenCalled();
  });
});

/** A node whose closest() resolves per-selector, for in-page eval callbacks. */
function domNode(cfg: { closest?: Record<string, unknown>; value?: string; placeholder?: string | null }) {
  return {
    closest: (sel: string) => cfg.closest?.[sel] ?? null,
    value: cfg.value ?? "",
    getAttribute: (k: string) => (k === "placeholder" ? cfg.placeholder ?? null : null),
    ownerDocument: { querySelector: () => null },
    id: ""
  };
}

describe("comboboxHasValue in-page checks", () => {
  it("detects a committed react-select value", async () => {
    // fillField's info call, then comboboxHasValue runs its callback on a node
    // whose react-select control holds a single-value node.
    const node = domNode({ closest: { '[class*="select__control"]': { querySelector: () => ({}) } } });
    const evaluate = vi.fn().mockResolvedValueOnce(comboInfo).mockImplementation(async (fn: (n: unknown) => unknown) => fn(node));
    const f = field(comboInfo, { evaluate });
    const option = loc({ count: async () => 1 });
    const page = fakePage({ eval$$: () => REAL_FORM, locators: { 'name="country"': f }, getByRole: vi.fn(() => option) });
    usePage(page);
    await fillAndMaybeSubmit(env, params(), [{ name: "country", label: "C", value: "US" }], false);
    expect(option.click).toHaveBeenCalled();
  });

  it("falls back to a generic ARIA combobox value", async () => {
    const node = domNode({ closest: {}, value: "United States", placeholder: "Select" });
    const evaluate = vi.fn().mockResolvedValueOnce(comboInfo).mockImplementation(async (fn: (n: unknown) => unknown) => fn(node));
    const f = field(comboInfo, { evaluate });
    const option = loc({ count: async () => 1 });
    const page = fakePage({ eval$$: () => REAL_FORM, locators: { 'name="country"': f }, getByRole: vi.fn(() => option) });
    usePage(page);
    await fillAndMaybeSubmit(env, params(), [{ name: "country", label: "C", value: "United States" }], false);
    expect(option.click).toHaveBeenCalled();
  });
});

describe("fillField swallows per-op failures (defensive catches)", () => {
  it("text field: click/scroll fail and there is no bounding box", async () => {
    const f = field(textInfo, {
      click: async () => { throw new Error("x"); },
      scrollIntoViewIfNeeded: async () => { throw new Error("x"); },
      boundingBox: async () => null,
      pressSequentially: async () => { throw new Error("x"); } // outer try/catch swallows
    });
    const res = await fillOne({ name: "msg", label: "M", value: "hi" }, { 'name="msg"': f });
    expect(res.outcome).toBe("filled");
  });

  it("radio: check rejection is swallowed", async () => {
    const radio = loc({ getAttribute: async () => "rid", check: async () => { throw new Error("x"); } });
    const radios = loc({ count: async () => 1, nth: vi.fn(() => radio) });
    const f = field({ ...textInfo, type: "radio" });
    const res = await fillOne(
      { name: "g", label: "G", value: "Yes" },
      { 'input[type="radio"]': radios, 'label[for="rid"]': loc({ textContent: async () => "Yes" }), 'name="g"': f }
    );
    expect(res.outcome).toBe("filled");
  });

  it("checkbox: a failed check falls back to a click whose failure is also swallowed", async () => {
    const box0 = loc({
      evaluate: async () => "Remote",
      check: async () => { throw new Error("x"); },
      click: vi.fn(async () => { throw new Error("x"); })
    });
    const boxes = loc({ count: async () => 2, nth: vi.fn(() => box0) });
    const f = field({ ...textInfo, type: "checkbox" });
    await fillOne({ name: "loc", label: "L", value: "Remote" }, { 'input[type="checkbox"]': boxes, 'name="loc"': f });
    expect(box0.click).toHaveBeenCalled();
  });

  it("select: both label and value selection failing is swallowed", async () => {
    const f = field({ ...textInfo, tag: "select" }, {
      selectOption: vi.fn().mockRejectedValueOnce(new Error("no label")).mockRejectedValue(new Error("no value"))
    });
    const res = await fillOne({ name: "yrs", label: "Y", value: "2" }, { 'name="yrs"': f });
    expect(f.selectOption).toHaveBeenCalledTimes(2);
    expect(res.outcome).toBe("filled");
  });

  it("radio: a failed label lookup falls back to value matching", async () => {
    const radio = loc({ getAttribute: async (k: string) => (k === "id" ? "rid" : k === "value" ? "Yes" : null) });
    const radios = loc({ count: async () => 1, nth: vi.fn(() => radio) });
    const f = field({ ...textInfo, type: "radio" });
    await fillOne(
      { name: "g", label: "G", value: "Yes" },
      { 'input[type="radio"]': radios, 'label[for="rid"]': loc({ textContent: async () => { throw new Error("x"); } }), 'name="g"': f }
    );
    expect(radio.check).toHaveBeenCalled();
  });

  it("combobox: verify-value check rejection is treated as not committed", async () => {
    const evaluate = vi.fn().mockResolvedValueOnce(comboInfo).mockRejectedValue(new Error("eval failed"));
    const f = field(comboInfo, { evaluate, click: async () => { throw new Error("x"); } });
    const option = loc({ count: async () => 0, click: async () => { throw new Error("x"); }, filter: vi.fn(() => loc({ count: async () => 0 })) });
    const page = fakePage({ eval$$: () => REAL_FORM, locators: { 'name="country"': f }, getByRole: vi.fn(() => option) });
    page.keyboard.press = vi.fn(async () => { throw new Error("x"); }) as never;
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params(), [{ name: "country", label: "C", value: "Nowhere" }], false);
    expect(res.outcome).toBe("filled");
  });
});

describe("defensive browser catches", () => {
  it("swallows a waitForSelector rejection on the happy path", async () => {
    const page = fakePage({ eval$$: () => REAL_FORM });
    page.waitForSelector = vi.fn(async () => { throw new Error("timeout"); }) as never;
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params(), [], false);
    expect(res.outcome).toBe("filled");
  });

  it("treats a field-collection ($$eval) failure as no fields", async () => {
    gemini.diagnosePage.mockResolvedValue({ form_visible: false, action: "none", reason: "none" });
    const page = fakePage({ eval$$: () => { throw new Error("eval failed"); } });
    usePage(page);
    await expect(extractForm(env, params())).rejects.toThrow();
  });

  it("swallows waitForLoadState during a vision click strategy", async () => {
    gemini.diagnosePage.mockResolvedValueOnce({ form_visible: false, action: "click", click_text: "Apply", reason: "b" });
    const page = fakePage({
      locators: { ':has-text("Apply")': loc({ count: async () => 1 }) },
      eval$$: (selector) => (selector.startsWith("body") ? REAL_FORM : [])
    });
    page.waitForLoadState = vi.fn(async () => { throw new Error("nav"); }) as never;
    usePage(page);
    const result = await extractForm(env, params());
    expect(result.recovery?.strategy.action).toBe("click");
  });

  it("swallows waitForSelector during a playbook scroll strategy", async () => {
    db.getPlaybook.mockResolvedValue({ action: "scroll" });
    let n = 0;
    const page = fakePage({ eval$$: () => (++n === 1 ? [] : REAL_FORM) });
    page.waitForSelector = vi.fn(async () => { throw new Error("no"); }) as never;
    usePage(page);
    const result = await extractForm(env, params());
    expect(result.recovery?.source).toBe("playbook");
  });

  it("swallows a pre-submit solve rejection", async () => {
    captcha.detectInteractiveChallenge.mockResolvedValueOnce("recaptcha_v2").mockResolvedValue(null);
    captcha.solveInteractiveChallenge.mockRejectedValue(new Error("solve blew up"));
    const page = fakePage({ eval$$: () => REAL_FORM });
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params(), [], true);
    expect(res.outcome).toBe("submitted");
  });

  it("captcha_blocked when the escalated solve rejects", async () => {
    adapter.confirmSubmitted.mockResolvedValue(false);
    captcha.detectInteractiveChallenge.mockResolvedValueOnce(null).mockResolvedValue("hcaptcha");
    captcha.solveInteractiveChallenge.mockRejectedValue(new Error("solve blew up"));
    const page = fakePage({ eval$$: () => REAL_FORM });
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params(), [], true);
    expect(res.outcome).toBe("captcha_blocked");
  });

  it("swallows a second submit failure after solving the escalated challenge", async () => {
    adapter.confirmSubmitted.mockResolvedValueOnce(false).mockResolvedValue(true);
    adapter.submit.mockResolvedValueOnce(undefined).mockRejectedValue(new Error("second submit fails"));
    captcha.detectInteractiveChallenge.mockResolvedValueOnce(null).mockResolvedValue("recaptcha_v2");
    captcha.solveInteractiveChallenge.mockResolvedValue(true);
    const page = fakePage({ eval$$: () => REAL_FORM });
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params(), [], true);
    expect(res.outcome).toBe("submitted");
  });
});

describe("attachResume", () => {
  it("downloads the resume and sets the file input", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2]).buffer })));
    const fileInput = loc({ count: async () => 1 });
    const page = fakePage({ eval$$: () => REAL_FORM, locators: { 'input[type="file"]': fileInput } });
    usePage(page);
    await fillAndMaybeSubmit(env, params({ resume: { signedUrl: "https://signed/cv.pdf", fileName: "cv.pdf", mimeType: "application/pdf" } }), [], false);
    expect(fileInput.setInputFiles).toHaveBeenCalled();
  });

  it("no-ops when the resume download fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    const page = fakePage({ eval$$: () => REAL_FORM });
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params({ resume: { signedUrl: "https://signed/x", fileName: "x", mimeType: "application/pdf" } }), [], false);
    expect(res.outcome).toBe("filled");
  });

  it("no-ops when there is no file input", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array().buffer })));
    const page = fakePage({ eval$$: () => REAL_FORM, locators: { 'input[type="file"]': loc({ count: async () => 0 }) } });
    usePage(page);
    await fillAndMaybeSubmit(env, params({ resume: { signedUrl: "https://s/x", fileName: "x", mimeType: "application/pdf" } }), [], false);
  });
});

describe("reachForm misc branches", () => {
  it("records a playbook failure when the known fix no longer works, then throws", async () => {
    db.getPlaybook.mockResolvedValue({ action: "scroll" });
    gemini.diagnosePage.mockResolvedValue({ form_visible: false, action: "none", reason: "gone" });
    const page = fakePage({ eval$$: () => [] });
    usePage(page);
    await expect(extractForm(env, params())).rejects.toThrow();
    expect(db.recordPlaybookFailure).toHaveBeenCalled();
  });

  it("applies an iframe recovery strategy from vision", async () => {
    gemini.diagnosePage.mockResolvedValueOnce({ form_visible: false, action: "iframe", reason: "embedded" });
    const embed = loc({ count: async () => 1, getAttribute: async () => "https://jobs.lever.co/embed" });
    let n = 0;
    const page = fakePage({ locators: { "iframe[src": embed }, eval$$: () => (++n <= 1 ? [] : REAL_FORM) });
    usePage(page);
    const result = await extractForm(env, params());
    expect(result.recovery?.strategy.action).toBe("iframe");
  });

  it("fill/submit stays lenient and hands back a body scope when no form is found", async () => {
    gemini.diagnosePage.mockResolvedValue({ form_visible: false, action: "none", reason: "none" });
    const page = fakePage({ eval$$: () => [] });
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params(), [], false);
    expect(res.outcome).toBe("filled"); // no throw despite no form
  });

  it("vision click recovery widens to a body sweep when the selector still misses", async () => {
    gemini.diagnosePage.mockResolvedValueOnce({ form_visible: false, action: "click", click_text: "Apply", reason: "btn" });
    const page = fakePage({
      locators: { ':has-text("Apply")': loc({ count: async () => 1 }) },
      eval$$: (selector) => (selector.startsWith("body") ? REAL_FORM : [])
    });
    usePage(page);
    const result = await extractForm(env, params());
    expect(result.recovery).toEqual({ source: "vision", strategy: { action: "click", click_text: "Apply" }, domain: "jobs.lever.co" });
  });

  it("iterates vision rounds, updating the reason, before giving up", async () => {
    gemini.diagnosePage
      .mockResolvedValueOnce({ form_visible: false, action: "scroll", reason: "scroll down" })
      .mockResolvedValueOnce({ form_visible: false, action: "none", reason: "still nothing" });
    const page = fakePage({ eval$$: () => [] });
    usePage(page);
    await expect(extractForm(env, params())).rejects.toThrow();
  });

  it("applies an iframe strategy that scrolls for a lazy embed that never mounts", async () => {
    gemini.diagnosePage
      .mockResolvedValueOnce({ form_visible: false, action: "iframe", reason: "embed" })
      .mockResolvedValueOnce({ form_visible: false, action: "none", reason: "gone" });
    const page = fakePage({ locators: { "iframe[src": loc({ count: async () => 0 }) }, eval$$: () => [] });
    usePage(page);
    await expect(extractForm(env, params())).rejects.toThrow();
    expect(page.mouse.wheel).toHaveBeenCalled();
  });
});

describe("remaining fill + reach branches", () => {
  it("skips answers marked skipped", async () => {
    const page = fakePage({ eval$$: () => REAL_FORM });
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params(), [{ name: "x", label: "X", value: "v", skipped: true }], false);
    expect(res.outcome).toBe("filled");
  });

  it("captcha_blocked when the challenge is solved but the submit still never confirms", async () => {
    adapter.confirmSubmitted.mockResolvedValue(false);
    captcha.detectInteractiveChallenge.mockResolvedValueOnce(null).mockResolvedValue("recaptcha_v2");
    captcha.solveInteractiveChallenge.mockResolvedValue(true);
    const page = fakePage({ eval$$: () => REAL_FORM });
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params(), [], true);
    expect(res.outcome).toBe("captcha_blocked");
  });

  it("vision none with an empty reason keeps the prior reason", async () => {
    gemini.diagnosePage.mockResolvedValue({ form_visible: false, action: "none", reason: "" });
    const page = fakePage({ eval$$: () => [] });
    usePage(page);
    await expect(extractForm(env, params())).rejects.toThrow(/form_not_found/);
  });

  it("vision sees a form but the body sweep still fails", async () => {
    gemini.diagnosePage.mockResolvedValue({ form_visible: true, action: "none", reason: "visible" });
    const page = fakePage({ eval$$: () => [] });
    usePage(page);
    await expect(extractForm(env, params())).rejects.toThrow();
  });

  it("vision click without click_text defaults to the Apply button", async () => {
    gemini.diagnosePage.mockResolvedValueOnce({ form_visible: false, action: "click", reason: "b" });
    const target = loc({ count: async () => 1 });
    let n = 0;
    const page = fakePage({ locators: { ':has-text("Apply")': target }, eval$$: () => (++n <= 1 ? [] : REAL_FORM) });
    usePage(page);
    await extractForm(env, params());
    expect(target.click).toHaveBeenCalled();
  });

  it("greenhouse iframe strategy skips a src-less embed and keeps scrolling", async () => {
    gemini.diagnosePage
      .mockResolvedValueOnce({ form_visible: false, action: "iframe", reason: "embed" })
      .mockResolvedValueOnce({ form_visible: false, action: "none", reason: "gone" });
    const embed = loc({ count: async () => 1, getAttribute: async () => null }); // present but no src
    const page = fakePage({ locators: { 'iframe[src*="greenhouse.io"]': embed }, eval$$: () => [] });
    usePage(page);
    await expect(extractForm(env, params({ ats: "greenhouse" }))).rejects.toThrow();
    expect(page.mouse.wheel).toHaveBeenCalled();
  });

  it("reads element info in-page, defaulting null attributes", async () => {
    const node = { tagName: "INPUT", getAttribute: () => null };
    const f = field(textInfo, { evaluate: vi.fn(async (fn: (n: unknown) => unknown) => fn(node)) });
    await fillOne({ name: "n", label: "N", value: "v" }, { 'name="n"': f });
    expect(f.pressSequentially).toHaveBeenCalled();
  });

  it("radio without an id matches by value only", async () => {
    const radio = loc({ getAttribute: async (k: string) => (k === "value" ? "Yes" : null) });
    const radios = loc({ count: async () => 1, nth: vi.fn(() => radio) });
    const f = field({ ...textInfo, type: "radio" });
    await fillOne({ name: "g", label: "G", value: "Yes" }, { 'input[type="radio"]': radios, 'name="g"': f });
    expect(radio.check).toHaveBeenCalled();
  });

  it("combobox finds the exact option only after typing to filter", async () => {
    const evaluate = vi.fn().mockResolvedValueOnce(comboInfo).mockResolvedValue(true);
    const f = field(comboInfo, { evaluate });
    const option = loc({ count: vi.fn().mockResolvedValueOnce(0).mockResolvedValue(1) });
    const page = fakePage({ eval$$: () => REAL_FORM, locators: { 'name="country"': f }, getByRole: vi.fn(() => option) });
    usePage(page);
    await fillAndMaybeSubmit(env, params(), [{ name: "country", label: "C", value: "Portugal" }], false);
    expect(f.pressSequentially).toHaveBeenCalled();
    expect(option.click).toHaveBeenCalled();
  });

  it("comboboxHasValue accepts a generic control holding a committed value", async () => {
    const node = domNode({ closest: { '[class*="control"]': { querySelector: () => ({}) } } });
    const evaluate = vi.fn().mockResolvedValueOnce(comboInfo).mockImplementation(async (fn: (n: unknown) => unknown) => fn(node));
    const f = field(comboInfo, { evaluate });
    const option = loc({ count: async () => 1 });
    const page = fakePage({ eval$$: () => REAL_FORM, locators: { 'name="country"': f }, getByRole: vi.fn(() => option) });
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params(), [{ name: "country", label: "C", value: "US" }], false);
    expect(res.outcome).toBe("filled");
  });

  it("checkbox group with no boxes on the page is a no-op", async () => {
    const boxes = loc({ count: async () => 0 });
    const f = field({ ...textInfo, type: "checkbox" });
    const res = await fillOne({ name: "gone", label: "G", value: "x" }, { 'input[type="checkbox"]': boxes, 'name="gone"': f });
    expect(res.outcome).toBe("filled");
  });

  it("checkbox label falls back to empty for a blank wrapping label", async () => {
    const box0 = loc({
      evaluate: async (fn: (n: unknown) => unknown) =>
        fn({ id: "", ownerDocument: { querySelector: () => null }, closest: () => ({ textContent: "" }), getAttribute: () => null })
    });
    const boxes = loc({ count: async () => 2, nth: vi.fn(() => box0) });
    const f = field({ ...textInfo, type: "checkbox" });
    await fillOne({ name: "b", label: "B", value: "x" }, { 'input[type="checkbox"]': boxes, 'name="b"': f });
    expect(box0.uncheck).toHaveBeenCalled();
  });

  it("radio: leaves the group untouched when nothing matches", async () => {
    const radio = loc({ getAttribute: async (k: string) => (k === "id" ? "rid" : k === "value" ? "Other" : null) });
    const radios = loc({ count: async () => 1, nth: vi.fn(() => radio) });
    const f = field({ ...textInfo, type: "radio" });
    await fillOne(
      { name: "g", label: "G", value: "Yes" },
      { 'input[type="radio"]': radios, 'label[for="rid"]': loc({ textContent: async () => "Nope" }), 'name="g"': f }
    );
    expect(radio.check).not.toHaveBeenCalled();
  });

  it("comboboxHasValue treats an undefined input value as empty", async () => {
    const node = { closest: () => null, value: undefined, getAttribute: () => null };
    const evaluate = vi.fn().mockResolvedValueOnce(comboInfo).mockImplementation(async (fn: (n: unknown) => unknown) => fn(node));
    const f = field(comboInfo, { evaluate });
    const option = loc({ count: async () => 1 });
    const page = fakePage({ eval$$: () => REAL_FORM, locators: { 'name="country"': f }, getByRole: vi.fn(() => option) });
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params(), [{ name: "country", label: "C", value: "US" }], false);
    expect(res.outcome).toBe("filled"); // never committed; retried then gave up
  });

  it("lone checkbox is left unchecked for a non-truthy value", async () => {
    const boxes = loc({ count: async () => 1 });
    const f = field({ ...textInfo, type: "checkbox" });
    await fillOne({ name: "agree", label: "A", value: "no thanks" }, { 'input[type="checkbox"]': boxes, 'name="agree"': f });
    expect(boxes.check).not.toHaveBeenCalled();
  });

  it("checkbox group with an answer that splits to nothing is a no-op", async () => {
    const box0 = loc();
    const boxes = loc({ count: async () => 2, nth: vi.fn(() => box0) });
    const f = field({ ...textInfo, type: "checkbox" });
    await fillOne({ name: "s", label: "S", value: " ; " }, { 'input[type="checkbox"]': boxes, 'name="s"': f });
    expect(box0.check).not.toHaveBeenCalled();
    expect(box0.uncheck).not.toHaveBeenCalled();
  });

  it("checkbox label[for] without text falls through to the wrapping label", async () => {
    const box0 = loc({
      evaluate: async (fn: (n: unknown) => unknown) =>
        fn({ id: "b1", ownerDocument: { querySelector: () => ({ textContent: null }) }, closest: () => ({ textContent: "Wrapped" }), getAttribute: () => null })
    });
    const boxes = loc({ count: async () => 2, nth: vi.fn(() => box0) });
    const f = field({ ...textInfo, type: "checkbox" });
    await fillOne({ name: "w", label: "W", value: "Wrapped" }, { 'input[type="checkbox"]': boxes, 'name="w"': f });
    expect(box0.check).toHaveBeenCalled();
  });

  it("combobox survives bounding-box, option-count, and typing failures", async () => {
    const evaluate = vi.fn().mockResolvedValueOnce(comboInfo).mockResolvedValue(false);
    const f = field(comboInfo, {
      evaluate,
      boundingBox: async () => { throw new Error("no box"); },
      pressSequentially: vi.fn(async () => { throw new Error("no typing"); })
    });
    const option = loc({
      count: vi.fn(async () => { throw new Error("no count"); }),
      filter: vi.fn(() => loc({ count: vi.fn(async () => { throw new Error("no count"); }) }))
    });
    const page = fakePage({ eval$$: () => REAL_FORM, locators: { 'name="country"': f }, getByRole: vi.fn(() => option) });
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params(), [{ name: "country", label: "C", value: "Spain" }], false);
    expect(res.outcome).toBe("filled");
  });

  it("combobox option click failure is swallowed", async () => {
    const evaluate = vi.fn().mockResolvedValueOnce(comboInfo).mockResolvedValue(false);
    const f = field(comboInfo, { evaluate });
    const option = loc({ count: async () => 1, click: vi.fn(async () => { throw new Error("x"); }) });
    const page = fakePage({ eval$$: () => REAL_FORM, locators: { 'name="country"': f }, getByRole: vi.fn(() => option) });
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params(), [{ name: "country", label: "C", value: "France" }], false);
    expect(res.outcome).toBe("filled");
    expect(option.click).toHaveBeenCalled();
  });

  it("lone checkbox check failure is swallowed", async () => {
    const boxes = loc({ count: async () => 1, check: vi.fn(async () => { throw new Error("x"); }) });
    const f = field({ ...textInfo, type: "checkbox" });
    const res = await fillOne({ name: "agree", label: "A", value: "yes" }, { 'input[type="checkbox"]': boxes, 'name="agree"': f });
    expect(res.outcome).toBe("filled");
  });

  it("group uncheck failure is swallowed", async () => {
    const box0 = loc({ evaluate: async () => "Go", uncheck: vi.fn(async () => { throw new Error("x"); }) });
    const boxes = loc({ count: async () => 2, nth: vi.fn(() => box0) });
    const f = field({ ...textInfo, type: "checkbox" });
    const res = await fillOne({ name: "s", label: "S", value: "TypeScript" }, { 'input[type="checkbox"]': boxes, 'name="s"': f });
    expect(res.outcome).toBe("filled");
  });

  it("resume upload defaults the file name and mime type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer })));
    const fileInput = loc({ count: async () => 1 });
    const page = fakePage({ eval$$: () => REAL_FORM, locators: { 'input[type="file"]': fileInput } });
    usePage(page);
    await fillAndMaybeSubmit(env, params({ resume: { signedUrl: "https://s/x", fileName: "", mimeType: "" } }), [], false);
    const arg = (fileInput.setInputFiles as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.name).toBe("resume.pdf");
    expect(arg.mimeType).toBe("application/pdf");
  });

  it("resume upload failure inside setInputFiles is swallowed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer })));
    const fileInput = loc({ count: async () => 1, setInputFiles: vi.fn(async () => { throw new Error("widget"); }) });
    const page = fakePage({ eval$$: () => REAL_FORM, locators: { 'input[type="file"]': fileInput } });
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params({ resume: { signedUrl: "https://s/x", fileName: "cv.pdf", mimeType: "application/pdf" } }), [], false);
    expect(res.outcome).toBe("filled");
  });
});

describe("fillCombobox exhaustion", () => {
  it("gives up after two attempts when nothing commits", async () => {
    const evaluate = vi.fn().mockResolvedValueOnce(comboInfo).mockResolvedValue(false); // info, then never committed
    const f = field(comboInfo, { evaluate });
    const noOption = loc({ count: async () => 0, filter: vi.fn(() => loc({ count: async () => 0 })) });
    const page = fakePage({ eval$$: () => REAL_FORM, locators: { 'name="country"': f }, getByRole: vi.fn(() => noOption) });
    usePage(page);
    const res = await fillAndMaybeSubmit(env, params(), [{ name: "country", label: "C", value: "Nowhere" }], false);
    expect(res.outcome).toBe("filled");
    expect(page.keyboard.press).toHaveBeenCalledWith("Escape");
  });
});
