import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { completeVerification, ensureAccount, looksLikeAuthPage } from "../src/account";
import { fakePage, loc, TEST_CREDS } from "./helpers/fake-page";

const asPage = (p: ReturnType<typeof fakePage>) => p as unknown as Page;
const CREDS = TEST_CREDS;

const present = () => loc({ count: vi.fn(async () => 1) });

/**
 * A page showing a credentials form. `text` is what the page reads as after
 * submitting, which is how the classifier decides where we landed.
 */
function authPage(opts: { text?: string; extra?: Record<string, ReturnType<typeof loc>> } = {}) {
  return fakePage({
    locators: {
      'input[type="password"]': present(),
      '[data-automation-id="email"]': present(),
      ...opts.extra
    },
    evaluate: () => opts.text ?? ""
  });
}

describe("looksLikeAuthPage", () => {
  it("is true only when both a password and a username field are present", async () => {
    expect(await looksLikeAuthPage(asPage(authPage()))).toBe(true);
  });

  it("is false without a password field", async () => {
    expect(await looksLikeAuthPage(asPage(fakePage()))).toBe(false);
  });

  it("is false when a stray password field has no username companion", async () => {
    // A "change password" widget on an authenticated page must not read as a
    // logout, or every run would try to log in again.
    const page = fakePage({ locators: { 'input[type="password"]': present() } });
    expect(await looksLikeAuthPage(asPage(page))).toBe(false);
  });
});

describe("ensureAccount", () => {
  it("returns authenticated immediately when the cached session is still valid", async () => {
    const page = fakePage();
    expect(await ensureAccount(asPage(page), CREDS)).toBe("authenticated");
    expect(page.fill).not.toHaveBeenCalled();
  });

  it("signs in and reports authenticated when the form disappears", async () => {
    // After submitting, the page no longer shows credentials: read as signed in.
    let submitted = false;
    const page = fakePage({ evaluate: () => "" });
    page.locator = vi.fn((sel: string) => {
      // Checked FIRST: a verify-password field would mean this is a signup form,
      // and a sign-in page must not have one.
      if (/verify|confirm/i.test(sel)) return loc();
      if (sel.includes("signInSubmitButton")) {
        return loc({
          count: vi.fn(async () => 1),
          click: vi.fn(async () => {
            submitted = true;
          })
        });
      }
      if (/password|email/i.test(sel)) return submitted ? loc() : present();
      return loc();
    });

    expect(await ensureAccount(asPage(page), CREDS)).toBe("authenticated");
    expect(page.fill).toHaveBeenCalledWith('[data-automation-id="email"]', CREDS.email);
  });

  it("parks the run when the tenant asks for email verification", async () => {
    const page = authPage({
      text: "Please verify your email to finish creating your account.",
      extra: { signInSubmitButton: present() }
    });
    expect(await ensureAccount(asPage(page), CREDS)).toBe("needs_email_verification");
  });

  it("reports a login failure on rejected credentials", async () => {
    const page = authPage({
      text: "Incorrect email or password.",
      extra: { signInSubmitButton: present() }
    });
    expect(await ensureAccount(asPage(page), CREDS)).toBe("login_failed");
  });

  it("reports a login failure when the tenant locks the account", async () => {
    const page = authPage({
      text: "Your account is locked.",
      extra: { signInSubmitButton: present() }
    });
    expect(await ensureAccount(asPage(page), CREDS)).toBe("login_failed");
  });

  it("presses Enter when the form offers no submit button", async () => {
    const password = present();
    const page = fakePage({
      locators: {
        'input[type="password"]': password,
        '[data-automation-id="email"]': present()
      },
      evaluate: () => "Incorrect email or password"
    });
    await ensureAccount(asPage(page), CREDS);
    expect(password.press).toHaveBeenCalledWith("Enter");
  });

  it("creates the account when the page is a create-account form", async () => {
    // A verify-password field means this is a signup form, so sign-in is skipped
    // and we go straight to creating (which is what avoids duplicate profiles).
    const submit = present();
    const consent = present();
    const page = fakePage({
      locators: {
        'input[type="password"]': present(),
        '[data-automation-id="email"]': present(),
        '[data-automation-id="verifyPassword"]': present(),
        '[data-automation-id="createAccountSubmitButton"]': submit,
        '[data-automation-id="createAccountCheckbox"]': consent
      },
      evaluate: () => "Check your email for a verification link"
    });

    expect(await ensureAccount(asPage(page), CREDS)).toBe("needs_email_verification");
    expect(consent.check).toHaveBeenCalled();
    expect(submit.click).toHaveBeenCalled();
    // The password is typed into BOTH the password and verify fields.
    expect(page.fill).toHaveBeenCalledWith('[data-automation-id="verifyPassword"]', CREDS.password);
  });

  it("follows a Create Account link when sign-in fails", async () => {
    const createLink = present();
    let clicked = false;
    const page = fakePage({ evaluate: () => "Check your email" });
    page.locator = vi.fn((sel: string) => {
      if (sel.includes("createAccountLink")) {
        return loc({
          count: vi.fn(async () => 1),
          first: vi.fn(() => ({
            ...createLink,
            click: vi.fn(async () => {
              clicked = true;
            })
          })),
          click: vi.fn(async () => {
            clicked = true;
          })
        });
      }
      if (sel.includes("password") || sel.includes("email")) return present();
      return loc();
    });

    const status = await ensureAccount(asPage(page), CREDS);
    expect(clicked).toBe(true);
    expect(status).toBe("needs_email_verification");
  });

  it("fails honestly when no credentials fields can be found to create with", async () => {
    // Auth page on entry, but the fields vanish before the create attempt.
    let calls = 0;
    const page = fakePage({ evaluate: () => "" });
    page.locator = vi.fn((sel: string) => {
      if (sel.includes("password") || sel.includes("email")) {
        // Present for the initial looksLikeAuthPage checks, then gone.
        return ++calls <= 3 ? present() : loc();
      }
      return loc();
    });
    expect(await ensureAccount(asPage(page), CREDS)).toBe("login_failed");
  });

  it("treats an unreadable page as authenticated rather than hanging", async () => {
    const page = fakePage({
      locators: {
        'input[type="password"]': present(),
        '[data-automation-id="email"]': present(),
        signInSubmitButton: present()
      }
    });
    page.evaluate = vi.fn(async () => {
      throw new Error("navigating");
    });
    // No verify prompt, no error text, and the form is still up: login_failed.
    expect(await ensureAccount(asPage(page), CREDS)).toBe("login_failed");
  });
});

describe("completeVerification", () => {
  it("visits the confirmation link inside the held session", async () => {
    const page = fakePage({ evaluate: () => "" });
    const status = await completeVerification(asPage(page), {
      link: "https://acme.wd1.myworkdayjobs.com/verify?t=1"
    });
    expect(page.goto).toHaveBeenCalledWith("https://acme.wd1.myworkdayjobs.com/verify?t=1", {
      waitUntil: "domcontentloaded"
    });
    expect(status).toBe("authenticated");
  });

  it("tolerates a navigation failure on the link", async () => {
    const page = fakePage({ evaluate: () => "" });
    page.goto = vi.fn(async () => {
      throw new Error("nav failed");
    });
    await expect(
      completeVerification(asPage(page), { link: "https://x/verify" })
    ).resolves.toBe("authenticated");
  });

  it("types a one-time code and submits it", async () => {
    const submit = present();
    const page = fakePage({
      locators: {
        '[data-automation-id="verificationCode"]': present(),
        '[data-automation-id="verificationSubmit"]': submit
      },
      evaluate: () => ""
    });
    const status = await completeVerification(asPage(page), { code: "483920" });
    expect(page.fill).toHaveBeenCalledWith('[data-automation-id="verificationCode"]', "483920");
    expect(submit.click).toHaveBeenCalled();
    expect(status).toBe("authenticated");
  });

  it("submits a code even when the tenant offers no explicit submit button", async () => {
    const page = fakePage({
      locators: { '[data-automation-id="verificationCode"]': present() },
      evaluate: () => ""
    });
    await expect(completeVerification(asPage(page), { code: "1234" })).resolves.toBe(
      "authenticated"
    );
  });

  it("fails when there is nowhere to type the code", async () => {
    const page = fakePage({ evaluate: () => "" });
    expect(await completeVerification(asPage(page), { code: "1234" })).toBe("login_failed");
  });

  it("keeps waiting when given neither a link nor a code", async () => {
    const page = fakePage();
    expect(await completeVerification(asPage(page), {})).toBe("needs_email_verification");
  });
});
