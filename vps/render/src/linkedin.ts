/**
 * LinkedIn sign-in for Easy Apply.
 *
 * Unlike the Workday account flow (create an account the arm owns, confirm it by
 * email), LinkedIn uses the user's OWN login. So there is no account creation
 * here, only sign-in, plus the one wrinkle a real professional account brings:
 * LinkedIn often answers a fresh-browser login with a one-time PIN sent to the
 * user's email or phone. We cannot read that mailbox, so a challenge parks the
 * run and the code is typed by the user in the dashboard, then handed back here.
 *
 * The status this returns is what the apply-arm Workflow parks on:
 *   authenticated      -> proceed to open Easy Apply and fill
 *   needs_login_code   -> park the run, wait for the user to enter the PIN
 *   login_failed       -> honest failure (wrong password, or a challenge we
 *                         cannot drive: a captcha, or an app-approval prompt)
 */
import type { Page } from "playwright";
import { CONFIG } from "./config.js";
import { visibleTextInPage } from "./account.js";

export type LinkedInAuthStatus = "authenticated" | "needs_login_code" | "login_failed";

export interface LinkedInAuthResult {
  status: LinkedInAuthStatus;
  /**
   * When a PIN challenge is shown, the URL to resume it at. A later phase opens
   * a fresh page (cookies persist, DOM does not), so the code-entry step returns
   * to this URL rather than guessing where the challenge lives.
   */
  checkpointUrl?: string;
}

const LOGIN_URL = "https://www.linkedin.com/login";
const FEED_URL = "https://www.linkedin.com/feed/";

const EMAIL_SELECTORS = [
  "#username",
  'input[name="session_key"]',
  'input[autocomplete="username"]',
  'input[type="email"]'
];
const PASSWORD_SELECTORS = ["#password", 'input[name="session_password"]', 'input[type="password"]'];
const SIGN_IN_SUBMIT = [
  'button[data-litms-control-urn*="login-submit"]',
  'button[aria-label="Sign in"]',
  'button[type="submit"]'
];

const CODE_SELECTORS = [
  'input[name="pin"]',
  "#input__email_verification_pin",
  'input[autocomplete="one-time-code"]',
  'input[name*="pin" i]',
  'input[id*="verification" i]'
];
const CODE_SUBMIT = [
  "#email-pin-submit-button",
  'button[id*="pin-submit" i]',
  'button[type="submit"]',
  'button:has-text("Submit")',
  'button:has-text("Verify")'
];

/** A PIN challenge we can drive: a URL or visible text that says "enter a code". */
const CHECKPOINT_URL_RE = /\/checkpoint\/|\/challenge\//i;
const CODE_PROMPT_RE =
  /enter the (?:code|pin)|verification code|we sent (?:a|you a) (?:code|pin)|two-step verification|confirm it.?s you|security verification/i;

/** Wording that means the password itself was wrong (a hard failure, no retry). */
const LOGIN_ERROR_RE =
  /wrong email or password|that.?s not the right password|couldn.?t (?:find|verify) (?:your|that) account|please enter a valid|hmm, we don.?t recognize/i;

/** First selector in `candidates` that matches something on the page, else null. */
async function firstMatch(page: Page, candidates: string[]): Promise<string | null> {
  for (const selector of candidates) {
    if (await page.locator(selector).count().catch(() => 0)) return selector;
  }
  return null;
}

/** The page's visible text; empty string when a navigation makes it unreadable. */
async function visibleText(page: Page): Promise<string> {
  try {
    return await page.evaluate(visibleTextInPage);
  } catch {
    return "";
  }
}

/** True while a login form (email + password) is on screen: we are NOT signed in. */
async function hasLoginForm(page: Page): Promise<boolean> {
  const email = await firstMatch(page, EMAIL_SELECTORS);
  const password = (await page.locator('input[type="password"]').count().catch(() => 0)) > 0;
  return email !== null && password;
}

/**
 * Decide where a sign-in attempt landed.
 *
 * Order matters: a PIN challenge keeps no password field but is NOT a failure,
 * so it is checked before "still a login form". A challenge with no code field
 * we can fill (a captcha, an app-approval prompt) is a hard failure, since the
 * arm cannot drive it and waiting for a code that has nowhere to go would hang.
 */
async function classify(page: Page): Promise<LinkedInAuthResult> {
  const url = page.url();
  const text = await visibleText(page);

  const looksLikeChallenge = CHECKPOINT_URL_RE.test(url) || CODE_PROMPT_RE.test(text);
  if (looksLikeChallenge) {
    if (await firstMatch(page, CODE_SELECTORS)) {
      return { status: "needs_login_code", checkpointUrl: url };
    }
    return { status: "login_failed" };
  }

  if (LOGIN_ERROR_RE.test(text)) return { status: "login_failed" };
  if (await hasLoginForm(page)) return { status: "login_failed" };
  return { status: "authenticated" };
}

/**
 * Sign in to LinkedIn in the held session.
 *
 * Returns immediately when the restored cookies still have us logged in (the
 * common path after the first run), which is why the session cache matters here
 * as much as it does for Workday.
 */
export async function signInLinkedIn(
  page: Page,
  creds: { email: string; password: string }
): Promise<LinkedInAuthResult> {
  // Cheapest check first: land on the feed and see where the restored session
  // stands. No login form means we are either already in OR resuming mid-PIN
  // (a challenge the last run left open); classify tells the two apart, so we
  // return authenticated or needs_login_code WITHOUT navigating to the login
  // page, which would abandon a live checkpoint.
  await page.goto(FEED_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(1000);
  if (!(await hasLoginForm(page))) {
    const landed = await classify(page);
    if (landed.status !== "login_failed") return landed;
    // An odd state with no form and no actionable challenge: fall through and
    // try an explicit sign-in rather than give up.
  }

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
  const emailSel = await firstMatch(page, EMAIL_SELECTORS);
  const passSel = await firstMatch(page, PASSWORD_SELECTORS);
  // No form to fill: either already signed in, or a challenge is up. Let
  // classify decide rather than guessing.
  if (!emailSel || !passSel) return classify(page);

  await page.fill(emailSel, creds.email).catch(() => {});
  await page.fill(passSel, creds.password).catch(() => {});
  const submit = await firstMatch(page, SIGN_IN_SUBMIT);
  if (submit) await page.locator(submit).first().click().catch(() => {});
  else await page.locator(passSel).first().press("Enter").catch(() => {});

  await page.waitForLoadState("networkidle", { timeout: CONFIG.navTimeoutMs }).catch(() => {});
  await page.waitForTimeout(1500);
  return classify(page);
}

/**
 * Type the one-time PIN the user gave us into the checkpoint, in the same
 * session that started the login. Returns the resulting status so the caller can
 * resume the run or fail it honestly.
 */
export async function submitLoginCode(
  page: Page,
  args: { code: string; checkpointUrl?: string | null }
): Promise<LinkedInAuthResult> {
  await page
    .goto(args.checkpointUrl || FEED_URL, { waitUntil: "domcontentloaded" })
    .catch(() => {});
  await page.waitForTimeout(1000);

  const codeSel = await firstMatch(page, CODE_SELECTORS);
  // No code field: the challenge is gone. Maybe it cleared itself (a resumed
  // session), maybe it expired; classify says which.
  if (!codeSel) return classify(page);

  await page.fill(codeSel, args.code).catch(() => {});
  const submit = await firstMatch(page, CODE_SUBMIT);
  if (submit) await page.locator(submit).first().click().catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: CONFIG.navTimeoutMs }).catch(() => {});
  await page.waitForTimeout(1500);
  return classify(page);
}
