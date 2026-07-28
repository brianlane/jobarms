import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import {
  collectJobCardsInPage,
  searchEasyApply,
  signInLinkedIn,
  submitLoginCode
} from "../src/linkedin";
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
  it("returns authenticated immediately when a live session is visible", async () => {
    // The member's top nav is on screen, so the restored cookies are good.
    const page = fakePage({ locators: { "#global-nav": loc({ count: vi.fn(async () => 1) }) } });
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
    // After submit the session lands on the feed, with the member top-nav
    // visible (the positive signal classify confirms on).
    const page = codePage({
      locators: {
        'input[name="pin"]': loc({ count: vi.fn(async () => 1) }),
        "#email-pin-submit-button": loc({ count: vi.fn(async () => 1) }),
        "#global-nav": loc({ count: vi.fn(async () => 1) })
      }
    });
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

describe("searchEasyApply", () => {
  const search = (page: ReturnType<typeof fakePage>, over = {}) =>
    searchEasyApply(page as unknown as Page, {
      keywords: "react engineer",
      location: "Denver",
      remote: true,
      limit: 5,
      ...over
    });

  it("drives the Easy Apply search URL and returns canonical cards", async () => {
    const page = fakePage({
      evaluate: () => [
        {
          href: "https://www.linkedin.com/jobs/view/111/?refId=x",
          title: "Frontend Eng",
          company: "Acme",
          location: "Denver, CO"
        }
      ]
    });

    const cards = await search(page);

    const gotoUrl = (page.goto as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(gotoUrl).toContain("https://www.linkedin.com/jobs/search/?");
    expect(gotoUrl).toContain("keywords=react+engineer");
    expect(gotoUrl).toContain("f_AL=true");
    expect(gotoUrl).toContain("location=Denver");
    expect(gotoUrl).toContain("f_WT=2");
    expect(cards).toEqual([
      {
        jobId: "111",
        url: "https://www.linkedin.com/jobs/view/111/",
        title: "Frontend Eng",
        company: "Acme",
        location: "Denver, CO"
      }
    ]);
  });

  it("omits the location and remote filters when not asked for", async () => {
    const page = fakePage({ evaluate: () => [] });
    await search(page, { location: "", remote: false });
    const gotoUrl = (page.goto as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(gotoUrl).not.toContain("location=");
    expect(gotoUrl).not.toContain("f_WT");
  });

  it("dedupes repeated postings, skips non-posting links, and stops at the limit", async () => {
    const page = fakePage({
      evaluate: () => [
        { href: "https://www.linkedin.com/jobs/view/1/", title: "A", company: "", location: "" },
        // The same posting reached through a tracking URL: one card, not two.
        { href: "https://www.linkedin.com/jobs/view/1/?refId=y", title: "A again", company: "", location: "" },
        { href: "https://www.linkedin.com/company/acme/", title: "not a job", company: "", location: "" },
        { href: "https://www.linkedin.com/jobs/view/2/", title: "B", company: "", location: "" },
        { href: "https://www.linkedin.com/jobs/view/3/", title: "C", company: "", location: "" }
      ]
    });

    const cards = await search(page, { limit: 2 });

    expect(cards.map((c) => c.jobId)).toEqual(["1", "2"]);
  });

  it("returns nothing when the page cannot be driven at all", async () => {
    const page = fakePage({
      evaluate: () => {
        throw new Error("page died");
      }
    });
    page.goto = vi.fn(async () => {
      throw new Error("nav refused");
    });
    (page.mouse as { wheel: ReturnType<typeof vi.fn> }).wheel = vi.fn(async () => {
      throw new Error("no wheel");
    });

    expect(await search(page)).toEqual([]);
  });
});

describe("collectJobCardsInPage", () => {
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  it("reads the link, title, company, and location out of each card", () => {
    (globalThis as { document?: unknown }).document = {
      querySelectorAll: () => [
        {
          querySelector: (sel: string) => {
            if (sel.includes("/jobs/view/")) {
              return { href: "https://www.linkedin.com/jobs/view/9/", innerText: " Eng " };
            }
            if (sel.includes("subtitle")) return { innerText: " Acme " };
            return { textContent: "Remote" };
          }
        }
      ]
    };

    expect(collectJobCardsInPage()).toEqual([
      { href: "https://www.linkedin.com/jobs/view/9/", title: "Eng", company: "Acme", location: "Remote" }
    ]);
  });

  it("falls back to the explicit card link class and the href attribute", () => {
    (globalThis as { document?: unknown }).document = {
      querySelectorAll: () => [
        {
          querySelector: (sel: string) => {
            // No generic /jobs/view/ anchor on this card...
            if (sel.includes("/jobs/view/")) return null;
            // ...but the titled card link exists, exposing href only as an attribute.
            if (sel.includes("job-card-container__link")) {
              return { getAttribute: () => "/jobs/view/7/" };
            }
            return null;
          }
        },
        // A card with no link at all is skipped.
        { querySelector: () => null }
      ]
    };

    expect(collectJobCardsInPage()).toEqual([
      { href: "/jobs/view/7/", title: "", company: "", location: "" }
    ]);
  });

  it("returns nothing when there is no document to read", () => {
    expect(collectJobCardsInPage()).toEqual([]);
  });
});
