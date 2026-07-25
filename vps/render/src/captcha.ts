/**
 * Anti-bot challenge DETECTION.
 *
 * Detection only, deliberately: solving an image-grid challenge needs a vision
 * model, and this box holds no AI credentials (the same reason the playbook and
 * vision diagnosis arrive in the request). What detection buys is an honest
 * outcome: when a challenge is on screen and no confirmation appeared, the run
 * reports `captcha_blocked` instead of the ambiguous `unconfirmed`, which is what
 * the metering policy keys off (real work was done, so the run consumes its slot
 * and the user is told to finish on the employer's site).
 *
 * Invisible reCAPTCHA v3/Enterprise has nothing to detect and nothing to see; it
 * scores the session by IP reputation and fingerprint. Owning this browser is the
 * actual answer there (see the Captcha Layer 3 notes in todo.md).
 */
import type { Page } from "playwright";

export type ChallengeKind = "recaptcha_v2" | "hcaptcha" | null;

/** Is a visible, interactive challenge widget present? Never throws. */
export async function detectChallenge(page: Page): Promise<ChallengeKind> {
  try {
    if ((await page.locator('iframe[src*="recaptcha/api2/anchor"]').count()) > 0) {
      return "recaptcha_v2";
    }
    if (
      (await page.locator('iframe[src*="hcaptcha.com"], iframe[title*="hCaptcha" i]').count()) > 0
    ) {
      return "hcaptcha";
    }
  } catch {
    // A detached page mid-probe is not worth failing a submit over.
  }
  return null;
}
