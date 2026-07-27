/**
 * Filling: put approved answers onto the live form, and attach the resume.
 *
 * MIGRATED from workers/apply-arm/src/browser.ts (fillField, fillCombobox,
 * comboboxHasValue, fillCheckboxGroup, attachResume, moveMouseTo). Behavior is
 * deliberately unchanged: these paths encode hard-won fixes (react-select values
 * only commit on an option click; checkbox groups must be driven to exactly the
 * wanted set; the resume attaches BEFORE typed answers so ATS autofill loses).
 *
 * Difference from the Workers version: `page.waitForTimeout` dwells are cheap
 * here. On Browser Rendering every command burned Workflow CPU, which is why
 * per-character typing was capped; we keep the cap anyway since it also keeps a
 * long cover letter from taking a minute to type.
 */
import type { Locator, Page } from "playwright";
import type { Answer, ResumeRef } from "./types.js";
import { checkboxLabelMatches, splitAnswerValues } from "./field-match.js";
import { scopedSelector } from "./scope.js";

/** Above this length, type instantly - per-char typing gets too slow. */
const REALISTIC_TYPING_MAX = 40;

/**
 * How to drive a control. Sites disagree about which way works, so when the
 * read-back says a field did not take, the other way is tried and whichever one
 * worked is remembered per site (see the worker's fill tactics).
 *
 * choice: drive the input, or click the visible label a person would click.
 * text:   type it like a person, or set the value in one go.
 */
export type ChoiceTactic = "control" | "label";
export type TextTactic = "type" | "set";

export interface Tactics {
  choice: ChoiceTactic;
  text: TextTactic;
}

export const DEFAULT_TACTICS: Tactics = { choice: "control", text: "type" };

/** The other way of driving each kind, for a second attempt. */
export function alternativeTactics(current: Tactics): Tactics {
  return {
    choice: current.choice === "control" ? "label" : "control",
    text: current.text === "type" ? "set" : "type"
  };
}

/** Escape a string for use inside a CSS id selector. */
export function cssEscape(value: string): string {
  return value.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

/** Move the mouse to an element's center in a couple of steps (human-like). */
async function moveMouseTo(page: Page, el: Locator): Promise<void> {
  const box = await el.boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Runs IN THE PAGE. True once a react-select/ARIA combobox actually holds a
 * chosen value. Exported so tests can run it against a fake node.
 */
export const comboboxValueInPage = (node: any): boolean => {
  // react-select: a value is committed ONLY when the value node renders. (The
  // input keeps stale typed text after a failed select, so raw input text must
  // NOT be treated as committed here.)
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
};

/**
 * Runs IN THE PAGE. The visible label of one checkbox in a group, resolved with
 * the page's OWN CSS.escape (a caller-side escaper would inject literal
 * backslashes into the quoted [for="..."] selector and never match).
 */
export const checkboxLabelInPage = (node: any): string => {
  const doc = node.ownerDocument;
  const esc = (globalThis as any).CSS?.escape ?? ((s: string) => s);
  if (node.id) {
    const l = doc.querySelector(`label[for="${esc(node.id)}"]`);
    if (l?.textContent) return l.textContent.trim();
  }
  const wrap = node.closest("label");
  if (wrap?.textContent) return wrap.textContent.trim();
  return node.getAttribute("aria-label") ?? "";
};

/**
 * Runs IN THE PAGE. Did the form actually TAKE the file?
 *
 * `input.files.length` is not the answer, and on Greenhouse it is the opposite of
 * the answer: their widget owns a `visually-hidden` input, and on success it
 * consumes the file and re-renders showing the name, leaving no input behind. A
 * file still sitting on the node is what a REJECTED upload looks like there.
 *
 * So a hidden input means a widget owns the upload and only the rendered name
 * counts, while a plain visible input has no widget to satisfy and holding the
 * file is all there is. Exported so tests can drive it against a fake document.
 */
export const resumeAcceptedInPage = (fileName: string): boolean => {
  const doc = (globalThis as any).document;
  const input = doc.querySelector('input[type="file"]');
  if (!input) {
    // The widget replaced its own input; the rendered name is the only evidence.
    return (doc.body?.textContent ?? "").includes(fileName);
  }
  const rect = input.getBoundingClientRect();
  const style = (globalThis as any).getComputedStyle(input);
  const widgetOwned =
    rect.width < 8 ||
    rect.height < 8 ||
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0";
  if (!widgetOwned) return (input.files?.length ?? 0) > 0;

  const container =
    input.closest('[class*="upload"], [role="group"], fieldset, [class*="field"]') ?? doc.body;
  return (container.textContent ?? "").includes(fileName);
};

/** Runs IN THE PAGE. The element facts the filler branches on. */
export const elementInfoInPage = (node: any) => ({
  tag: node.tagName.toLowerCase(),
  type: (node.getAttribute("type") ?? "").toLowerCase(),
  cls: node.getAttribute("class") ?? "",
  role: node.getAttribute("role") ?? "",
  autocomplete: node.getAttribute("aria-autocomplete") ?? ""
});
/* eslint-enable @typescript-eslint/no-explicit-any */

/** True once a react-select/ARIA combobox actually holds a chosen value. */
async function comboboxHasValue(el: Locator): Promise<boolean> {
  return el.evaluate(comboboxValueInPage).catch(() => false);
}

/**
 * Operate a react-select / ARIA combobox. The options only exist in the DOM once
 * the menu is open, and (critically) the value only COMMITS when an option is
 * actually clicked/Enter-selected from the open menu: typing text alone is
 * discarded on blur. So: open, click the matching option (typing first only to
 * filter long lists), then VERIFY the selection stuck and retry once if not.
 */
export async function fillCombobox(page: Page, el: Locator, value: string): Promise<void> {
  if (!value.trim()) return;

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

/**
 * Tick the checkbox(es) in a group whose label matches the answer. A single
 * boolean consent box is checked when the answer reads truthy. The answer for a
 * multi-option group is the option label(s), "; "-joined for several.
 */
export async function fillCheckboxGroup(
  page: Page,
  escapedName: string,
  value: string,
  tactic: ChoiceTactic = "control"
): Promise<void> {
  const boxes = page.locator(`input[type="checkbox"][name="${escapedName}"]`);
  const n = await boxes.count();
  if (n === 0) return;
  if (n === 1) {
    if (/^(true|yes|checked|on|1)$/i.test(value.trim())) {
      await setBox(page, boxes.first(), true, tactic);
    }
    return;
  }
  const wanted = splitAnswerValues(value);
  if (wanted.length === 0) return;
  for (let i = 0; i < n; i++) {
    const box = boxes.nth(i);
    // Resolve the option's visible label using the PAGE's real CSS.escape (a
    // worker-side escaper would inject literal backslashes into the quoted
    // [for="..."] selector and never match).
    const label = await box.evaluate(checkboxLabelInPage).catch(() => "");
    // Drive the group to EXACTLY the wanted set: tick matches, clear the rest
    // (corrects any stray or pre-checked box so the final state is truthful).
    await setBox(page, box, Boolean(label && checkboxLabelMatches(label, wanted)), tactic);
  }
}

/**
 * Put one box into the wanted state.
 *
 * Two ways, because sites disagree about which one works. "control" drives the
 * input directly, which is what a plain form wants. "label" clicks the visible
 * `<label>` instead, which is what a person does and what some widgets are the
 * only thing they listen to: a custom control can leave its real input hidden and
 * wire all its behaviour to the label.
 */
async function setBox(
  page: Page,
  box: Locator,
  wanted: boolean,
  tactic: ChoiceTactic
): Promise<void> {
  if (tactic === "label") {
    const id = await box.getAttribute("id").catch(() => null);
    const already = await box.isChecked().catch(() => null);
    if (id && already !== null) {
      // Clicking a label TOGGLES, so only click when the state is actually wrong.
      if (already !== wanted) {
        await page
          .locator(`label[for="${attrEscape(id)}"]`)
          .first()
          .click()
          .catch(() => {});
      }
      return;
    }
    // No label to click, or a state we could not read. Fall through and drive the
    // control: doing nothing would leave a stray tick standing, and clearing the
    // boxes we do not want is half of what makes the final state truthful.
  }
  if (wanted) {
    await box.check().catch(() => box.click().catch(() => {}));
  } else {
    await box.uncheck().catch(() => {});
  }
}

/**
 * Escape a value for use inside a double-quoted CSS attribute selector.
 *
 * Backslashes go FIRST: escaping quotes first would then double-escape the
 * backslashes we just inserted. A field name containing a stray backslash is
 * odd but entirely possible on a hand-rolled career site, and getting this wrong
 * turns a selector into a syntax error (or worse, a different selector).
 */
export function attrEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * The only elements worth pointing a fill at.
 *
 * Restricting by tag is load-bearing, not tidiness. Greenhouse gives a
 * checkbox group's wrapping `<fieldset>` the SAME id as the field name, and a
 * fieldset precedes its own inputs in document order, so an unrestricted
 * `#<name>` match resolved the CONTAINER. A container has no `type`, so the
 * checkbox branch never ran and the text path clicked it instead: a click at the
 * centre of a group box, which lands on whichever option happens to sit there.
 * On a US sanctions question that silently ticked "Ordinarily a resident of
 * Cuba, Iran, North Korea, Syria..." while the answer said "None of the above".
 */
const CONTROL_TAGS = ["input", "select", "textarea"] as const;

/**
 * Resolve an answer to a real control, preferring `name` over `id` and the
 * adapter scope over the whole page.
 *
 * `name` comes first because for a checkbox or radio GROUP the name IS the
 * field, while the id may well belong to the wrapper.
 */
async function resolveControl(
  page: Page,
  scope: string,
  answer: Answer
): Promise<Locator | null> {
  const esc = attrEscape(answer.name);
  const id = cssEscape(answer.name);
  const byName = CONTROL_TAGS.map((tag) => `${tag}[name="${esc}"]`);
  const byId = CONTROL_TAGS.map((tag) => `${tag}#${id}`);

  const attempts = [
    scopedSelector(scope, byName),
    scopedSelector(scope, byId),
    // Page-wide, so a recovered custom form extracted outside the adapter scope
    // still fills.
    byName.join(", "),
    byId.join(", ")
  ];
  for (const selector of attempts) {
    const candidate = page.locator(selector).first();
    if ((await candidate.count()) > 0) return candidate;
  }
  return null;
}

/** Put one answer onto the form. Never throws. */
export async function fillField(
  page: Page,
  scope: string,
  answer: Answer,
  tactics: Tactics = DEFAULT_TACTICS
): Promise<void> {
  const esc = attrEscape(answer.name);
  const el = await resolveControl(page, scope, answer);
  if (!el) return;

  // Inspect the real element: native controls report their tag/type, but a
  // react-select dropdown is an <input> we must OPERATE, not type into.
  const info = await el.evaluate(elementInfoInPage);
  const isCombobox =
    info.tag === "input" &&
    (info.cls.split(/\s+/).includes("select__input") ||
      info.role === "combobox" ||
      info.autocomplete === "list");

  // Behavioral realism: bring the field into view and move the mouse to it
  // before interacting, so the session reads less like a bot.
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
      await fillCheckboxGroup(page, esc, answer.value, tactics.choice);
      return;
    }
    if (info.type === "radio") {
      const radios = page.locator(`input[type="radio"][name="${esc}"]`);
      const n = await radios.count();
      for (let i = 0; i < n; i++) {
        const radio = radios.nth(i);
        const id = await radio.getAttribute("id");
        const label = id
          ? await page
              .locator(`label[for="${id}"]`)
              .first()
              .textContent()
              .catch(() => null)
          : null;
        const value = await radio.getAttribute("value");
        if ((label ?? "").trim() === answer.value || value === answer.value) {
          await setBox(page, radio, true, tactics.choice);
          break;
        }
      }
      return;
    }
    if (info.type === "file") return; // handled by attachResume

    await el.click().catch(() => {});
    await el.fill("");
    // Keystroke realism helps invisible-captcha scoring, but a long cover letter
    // typed character by character is slow, so cap it.
    if (tactics.text === "type" && answer.value.length <= REALISTIC_TYPING_MAX) {
      await el.pressSequentially(answer.value, { delay: 30 + Math.floor(Math.random() * 40) });
    } else {
      await el.fill(answer.value);
    }
  } catch {
    // Field visible in the DOM but not interactable - leave it for review.
  }
}

/** Fill every answered field in order, with a human-like dwell between them. */
export async function fillAnswers(
  page: Page,
  scope: string,
  answers: Answer[],
  tactics: Tactics = DEFAULT_TACTICS
): Promise<void> {
  for (const answer of answers) {
    if (answer.skipped || answer.value === "") continue;
    await fillField(page, scope, answer, tactics);
    await page.waitForTimeout(150 + Math.floor(Math.random() * 350));
  }
}

/** Longest resume we will accept, decoded. Well past any real PDF or DOCX. */
const RESUME_MAX_BYTES = 15 * 1024 * 1024;

/** What became of the resume, so the caller can say so rather than assume. */
export type ResumeOutcome = "not_requested" | "attached" | "failed";

/**
 * Attaching races the employer's own uploader.
 *
 * Measured on Greenhouse: handing the file over the instant the document is
 * ready is silently ignored, and from roughly a quarter second later it is
 * accepted every time. Their script has to mount before it can take anything.
 * Rather than guess a sleep that is too short on a slow box and wasted on a fast
 * one, hand it over and ask the widget, then hand it over again.
 */
const RESUME_ATTEMPTS = 4;
const RESUME_SETTLE_MS = 1200;

/**
 * Attach the resume to the form's file input.
 *
 * Runs BEFORE typed answers because some ATSes autofill fields from the resume,
 * and we want the arm's answers to win. The bytes arrive in the request (see
 * ResumeRef): this service makes no outbound requests of its own, so it can never
 * be used as a fetcher.
 *
 * The result is CONFIRMED against the input rather than inferred from the absence
 * of an exception. Greenhouse's current uploader is a custom widget whose handler
 * throws on a plain `setInputFiles` and then removes the input, so the call can
 * appear to succeed while the form ends up holding no file at all. A required
 * field silently empty is exactly the thing a review gate exists to catch, and it
 * can only catch what it is told.
 */
export async function attachResume(page: Page, resume: ResumeRef): Promise<ResumeOutcome> {
  if (!resume.contentBase64) return "not_requested";
  const buffer = Buffer.from(resume.contentBase64, "base64");
  // Base64 decoding is lenient, so an empty result means the payload was junk.
  if (buffer.length === 0 || buffer.length > RESUME_MAX_BYTES) return "failed";

  const name = resume.fileName || "resume.pdf";
  const file = { name, mimeType: resume.mimeType || "application/pdf", buffer };

  for (let attempt = 0; attempt < RESUME_ATTEMPTS; attempt++) {
    const input = page.locator('input[type="file"]').first();
    // No input left and not yet accepted means there is nowhere to put it.
    if ((await input.count()) === 0) break;
    await input.setInputFiles(file).catch(() => {});
    await page.waitForTimeout(RESUME_SETTLE_MS);
    if (await resumeAccepted(page, name)) break;
  }

  if (!(await resumeAccepted(page, name))) return "failed";
  // Give ATS-side resume parsing a moment before typed answers land, so their
  // autofill cannot overwrite what the arm is about to type.
  await page.waitForTimeout(3000);
  return "attached";
}

/** Ask the page whether the upload took, never assuming from a lack of throw. */
async function resumeAccepted(page: Page, fileName: string): Promise<boolean> {
  const accepted = await page.evaluate(resumeAcceptedInPage, fileName).catch(() => false);
  // Strict: anything but a definite yes is a no, because the cost of a false
  // "attached" is a required field the user never knew was empty.
  return accepted === true;
}
