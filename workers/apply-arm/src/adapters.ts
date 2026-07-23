/**
 * Per-ATS quirks. Everything generic lives in browser.ts; adapters know how
 * to reach the form, submit it, and recognize success.
 */
import type { Page } from "@cloudflare/playwright";

export interface AtsAdapter {
  formSelector: string;
  /** Get from the job posting page to a visible application form. */
  openApplication(page: Page): Promise<void>;
  submit(page: Page): Promise<void>;
  confirmSubmitted(page: Page): Promise<boolean>;
}

const greenhouse: AtsAdapter = {
  // Classic hosted boards use #application-form (new) or #application_form /
  // #main_fields (legacy) - match either.
  formSelector: 'form[id*="application"], #application-form, #application_form',

  async openApplication(page) {
    // Hosted GH job pages show the form inline. Most companies now redirect
    // hosted URLs to their own careers site, which lazy-loads the Greenhouse
    // form in an iframe - poll for form-or-iframe, then navigate INTO the
    // embed so the form is top-level for the extractor/filler.
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
        .locator('text=/application submitted|thank you/i')
        .first()
        .waitFor({ timeout: 15_000 });
      return true;
    } catch {
      return /thanks|confirmation/i.test(page.url());
    }
  }
};

export const ADAPTERS: Record<"greenhouse" | "lever", AtsAdapter> = {
  greenhouse,
  lever
};
