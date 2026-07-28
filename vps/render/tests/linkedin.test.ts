import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { signInLinkedIn, submitLoginCode } from "../src/linkedin";
import { fakePage, loc, TEST_CREDS } from "./helpers/fake-page";

/** A page carrying a LinkedIn login form (email + password + submit). */
function loginPage(over: Parameters<typeof fakePage>[0] = {}) {
  const { locators, ...rest } = over;
  return fakePage({
    locators: {
      "#username": loc({ count: vi.fn(async () => 1) }),
      "#password": loc({ count: vi.fn(async () => 1) }),
      'input[type="password"]': loc({ count: vi.fn(async () => 1) }),
      'button[type="submit"]': loc({ count: vi.fn(async () => 1) }),
      ...(locators ?? {})
    },
    ...rest
  });
}

const call = (page: ReturnType<typeof fakePage>, creds = TEST_CREDS) =>
  signInLinkedIn(page as unknown as Page, creds);

describe("signInLinkedIn", () => {
  it("returns authenticated immediately when the session is still valid", async () => {
    // No login form and not a checkpoint: the restored cookies are still good.
    const page = fakePage();
    expect(await call(page)).toEqual({ status: "authenticated" });
    // It never navigated to the login page.
    expect((page.goto as ReturnType<typeof vi.fn>).mock.calls.some((c) => /\/login/.test(c[0]))).toBe(
      false
    );
  });

  it("resumes a checkpoint the restored session is already sitting on", async () => {
    // The last run left a PIN challenge open; landing on the feed redirects
    // straight back to it. We must NOT bounce to the login page (that abandons
    // the live challenge) but return needs_login_code with the checkpoint URL.
    const page = fakePage({ locators: { 'input[name="pin"]': loc({ count: vi.fn(async () => 1) }) } });
    page.goto = vi.fn(async () => {});
    page.url = vi.fn(() => "https://www.linkedin.com/checkpoint/challenge/7");

    const result = await call(page);

    expect(result).toEqual({
      status: "needs_login_code",
      checkpointUrl: "https://www.linkedin.com/checkpoint/challenge/7"
    });
    expect(
      (page.goto as ReturnType<typeof vi.fn>).mock.calls.some((c) => /\/login/.test(c[0]))
    ).toBe(false);
  });

  it("fills the form and parks on a PIN challenge detected by URL", async () => {
    const page = loginPage({
      locators: { 'input[name="pin"]': loc({ count: vi.fn(async () => 1) }) }
    });
    // The submit redirects to a checkpoint; freeze the url there.
    page.goto = vi.fn(async () => {});
    page.url = vi.fn(() => "https://www.linkedin.com/checkpoint/challenge/1");

    const result = await call(page);

    expect(result).toEqual({
      status: "needs_login_code",
      checkpointUrl: "https://www.linkedin.com/checkpoint/challenge/1"
    });
    // The credentials were typed before the challenge appeared.
    expect(page.fill).toHaveBeenCalled();
  });

  it("parks on a PIN challenge detected by the page's wording", async () => {
    const page = loginPage({
      locators: { 'input[name="pin"]': loc({ count: vi.fn(async () => 1) }) },
      evaluate: () => "Enter the code we sent to your email"
    });
    const result = await call(page);
    expect(result.status).toBe("needs_login_code");
  });

  it("reports login_failed when the password was wrong", async () => {
    const page = loginPage({ evaluate: () => "Wrong email or password. Try again." });
    expect(await call(page)).toEqual({ status: "login_failed" });
  });

  it("reports login_failed when the login form is still up with no error", async () => {
    const page = loginPage({ evaluate: () => "" });
    expect(await call(page)).toEqual({ status: "login_failed" });
  });

  it("submits with Enter when there is no sign-in button", async () => {
    const press = vi.fn(async () => {});
    // Built without loginPage so no submit button is present.
    const page = fakePage({
      locators: {
        "#username": loc({ count: vi.fn(async () => 1) }),
        "#password": loc({ count: vi.fn(async () => 1), press }),
        'input[type="password"]': loc({ count: vi.fn(async () => 1) })
      },
      evaluate: () => ""
    });
    await call(page);
    expect(press).toHaveBeenCalledWith("Enter");
  });

  it("reports login_failed on a challenge it cannot drive (no code field)", async () => {
    // A checkpoint at the feed with no login form and no code input: an
    // app-approval or captcha challenge the arm cannot complete.
    const page = fakePage();
    page.goto = vi.fn(async () => {});
    page.url = vi.fn(() => "https://www.linkedin.com/checkpoint/challenge/x");
    expect(await call(page)).toEqual({ status: "login_failed" });
  });

  it("tolerates a page whose text cannot be read", async () => {
    const page = loginPage({
      evaluate: () => {
        throw new Error("navigated away mid-read");
      }
    });
    // Unreadable text -> no error/challenge match; the login form is still up.
    expect(await call(page)).toEqual({ status: "login_failed" });
  });

  it("treats a locator probe that throws as absent", async () => {
    const page = fakePage({
      locators: { "#username": loc({ count: vi.fn(async () => { throw new Error("detached"); }) }) },
      evaluate: () => ""
    });
    // The email probe throws, so there is no login form to fill: already signed in.
    expect((await call(page)).status).toBe("authenticated");
  });

  it("treats a failing password probe as no login form", async () => {
    const page = fakePage({
      locators: {
        "#username": loc({ count: vi.fn(async () => 1) }),
        'input[type="password"]': loc({ count: vi.fn(async () => { throw new Error("detached"); }) })
      },
      evaluate: () => ""
    });
    expect((await call(page)).status).toBe("authenticated");
  });

  it("tolerates every browser action failing during sign-in", async () => {
    const clickLoc = loc({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => { throw new Error("detached"); })
    });
    const page = loginPage({
      locators: { 'button[type="submit"]': clickLoc },
      evaluate: () => ""
    });
    page.goto = vi.fn(async () => { throw new Error("nav"); });
    page.fill = vi.fn(async () => { throw new Error("fill"); });
    page.waitForLoadState = vi.fn(async () => { throw new Error("idle"); });

    // None of it throws out; the classify still returns a verdict.
    expect((await call(page)).status).toBe("login_failed");
  });

  it("tolerates the Enter press failing when there is no sign-in button", async () => {
    const press = vi.fn(async () => {
      throw new Error("detached");
    });
    const page = fakePage({
      locators: {
        "#username": loc({ count: vi.fn(async () => 1) }),
        "#password": loc({ count: vi.fn(async () => 1), press }),
        'input[type="password"]': loc({ count: vi.fn(async () => 1) })
      },
      evaluate: () => ""
    });
    await call(page);
    expect(press).toHaveBeenCalled();
  });
});

describe("submitLoginCode", () => {
  const codePage = (over: Parameters<typeof fakePage>[0] = {}) =>
    fakePage({
      locators: {
        'input[name="pin"]': loc({ count: vi.fn(async () => 1) }),
        "#email-pin-submit-button": loc({ count: vi.fn(async () => 1) }),
        ...(over.locators ?? {})
      },
      ...over
    });

  it("types the code at the checkpoint URL and reports authenticated", async () => {
    const page = codePage();
    // After submit the session lands on the feed.
    page.goto = vi.fn(async () => {});
    page.url = vi.fn(() => "https://www.linkedin.com/feed/");

    const result = await submitLoginCode(page as unknown as Page, {
      code: "483920",
      checkpointUrl: "https://www.linkedin.com/checkpoint/challenge/1"
    });

    expect(result).toEqual({ status: "authenticated" });
  });

  it("falls back to the feed URL when no checkpoint URL was captured", async () => {
    const page = codePage();
    page.url = vi.fn(() => "https://www.linkedin.com/feed/");
    await submitLoginCode(page as unknown as Page, { code: "483920" });
    expect((page.goto as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "https://www.linkedin.com/feed/"
    );
  });

  it("classifies without typing when the code field is gone", async () => {
    // The challenge already cleared: no code input, on the feed -> authenticated.
    const page = fakePage({ url: "https://www.linkedin.com/feed/" });
    const result = await submitLoginCode(page as unknown as Page, { code: "483920" });
    expect(result).toEqual({ status: "authenticated" });
  });

  it("still fills the code when the challenge lacks an explicit submit button", async () => {
    const page = fakePage({
      locators: { 'input[name="pin"]': loc({ count: vi.fn(async () => 1) }) },
      evaluate: () => ""
    });
    page.url = vi.fn(() => "https://www.linkedin.com/feed/");
    await submitLoginCode(page as unknown as Page, { code: "111111" });
    // The code is typed via page.fill(selector, value), like the account flow.
    expect((page.fill as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'input[name="pin"]',
      "111111"
    );
  });

  it("tolerates every browser action failing while submitting the code", async () => {
    const clickLoc = loc({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => { throw new Error("detached"); })
    });
    const page = fakePage({
      locators: {
        'input[name="pin"]': loc({ count: vi.fn(async () => 1) }),
        "#email-pin-submit-button": clickLoc
      },
      evaluate: () => ""
    });
    page.goto = vi.fn(async () => { throw new Error("nav"); });
    page.fill = vi.fn(async () => { throw new Error("fill"); });
    page.waitForLoadState = vi.fn(async () => { throw new Error("idle"); });
    page.url = vi.fn(() => "https://www.linkedin.com/feed/");

    const result = await submitLoginCode(page as unknown as Page, {
      code: "1",
      checkpointUrl: "https://www.linkedin.com/checkpoint/challenge/1"
    });
    expect(result.status).toBe("authenticated");
  });
});
