/**
 * Candidate accounts on employer tenants.
 *
 * Workday gives every employer its own tenant with its own candidate database,
 * so "apply" means: create an account on THIS tenant, verify the email, then
 * fill the wizard. All of it is invisible to the user: the account uses their
 * managed applicant alias and a generated password, both held by the app (see
 * the `site_accounts` vault), and the verification mail arrives at the alias and
 * is handed back to us by the inbound webhook.
 *
 * The state machine this returns is what the apply-arm Workflow parks on:
 *   authenticated             -> proceed to extract/fill
 *   needs_email_verification  -> park the run, wait for the inbound mail
 *   login_failed              -> honest failure (bad credentials, MFA, captcha)
 */
import type { Page } from "playwright";
import { CONFIG } from "./config.js";

export type AccountStatus =
  | "authenticated"
  | "needs_email_verification"
  | "login_failed";

export interface AccountCredentials {
  /** The user's managed applicant alias. */
  email: string;
  /** Generated per tenant, stored encrypted by the app. */
  password: string;
}

/** First selector in `candidates` that matches something, else null. */
async function firstMatch(page: Page, candidates: string[]): Promise<string | null> {
  for (const selector of candidates) {
    if (await page.locator(selector).count().catch(() => 0)) return selector;
  }
  return null;
}

const EMAIL_SELECTORS = [
  '[data-automation-id="email"]',
  'input[type="email"]',
  'input[autocomplete="username"]',
  'input[name*="email" i]',
  'input[name*="user" i]'
];

const PASSWORD_SELECTORS = [
  '[data-automation-id="password"]',
  'input[type="password"]:not([data-automation-id="verifyPassword"])',
  'input[type="password"]'
];

const VERIFY_PASSWORD_SELECTORS = [
  '[data-automation-id="verifyPassword"]',
  'input[name*="verify" i][type="password"]',
  'input[name*="confirm" i][type="password"]'
];

const CREATE_ACCOUNT_LINKS = [
  '[data-automation-id="createAccountLink"]',
  'button:has-text("Create Account")',
  'a:has-text("Create Account")',
  'button:has-text("Sign Up")'
];

const SIGN_IN_SUBMIT = [
  '[data-automation-id="signInSubmitButton"]',
  'button[type="submit"]:has-text("Sign In")',
  'button:has-text("Sign In")'
];

const CREATE_ACCOUNT_SUBMIT = [
  '[data-automation-id="createAccountSubmitButton"]',
  'button:has-text("Create Account")',
  'button[type="submit"]'
];

/**
 * Phrases a tenant shows when the account exists but its email is unconfirmed.
 * Matched against visible text, not markup, so a hidden template string cannot
 * park a run that is actually fine.
 */
const VERIFY_PROMPT_RE =
  /verify your email|check your email|verification (?:link|email|code) (?:has been )?sent|confirm your email/i;

/** Phrases that mean the credentials themselves were rejected. */
const LOGIN_ERROR_RE =
  /incorrect email or password|invalid (?:email|password|credentials)|account is locked|too many (?:failed )?attempts/i;

/** True when the page is showing a credentials form (so we are NOT signed in). */
export async function looksLikeAuthPage(page: Page): Promise<boolean> {
  const hasPassword = (await page.locator('input[type="password"]').count().catch(() => 0)) > 0;
  if (!hasPassword) return false;
  return (await firstMatch(page, EMAIL_SELECTORS)) !== null;
}

/**
 * Runs IN THE PAGE. The body's visible text.
 *
 * `document` is reached through globalThis because the package deliberately
 * carries no DOM lib (same convention as the apply-arm worker). Exported so
 * tests can run it against a fake document.
 */
export const visibleTextInPage = (): string =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((globalThis as any).document?.body?.innerText as string) ?? "";

/** The page's visible text. Empty string when unreadable. */
async function visibleText(page: Page): Promise<string> {
  try {
    return await page.evaluate(visibleTextInPage);
  } catch {
    // A navigation mid-read is normal right after submitting credentials.
    return "";
  }
}

/**
 * Get the session authenticated on this tenant, creating the account if needed.
 *
 * Called with a page already on the tenant's apply/sign-in surface. When the
 * cached session is still logged in there is no credentials form and this
 * returns immediately, which is the common path after the first run.
 */
export async function ensureAccount(
  page: Page,
  creds: AccountCredentials
): Promise<AccountStatus> {
  // Already signed in (cookies restored from a previous phase or run).
  if (!(await looksLikeAuthPage(page))) return "authenticated";

  // Prefer signing in: the account probably exists from an earlier run, and a
  // second create-account attempt on the same email is what produces the
  // duplicate candidate profiles Workday is infamous for.
  const signedIn = await attemptSignIn(page, creds);
  if (signedIn !== "login_failed") return signedIn;

  // Sign-in failed, so create the account.
  const createLink = await firstMatch(page, CREATE_ACCOUNT_LINKS);
  if (createLink) {
    await page.locator(createLink).first().click().catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(1500);
  }
  return attemptCreateAccount(page, creds);
}

/** Fill and submit the sign-in form. */
async function attemptSignIn(page: Page, creds: AccountCredentials): Promise<AccountStatus> {
  const emailSel = await firstMatch(page, EMAIL_SELECTORS);
  const passSel = await firstMatch(page, PASSWORD_SELECTORS);
  if (!emailSel || !passSel) return "login_failed";

  // A create-account form also has email+password; its tell is the "verify
  // password" field. Do not try to sign in with it.
  if (await firstMatch(page, VERIFY_PASSWORD_SELECTORS)) return "login_failed";

  await page.fill(emailSel, creds.email).catch(() => {});
  await page.fill(passSel, creds.password).catch(() => {});

  const submit = await firstMatch(page, SIGN_IN_SUBMIT);
  if (submit) await page.locator(submit).first().click().catch(() => {});
  else await page.locator(passSel).first().press("Enter").catch(() => {});

  await page.waitForLoadState("networkidle", { timeout: CONFIG.navTimeoutMs }).catch(() => {});
  await page.waitForTimeout(1500);

  return classify(page);
}

/** Fill and submit the create-account form. */
async function attemptCreateAccount(
  page: Page,
  creds: AccountCredentials
): Promise<AccountStatus> {
  const emailSel = await firstMatch(page, EMAIL_SELECTORS);
  const passSel = await firstMatch(page, PASSWORD_SELECTORS);
  if (!emailSel || !passSel) return "login_failed";

  await page.fill(emailSel, creds.email).catch(() => {});
  await page.fill(passSel, creds.password).catch(() => {});

  const verifySel = await firstMatch(page, VERIFY_PASSWORD_SELECTORS);
  if (verifySel) await page.fill(verifySel, creds.password).catch(() => {});

  // Tenants gate the submit button on a "I agree to the terms" checkbox.
  const consent = page
    .locator('[data-automation-id="createAccountCheckbox"], input[type="checkbox"]')
    .first();
  if ((await consent.count().catch(() => 0)) > 0) {
    await consent.check().catch(() => {});
  }

  const submit = await firstMatch(page, CREATE_ACCOUNT_SUBMIT);
  if (submit) await page.locator(submit).first().click().catch(() => {});

  await page.waitForLoadState("networkidle", { timeout: CONFIG.navTimeoutMs }).catch(() => {});
  await page.waitForTimeout(2000);

  return classify(page);
}

/**
 * Decide where the session landed after submitting credentials.
 *
 * Order matters: a tenant that wants email confirmation often keeps the
 * credentials form on screen, so checking "still an auth page" first would
 * misreport a pending verification as a hard login failure.
 */
async function classify(page: Page): Promise<AccountStatus> {
  const text = await visibleText(page);
  if (VERIFY_PROMPT_RE.test(text)) return "needs_email_verification";
  if (LOGIN_ERROR_RE.test(text)) return "login_failed";
  if (await looksLikeAuthPage(page)) return "login_failed";
  return "authenticated";
}

export interface VerificationInput {
  /** Confirmation URL from the mail, when it carried one. */
  link?: string | null;
  /** One-time code from the mail, when it carried one instead. */
  code?: string | null;
}

/**
 * Finish an email verification inside the held session.
 *
 * A link is simply visited (the cookies make it count as this candidate); a code
 * is typed into whatever one-time-code field the tenant is showing. Returns the
 * resulting status so the caller can resume the run or fail it honestly.
 */
export async function completeVerification(
  page: Page,
  input: VerificationInput
): Promise<AccountStatus> {
  if (input.link) {
    await page.goto(input.link, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(2000);
    return classify(page);
  }

  if (input.code) {
    const codeSel = await firstMatch(page, [
      '[data-automation-id="verificationCode"]',
      'input[name*="code" i]',
      'input[autocomplete="one-time-code"]'
    ]);
    if (!codeSel) return "login_failed";
    await page.fill(codeSel, input.code).catch(() => {});
    const submit = await firstMatch(page, [
      '[data-automation-id="verificationSubmit"]',
      'button[type="submit"]',
      'button:has-text("Submit")',
      'button:has-text("Verify")'
    ]);
    if (submit) await page.locator(submit).first().click().catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: CONFIG.navTimeoutMs }).catch(() => {});
    await page.waitForTimeout(1500);
    return classify(page);
  }

  // Nothing to act on: the caller should keep waiting for mail.
  return "needs_email_verification";
}
