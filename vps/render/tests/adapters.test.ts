import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { ADAPTERS } from "../src/adapters";
import { fakePage, loc } from "./helpers/fake-page";

const asPage = (p: ReturnType<typeof fakePage>) => p as unknown as Page;

describe("adapter contract", () => {
  it("marks only Workday as account-gated", () => {
    expect(ADAPTERS.greenhouse.requiresAccount).toBe(false);
    expect(ADAPTERS.lever.requiresAccount).toBe(false);
    expect(ADAPTERS.ashby.requiresAccount).toBe(false);
    // Load-bearing for generic: the best-effort path must NEVER create
    // accounts on an unknown site.
    expect(ADAPTERS.generic.requiresAccount).toBe(false);
    expect(ADAPTERS.workday.requiresAccount).toBe(true);
  });

  it("gives wizard hooks only to the multi-page ATS", () => {
    expect(ADAPTERS.greenhouse.nextPage).toBeUndefined();
    expect(ADAPTERS.lever.nextPage).toBeUndefined();
    expect(ADAPTERS.ashby.nextPage).toBeUndefined();
    expect(ADAPTERS.generic.nextPage).toBeUndefined();
    expect(ADAPTERS.workday.nextPage).toBeTypeOf("function");
    expect(ADAPTERS.workday.isLastPage).toBeTypeOf("function");
  });
});

describe("greenhouse", () => {
  const gh = ADAPTERS.greenhouse;

  it("returns immediately when the form is already inline", async () => {
    const form = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({ locators: { 'form[id*="application"]': form } });
    await gh.openApplication(asPage(page));
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("navigates INTO a greenhouse iframe so the form is top-level", async () => {
    const embed = loc({
      count: vi.fn(async () => 1),
      getAttribute: vi.fn(async () => "https://job-boards.greenhouse.io/acme/jobs/1")
    });
    const page = fakePage({ locators: { "iframe[src*=": embed } });
    await gh.openApplication(asPage(page));
    expect(page.goto).toHaveBeenCalledWith("https://job-boards.greenhouse.io/acme/jobs/1", {
      waitUntil: "domcontentloaded"
    });
  });

  it("clicks Apply on the fifth attempt to mount a lazy embed", async () => {
    const apply = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({ locators: { ':has-text("Apply")': apply } });
    await gh.openApplication(asPage(page));
    expect(apply.click).toHaveBeenCalledTimes(1);
  });

  it("gives up quietly after exhausting its attempts", async () => {
    const page = fakePage();
    await expect(gh.openApplication(asPage(page))).resolves.toBeUndefined();
  });

  it("skips an iframe whose src attribute is missing", async () => {
    const embed = loc({ count: vi.fn(async () => 1), getAttribute: vi.fn(async () => null) });
    const page = fakePage({ locators: { "iframe[src*=": embed } });
    await gh.openApplication(asPage(page));
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("clicks the submit control", async () => {
    const submit = loc();
    const page = fakePage({ locators: { "button[type=": submit } });
    await gh.submit(asPage(page));
    expect(submit.click).toHaveBeenCalled();
  });

  it("confirms on the confirmation element", async () => {
    const page = fakePage({ locators: { "#application_confirmation": loc() } });
    expect(await gh.confirmSubmitted(asPage(page))).toBe(true);
  });

  it("falls back to the URL and page text when no element appears", async () => {
    const missing = loc({
      waitFor: vi.fn(async () => {
        throw new Error("timeout");
      })
    });
    const byUrl = fakePage({
      locators: { "#application_confirmation": missing },
      url: "https://boards.greenhouse.io/confirmation"
    });
    expect(await gh.confirmSubmitted(asPage(byUrl))).toBe(true);

    const byText = fakePage({
      locators: { "#application_confirmation": missing },
      url: "https://boards.greenhouse.io/x",
      content: "<p>Thank you for applying</p>"
    });
    expect(await gh.confirmSubmitted(asPage(byText))).toBe(true);

    const neither = fakePage({
      locators: { "#application_confirmation": missing },
      url: "https://boards.greenhouse.io/x",
      content: "<p>nope</p>"
    });
    expect(await gh.confirmSubmitted(asPage(neither))).toBe(false);
  });
});

describe("lever", () => {
  const lever = ADAPTERS.lever;

  it("navigates to the /apply URL from a posting page", async () => {
    const page = fakePage({ url: "https://jobs.lever.co/acme/1?src=x" });
    await lever.openApplication(asPage(page));
    expect(page.goto).toHaveBeenCalledWith("https://jobs.lever.co/acme/1/apply", {
      waitUntil: "domcontentloaded"
    });
  });

  it("stays put when already on the apply page", async () => {
    const page = fakePage({ url: "https://jobs.lever.co/acme/1/apply" });
    await lever.openApplication(asPage(page));
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("clicks submit and confirms by element", async () => {
    const submit = loc();
    const page = fakePage({ locators: { "button[type=": submit } });
    await lever.submit(asPage(page));
    expect(submit.click).toHaveBeenCalled();
    expect(await lever.confirmSubmitted(asPage(fakePage({ locators: { "text=/": loc() } })))).toBe(
      true
    );
  });

  it("falls back to the URL when no confirmation element appears", async () => {
    const missing = loc({
      waitFor: vi.fn(async () => {
        throw new Error("timeout");
      })
    });
    expect(
      await lever.confirmSubmitted(
        asPage(fakePage({ locators: { "text=/": missing }, url: "https://jobs.lever.co/thanks" }))
      )
    ).toBe(true);
    expect(
      await lever.confirmSubmitted(
        asPage(fakePage({ locators: { "text=/": missing }, url: "https://jobs.lever.co/x" }))
      )
    ).toBe(false);
  });
});

describe("ashby", () => {
  const ashby = ADAPTERS.ashby;

  it("navigates to the /application tab from a posting page", async () => {
    const page = fakePage({ url: "https://jobs.ashbyhq.com/acme/uuid-1?src=x" });
    await ashby.openApplication(asPage(page));
    expect(page.goto).toHaveBeenCalledWith("https://jobs.ashbyhq.com/acme/uuid-1/application", {
      waitUntil: "domcontentloaded"
    });
    // The client-rendered shell must hydrate the system fields before extract.
    expect(page.waitForSelector).toHaveBeenCalledWith(
      expect.stringContaining("_systemfield_name"),
      expect.anything()
    );
  });

  it("stays put when already on the application tab", async () => {
    const page = fakePage({ url: "https://jobs.ashbyhq.com/acme/uuid-1/application" });
    await ashby.openApplication(asPage(page));
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("clicks the submit control", async () => {
    const submit = loc();
    const page = fakePage({ locators: { 'button:has-text("Submit Application")': submit } });
    await ashby.submit(asPage(page));
    expect(submit.click).toHaveBeenCalled();
  });

  it("confirms on the submitted message", async () => {
    const page = fakePage({ locators: { "text=/": loc() } });
    expect(await ashby.confirmSubmitted(asPage(page))).toBe(true);
  });

  it("falls back to the page content, never the URL (SPA: it does not change)", async () => {
    const missing = loc({
      waitFor: vi.fn(async () => {
        throw new Error("timeout");
      })
    });
    const byContent = fakePage({
      locators: { "text=/": missing },
      url: "https://jobs.ashbyhq.com/acme/uuid-1/application",
      content: "<p>Your application has been submitted</p>"
    });
    expect(await ashby.confirmSubmitted(asPage(byContent))).toBe(true);

    const neither = fakePage({
      locators: { "text=/": missing },
      url: "https://jobs.ashbyhq.com/acme/uuid-1/application",
      content: "<p>nope</p>"
    });
    expect(await ashby.confirmSubmitted(asPage(neither))).toBe(false);
  });
});

describe("generic", () => {
  const generic = ADAPTERS.generic;

  it("returns immediately when fillable form fields are already on screen", async () => {
    const fields = loc({ count: vi.fn(async () => 3) });
    const page = fakePage({ locators: { "form input": fields } });
    await generic.openApplication(asPage(page));
    expect(page.locator).toHaveBeenCalledTimes(1);
  });

  it("recognizes a formless application (email + name, no password) and leaves Apply alone", async () => {
    // Component-built career sites render fields without a <form>; email next
    // to a name field means the application is up (the same pair the sanity
    // check accepts), and clicking Apply again could navigate away from it.
    const email = loc({ count: vi.fn(async () => 1) });
    const name = loc({ count: vi.fn(async () => 1) });
    const apply = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({
      locators: {
        'input[type="email"]': email,
        'input[name*="name" i]': name,
        ':has-text("Apply")': apply
      }
    });
    await generic.openApplication(asPage(page));
    expect(apply.click).not.toHaveBeenCalled();
  });

  it("recognizes a file upload as the application being up", async () => {
    const file = loc({ count: vi.fn(async () => 1) });
    const apply = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({ locators: { 'input[type="file"]': file, ':has-text("Apply")': apply } });
    await generic.openApplication(asPage(page));
    expect(apply.click).not.toHaveBeenCalled();
  });

  it("is not fooled by a newsletter box (email alone) or a login (email + password)", async () => {
    const email = loc({ count: vi.fn(async () => 1) });
    const apply = loc({ count: vi.fn(async () => 1) });
    const newsletter = fakePage({
      locators: { 'input[type="email"]': email, ':has-text("Apply")': apply }
    });
    await generic.openApplication(asPage(newsletter));
    expect(apply.click).toHaveBeenCalled();

    const password = loc({ count: vi.fn(async () => 1) });
    const applyLogin = loc({ count: vi.fn(async () => 1) });
    const login = fakePage({
      locators: {
        'input[type="email"]': loc({ count: vi.fn(async () => 1) }),
        'input[type="password"]': password,
        ':has-text("Apply")': applyLogin
      }
    });
    await generic.openApplication(asPage(login));
    expect(applyLogin.click).toHaveBeenCalled();
  });

  it("keeps the narrow form scope (the page-wide fallback lives in reach.ts)", () => {
    expect(generic.formSelector).toBe("form");
  });

  it("clicks Apply while no form is present, then gives up quietly", async () => {
    const apply = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({ locators: { ':has-text("Apply")': apply } });
    await expect(generic.openApplication(asPage(page))).resolves.toBeUndefined();
    // One click per attempt: the universal move, nothing clever.
    expect(apply.click).toHaveBeenCalledTimes(3);
  });

  it("tolerates a page with neither form nor Apply control", async () => {
    await expect(generic.openApplication(asPage(fakePage()))).resolves.toBeUndefined();
  });

  it("dismisses a consent overlay before clicking Apply", async () => {
    const consent = loc({ count: vi.fn(async () => 1) });
    const apply = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({
      locators: { "#onetrust-accept-btn-handler": consent, ':has-text("Apply")': apply }
    });
    await generic.openApplication(asPage(page));
    expect(consent.click).toHaveBeenCalled();
    expect(apply.click).toHaveBeenCalled();
  });

  it("ignores a consent control that is present but not visible", async () => {
    const consent = loc({ count: vi.fn(async () => 1), isVisible: vi.fn(async () => false) });
    const page = fakePage({ locators: { "#onetrust-accept-btn-handler": consent } });
    await generic.openApplication(asPage(page));
    expect(consent.click).not.toHaveBeenCalled();
  });

  it("treats an isVisible failure as not visible, and swallows a consent click failure", async () => {
    const flaky = loc({
      count: vi.fn(async () => 1),
      isVisible: vi.fn(async () => {
        throw new Error("detached");
      })
    });
    await expect(
      generic.openApplication(asPage(fakePage({ locators: { "#onetrust-accept-btn-handler": flaky } })))
    ).resolves.toBeUndefined();
    expect(flaky.click).not.toHaveBeenCalled();

    const refusing = loc({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => {
        throw new Error("intercepted");
      })
    });
    await expect(
      generic.openApplication(asPage(fakePage({ locators: { "#onetrust-accept-btn-handler": refusing } })))
    ).resolves.toBeUndefined();
  });

  it("shrugs off a click or load-state failure (best-effort all the way down)", async () => {
    const apply = loc({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => {
        throw new Error("detached");
      })
    });
    const page = fakePage({ locators: { ':has-text("Apply")': apply } });
    page.waitForLoadState = vi.fn(async () => {
      throw new Error("navigation aborted");
    });
    await expect(generic.openApplication(asPage(page))).resolves.toBeUndefined();
  });

  it("clicks the submit control", async () => {
    const submit = loc();
    const page = fakePage({ locators: { 'button[type="submit"]': submit } });
    await generic.submit(asPage(page));
    expect(submit.click).toHaveBeenCalled();
  });

  it("confirms only on explicit success wording", async () => {
    expect(
      await generic.confirmSubmitted(asPage(fakePage({ locators: { "text=/": loc() } })))
    ).toBe(true);

    const missing = loc({
      waitFor: vi.fn(async () => {
        throw new Error("timeout");
      })
    });
    const byContent = fakePage({
      locators: { "text=/": missing },
      content: "<p>Thank you for your application!</p>"
    });
    expect(await generic.confirmSubmitted(asPage(byContent))).toBe(true);

    // "Success" alone, a changed URL, a vibe: none of it counts. With no known
    // confirmation shape, anything less than explicit wording must end as an
    // honest submit_unconfirmed rather than a claimed success.
    const vague = fakePage({
      locators: { "text=/": missing },
      url: "https://careers.example.com/success",
      content: "<p>Success!</p>"
    });
    expect(await generic.confirmSubmitted(asPage(vague))).toBe(false);
  });
});

describe("workday", () => {
  const wd = ADAPTERS.workday;

  it("clicks Apply and then the resume autofill shortcut", async () => {
    const apply = loc({ count: vi.fn(async () => 1) });
    const autofill = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({
      locators: {
        '[data-automation-id="adventureButton"]': apply,
        '[data-automation-id="autofillWithResume"]': autofill
      }
    });
    await wd.openApplication(asPage(page));
    expect(apply.click).toHaveBeenCalled();
    expect(autofill.click).toHaveBeenCalled();
  });

  it("tolerates a posting with neither control", async () => {
    await expect(wd.openApplication(asPage(fakePage()))).resolves.toBeUndefined();
  });

  it("advances the wizard using the first available next control", async () => {
    const next = loc({ count: vi.fn(async () => 1), isEnabled: vi.fn(async () => true) });
    const page = fakePage({
      locators: { '[data-automation-id="pageFooterNextButton"]': next }
    });
    expect(await wd.nextPage!(asPage(page))).toBe(true);
    expect(next.click).toHaveBeenCalled();
  });

  it("reports no advance when the next control is disabled", async () => {
    const next = loc({ count: vi.fn(async () => 1), isEnabled: vi.fn(async () => false) });
    const page = fakePage({
      locators: { '[data-automation-id="pageFooterNextButton"]': next }
    });
    expect(await wd.nextPage!(asPage(page))).toBe(false);
    expect(next.click).not.toHaveBeenCalled();
  });

  it("treats an isEnabled failure as not advanceable", async () => {
    const next = loc({
      count: vi.fn(async () => 1),
      isEnabled: vi.fn(async () => {
        throw new Error("detached");
      })
    });
    const page = fakePage({
      locators: { '[data-automation-id="pageFooterNextButton"]': next }
    });
    expect(await wd.nextPage!(asPage(page))).toBe(false);
  });

  it("reports no advance when the wizard has no next control", async () => {
    expect(await wd.nextPage!(asPage(fakePage()))).toBe(false);
  });

  it("recognizes the final page by its submit control", async () => {
    const submit = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({
      locators: { '[data-automation-id="pageFooterSubmitButton"]': submit }
    });
    expect(await wd.isLastPage!(asPage(page))).toBe(true);
    expect(await wd.isLastPage!(asPage(fakePage()))).toBe(false);
  });

  it("submits through the first available submit control", async () => {
    const submit = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({
      locators: { '[data-automation-id="pageFooterSubmitButton"]': submit }
    });
    await wd.submit(asPage(page));
    expect(submit.click).toHaveBeenCalled();
  });

  it("does nothing when there is no submit control to click", async () => {
    await expect(wd.submit(asPage(fakePage()))).resolves.toBeUndefined();
  });

  it("confirms by element, then by URL", async () => {
    expect(
      await wd.confirmSubmitted(
        asPage(fakePage({ locators: { '[data-automation-id="confirmationPage"]': loc() } }))
      )
    ).toBe(true);

    const missing = loc({
      waitFor: vi.fn(async () => {
        throw new Error("timeout");
      })
    });
    expect(
      await wd.confirmSubmitted(
        asPage(
          fakePage({
            locators: { '[data-automation-id="confirmationPage"]': missing },
            url: "https://acme.wd1.myworkdayjobs.com/submitted"
          })
        )
      )
    ).toBe(true);
    expect(
      await wd.confirmSubmitted(
        asPage(
          fakePage({
            locators: { '[data-automation-id="confirmationPage"]': missing },
            url: "https://acme.wd1.myworkdayjobs.com/step/3"
          })
        )
      )
    ).toBe(false);
  });
});
