/**
 * Layer 2: solve INTERACTIVE image-grid captchas (reCAPTCHA v2 checkbox +
 * challenge, hCaptcha) with our own Gemini vision, no third-party service.
 *
 * This does NOT apply to invisible reCAPTCHA v3/Enterprise (no image to see;
 * that is an IP/fingerprint problem, Layer 3). It only engages when a visible
 * challenge widget is actually present.
 */
import type { Page } from "@cloudflare/playwright";
import type { Env } from "./types";
import { solveImageGrid } from "./gemini";

export type ChallengeKind = "recaptcha_v2" | "hcaptcha" | null;

/** Is a visible, interactive challenge widget present on the page? */
export async function detectInteractiveChallenge(page: Page): Promise<ChallengeKind> {
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
    // detection is best-effort
  }
  return null;
}

const CHALLENGE_BUDGET_MS = 90_000;

/**
 * Attempt to clear an interactive challenge. Returns true if we believe it is
 * solved (checkbox checked / no challenge remaining). Best-effort and bounded;
 * a false result becomes a captcha_blocked outcome upstream.
 */
export async function solveInteractiveChallenge(
  env: Env,
  page: Page,
  kind: ChallengeKind
): Promise<boolean> {
  const deadline = Date.now() + CHALLENGE_BUDGET_MS;
  if (kind === "recaptcha_v2") return solveRecaptchaV2(env, page, deadline);
  // hCaptcha grid uses the same visual approach; detection wired, solve is a
  // best-effort reuse of the grid solver via its challenge popup.
  if (kind === "hcaptcha") return solveHcaptcha(env, page, deadline);
  return false;
}

async function solveRecaptchaV2(env: Env, page: Page, deadline: number): Promise<boolean> {
  const anchor = page.frameLocator('iframe[src*="recaptcha/api2/anchor"]');
  // Click the "I'm not a robot" checkbox.
  try {
    await anchor.locator("#recaptcha-anchor").click({ timeout: 8000 });
  } catch {
    return false;
  }
  await page.waitForTimeout(1500);

  const isChecked = async (): Promise<boolean> => {
    try {
      const cls = (await anchor.locator("#recaptcha-anchor").getAttribute("aria-checked")) ?? "";
      return cls === "true";
    } catch {
      return false;
    }
  };
  if (await isChecked()) return true; // passive pass, no grid shown

  const bframe = page.frameLocator('iframe[src*="recaptcha/api2/bframe"]');

  // Up to 3 grids/reloads.
  for (let round = 0; round < 3 && Date.now() < deadline; round++) {
    const instruction = await bframe
      .locator(".rc-imageselect-instructions")
      .textContent()
      .catch(() => null);
    if (!instruction) break;

    // reCAPTCHA grids are 3x3 (classic) or 4x4 (fresh). Detect by tile count.
    const tiles = bframe.locator("table td[role='button'], .rc-imageselect-tile");
    const tileCount = await tiles.count().catch(() => 0);
    if (tileCount === 0) break;
    const cols = tileCount === 16 ? 4 : 3;
    const rows = Math.ceil(tileCount / cols);

    // Screenshot the challenge popup and ask Gemini which tiles match.
    let shot: Uint8Array | null = null;
    try {
      const el = bframe.locator(".rc-imageselect-payload, #rc-imageselect");
      shot = new Uint8Array(await el.first().screenshot());
    } catch {
      shot = null;
    }
    if (!shot) break;

    const picks = await solveImageGrid(env, shot, instruction.replace(/\s+/g, " ").trim(), rows, cols).catch(
      () => [] as number[]
    );
    if (picks.length === 0) {
      // Nothing matched; reload for a different challenge.
      await bframe.locator("#recaptcha-reload-button").click().catch(() => {});
      await page.waitForTimeout(1500);
      continue;
    }

    for (const idx of picks) {
      await tiles.nth(idx).click().catch(() => {});
      await page.waitForTimeout(200 + Math.random() * 250);
    }
    await bframe.locator("#recaptcha-verify-button").click().catch(() => {});
    await page.waitForTimeout(2500);

    if (await isChecked()) return true;
  }

  return isChecked();
}

async function solveHcaptcha(env: Env, page: Page, deadline: number): Promise<boolean> {
  // hCaptcha: open the challenge, screenshot, solve the grid. hCaptcha markup
  // is less stable than reCAPTCHA; treat as best-effort.
  const checkbox = page.frameLocator('iframe[src*="hcaptcha.com"][title*="checkbox" i]');
  try {
    await checkbox.locator("#checkbox").click({ timeout: 8000 });
  } catch {
    return false;
  }
  await page.waitForTimeout(2000);

  const challenge = page.frameLocator('iframe[src*="hcaptcha.com"][title*="challenge" i]');
  for (let round = 0; round < 2 && Date.now() < deadline; round++) {
    const instruction = await challenge
      .locator(".prompt-text, .challenge-prompt")
      .textContent()
      .catch(() => null);
    const tiles = challenge.locator(".task-image, .image");
    const tileCount = await tiles.count().catch(() => 0);
    if (!instruction || tileCount === 0) break;

    const cols = tileCount >= 9 ? 3 : 2;
    const rows = Math.ceil(tileCount / cols);
    let shot: Uint8Array | null = null;
    try {
      shot = new Uint8Array(await challenge.locator("body").first().screenshot());
    } catch {
      shot = null;
    }
    if (!shot) break;

    const picks = await solveImageGrid(env, shot, instruction.trim(), rows, cols).catch(
      () => [] as number[]
    );
    for (const idx of picks) {
      await tiles.nth(idx).click().catch(() => {});
      await page.waitForTimeout(250);
    }
    await challenge.locator(".button-submit").click().catch(() => {});
    await page.waitForTimeout(2500);
  }
  // We cannot reliably read hCaptcha solved-state cross-frame; report optimistic
  // only if the challenge iframe disappeared.
  return (await page.locator('iframe[src*="hcaptcha.com"][title*="challenge" i]').count()) === 0;
}
