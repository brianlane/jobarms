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
  // #main_fields (legacy) — match either.
  formSelector: 'form[id*="application"], #application-form, #application_form',

  async openApplication(page) {
    // Hosted GH job pages show the form inline; embedded boards need the
    // "Apply" tab. Click it if the form isn't already there.
    const form = page.locator('form[id*="application"]');
    if ((await form.count()) > 0) return;
    const applyBtn = page
      .locator('a:has-text("Apply"), button:has-text("Apply")')
      .first();
    if ((await applyBtn.count()) > 0) {
      await applyBtn.click();
      await page.waitForTimeout(1500);
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
  formSelector: ".application-form, form#application-form, form[action*='apply']",

  async openApplication(page) {
    // Posting pages live at /<company>/<id>; the form at /<company>/<id>/apply.
    if (!page.url().includes("/apply")) {
      const applyBtn = page
        .locator('a[href*="/apply"], .postings-btn, a:has-text("Apply for this job")')
        .first();
      if ((await applyBtn.count()) > 0) {
        await applyBtn.click();
        await page.waitForLoadState("domcontentloaded");
      } else {
        await page.goto(page.url().replace(/\/?$/, "/apply"), { waitUntil: "domcontentloaded" });
      }
    }
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
