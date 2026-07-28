/**
 * Reaching the real application form: the SINGLE front door shared by extract,
 * fill-for-review, and submit, so every phase lands on the identical form (the
 * fix for submit sessions filling a blank page).
 *
 * MIGRATED from workers/apply-arm/src/browser.ts `reachForm` / `applyStrategy`,
 * with one structural change: the playbook lookup and the vision diagnosis are
 * INJECTED (see `ReachHooks`) instead of imported. The sidecar holds no Supabase
 * or Gemini credentials; the apply-arm Workflow still owns both, passes the
 * known playbook in with the request, and gets the winning strategy back to
 * record. That keeps the box a pure browser and keeps secrets on the edge.
 */
import type { Page } from "playwright";
import { ADAPTERS } from "./adapters.js";
import { collectFields } from "./extract.js";
import { looksLikeApplicationForm } from "./form-sanity.js";
import { safeUrl } from "./ssrf.js";
import type { Ats, FormField, Recovery, RecoveryStrategy } from "./types.js";

/**
 * No application form is reachable at the scope we tried.
 *
 * Carries a screenshot because the caller owns the vision model: it looks at this
 * shot, decides what stands between us and the form (click Apply, enter an embed,
 * scroll), and calls back with that strategy. So this is only terminal once the
 * caller has spent its vision budget.
 */
export class FormNotFoundError extends Error {
  readonly screenshot: Buffer | null;
  readonly reason: string;

  constructor(reason: string, screenshot: Buffer | null = null) {
    super(`form_not_found: ${reason}`);
    this.name = "FormNotFoundError";
    this.reason = reason;
    this.screenshot = screenshot;
  }
}

export interface ReachHooks {
  /**
   * This domain's known-good recovery from past runs, when the caller has one.
   * Applied FIRST so a healed domain never pays for vision again.
   */
  playbook?: RecoveryStrategy | null;
  /**
   * Ask the caller's vision model what stands between us and the form. Given a
   * screenshot, it returns an action to try. Absent means "no vision available",
   * in which case recovery is playbook-only.
   */
  diagnose?: (
    screenshot: Buffer,
    url: string,
    reason: string
  ) => Promise<{ action: "click" | "iframe" | "scroll" | "none"; click_text?: string; reason?: string; form_visible?: boolean } | null>;
}

export interface ReachResult {
  recovery: Recovery | null;
  /** Selector scope the fields live under; fill/extract target it. */
  scope: string;
  /** Raw (unfiltered) fields collected at the winning scope. */
  rawFields: FormField[];
  /** Set when the playbook was tried and did not work, so the caller can decay it. */
  playbookFailed: boolean;
}

export interface ReachOptions {
  /**
   * Throw FormNotFoundError when no form is reachable. Extract wants this so a
   * run fails early and honestly; fill/submit stay lenient and lean on
   * fillField's page-wide fallback rather than filling nothing.
   */
  throwIfNotFound: boolean;
}

/** Execute one recovery strategy against the live page. Best-effort. */
export async function applyStrategy(
  page: Page,
  formSelector: string,
  strategy: RecoveryStrategy,
  ats: Ats
): Promise<void> {
  try {
    if (strategy.action === "click") {
      const text = (strategy.click_text || "Apply").replace(/"/g, "");
      const target = page
        .locator(`a:has-text("${text}"), button:has-text("${text}")`)
        .first();
      if ((await target.count()) > 0) {
        await target.click();
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await page.waitForTimeout(2500);
      }
      return;
    }

    if (strategy.action === "iframe") {
      const providerHosts: Record<Ats, string | null> = {
        greenhouse: "greenhouse.io",
        lever: "lever.co",
        workday: "myworkdayjobs.com",
        ashby: "ashbyhq.com",
        // LinkedIn renders Easy Apply inline in a modal, never in an iframe, so
        // there is no embed host to anchor on.
        linkedin: null,
        // No provider to anchor on for unknown boards: any iframe with a src
        // is a candidate embed.
        generic: null
      };
      const providerHost = providerHosts[ats];
      const embedSelector = providerHost ? `iframe[src*="${providerHost}"]` : "iframe[src]";
      for (let attempt = 0; attempt < 5; attempt++) {
        const embed = page.locator(embedSelector).first();
        if ((await embed.count()) > 0) {
          const src = await embed.getAttribute("src");
          // Resolved against the page URL first (career sites commonly embed
          // with relative paths), then re-validated because the value comes
          // from the PAGE, not the caller: on an untuned board any markup
          // could offer an iframe, and a loopback or metadata target must
          // never be navigated to.
          let resolved: string | null = null;
          if (src) {
            try {
              resolved = new URL(src, page.url()).toString();
            } catch {
              resolved = null;
            }
          }
          const safe = resolved ? safeUrl(resolved) : null;
          if (safe) {
            await page.goto(safe, { waitUntil: "domcontentloaded" });
            return;
          }
        }
        await page.mouse.wheel(0, 1200); // lazy embeds mount on scroll
        await page.waitForTimeout(1500);
      }
      return;
    }

    // scroll: the form may simply be further down the page.
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(800);
    }
    await page.waitForSelector(formSelector, { timeout: 5000 }).catch(() => {});
  } catch {
    // Strategy execution is best-effort; the sanity re-check decides success.
  }
}

/**
 * Navigate to the posting and get a real application form on screen, healing in
 * this order: adapter selector, then this domain's playbook, then up to two
 * vision rounds.
 */
export async function reachForm(
  page: Page,
  jobUrl: string,
  ats: Ats,
  hooks: ReachHooks,
  opts: ReachOptions
): Promise<ReachResult> {
  const adapter = ADAPTERS[ats];
  await page.goto(jobUrl, { waitUntil: "domcontentloaded" });
  await adapter.openApplication(page);
  await page.waitForSelector(adapter.formSelector, { timeout: 20_000 }).catch(() => {});

  const acquire = (scope: string) => collectFields(page, scope);

  let fields = await acquire(adapter.formSelector);
  let sanity = looksLikeApplicationForm(fields);
  if (sanity.ok) {
    return {
      recovery: null,
      scope: adapter.formSelector,
      rawFields: fields,
      playbookFailed: false
    };
  }

  // Generic (untuned boards) only: component-built career sites render every
  // field with NO <form> element (a bunq careers page held 41 fields that
  // way), so sweep the whole page before spending any recovery rounds. The
  // narrow scope above always wins first, and the sanity check still decides
  // what counts as an application form. Tuned adapters deliberately do NOT
  // get this: their selectors already carry the right fallbacks, and a
  // premature wide pass on a landing page could mask the real, reachable
  // form behind whatever chrome happens to pass the sanity bar.
  if (ats === "generic") {
    const wide = await acquire("body");
    if (looksLikeApplicationForm(wide).ok) {
      return { recovery: null, scope: "body", rawFields: wide, playbookFailed: false };
    }
  }

  const domain = new URL(page.url()).hostname;
  let playbookFailed = false;

  // Round 0: the known fix for this domain from previous successful recoveries.
  if (hooks.playbook) {
    await applyStrategy(page, adapter.formSelector, hooks.playbook, ats);
    await adapter.openApplication(page);
    fields = await acquire(adapter.formSelector);
    if (looksLikeApplicationForm(fields).ok) {
      return {
        recovery: { source: "playbook", strategy: hooks.playbook, domain },
        scope: adapter.formSelector,
        rawFields: fields,
        playbookFailed: false
      };
    }
    // The playbook may have been a page-wide-extract recovery: retry the sweep.
    const wide = await acquire("body");
    if (looksLikeApplicationForm(wide).ok) {
      return {
        recovery: { source: "playbook", strategy: hooks.playbook, domain },
        scope: "body",
        rawFields: wide,
        playbookFailed: false
      };
    }
    playbookFailed = true;
  }

  // Rounds 1-2: vision. Look at the page and act on what we see.
  let lastReason = sanity.reason;
  for (let round = 0; hooks.diagnose && round < 2; round++) {
    const shot = await page.screenshot({ fullPage: false });
    const diagnosis = await hooks.diagnose(shot, page.url(), lastReason).catch(() => null);
    if (!diagnosis) break;

    // Vision sees a real form but our adapter selector missed it (custom
    // career-site markup). Widen extraction to every form on the page.
    if (diagnosis.form_visible && diagnosis.action === "none") {
      const wide = await acquire("body");
      if (looksLikeApplicationForm(wide).ok) {
        // "scroll" is how a page-wide extract is recorded (no action needed).
        const strategy: RecoveryStrategy = { action: "scroll" };
        return {
          recovery: { source: "vision", strategy, domain },
          scope: "body",
          rawFields: wide,
          playbookFailed
        };
      }
    }
    if (diagnosis.action === "none") {
      lastReason = diagnosis.reason || lastReason;
      break;
    }

    const strategy: RecoveryStrategy = {
      action: diagnosis.action,
      click_text: diagnosis.click_text
    };
    await applyStrategy(page, adapter.formSelector, strategy, ats);
    await adapter.openApplication(page);
    fields = await acquire(adapter.formSelector);
    let scope = adapter.formSelector;
    sanity = looksLikeApplicationForm(fields);
    if (!sanity.ok) {
      // Selector still missed it; try a page-wide sweep before giving up.
      const wide = await acquire("body");
      if (looksLikeApplicationForm(wide).ok) {
        fields = wide;
        scope = "body";
      }
    }
    if (looksLikeApplicationForm(fields).ok) {
      return {
        recovery: { source: "vision", strategy, domain },
        scope,
        rawFields: fields,
        playbookFailed
      };
    }
    lastReason = sanity.reason;
  }

  // Lenient (fill/submit): hand back the widest scope so fillField's page-wide
  // fallback still gets a shot rather than filling nothing.
  if (!opts.throwIfNotFound) {
    return {
      recovery: null,
      scope: "body",
      rawFields: await acquire("body"),
      playbookFailed
    };
  }
  // Extract: fail early and honestly instead of parking a junk review. The
  // screenshot rides along so the caller's vision model can decide what to try.
  const shot = await page.screenshot({ fullPage: false }).catch(() => null);
  throw new FormNotFoundError(lastReason, shot);
}
