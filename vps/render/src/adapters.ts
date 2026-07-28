/**
 * Per-ATS quirks. Everything generic lives in reach/extract/fill; adapters know
 * how to get to a form, submit it, and recognize success.
 *
 * MIGRATED from workers/apply-arm/src/adapters.ts, plus:
 *  - `requiresAccount`: whether applying needs a candidate account on this
 *    tenant (Workday), which is what drives the sidecar's session handling.
 *  - `pagination`: how to advance a multi-page wizard, absent for single-page
 *    ATSes.
 */
import type { Page } from "playwright";
import { collectFields } from "./extract.js";
import { looksLikeApplicationForm } from "./form-sanity.js";
import type { Ats } from "./types.js";

export interface AtsAdapter {
  formSelector: string;
  /**
   * True when applying requires a candidate account on the employer's tenant.
   * Workday gives every employer its own tenant with its own candidate database,
   * so a run has to create (or reuse) an account and verify the email first.
   * LinkedIn is account-gated too, but signs in with the user's OWN login (see
   * the sidecar's linkedin.ts), which the app-side session handling arranges.
   */
  requiresAccount: boolean;
  /** Get from the job posting page to a visible application form. */
  openApplication(page: Page): Promise<void>;
  submit(page: Page): Promise<void>;
  confirmSubmitted(page: Page): Promise<boolean>;
  /** Multi-page wizards only: advance a page, reporting whether it moved. */
  nextPage?(page: Page): Promise<boolean>;
  /** Multi-page wizards only: true when this is the final (review) page. */
  isLastPage?(page: Page): Promise<boolean>;
  /**
   * Optional: abandon a half-filled application without submitting. Used when
   * the read-back interlock refuses to send: on LinkedIn a lingering Easy Apply
   * modal would otherwise sit open as a draft. Best-effort; absence is fine.
   */
  discardApplication?(page: Page): Promise<void>;
}

const greenhouse: AtsAdapter = {
  // Classic hosted boards use #application-form (new) or #application_form /
  // #main_fields (legacy) - match either.
  formSelector: 'form[id*="application"], #application-form, #application_form',
  requiresAccount: false,

  async openApplication(page) {
    // Hosted GH job pages show the form inline. Most companies now redirect
    // hosted URLs to their own careers site, which lazy-loads the Greenhouse
    // form in an iframe - poll for form-or-iframe, then navigate INTO the embed
    // so the form is top-level for the extractor/filler.
    for (let attempt = 0; attempt < 10; attempt++) {
      if ((await page.locator('form[id*="application"]').count()) > 0) return;

      const embed = page.locator('iframe[src*="greenhouse.io"]').first();
      if ((await embed.count()) > 0) {
        const src = await embed.getAttribute("src");
        if (src) {
          await page.goto(src, { waitUntil: "domcontentloaded" });
          return;
        }
      }

      // Some career pages need the Apply button clicked to mount the embed.
      if (attempt === 4) {
        const applyBtn = page.locator('a:has-text("Apply"), button:has-text("Apply")').first();
        if ((await applyBtn.count()) > 0) {
          await applyBtn.click().catch(() => {});
        }
      }
      await page.waitForTimeout(2000);
    }
  },

  async submit(page) {
    await page
      .locator('form[id*="application"] button[type="submit"], #submit_app, input[type="submit"]')
      .first()
      .click();
    await page.waitForTimeout(5000);
  },

  async confirmSubmitted(page) {
    const confirmation = page.locator(
      '#application_confirmation, [class*="confirmation"], text=/thank you for applying/i'
    );
    try {
      await confirmation.first().waitFor({ timeout: 15_000 });
      return true;
    } catch {
      // Some boards redirect to a bare "application submitted" page.
      return /confirmation|thank/i.test(page.url()) || /thank you/i.test(await page.content());
    }
  }
};

const lever: AtsAdapter = {
  formSelector: "form",
  requiresAccount: false,

  async openApplication(page) {
    // Posting pages live at /<company>/<id>; the form at /<company>/<id>/apply.
    if (!page.url().includes("/apply")) {
      await page.goto(page.url().split("?")[0].replace(/\/?$/, "/apply"), {
        waitUntil: "domcontentloaded"
      });
    }
    // The real fields (not just the form shell) must be present before
    // extraction - Lever renders name/email synchronously but wait anyway.
    await page.waitForSelector('input[name="name"], input[name="email"]', { timeout: 20_000 });
  },

  async submit(page) {
    await page
      .locator('button[type="submit"], #btn-submit, button:has-text("Submit application")')
      .first()
      .click();
    await page.waitForTimeout(5000);
  },

  async confirmSubmitted(page) {
    try {
      await page
        .locator("text=/application submitted|thank you/i")
        .first()
        .waitFor({ timeout: 15_000 });
      return true;
    } catch {
      return /thanks|confirmation/i.test(page.url());
    }
  }
};

/** Controls that move a Workday wizard forward, in preference order. */
const WORKDAY_NEXT = [
  'button[data-automation-id="pageFooterNextButton"]',
  'button[data-automation-id="bottom-navigation-next-button"]',
  'button:has-text("Save and Continue")',
  'button:has-text("Continue")',
  'button:has-text("Next")'
];

const WORKDAY_SUBMIT = [
  'button[data-automation-id="pageFooterSubmitButton"]',
  'button[data-automation-id="bottom-navigation-submit-button"]',
  'button:has-text("Submit")'
];

const workday: AtsAdapter = {
  // Workday renders its form as ARIA-tagged divs rather than a semantic <form>,
  // so the scope is the page-level content container.
  formSelector: '[data-automation-id="jobApplicationPage"], form, [role="main"]',
  requiresAccount: true,

  async openApplication(page) {
    // A posting page has an Apply button that leads to sign-in/create-account
    // and then the wizard. Session handling (account creation, login, email
    // verification) happens in sessions.ts BEFORE this runs, so by now we are
    // either authenticated or about to be told we need an account.
    const applyBtn = page
      .locator(
        '[data-automation-id="adventureButton"], a:has-text("Apply"), button:has-text("Apply")'
      )
      .first();
    if ((await applyBtn.count()) > 0) {
      await applyBtn.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(2500);
    }
    // "Autofill with Resume" short-circuits several pages of retyping when the
    // tenant offers it. Best-effort: the manual path fills the same fields.
    const autofill = page
      .locator('[data-automation-id="autofillWithResume"], button:has-text("Autofill with Resume")')
      .first();
    if ((await autofill.count()) > 0) {
      await autofill.click().catch(() => {});
      await page.waitForTimeout(1500);
    }
  },

  async submit(page) {
    for (const selector of WORKDAY_SUBMIT) {
      const button = page.locator(selector).first();
      if ((await button.count()) > 0) {
        await button.click();
        await page.waitForTimeout(5000);
        return;
      }
    }
  },

  async confirmSubmitted(page) {
    try {
      await page
        .locator(
          '[data-automation-id="confirmationPage"], text=/your application has been submitted|thank you for applying/i'
        )
        .first()
        .waitFor({ timeout: 15_000 });
      return true;
    } catch {
      return /confirmation|thank|submitted/i.test(page.url());
    }
  },

  async nextPage(page) {
    for (const selector of WORKDAY_NEXT) {
      const button = page.locator(selector).first();
      if ((await button.count()) > 0 && (await button.isEnabled().catch(() => false))) {
        await button.click().catch(() => {});
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await page.waitForTimeout(2000);
        return true;
      }
    }
    return false;
  },

  async isLastPage(page) {
    for (const selector of WORKDAY_SUBMIT) {
      if ((await page.locator(selector).first().count()) > 0) return true;
    }
    return false;
  }
};

const ashby: AtsAdapter = {
  // Ashby renders its form as React components without a <form> element; the
  // `ashby-*` classes are the public styling hooks Ashby documents for hosted
  // boards, so they are stable across organizations. Plain `form` covers
  // career-site embeds that wrap the board in their own markup.
  formSelector: ".ashby-application-form-container, form",
  requiresAccount: false,

  async openApplication(page) {
    // Postings live at /<org>/<jobId>; the form is the /application tab.
    if (!page.url().includes("/application")) {
      await page.goto(page.url().split("?")[0].replace(/\/?$/, "/application"), {
        waitUntil: "domcontentloaded"
      });
    }
    // The page is a client-rendered shell: the real fields (Ashby system
    // fields, present on every posting) must hydrate before extraction.
    await page.waitForSelector(
      'input[name="_systemfield_name"], input[name="_systemfield_email"]',
      { timeout: 20_000 }
    );
  },

  async submit(page) {
    await page
      .locator('button:has-text("Submit Application"), button[type="submit"]')
      .first()
      .click();
    await page.waitForTimeout(5000);
  },

  async confirmSubmitted(page) {
    // Ashby is a single-page app, so the URL does not change on submit; the
    // success state replaces the form with a submitted/thank-you message.
    try {
      await page
        .locator("text=/application (has been |was )?submitted|thank you for applying/i")
        .first()
        .waitFor({ timeout: 15_000 });
      return true;
    } catch {
      return /application (has been |was )?submitted|thank you for applying/i.test(
        await page.content()
      );
    }
  }
};

/** Controls that advance a LinkedIn Easy Apply modal, in preference order. */
const LINKEDIN_NEXT = [
  'button[aria-label="Continue to next step"]',
  'button[aria-label="Review your application"]',
  'button:has-text("Review")',
  'button:has-text("Next")',
  'button:has-text("Continue")'
];

const LINKEDIN_SUBMIT = [
  'button[aria-label="Submit application"]',
  'button:has-text("Submit application")'
];

const LINKEDIN_MODAL = '.jobs-easy-apply-modal, [data-test-modal][role="dialog"]';

const linkedin: AtsAdapter = {
  // The Easy Apply modal, not the page: a bare `form` would match the job
  // search box that also lives on a posting page.
  formSelector: LINKEDIN_MODAL,
  requiresAccount: true,

  async openApplication(page) {
    // reachForm has already navigated to the posting, and sign-in happened in
    // /session/ensure, so by now the Easy Apply button is present for a logged-in
    // user. Click it and wait for the modal to mount.
    const easyApply = page
      .locator(
        'button.jobs-apply-button, button[aria-label*="Easy Apply" i], button:has-text("Easy Apply")'
      )
      .first();
    for (let attempt = 0; attempt < 6; attempt++) {
      if ((await page.locator(LINKEDIN_MODAL).count()) > 0) return;
      if (
        (await easyApply.count()) > 0 &&
        (await easyApply.isVisible().catch(() => false))
      ) {
        await easyApply.click().catch(() => {});
        await page.waitForTimeout(2000);
      } else {
        await page.waitForTimeout(1500);
      }
    }
  },

  async submit(page) {
    for (const selector of LINKEDIN_SUBMIT) {
      const button = page.locator(selector).first();
      if ((await button.count()) > 0) {
        await button.click();
        await page.waitForTimeout(4000);
        return;
      }
    }
  },

  async confirmSubmitted(page) {
    try {
      await page
        .locator("text=/your application was sent|application sent|application submitted/i")
        .first()
        .waitFor({ timeout: 15_000 });
      return true;
    } catch {
      return /your application was sent|application sent/i.test(await page.content());
    }
  },

  async nextPage(page) {
    for (const selector of LINKEDIN_NEXT) {
      const button = page.locator(selector).first();
      if ((await button.count()) > 0 && (await button.isEnabled().catch(() => false))) {
        await button.click().catch(() => {});
        await page.waitForTimeout(1500);
        return true;
      }
    }
    return false;
  },

  async isLastPage(page) {
    for (const selector of LINKEDIN_SUBMIT) {
      if ((await page.locator(selector).first().count()) > 0) return true;
    }
    return false;
  },

  async discardApplication(page) {
    // Close the modal (X), then confirm the "Discard" prompt LinkedIn shows so
    // the abandoned application does not linger as a saved draft.
    const dismiss = page.locator('button[aria-label="Dismiss"]').first();
    if ((await dismiss.count()) > 0) {
      await dismiss.click().catch(() => {});
      await page.waitForTimeout(500);
    }
    const discard = page
      .locator('button[data-test-dialog-primary-btn], button:has-text("Discard")')
      .first();
    if ((await discard.count()) > 0) {
      await discard.click().catch(() => {});
      await page.waitForTimeout(500);
    }
  }
};

/**
 * Consent/cookie/privacy overlays either intercept pointer events across the
 * WHOLE page (a Framer cookie banner on a bunq careers page timed out every
 * click under it) or visually dominate it enough that vision reads the page as
 * an unclearable modal and gives up (a Dayforce posting's fixed `.ant-card`
 * consent card was diagnosed as "a privacy notice modal overlaying the page").
 * Dismissing them first fixes both. Accept-shaped controls only, first visible
 * match, best-effort: a page without a banner loses nothing.
 *
 * `:has-text()` matches case-insensitively, so one casing per phrase is
 * enough. The attribute selector catches component-generated ids like
 * `__framer-cookie-component-button-accept`. Phrases stay accept-shaped and
 * avoid bare "Continue"/"OK", which double as wizard controls.
 */
// `:has-text()` is a case-insensitive SUBSTRING match, so a bare
// `has-text("Agree")` also matches a "Disagree" reject button. Ambiguous
// single words therefore use `:text-is()` (exact, trimmed) instead; multi-word
// accept phrases keep substring matching, which no reject control contains.
const CONSENT_SELECTORS = [
  "#onetrust-accept-btn-handler",
  '[id*="cookie"][id*="accept"]',
  'button:has-text("Accept all")',
  'button:has-text("Accept cookies")',
  'button:has-text("Accept and continue")',
  'button:has-text("I accept")',
  'button:has-text("I agree")',
  'button:has-text("Agree and continue")',
  'button:text-is("Agree")',
  'button:text-is("Accept")',
  'button:has-text("Allow all")',
  'button:has-text("Got it")'
];

async function dismissConsentOverlay(page: Page): Promise<void> {
  for (const selector of CONSENT_SELECTORS) {
    const control = page.locator(selector).first();
    if ((await control.count()) > 0 && (await control.isVisible().catch(() => false))) {
      await control.click().catch(() => {});
      await page.waitForTimeout(500);
      return;
    }
  }
}

const dayforce: AtsAdapter = {
  // The Ceridian Dayforce candidate portal renders one <form> per wizard page.
  formSelector: "form",
  requiresAccount: false,

  async openApplication(page) {
    // The consent card is a fixed ant-card that vision reads as a blocking
    // modal; clear it first so the flow is unobstructed.
    await dismissConsentOverlay(page);

    // Posting page (/jobs/<id>) -> the Apply button leads to a flow-selection
    // screen offering guest vs account application.
    if (!page.url().includes("/apply")) {
      await page
        .locator('a:has-text("Apply"), button:has-text("Apply")')
        .first()
        .click()
        .catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(2500);
    }

    // Always take the guest path: JobArms never creates an account on an
    // employer tenant for a non-account-gated ATS.
    const guest = page
      .locator(
        'button:has-text("Apply without an Account"), a:has-text("Apply without an Account")'
      )
      .first();
    if ((await guest.count()) > 0) {
      await guest.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(2500);
    }

    // Wait for the guest application form SPECIFICALLY, by its
    // `jobPostingApplication_`-prefixed controls (personalInfo, files, etc.),
    // never a bare `form`: the portal keeps search and chrome forms in the DOM,
    // and matching those would extract the wrong form before the wizard mounts.
    await page
      .waitForSelector('input[name^="jobPostingApplication"]', { timeout: 20_000 })
      .catch(() => {});
  },

  async submit(page) {
    await page.locator(GENERIC_SUBMIT_TEXT).first().click();
    await page.waitForTimeout(5000);
  },

  async confirmSubmitted(page) {
    try {
      await page
        .locator(
          "text=/application (has been |was )?submitted|thank you for (applying|your application)|your application has been received/i"
        )
        .first()
        .waitFor({ timeout: 15_000 });
      return true;
    } catch {
      return /application (has been |was )?submitted|thank you for (applying|your application)|your application has been received/i.test(
        await page.content()
      );
    }
  },

  // The guest application is a multi-page wizard (page one ends on "Next"),
  // driven by the shared loop in app.ts with the same text-based Next/Submit
  // detection as the generic adapter.
  async isLastPage(page) {
    return hasGenericSubmit(page);
  },

  async nextPage(page) {
    return advanceByNext(page);
  }
};

/**
 * The best-effort adapter for boards nobody has tuned.
 *
 * It does the universal moves and nothing clever: everything harder is the
 * job of the recovery machinery (playbooks, vision, page-wide extraction),
 * which is keyed per domain and therefore learns each untuned site with use.
 * Generic runs are review-gate only and `confirmSubmitted` is deliberately
 * strict: with no known confirmation shape, only explicit success wording
 * counts, and anything less ends as an honest `submit_unconfirmed` rather
 * than a claimed success.
 */
const generic: AtsAdapter = {
  // Narrow on purpose: a real <form> must always win. Component-built career
  // sites that render fields with NO <form> element are handled by the
  // generic-only page-wide fallback in reach.ts, which runs only after this
  // scope found nothing form-shaped.
  formSelector: "form",
  requiresAccount: false,

  async openApplication(page) {
    /**
     * Is the APPLICATION form already on screen? If so, another Apply click
     * could navigate away from it. Answered by the SAME extraction + sanity
     * pair the reach path uses, not by a lookalike heuristic: every attempt
     * to approximate it (email input? email + name attribute?) either
     * mistook a newsletter box for the form or skipped Apply on a page whose
     * extraction was about to fail, because the sanity check also accepts
     * label text, opaque field names, and sheer field volume. One check, one
     * verdict. The password guard is the single extra rule, since a login
     * widget can carry enough chrome to pass the sanity bar.
     */
    const applicationUp = async (): Promise<boolean> => {
      if ((await page.locator('input[type="password"]').count()) > 0) return false;
      return looksLikeApplicationForm(await collectFields(page, "body")).ok;
    };

    // If the form is not up, try the two universal moves: clear a consent
    // overlay, then click an Apply control and wait for something to mount.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await applicationUp()) return;

      await dismissConsentOverlay(page);

      const applyBtn = page.locator('a:has-text("Apply"), button:has-text("Apply")').first();
      if ((await applyBtn.count()) > 0) {
        await applyBtn.click().catch(() => {});
        await page.waitForLoadState("domcontentloaded").catch(() => {});
      }
      await page.waitForTimeout(2000);
    }
  },

  async submit(page) {
    await page
      .locator(
        'form button[type="submit"], form input[type="submit"], button:has-text("Submit")'
      )
      .first()
      .click();
    await page.waitForTimeout(5000);
  },

  async confirmSubmitted(page) {
    try {
      await page
        .locator(
          "text=/application (has been |was )?submitted|thank you for (applying|your application)/i"
        )
        .first()
        .waitFor({ timeout: 15_000 });
      return true;
    } catch {
      return /application (has been |was )?submitted|thank you for (applying|your application)/i.test(
        await page.content()
      );
    }
  },

  // Wizard hooks: many untuned application forms span pages (a Dayforce guest
  // application ends page one on "Next", not "Submit"). The shared wizard loop
  // in app.ts drives these, accumulating every page's fields into one review
  // payload and replaying answers per page, bounded by maxWizardPages. A plain
  // single-page form reports isLastPage=false and nextPage=false, so the loop
  // stops after page one, unchanged.
  async isLastPage(page) {
    return hasGenericSubmit(page);
  },

  async nextPage(page) {
    return advanceByNext(page);
  }
};

/**
 * Advance a multi-page wizard: click the first enabled Next-shaped control,
 * unless a submit control shows this is already the last page. Shared by the
 * generic and Dayforce adapters so the advance behavior (and its best-effort
 * failure handling) lives, and is tested, in one place.
 */
async function advanceByNext(page: Page): Promise<boolean> {
  if (await hasGenericSubmit(page)) return false;
  for (const selector of GENERIC_NEXT) {
    const button = page.locator(selector).first();
    if ((await button.count()) > 0 && (await button.isEnabled().catch(() => false))) {
      await button.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(2000);
      return true;
    }
  }
  return false;
}

/**
 * A submittable final page, detected by button TEXT, never by `type="submit"`:
 * a wizard's "Next" button is frequently `type="submit"` inside the page form,
 * so keying off the attribute would read page one as the last page and refuse
 * to advance. The actual submit click (below) keeps the broader attribute
 * selector, because by then we have decided this IS the last page.
 */
async function hasGenericSubmit(page: Page): Promise<boolean> {
  // Visibility matters: a wizard often keeps an off-step Submit button in the
  // DOM (hidden) on earlier pages, and counting it would read page one as the
  // last page and freeze paging. Only a VISIBLE submit control ends the wizard.
  const button = page.locator(GENERIC_SUBMIT_TEXT).first();
  return (await button.count()) > 0 && (await button.isVisible().catch(() => false));
}

const GENERIC_SUBMIT_TEXT = 'button:has-text("Submit application"), button:has-text("Submit")';

/** Advance controls, in preference order, for a generic multi-page wizard. */
const GENERIC_NEXT = [
  'button:has-text("Save and continue")',
  'button:has-text("Save and Continue")',
  'button:has-text("Continue")',
  'button:has-text("Next")',
  'a:has-text("Next")'
];

export const ADAPTERS: Record<Ats, AtsAdapter> = {
  greenhouse,
  lever,
  workday,
  ashby,
  dayforce,
  linkedin,
  generic
};
