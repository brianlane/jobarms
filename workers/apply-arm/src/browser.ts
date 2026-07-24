/**
 * Browser session logic: navigate, extract the application form, fill it,
 * submit. One entry point per phase so the Workflow can retry each phase as
 * its own step with a fresh browser session (sessions cannot survive the
 * human-latency review gate anyway).
 */
import { Buffer } from "node:buffer";
import { launch, type Browser, type Page } from "@cloudflare/playwright";
import type { Answer, Env, FormField, RunParams } from "./types";
import { ADAPTERS } from "./adapters";
import { looksLikeApplicationForm } from "./form-sanity";
import { filterApplicationFields } from "./field-filter";
import { diagnosePage } from "./gemini";
import { getPlaybook, recordPlaybookFailure } from "./db";
import { detectInteractiveChallenge, solveInteractiveChallenge } from "./captcha-vision";
import { checkboxLabelMatches, splitAnswerValues } from "./field-match";

export interface RecoveryStrategy {
  action: "click" | "iframe" | "scroll";
  click_text?: string;
}

export interface FillResult {
  fields: FormField[];
  screenshot: Uint8Array;
  /** Set when the real form was only reachable through self-healing. */
  recovery: { source: "playbook" | "vision"; strategy: RecoveryStrategy; domain: string } | null;
}

/** Terminal: no application form reachable on this page. Not worth retrying. */
export class FormNotFoundError extends Error {
  constructor(reason: string) {
    super(`form_not_found: ${reason}`);
  }
}

/**
 * - filled: review-gate fill only (submit=false).
 * - submitted: the employer confirmed receipt.
 * - captcha_blocked: everything filled, but an anti-bot check could not be
 *   cleared (invisible score too low, or a visible challenge we couldn't solve).
 *   Counts as work done (consumed), not a system failure.
 * - unconfirmed: submit clicked, no confirmation and no captcha signal (likely
 *   went through; treated as work done upstream).
 */
export type SubmitOutcome = "filled" | "submitted" | "captcha_blocked" | "unconfirmed";

export interface SubmitResult {
  outcome: SubmitOutcome;
  screenshot: Uint8Array;
}

async function withBrowser<T>(env: Env, fn: (page: Page) => Promise<T>): Promise<T> {
  if (!env.BROWSER) {
    throw new Error("BROWSER binding missing - Workers Paid + wrangler.jsonc bindings required");
  }
  const browser: Browser = await launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

/** Where the real form was found: the adapter's scope, or a page-wide sweep. */
export interface ReachResult {
  recovery: FillResult["recovery"];
  /** Selector scope the fields live under - fillField/collectFields target it. */
  scope: string;
  /** Raw (unfiltered) fields collected at the winning scope. */
  rawFields: FormField[];
}

interface ReachOptions {
  /** Run the Gemini vision rounds when the adapter/playbook path misses. */
  vision: boolean;
  /** Throw FormNotFoundError when no form is reachable (extract wants this;
   *  fill/submit stays lenient and leans on fillField's page-wide fallback). */
  throwIfNotFound: boolean;
}

/**
 * Reach the real application form on the live page - the SINGLE front door
 * shared by extract, fill-for-review, and submit so every session lands on the
 * identical form (the fix for submit sessions filling a blank page). Self-heals
 * in the same order extractForm always has:
 *   0. adapter selector straight away,
 *   1. this domain's stored playbook from past successful recoveries,
 *   2. up to two vision rounds (Gemini looks at a screenshot and says what
 *      stands between the arm and the form: click Apply, enter an embed, scroll).
 * Returns the winning scope + raw fields; extract screenshots/filters, fill
 * uses the scope to target its locators.
 */
async function reachForm(
  env: Env,
  page: Page,
  params: RunParams,
  opts: ReachOptions
): Promise<ReachResult> {
  const adapter = ADAPTERS[params.ats];
  await page.goto(params.jobUrl, { waitUntil: "domcontentloaded" });
  await adapter.openApplication(page);
  await page.waitForSelector(adapter.formSelector, { timeout: 20_000 }).catch(() => {});

  const acquire = async (scope: string): Promise<FormField[]> =>
    collectFields(page, scope).catch(() => [] as FormField[]);

  let fields = await acquire(adapter.formSelector);
  let sanity = looksLikeApplicationForm(fields);
  if (sanity.ok) {
    return { recovery: null, scope: adapter.formSelector, rawFields: fields };
  }

  const domain = new URL(page.url()).hostname;

  // Round 0: known fix for this domain from previous successful recoveries.
  const playbook = await getPlaybook(env, domain, params.ats);
  if (playbook) {
    await applyStrategy(page, adapter.formSelector, playbook, params.ats);
    await adapter.openApplication(page);
    fields = await acquire(adapter.formSelector);
    sanity = looksLikeApplicationForm(fields);
    if (sanity.ok) {
      return {
        recovery: { source: "playbook", strategy: playbook, domain },
        scope: adapter.formSelector,
        rawFields: fields
      };
    }
    // Playbook may have been a page-wide-extract recovery: retry the body sweep.
    const wide = await acquire("body");
    if (looksLikeApplicationForm(wide).ok) {
      return {
        recovery: { source: "playbook", strategy: playbook, domain },
        scope: "body",
        rawFields: wide
      };
    }
    await recordPlaybookFailure(env, domain, params.ats);
  }

  // Rounds 1-2: vision. Look at the page, act on what we see.
  let lastReason = sanity.reason;
  if (opts.vision) {
    for (let round = 0; round < 2; round++) {
      const shot = new Uint8Array(await page.screenshot({ fullPage: false }));
      const diagnosis = await diagnosePage(env, shot, page.url(), lastReason).catch(() => null);
      if (!diagnosis) break;

      // Vision sees a real form but our adapter selector missed it (custom
      // career-site markup). Widen extraction to every form on the page.
      if (diagnosis.form_visible && diagnosis.action === "none") {
        const wide = await acquire("body");
        if (looksLikeApplicationForm(wide).ok) {
          const strategy: RecoveryStrategy = { action: "scroll" }; // "extract page-wide"
          return { recovery: { source: "vision", strategy, domain }, scope: "body", rawFields: wide };
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
      await applyStrategy(page, adapter.formSelector, strategy, params.ats);
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
        return { recovery: { source: "vision", strategy, domain }, scope, rawFields: fields };
      }
      lastReason = sanity.reason;
    }
  }

  if (opts.throwIfNotFound) throw new FormNotFoundError(lastReason);
  // Lenient (fill/submit): hand back the widest scope so fillField's page-wide
  // fallback still gets a shot rather than filling nothing.
  return { recovery: null, scope: "body", rawFields: await acquire("body") };
}

/**
 * Extract the application form, self-healing via the shared reachForm door.
 * Terminal failure throws FormNotFoundError so runs fail early and honestly
 * instead of parking a junk review.
 */
export async function extractForm(env: Env, params: RunParams): Promise<FillResult> {
  return withBrowser(env, async (page) => {
    const { recovery, rawFields } = await reachForm(env, page, params, {
      vision: true,
      throwIfNotFound: true
    });
    // Sanity ran on RAW fields inside reachForm (keeps the type==="file" resume
    // signal); the surfaced set is filtered to real questions only.
    const screenshot = new Uint8Array(await page.screenshot({ fullPage: true }));
    return { fields: filterApplicationFields(rawFields), screenshot, recovery };
  });
}

/** Execute one recovery strategy against the live page. */
async function applyStrategy(
  page: Page,
  formSelector: string,
  strategy: RecoveryStrategy,
  ats: "greenhouse" | "lever"
): Promise<void> {
  try {
    if (strategy.action === "click") {
      const text = strategy.click_text || "Apply";
      const target = page
        .locator(`a:has-text("${text.replace(/"/g, "")}"), button:has-text("${text.replace(/"/g, "")}")`)
        .first();
      if ((await target.count()) > 0) {
        await target.click();
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await page.waitForTimeout(2500);
      }
      return;
    }

    if (strategy.action === "iframe") {
      const providerHost = ats === "greenhouse" ? "greenhouse.io" : "lever.co";
      for (let attempt = 0; attempt < 5; attempt++) {
        const embed = page.locator(`iframe[src*="${providerHost}"]`).first();
        if ((await embed.count()) > 0) {
          const src = await embed.getAttribute("src");
          if (src) {
            await page.goto(src, { waitUntil: "domcontentloaded" });
            return;
          }
        }
        await page.mouse.wheel(0, 1200); // lazy embeds mount on scroll
        await page.waitForTimeout(1500);
      }
      return;
    }

    // scroll: the form may be further down the page
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(800);
    }
    await page.waitForSelector(formSelector, { timeout: 5000 }).catch(() => {});
  } catch {
    // strategy execution is best-effort; the sanity re-check decides success
  }
}

/** Fill the form with approved answers and (optionally) submit. */
export async function fillAndMaybeSubmit(
  env: Env,
  params: RunParams,
  answers: Answer[],
  submit: boolean
): Promise<SubmitResult> {
  return withBrowser(env, async (page) => {
    const adapter = ADAPTERS[params.ats];
    // Reach the SAME form extraction found. The playbook extract recorded makes
    // this the fast path (no vision); we still allow vision as a safety net for
    // a fresh session after the review gate. `scope` is where the form lives
    // (adapter selector or a page-wide sweep) so fillField targets the right DOM.
    const { scope } = await reachForm(env, page, params, {
      vision: true,
      throwIfNotFound: false
    });

    // Attach the resume first - some ATSes autofill fields from it and we
    // want typed answers to win.
    if (params.resume.signedUrl) {
      await attachResume(page, params);
    }

    for (const answer of answers) {
      if (answer.skipped || answer.value === "") continue;
      await fillField(page, scope, answer);
      // Small human-like dwell between fields (Layer 1 behavioral realism),
      // kept short so a 16-field form doesn't stretch the browser session.
      await page.waitForTimeout(150 + Math.floor(Math.random() * 350));
    }

    if (!submit) {
      const screenshot = new Uint8Array(await page.screenshot({ fullPage: true }));
      return { outcome: "filled", screenshot };
    }

    // Layer 2: if a visible interactive challenge is present before submit
    // (e.g. reCAPTCHA v2 checkbox on the form), try to clear it ourselves.
    const preKind = await detectInteractiveChallenge(page);
    if (preKind) {
      await solveInteractiveChallenge(env, page, preKind).catch(() => false);
    }

    // Longer human pause before the final submit so v3 behavioral scoring
    // sees deliberate interaction, then click the REAL control (never
    // programmatic submit) so the site's captcha JS mints its token.
    await page.waitForTimeout(1000 + Math.floor(Math.random() * 1000));
    await adapter.submit(page);
    await page.waitForTimeout(2500);

    if (await adapter.confirmSubmitted(page)) {
      const screenshot = new Uint8Array(await page.screenshot({ fullPage: true }));
      return { outcome: "submitted", screenshot };
    }

    // A challenge escalated on submit (invisible check failed and forced a
    // visible puzzle, or the form re-rendered with a captcha). Try once more.
    const postKind = await detectInteractiveChallenge(page);
    if (postKind) {
      const solved = await solveInteractiveChallenge(env, page, postKind).catch(() => false);
      if (solved) {
        await adapter.submit(page).catch(() => {});
        await page.waitForTimeout(2500);
        if (await adapter.confirmSubmitted(page)) {
          const screenshot = new Uint8Array(await page.screenshot({ fullPage: true }));
          return { outcome: "submitted", screenshot };
        }
      }
      const screenshot = new Uint8Array(await page.screenshot({ fullPage: true }));
      return { outcome: "captcha_blocked", screenshot };
    }

    // No confirmation, no captcha signal: submit most likely went through.
    const screenshot = new Uint8Array(await page.screenshot({ fullPage: true }));
    return { outcome: "unconfirmed", screenshot };
  });
}

// ---------------------------------------------------------------------------

async function collectFields(page: Page, formSelector: string): Promise<FormField[]> {
  // The callback below is serialized and executed IN THE PAGE (browser DOM),
  // so it's typed loosely - the worker's tsconfig has no DOM lib on purpose.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const inPage = (elements: any[]): FormField[] => {
    const doc = (globalThis as any).document;
    const cssEscape = (globalThis as any).CSS.escape as (v: string) => string;
    const fields: FormField[] = [];
    const seen = new Set<string>();

    const textFromIds = (ids: string): string =>
      ids
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(" ")
        .trim();

    const labelFor = (el: any): string => {
      const id = el.getAttribute("id");
      if (id) {
        const label = doc.querySelector(`label[for="${cssEscape(id)}"]`);
        if (label?.textContent) return label.textContent.trim();
      }
      // react-select and other ARIA widgets point at a separate label node.
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const txt = textFromIds(labelledBy);
        if (txt) return txt;
      }
      const wrapping = el.closest("label");
      if (wrapping?.textContent) return wrapping.textContent.trim();
      const aria = el.getAttribute("aria-label");
      if (aria) return aria;
      const placeholder = el.getAttribute("placeholder");
      if (placeholder) return placeholder;
      return el.getAttribute("name") ?? "";
    };

    // The visible label for one option (radio/checkbox) within a group.
    const optionLabel = (el: any): string => {
      const oid = el.getAttribute("id");
      const l = oid ? doc.querySelector(`label[for="${cssEscape(oid)}"]`) : null;
      return ((l?.textContent ?? el.getAttribute("aria-label") ?? el.getAttribute("value")) ?? "").trim();
    };

    // The prompt for a radio/checkbox GROUP (not one option's label): a
    // description attribute (Greenhouse), a fieldset legend, or aria-describedby.
    const groupLabel = (el: any): string => {
      const desc = el.getAttribute("description");
      if (desc) return desc.replace(/\s+/g, " ").trim();
      const fs = el.closest("fieldset");
      const legend = fs?.querySelector("legend");
      if (legend?.textContent) return legend.textContent.replace(/\s+/g, " ").trim();
      const describedBy = el.getAttribute("aria-describedby");
      if (describedBy) {
        const txt = textFromIds(describedBy);
        if (txt) return txt.replace(/\s+/g, " ").trim();
      }
      return "";
    };

    const isRequired = (el: any): boolean =>
      el.hasAttribute("required") || el.getAttribute("aria-required") === "true";

    // A text input that is really a dropdown (react-select, ARIA combobox).
    const isCombobox = (el: any, tag: string): boolean => {
      if (tag !== "input") return false;
      const cls = (el.getAttribute("class") ?? "").split(/\s+/);
      return (
        cls.includes("select__input") ||
        el.getAttribute("role") === "combobox" ||
        el.getAttribute("aria-autocomplete") === "list"
      );
    };

    for (const el of elements) {
      const tag = el.tagName.toLowerCase();
      let type = tag === "input" ? (el.getAttribute("type") ?? "text").toLowerCase() : tag;
      if (["hidden", "submit", "button", "image", "reset"].includes(type)) continue;

      // Custom dropdowns surface as text inputs; treat them as selects so the
      // filler operates the widget instead of typing into an inert box.
      if (isCombobox(el, tag)) type = "select";

      const name = el.getAttribute("name") ?? el.getAttribute("id") ?? "";
      if (!name) continue;

      // Radio and checkbox GROUPS: one field per name, options aggregated so
      // the model picks a real option and the filler ticks the right box.
      if (type === "radio" || type === "checkbox") {
        if (seen.has(name)) continue;
        const group: any[] = Array.from(
          doc.querySelectorAll(`input[type="${type}"][name="${cssEscape(name)}"]`)
        );
        // A lone checkbox is a boolean consent box, not a multi-option group.
        if (type === "checkbox" && group.length <= 1) {
          seen.add(name);
          fields.push({ name, label: labelFor(el), type: "checkbox", required: isRequired(el), options: [] });
          continue;
        }
        seen.add(name);
        fields.push({
          name,
          label: (groupLabel(el) || labelFor(el)).replace(/\s+/g, " ").slice(0, 300),
          type,
          required: group.some(isRequired),
          options: group.map(optionLabel).filter(Boolean)
        });
        continue;
      }

      if (seen.has(name)) continue;
      seen.add(name);

      let options: string[] = [];
      if (tag === "select") {
        options = Array.from(el.querySelectorAll("option"))
          .map((o: any) => (o.textContent ?? "").trim())
          .filter((t: string) => t && !/^select/i.test(t));
      }

      fields.push({
        name,
        label: labelFor(el).replace(/\s+/g, " ").slice(0, 300),
        type,
        required: isRequired(el),
        options
      });
    }
    return fields;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return page.$$eval(
    `${formSelector} input, ${formSelector} textarea, ${formSelector} select`,
    inPage
  );
}

async function fillField(page: Page, formSelector: string, answer: Answer): Promise<void> {
  const esc = answer.name.replace(/"/g, '\\"');
  const scoped = `${formSelector} [name="${esc}"], ${formSelector} #${CSS_escape(answer.name)}`;

  // Prefer the adapter-scoped match; fall back to a page-wide match so
  // recovered custom forms (extracted page-wide) still fill.
  let el = page.locator(scoped).first();
  if ((await el.count()) === 0) {
    el = page.locator(`[name="${esc}"], #${CSS_escape(answer.name)}`).first();
  }
  const count = await el.count();
  if (count === 0) return;

  // Inspect the real element: native controls report their tag/type, but a
  // react-select dropdown is an <input> we must OPERATE, not type into.
  const info = await el.evaluate((node: any) => ({
    tag: node.tagName.toLowerCase(),
    type: (node.getAttribute("type") ?? "").toLowerCase(),
    cls: node.getAttribute("class") ?? "",
    role: node.getAttribute("role") ?? "",
    autocomplete: node.getAttribute("aria-autocomplete") ?? ""
  }));
  const isCombobox =
    info.tag === "input" &&
    (info.cls.split(/\s+/).includes("select__input") ||
      info.role === "combobox" ||
      info.autocomplete === "list");

  // Layer 1 realism: bring the field into view and move the mouse to it
  // before interacting, so behavior reads less like a bot.
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await moveMouseTo(page, el).catch(() => {});

  try {
    if (info.tag === "select") {
      await el.selectOption({ label: answer.value }).catch(async () => {
        await el.selectOption(answer.value).catch(() => {});
      });
      return;
    }
    if (isCombobox) {
      await fillCombobox(page, el, answer.value);
      return;
    }
    if (info.type === "checkbox") {
      await fillCheckboxGroup(page, esc, answer.value);
      return;
    }
    if (info.type === "radio") {
      const radios = page.locator(`input[type="radio"][name="${esc}"]`);
      const n = await radios.count();
      for (let i = 0; i < n; i++) {
        const radio = radios.nth(i);
        const id = await radio.getAttribute("id");
        const label = id ? await page.locator(`label[for="${id}"]`).first().textContent().catch(() => null) : null;
        const value = await radio.getAttribute("value");
        if ((label ?? "").trim() === answer.value || value === answer.value) {
          await radio.check().catch(() => {});
          break;
        }
      }
      return;
    }
    if (info.type === "file") return; // handled by attachResume

    await el.click().catch(() => {});
    await el.fill("");
    // Keystroke realism helps invisible-captcha scoring, but each character
    // is a separate Browser Rendering command that burns Workflow CPU. Type
    // char-by-char only for SHORT values (names, short answers) and fill the
    // rest instantly, so a long cover letter can't blow the CPU budget.
    if (answer.value.length <= REALISTIC_TYPING_MAX) {
      await el.pressSequentially(answer.value, { delay: 30 + Math.floor(Math.random() * 40) });
    } else {
      await el.fill(answer.value);
    }
  } catch {
    // Field visible in DOM but not interactable - leave for review.
  }
}

/**
 * Operate a react-select / ARIA combobox. The options only exist in the DOM
 * once the menu is open, and (critically) the value only COMMITS when an option
 * is actually clicked/Enter-selected from the open menu - typing text alone is
 * discarded on blur. So: open, click the matching option (typing first only to
 * filter long lists), then VERIFY the selection stuck and retry once if not.
 */
async function fillCombobox(
  page: Page,
  el: ReturnType<Page["locator"]>,
  value: string
): Promise<void> {
  if (!value) return;

  for (let attempt = 0; attempt < 2; attempt++) {
    await el.click().catch(() => {}); // open the menu
    await page.waitForTimeout(350);

    // Prefer an exact option; if the list is long/lazy, type to filter first.
    let option = page.getByRole("option", { name: value, exact: true }).first();
    if ((await option.count().catch(() => 0)) === 0) {
      await el
        .pressSequentially(value.slice(0, REALISTIC_TYPING_MAX), {
          delay: 25 + Math.floor(Math.random() * 25)
        })
        .catch(() => {});
      await page.waitForTimeout(450);
      option = page.getByRole("option", { name: value, exact: true }).first();
      if ((await option.count().catch(() => 0)) === 0) {
        // Looser match (e.g. "United States" vs "United States+1").
        option = page.getByRole("option").filter({ hasText: value }).first();
      }
    }

    if ((await option.count().catch(() => 0)) > 0) {
      // Click the option to COMMIT (Enter alone is unreliable across widgets).
      await option.click().catch(() => {});
    } else {
      await page.keyboard.press("Enter").catch(() => {});
    }
    await page.waitForTimeout(250);

    if (await comboboxHasValue(el)) return;
    // Nothing committed: close the menu and try once more.
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
  }
}

/** True once a react-select/ARIA combobox actually holds a chosen value. */
async function comboboxHasValue(el: ReturnType<Page["locator"]>): Promise<boolean> {
  return el
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .evaluate((node: any) => {
      // react-select: a value is committed ONLY when the value node renders.
      // (The input keeps stale typed text after a failed select, so raw input
      // text must NOT be treated as committed here.)
      const rsControl = node.closest('[class*="select__control"]');
      if (rsControl) {
        return !!rsControl.querySelector('[class*="single-value"], [class*="multi-value"]');
      }
      const anyControl = node.closest('[class*="control"]');
      if (anyControl?.querySelector('[class*="single-value"], [class*="multi-value"]')) return true;
      // Generic ARIA combobox (not react-select): trust a non-placeholder value.
      const v = (node.value ?? "").trim();
      const ph = node.getAttribute("placeholder");
      return v.length > 0 && v !== ph;
    })
    .catch(() => false);
}

/**
 * Tick the checkbox(es) in a group whose label matches the answer. A single
 * boolean consent box is checked when the answer reads truthy. The answer for
 * a multi-option group is the option label(s), "; "-joined for several.
 */
async function fillCheckboxGroup(page: Page, esc: string, value: string): Promise<void> {
  const boxes = page.locator(`input[type="checkbox"][name="${esc}"]`);
  const n = await boxes.count();
  if (n === 0) return;
  if (n === 1) {
    if (/^(true|yes|checked|on|1)$/i.test(value.trim())) await boxes.first().check().catch(() => {});
    return;
  }
  const wanted = splitAnswerValues(value);
  if (wanted.length === 0) return;
  for (let i = 0; i < n; i++) {
    const box = boxes.nth(i);
    // Resolve the option's visible label using the PAGE's real CSS.escape (the
    // worker-side escaper would inject literal backslashes into the quoted
    // [for="..."] selector and never match).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const label = await box
      .evaluate((node: any) => {
        const doc = node.ownerDocument;
        const cssEscape = (globalThis as any).CSS?.escape ?? ((s: string) => s);
        if (node.id) {
          const l = doc.querySelector(`label[for="${cssEscape(node.id)}"]`);
          if (l?.textContent) return l.textContent.trim();
        }
        const wrap = node.closest("label");
        if (wrap?.textContent) return wrap.textContent.trim();
        return node.getAttribute("aria-label") ?? "";
      })
      .catch(() => "");
    // Drive the group to EXACTLY the wanted set: tick matches, clear the rest
    // (corrects any stray or pre-checked box so the final state is truthful).
    if (label && checkboxLabelMatches(label, wanted)) {
      await box.check().catch(() => box.click().catch(() => {}));
    } else {
      await box.uncheck().catch(() => {});
    }
  }
}

/** Above this length, type instantly - per-char typing gets too CPU-expensive. */
const REALISTIC_TYPING_MAX = 40;

/** Move the mouse to an element's center in a couple of steps (human-like). */
async function moveMouseTo(
  page: Page,
  el: ReturnType<Page["locator"]>
): Promise<void> {
  const box = await el.boundingBox();
  if (!box) return;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 3 });
}

function CSS_escape(value: string): string {
  return value.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

async function attachResume(page: Page, params: RunParams): Promise<void> {
  if (!params.resume.signedUrl) return;
  const res = await fetch(params.resume.signedUrl);
  if (!res.ok) return;
  const buffer = new Uint8Array(await res.arrayBuffer());

  const fileInput = page.locator('input[type="file"]').first();
  if ((await fileInput.count()) === 0) return;
  try {
    await fileInput.setInputFiles({
      name: params.resume.fileName || "resume.pdf",
      mimeType: params.resume.mimeType || "application/pdf",
      buffer: Buffer.from(buffer)
    });
    // Give ATS-side resume parsing a moment before typed answers land.
    await page.waitForTimeout(3000);
  } catch {
    // Upload widget not a plain input - leave for review gate.
  }
}
