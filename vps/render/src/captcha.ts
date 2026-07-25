/**
 * Interactive anti-bot challenges: detection AND solving.
 *
 * The awkward part is that solving needs two things that deliberately live in
 * different places. Clicking tiles needs the LIVE PAGE, which only this service
 * has. Deciding which tiles to click needs a VISION MODEL, and this box holds no
 * AI credentials on purpose (it is shared hardware; see the service README).
 *
 * So the model stays on the edge and we call out to it: `askSolver` is a
 * callback that ships a screenshot of the grid plus the instruction to the
 * apply-arm worker, which runs Gemini and returns the tile indices. That is a
 * FIXED endpoint from config, never a URL from a request, so it adds no SSRF
 * surface.
 *
 * Scope: this only engages for a VISIBLE grid challenge (reCAPTCHA v2,
 * hCaptcha). Invisible reCAPTCHA v3/Enterprise has no image to look at; it
 * scores the session by IP reputation and fingerprint, which is what owning this
 * browser is for.
 */
import type { FrameLocator, Page } from "playwright";
import { CONFIG } from "./config.js";

export type ChallengeKind = "recaptcha_v2" | "hcaptcha" | null;

/**
 * Ask the edge which grid cells match. Cells are numbered left to right, top to
 * bottom from 0. Returns an empty array when nothing matches or the model is
 * unavailable, which the callers treat as "reload and try another grid".
 */
export type AskSolver = (
  imageBase64: string,
  instruction: string,
  rows: number,
  cols: number
) => Promise<number[]>;

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

/**
 * The production solver: POST the grid to the worker's solve endpoint.
 *
 * Null when unconfigured, so a deployment without the callback wired simply does
 * not attempt solving (and reports captcha_blocked) rather than erroring.
 */
export function httpSolver(
  attribution: { userId?: string; runId?: string } = {}
): AskSolver | null {
  if (!CONFIG.solverUrl || !CONFIG.solverToken) return null;
  return async (imageBase64, instruction, rows, cols) => {
    try {
      const res = await fetch(CONFIG.solverUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${CONFIG.solverToken}`
        },
        // userId/runId ride along so the model spend is attributed to the run
        // that caused it rather than landing as unattributed platform cost.
        body: JSON.stringify({ imageBase64, instruction, rows, cols, ...attribution }),
        signal: AbortSignal.timeout(CONFIG.solverTimeoutMs)
      });
      if (!res.ok) return [];
      const body = (await res.json().catch(() => null)) as { tiles?: unknown } | null;
      if (!Array.isArray(body?.tiles)) return [];
      // Re-validate here too: the grid we clicked must match the grid we asked
      // about, and a bad index would throw inside the click loop.
      return body.tiles.filter(
        (n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < rows * cols
      );
    } catch {
      // A solver outage is not a run failure; it just means captcha_blocked.
      return [];
    }
  };
}

/**
 * Try to clear a visible challenge. True when we believe a token was minted.
 *
 * Best-effort and bounded by a wall-clock budget: a false result becomes a
 * `captcha_blocked` outcome upstream, which is an honest "we filled everything,
 * the employer's bot check stopped the send".
 */
export async function solveChallenge(
  page: Page,
  kind: ChallengeKind,
  askSolver: AskSolver,
  now: () => number = Date.now
): Promise<boolean> {
  const deadline = now() + CONFIG.challengeBudgetMs;
  if (kind === "recaptcha_v2") return solveRecaptchaV2(page, askSolver, deadline, now);
  if (kind === "hcaptcha") return solveHcaptcha(page, askSolver, deadline, now);
  return false;
}

/** Screenshot one element as base64, or null when it cannot be captured. */
async function shotOf(frame: FrameLocator, selector: string): Promise<string | null> {
  try {
    const buffer = await frame.locator(selector).first().screenshot();
    return buffer.toString("base64");
  } catch {
    return null;
  }
}

async function solveRecaptchaV2(
  page: Page,
  askSolver: AskSolver,
  deadline: number,
  now: () => number
): Promise<boolean> {
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
      return (await anchor.locator("#recaptcha-anchor").getAttribute("aria-checked")) === "true";
    } catch {
      return false;
    }
  };
  // A passive pass: the checkbox alone satisfied it and no grid ever appeared.
  if (await isChecked()) return true;

  const bframe = page.frameLocator('iframe[src*="recaptcha/api2/bframe"]');

  // Up to three grids: reCAPTCHA serves a fresh one after a wrong answer.
  for (let round = 0; round < 3 && now() < deadline; round++) {
    const instruction = await bframe
      .locator(".rc-imageselect-instructions")
      .textContent()
      .catch(() => null);
    if (!instruction) break;

    // Grids are 3x3 (classic) or 4x4 (fresh); infer from the tile count.
    const tiles = bframe.locator("table td[role='button'], .rc-imageselect-tile");
    const tileCount = await tiles.count().catch(() => 0);
    if (tileCount === 0) break;
    const cols = tileCount === 16 ? 4 : 3;
    const rows = Math.ceil(tileCount / cols);

    const shot = await shotOf(bframe, ".rc-imageselect-payload, #rc-imageselect");
    if (!shot) break;

    const picks = await askSolver(shot, instruction.replace(/\s+/g, " ").trim(), rows, cols).catch(
      () => [] as number[]
    );
    if (picks.length === 0) {
      // Nothing matched: ask for a different challenge rather than guessing.
      await bframe.locator("#recaptcha-reload-button").click().catch(() => {});
      await page.waitForTimeout(1500);
      continue;
    }

    for (const index of picks) {
      await tiles.nth(index).click().catch(() => {});
      // Human-ish spacing between tile clicks; the widget scores cadence too.
      await page.waitForTimeout(200 + Math.floor(Math.random() * 250));
    }
    await bframe.locator("#recaptcha-verify-button").click().catch(() => {});
    await page.waitForTimeout(2500);

    if (await isChecked()) return true;
  }

  return isChecked();
}

async function solveHcaptcha(
  page: Page,
  askSolver: AskSolver,
  deadline: number,
  now: () => number
): Promise<boolean> {
  // hCaptcha markup is less stable than reCAPTCHA's; treat all of this as
  // best-effort and lean on the final aria-checked read for the verdict.
  const checkbox = page.frameLocator('iframe[src*="hcaptcha.com"][title*="checkbox" i]');
  try {
    await checkbox.locator("#checkbox").click({ timeout: 8000 });
  } catch {
    return false;
  }
  await page.waitForTimeout(2000);

  const challenge = page.frameLocator('iframe[src*="hcaptcha.com"][title*="challenge" i]');
  for (let round = 0; round < 2 && now() < deadline; round++) {
    const instruction = await challenge
      .locator(".prompt-text, .challenge-prompt")
      .textContent()
      .catch(() => null);
    const tiles = challenge.locator(".task-image, .image");
    const tileCount = await tiles.count().catch(() => 0);
    if (!instruction || tileCount === 0) break;

    const cols = tileCount >= 9 ? 3 : 2;
    const rows = Math.ceil(tileCount / cols);
    const shot = await shotOf(challenge, "body");
    if (!shot) break;

    const picks = await askSolver(shot, instruction.trim(), rows, cols).catch(
      () => [] as number[]
    );
    for (const index of picks) {
      await tiles.nth(index).click().catch(() => {});
      await page.waitForTimeout(250);
    }
    await challenge.locator(".button-submit").click().catch(() => {});
    await page.waitForTimeout(2500);
  }

  // The checkbox widget reports aria-checked once a token is minted, so trust it
  // in EITHER direction first. Only when the state is unreadable do we fall back
  // to the optimistic "challenge popup is gone" signal: an explicit false must
  // never be reported as solved just because the popup closed.
  const checked = await checkbox
    .locator("#checkbox")
    .getAttribute("aria-checked")
    .catch(() => null);
  if (checked === "true") return true;
  if (checked === "false") return false;
  return page
    .locator('iframe[src*="hcaptcha.com"][title*="challenge" i]')
    .count()
    .then((n) => n === 0)
    // Unreadable means we cannot claim success either. Reporting solved here
    // would turn a blocked submit into a silent "probably went through", which
    // is exactly the ambiguity captcha_blocked exists to avoid.
    .catch(() => false);
}
