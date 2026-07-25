import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { completeVerification, ensureAccount, looksLikeAuthPage } from "../src/account";
import { ADAPTERS } from "../src/adapters";
import { applyStrategy } from "../src/reach";
import { attachResume, fillCheckboxGroup, fillCombobox, fillField } from "../src/fill";
import { fakePage, loc, TEST_CREDS } from "./helpers/fake-page";

/**
 * Every browser call in these modules is deliberately best-effort: a page can
 * navigate, detach, or re-render at any moment, and a phase must degrade to
 * "leave it for review" rather than throw. This file drives those failure paths.
 */

const asPage = (p: ReturnType<typeof fakePage>) => p as unknown as Page;
const boom = () => Promise.reject(new Error("boom"));
const CREDS = TEST_CREDS;

/** A locator that exists but rejects every interaction. */
function hostileLoc(over: Record<string, unknown> = {}) {
  return loc({
    count: vi.fn(async () => 1),
    click: vi.fn(boom),
    fill: vi.fn(boom),
    check: vi.fn(boom),
    uncheck: vi.fn(boom),
    selectOption: vi.fn(boom),
    getAttribute: vi.fn(boom),
    textContent: vi.fn(boom),
    scrollIntoViewIfNeeded: vi.fn(boom),
    boundingBox: vi.fn(boom),
    pressSequentially: vi.fn(boom),
    setInputFiles: vi.fn(boom),
    waitFor: vi.fn(boom),
    isEnabled: vi.fn(boom),
    press: vi.fn(boom),
    ...over
  });
}

/** A page whose lifecycle calls all reject. */
function hostilePage(cfg: Parameters<typeof fakePage>[0] = {}) {
  const page = fakePage(cfg);
  page.fill = vi.fn(boom);
  page.goto = vi.fn(boom);
  page.waitForLoadState = vi.fn(boom);
  page.keyboard = { press: vi.fn(boom) };
  page.mouse = { wheel: vi.fn(boom), move: vi.fn(boom) };
  return page;
}

describe("account resilience", () => {
  it("treats an unreadable field probe as absent", async () => {
    const page = fakePage({ locators: { 'input[type="password"]': hostileLoc({ count: vi.fn(boom) }) } });
    expect(await looksLikeAuthPage(asPage(page))).toBe(false);
  });

  it("signs in even when every fill, click, and wait rejects", async () => {
    const page = hostilePage({
      locators: {
        'input[type="password"]': hostileLoc(),
        '[data-automation-id="email"]': hostileLoc(),
        '[data-automation-id="signInSubmitButton"]': hostileLoc()
      },
      evaluate: () => "Incorrect email or password"
    });
    // Reaches a verdict rather than throwing.
    expect(await ensureAccount(asPage(page), CREDS)).toBe("login_failed");
  });

  it("falls back to pressing Enter when that rejects too", async () => {
    const password = hostileLoc();
    const page = hostilePage({
      locators: {
        'input[type="password"]': password,
        '[data-automation-id="email"]': hostileLoc()
      },
      evaluate: () => "Invalid credentials"
    });
    expect(await ensureAccount(asPage(page), CREDS)).toBe("login_failed");
    expect(password.press).toHaveBeenCalled();
  });

  it("creates an account through a create-account link whose click rejects", async () => {
    const page = hostilePage({
      locators: {
        'input[type="password"]': hostileLoc(),
        '[data-automation-id="email"]': hostileLoc(),
        '[data-automation-id="verifyPassword"]': hostileLoc(),
        '[data-automation-id="createAccountLink"]': hostileLoc(),
        '[data-automation-id="createAccountCheckbox"]': hostileLoc(),
        '[data-automation-id="createAccountSubmitButton"]': hostileLoc()
      },
      evaluate: () => "Check your email to verify your account"
    });
    expect(await ensureAccount(asPage(page), CREDS)).toBe("needs_email_verification");
  });

  it("reports login_failed when the create-account form has no fields left", async () => {
    let probes = 0;
    const page = hostilePage({ evaluate: () => "" });
    page.locator = vi.fn((sel: string) => {
      // Present long enough to look like an auth page, then gone.
      if (/password|email/i.test(sel) && ++probes <= 2) return hostileLoc();
      return loc();
    });
    expect(await ensureAccount(asPage(page), CREDS)).toBe("login_failed");
  });

  it("completes a link verification even when navigation rejects", async () => {
    const page = hostilePage({ evaluate: () => "" });
    expect(
      await completeVerification(asPage(page), { link: "https://acme.com/verify" })
    ).toBe("authenticated");
  });

  it("completes a code verification even when fill and click reject", async () => {
    const page = hostilePage({
      locators: {
        '[data-automation-id="verificationCode"]': hostileLoc(),
        '[data-automation-id="verificationSubmit"]': hostileLoc()
      },
      evaluate: () => ""
    });
    expect(await completeVerification(asPage(page), { code: "123456" })).toBe("authenticated");
  });
});

describe("adapter resilience", () => {
  it("greenhouse tolerates an Apply button whose click rejects", async () => {
    const page = fakePage({ locators: { ':has-text("Apply")': hostileLoc() } });
    await expect(ADAPTERS.greenhouse.openApplication(asPage(page))).resolves.toBeUndefined();
  });

  it("workday tolerates Apply and autofill clicks that reject", async () => {
    const page = hostilePage({
      locators: {
        '[data-automation-id="adventureButton"]': hostileLoc(),
        '[data-automation-id="autofillWithResume"]': hostileLoc()
      }
    });
    await expect(ADAPTERS.workday.openApplication(asPage(page))).resolves.toBeUndefined();
  });

  it("workday reports no advance when the next click rejects", async () => {
    const next = hostileLoc({ isEnabled: vi.fn(async () => true) });
    const page = hostilePage({
      locators: { '[data-automation-id="pageFooterNextButton"]': next }
    });
    // The click failed, but the wizard still reports that it tried to move on,
    // so the caller re-reads the page rather than assuming the step succeeded.
    expect(await ADAPTERS.workday.nextPage!(asPage(page))).toBe(true);
  });
});

describe("reach resilience", () => {
  it("swallows a rejecting click strategy", async () => {
    const page = hostilePage({ locators: { ":has-text(": hostileLoc() } });
    await expect(
      applyStrategy(asPage(page), "form", { action: "click", click_text: "Apply" }, "lever")
    ).resolves.toBeUndefined();
  });

  it("swallows a rejecting iframe hop", async () => {
    const embed = hostileLoc({ getAttribute: vi.fn(async () => "https://embed.lever.co/f") });
    const page = hostilePage({ locators: { "iframe[src*=": embed } });
    await expect(
      applyStrategy(asPage(page), "form", { action: "iframe" }, "lever")
    ).resolves.toBeUndefined();
  });

  it("swallows a rejecting scroll", async () => {
    const page = hostilePage();
    await expect(
      applyStrategy(asPage(page), "form", { action: "scroll" }, "lever")
    ).resolves.toBeUndefined();
  });
});

describe("fill resilience", () => {
  /** Element info must still resolve; everything else rejects. */
  const info = (over: Record<string, string> = {}) => ({
    tag: "input",
    type: "text",
    cls: "",
    role: "",
    autocomplete: "",
    ...over
  });

  it("leaves a field for review when scroll, mouse move, and typing all reject", async () => {
    const el = hostileLoc({ evaluate: vi.fn(async () => info()) });
    const page = hostilePage({ locators: { "[name=": el } });
    await expect(
      fillField(asPage(page), "form", { name: "q", label: "Q", value: "v" })
    ).resolves.toBeUndefined();
  });

  it("skips the mouse move when the box read rejects", async () => {
    const el = hostileLoc({
      evaluate: vi.fn(async () => info()),
      boundingBox: vi.fn(boom)
    });
    const page = hostilePage({ locators: { "[name=": el } });
    await fillField(asPage(page), "form", { name: "q", label: "Q", value: "v" });
    expect(page.mouse.move).not.toHaveBeenCalled();
  });

  it("falls back from label to value on a select, then gives up", async () => {
    const el = hostileLoc({ evaluate: vi.fn(async () => info({ tag: "select" })) });
    const page = hostilePage({ locators: { "[name=": el } });
    await fillField(asPage(page), "form", { name: "s", label: "S", value: "x" });
    expect(el.selectOption).toHaveBeenCalledTimes(2);
  });

  it("handles a radio group whose attribute reads reject", async () => {
    const radio = hostileLoc();
    radio.nth = vi.fn(() => radio);
    const el = hostileLoc({ evaluate: vi.fn(async () => info({ type: "radio" })) });
    const page = hostilePage();
    page.locator = vi.fn((sel: string) => (sel.includes('type="radio"') ? radio : el));
    await expect(
      fillField(asPage(page), "form", { name: "r", label: "R", value: "Yes" })
    ).resolves.toBeUndefined();
  });

  it("keeps going when a combobox click, typing, and key presses reject", async () => {
    const el = hostileLoc({ evaluate: vi.fn(async () => false) });
    const option = hostileLoc({ count: vi.fn(async () => 0) });
    option.filter = vi.fn(() => option);
    const page = hostilePage({ getByRole: () => option });
    await expect(fillCombobox(asPage(page), el as never, "Canada")).resolves.toBeUndefined();
  });

  it("clicks an option whose click rejects without failing the fill", async () => {
    const el = hostileLoc({ evaluate: vi.fn(async () => true) });
    const option = hostileLoc();
    const page = hostilePage({ getByRole: () => option });
    await expect(fillCombobox(asPage(page), el as never, "Canada")).resolves.toBeUndefined();
    expect(option.click).toHaveBeenCalled();
  });

  it("checks a lone consent box whose check rejects", async () => {
    const box = hostileLoc();
    const page = hostilePage({ locators: { 'type="checkbox"': box } });
    await expect(fillCheckboxGroup(asPage(page), "agree", "yes")).resolves.toBeUndefined();
  });

  it("clears group boxes whose uncheck rejects", async () => {
    const box = hostileLoc({ evaluate: vi.fn(async () => "Other") });
    const boxes = hostileLoc({ count: vi.fn(async () => 2) });
    boxes.nth = vi.fn(() => box);
    const page = hostilePage({ locators: { 'type="checkbox"': boxes } });
    await expect(fillCheckboxGroup(asPage(page), "src", "LinkedIn")).resolves.toBeUndefined();
    expect(box.uncheck).toHaveBeenCalled();
  });

  it("falls back to clicking a box when both check and click reject", async () => {
    const box = hostileLoc({ evaluate: vi.fn(async () => "LinkedIn") });
    const boxes = hostileLoc({ count: vi.fn(async () => 2) });
    boxes.nth = vi.fn(() => box);
    const page = hostilePage({ locators: { 'type="checkbox"': boxes } });
    await expect(fillCheckboxGroup(asPage(page), "src", "LinkedIn")).resolves.toBeUndefined();
    expect(box.click).toHaveBeenCalled();
  });

  it("leaves the resume for review when the upload widget rejects", async () => {
    const input = hostileLoc();
    const page = hostilePage({ locators: { 'input[type="file"]': input } });
    await expect(
      attachResume(asPage(page), {
        contentBase64: Buffer.from("%PDF fake").toString("base64"),
        fileName: "",
        mimeType: ""
      })
    ).resolves.toBeUndefined();
  });
});
