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

export interface JobCard {
  jobId: string;
  url: string;
  title: string;
  company: string;
  location: string;
}

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

/** Chrome LinkedIn renders only for a signed-in member (the top nav / me menu). */
const SIGNED_IN_SELECTORS = [
  "#global-nav",
  ".global-nav",
  "img.global-nav__me-photo",
  '[data-control-name="identity_welcome_message"]'
];

/**
 * A POSITIVE signal that a live member session is on screen.
 *
 * Used to fast-path past sign-in only when we can actually see we are in, rather
 * than inferring it from the mere absence of a login form (a logged-out
 * interstitial has neither).
 */
async function isSignedIn(page: Page): Promise<boolean> {
  return (await firstMatch(page, SIGNED_IN_SELECTORS)) !== null;
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

  // The one unambiguous "enter your PIN" signal is a code field we can actually
  // drive; broad wording alone is not enough to call it a challenge.
  const looksLikeChallenge = CHECKPOINT_URL_RE.test(url) || CODE_PROMPT_RE.test(text);
  if (looksLikeChallenge && (await firstMatch(page, CODE_SELECTORS))) {
    return { status: "needs_login_code", checkpointUrl: url };
  }

  // A positively visible member session wins over everything below: benign page
  // copy like "security verification" must not fail a sign-in we completed.
  if (await isSignedIn(page)) return { status: "authenticated" };

  // Not signed in: a challenge with nothing to type, a rejected password, or a
  // login form still on screen all mean the sign-in did not land.
  if (looksLikeChallenge || LOGIN_ERROR_RE.test(text) || (await hasLoginForm(page))) {
    return { status: "login_failed" };
  }
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
  // Land on the feed and see where the restored session stands. Skip sign-in
  // only when a live session is POSITIVELY visible, or when we are resuming a
  // PIN the last run left open (navigating to the login page would abandon that
  // live checkpoint). Anything else, including a feed that merely lacks the
  // login form, falls through to an explicit sign-in rather than assuming we
  // are in.
  await page.goto(FEED_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(1000);
  if (await isSignedIn(page)) return { status: "authenticated" };
  if (!(await hasLoginForm(page))) {
    const landed = await classify(page);
    if (landed.status === "needs_login_code") return landed;
    // No live session, no login form, no challenge: fall through and sign in.
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
/**
 * Runs IN THE PAGE. Collect the visible job cards on a LinkedIn search results
 * page: the posting link plus whatever title/company/location the card shows.
 *
 * `document` is reached through globalThis because the package carries no DOM
 * lib (same convention as extract.ts). Exported so it can be unit-tested against
 * a fake document.
 */
export const collectJobCardsInPage = (): Array<{
  href: string;
  title: string;
  company: string;
  location: string;
}> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = (globalThis as any).document;
  const text = (el: unknown): string =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (((el as any)?.innerText ?? (el as any)?.textContent ?? "") as string).trim();
  const cards: unknown[] = Array.from(
    doc?.querySelectorAll?.(
      ".job-card-container, li.jobs-search-results__list-item, [data-job-id]"
    ) ?? []
  );
  const out: Array<{ href: string; title: string; company: string; location: string }> = [];
  for (const card of cards) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = card as any;
    const link =
      c.querySelector?.("a[href*='/jobs/view/']") ?? c.querySelector?.("a.job-card-container__link");
    const href = (link?.href ?? link?.getAttribute?.("href") ?? "") as string;
    if (!href) continue;
    out.push({
      href,
      title: text(link),
      company: text(
        c.querySelector?.(".artdeco-entity-lockup__subtitle, .job-card-container__primary-description")
      ),
      location: text(
        c.querySelector?.(".job-card-container__metadata-item, .artdeco-entity-lockup__caption")
      )
    });
  }
  return out;
};

/** The numeric posting id from a LinkedIn job href, or null. */
function jobIdFromHref(href: string): string | null {
  const m = href.match(/\/jobs\/view\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * Search LinkedIn for Easy Apply jobs matching the query, in the held session.
 *
 * Returns up to `limit` cards, deduplicated by posting id and normalized to the
 * canonical view URL the apply path drives. Best-effort: a search that renders
 * nothing yields an empty list, and the batch simply applies to nothing.
 */
export async function searchEasyApply(
  page: Page,
  args: { keywords: string; location: string; remote: boolean; limit: number }
): Promise<JobCard[]> {
  const params = new URLSearchParams({ keywords: args.keywords, f_AL: "true" });
  if (args.location) params.set("location", args.location);
  // f_WT=2 is LinkedIn's "Remote" workplace-type filter.
  if (args.remote) params.set("f_WT", "2");
  await page
    .goto(`https://www.linkedin.com/jobs/search/?${params.toString()}`, {
      waitUntil: "domcontentloaded"
    })
    .catch(() => {});
  await page.waitForTimeout(2000);

  // Results lazy-load as the list scrolls; nudge it a few times before reading.
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 2000).catch(() => {});
    await page.waitForTimeout(800);
  }

  const raw = await page.evaluate(collectJobCardsInPage).catch(() => []);
  const seen = new Set<string>();
  const cards: JobCard[] = [];
  for (const item of raw) {
    const jobId = jobIdFromHref(item.href);
    if (!jobId || seen.has(jobId)) continue;
    seen.add(jobId);
    cards.push({
      jobId,
      url: `https://www.linkedin.com/jobs/view/${jobId}/`,
      title: item.title,
      company: item.company,
      location: item.location
    });
    if (cards.length >= args.limit) break;
  }
  return cards;
}

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
