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
 *
 * `index` says WHICH file input the attach targeted (Ashby has two, and the
 * autofill pane's comes first in the DOM); reading the wrong one here would
 * judge the upload by a widget nobody fed.
 */
export const resumeAcceptedInPage = (arg: { fileName: string; index?: number }): boolean => {
  const fileName = arg.fileName;
  const index = arg.index ?? 0;
  const doc = (globalThis as any).document;

  /**
   * A widget complaining. Checked because a filename on screen is NOT proof of an
   * upload: Greenhouse renders the name straight off `input.files[0]` and only
   * then hands it to its uploader, so a failure leaves the name sitting next to
   * "Cannot read properties of undefined (reading 'uploadFile')" and a required
   * field with nothing in it. Reading the name alone called that a success.
   *
   * The pattern is declared HERE, not at module scope. This function is
   * serialized and re-created inside the browser, which leaves every module-level
   * name behind: referencing one throws a ReferenceError in the page, the caller
   * catches it, and a perfectly good upload reads as a failure.
   */
  const complaining = (el: any): boolean =>
    /cannot|could ?n[o']t|unable to|failed|error|try again/i.test(
      (el?.textContent ?? "").replace(/\s+/g, " ")
    );

  const list = doc.querySelectorAll?.('input[type="file"]');
  const input =
    (list && list.length > index ? list[index] : null) ?? doc.querySelector('input[type="file"]');
  if (!input) {
    // The widget replaced its own input, which the working ones do once they have
    // the file. The rendered name is the only evidence left, so scope the
    // complaint check to whatever is showing it rather than the whole page.
    const shown = [...doc.querySelectorAll('[class*="upload"], [class*="file"]')].find((el: any) =>
      (el.textContent ?? "").includes(fileName)
    );
    if (shown && complaining(shown)) return false;
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
  if (complaining(container)) return false;
  return (container.textContent ?? "").includes(fileName);
};

/**
 * Runs IN THE PAGE. Which file input is the RESUME field's own?
 *
 * "The first one" was the answer until Ashby, whose form carries TWO hidden
 * file inputs: an "Autofill from resume" convenience pane at the top and the
 * actual Resume field further down. Feeding the pane parses the file and
 * prefills some answers, but the required Resume field stays empty, so every
 * Ashby run honestly reported resume_not_attached. Score each input by the
 * text around it instead: a container talking about a resume wins, a container
 * talking about autofill loses, and a lone input keeps index 0 so the
 * single-input ATSes behave exactly as before.
 */
export const resumeFileInputIndexInPage = (): number => {
  const doc = (globalThis as any).document;
  const inputs = [...(doc.querySelectorAll?.('input[type="file"]') ?? [])];
  if (inputs.length <= 1) return 0;
  let best = 0;
  let bestScore = -Infinity;
  inputs.forEach((input: any, i: number) => {
    const container =
      input.closest?.('[class*="field"], [class*="upload"], [role="group"], fieldset') ?? null;
    const around = `${container?.textContent ?? ""} ${container?.className ?? ""}`.slice(0, 500);
    let score = 0;
    if (/resume|curriculum|\bcv\b/i.test(around)) score += 2;
    if (/autofill/i.test(around)) score -= 3;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
};

/**
 * Runs IN THE PAGE. Is the file input hidden behind a widget of the site's own?
 *
 * Such a widget owns the upload: writing to its input behind its back fires a
 * change event into a handler whose uploader was never built, because that only
 * happens on the path a real click takes. A plain visible input has no such
 * machinery and is best left alone.
 *
 * `index` is which file input to look at (see resumeFileInputIndexInPage);
 * falling back to the first keeps a page whose inputs shifted between the pick
 * and this check from answering about nothing.
 */
export const fileInputIsWidgetOwnedInPage = (index?: number): boolean => {
  const doc = (globalThis as any).document;
  const list = doc.querySelectorAll?.('input[type="file"]');
  const input =
    (list && list.length > (index ?? 0) ? list[index ?? 0] : null) ??
    doc.querySelector('input[type="file"]');
  if (!input) return false;
  const rect = input.getBoundingClientRect();
  const style = (globalThis as any).getComputedStyle(input);
  return (
    rect.width < 8 ||
    rect.height < 8 ||
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  );
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
 * The element delimiting ONE question, mirroring `fieldContainer` in
 * extract.ts: whatever grouping the collector announced, the filler must
 * resolve the same way or it drives a different set of controls than the
 * answer was generated for.
 */
const FIELD_CONTAINER_XPATH =
  'xpath=ancestor::*[contains(@class, "fieldEntry") or contains(@class, "field-entry") or self::fieldset or @role="group" or @role="radiogroup"][1]';

/**
 * Tick the checkbox(es) in a group whose label matches the answer. A single
 * boolean consent box is checked when the answer reads truthy. The answer for a
 * multi-option group is the option label(s), "; "-joined for several.
 *
 * Groups come in two shapes. Options sharing a `name` (Greenhouse, Lever) are
 * the classic form. Ashby instead gives every option its OWN input named by the
 * option's text, so a name lookup finds one box: the rest of the question lives
 * in the surrounding field container, and a lone box whose container offers
 * option BUTTONS is a toggle widget whose buttons are the real controls.
 */
export async function fillCheckboxGroup(
  page: Page,
  escapedName: string,
  value: string,
  tactic: ChoiceTactic = "control"
): Promise<void> {
  let boxes = page.locator(`input[type="checkbox"][name="${escapedName}"]`);
  let n = await boxes.count();
  if (n === 0) return;
  if (n === 1) {
    const container = boxes.first().locator(FIELD_CONTAINER_XPATH);
    const siblings = container.locator('input[type="checkbox"]');
    const siblingCount = await siblings.count().catch(() => 0);
    if (siblingCount > 1) {
      boxes = siblings;
      n = siblingCount;
    } else {
      // Toggle widget: click the container's button matching the answer. The
      // hidden checkbox is only state storage; driving it directly leaves the
      // widget's own rendering (and possibly its React state) behind.
      const wanted = value.trim();
      if (wanted) {
        const button = container.getByRole("button", { name: wanted, exact: true }).first();
        if ((await button.count().catch(() => 0)) > 0) {
          await button.click().catch(() => {});
          return;
        }
      }
      // The truthy fallback is for PLAIN consent boxes only. A toggle whose
      // wanted option matched no button must stay empty: checking the hidden
      // box behind the widget's back renders nothing, the read-back reports
      // selection from the buttons, and the interlock would flag a "filled"
      // field the form visibly does not hold. Empty is honest and reviewable.
      const buttonish = Number(
        await container
          .evaluate((node: unknown) => {
            const container = node as { querySelectorAll: (s: string) => ArrayLike<unknown> };
            return Array.from(container.querySelectorAll("button")).filter((b) => {
              const text = ((b as { textContent?: string | null }).textContent ?? "").trim();
              return text.length > 0 && text.length <= 30;
            }).length;
          })
          .catch(() => 0)
      );
      if (buttonish >= 2) return;
      if (/^(true|yes|checked|on|1)$/i.test(wanted)) {
        await setBox(page, boxes.first(), true, tactic);
      }
      return;
    }
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
  const byName = CONTROL_TAGS.map((tag) => `${tag}[name="${esc}"]`);
  // [id="..."] rather than #id: an id selector must be a valid CSS identifier,
  // and an identifier cannot START with a digit. Ashby names every custom field
  // with a UUID, so `#329cb038-...` was a querySelectorAll SyntaxError that
  // killed the whole fill phase. The attribute form matches the same elements
  // with no identifier grammar to violate, and attrEscape already guards it.
  const byId = CONTROL_TAGS.map((tag) => `${tag}[id="${esc}"]`);

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

/** How long a widget gets to open its file chooser before we stop waiting. */
const CHOOSER_TIMEOUT_MS = 8000;

/** The in-memory file both attach paths hand over. */
interface ResumeFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

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

  // The verdict rides OUT of the loop with the attempt that earned it: asking
  // the page again afterwards would re-pick the index, and a page that shifted
  // in the meantime could fail an upload that just verified.
  let attached = false;
  for (let attempt = 0; attempt < RESUME_ATTEMPTS; attempt++) {
    // Re-picked every attempt because widgets add and remove inputs as they work.
    let index = await resumeInputIndex(page);
    let input = page.locator('input[type="file"]').nth(index);
    if ((await input.count()) === 0) {
      // The index can go stale INSIDE an attempt (a widget swapped its inputs
      // between the pick and this look), which means stale, not gone: fall back
      // to the first input, and keep index and input pointing at the SAME
      // element or the checks below would judge a control nobody fed.
      index = 0;
      input = page.locator('input[type="file"]').first();
      // No input left and not yet accepted means there is nowhere to put it.
      if ((await input.count()) === 0) break;
    }

    // A hidden input belongs to a widget, and the widget has to be the one to
    // take the file. Writing to the input directly fires a change event into a
    // handler whose uploader was never constructed, which is how a Greenhouse
    // upload died on "reading 'uploadFile'" while still showing the filename.
    const widgetOwned = await page.evaluate(fileInputIsWidgetOwnedInPage, index).catch(() => false);
    if (!widgetOwned || !(await attachThroughWidget(page, input, file))) {
      await input.setInputFiles(file).catch(() => {});
    }

    await page.waitForTimeout(RESUME_SETTLE_MS);
    if (await resumeAccepted(page, name, index)) {
      attached = true;
      break;
    }
  }

  if (!attached) return "failed";
  // Give ATS-side resume parsing a moment before typed answers land, so their
  // autofill cannot overwrite what the arm is about to type.
  await page.waitForTimeout(3000);
  return "attached";
}

/** Where the chosen file input sits: the index into the page's file inputs. */
async function resumeInputIndex(page: Page): Promise<number> {
  const index = await page.evaluate(resumeFileInputIndexInPage).catch(() => 0);
  return typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : 0;
}

/** The button that belongs to the widget wrapped around the given file input. */
const UPLOAD_BUTTON = /attach|upload|choose file|select file|browse/i;

/**
 * Hand the file to the widget the way a person would: click its own control and
 * answer the file chooser it opens.
 *
 * Deliberately narrow about which control. These uploaders sit next to buttons
 * offering Dropbox, Google Drive, and "Enter manually", and clicking one of those
 * leads somewhere with no chooser and no way back.
 *
 * The button is looked for inside the INPUT's own widget first: Ashby's page
 * carries an "Autofill from resume" pane whose own "Upload file" button comes
 * first page-wide, and clicking it feeds the pane instead of the Resume field.
 * Page-wide stays as the fallback for widgets whose button lives outside any
 * recognizable container.
 *
 * Returns false when there is nothing to click or the click opened no chooser, so
 * the caller can fall back rather than skip the resume entirely.
 */
async function attachThroughWidget(page: Page, input: Locator, file: ResumeFile): Promise<boolean> {
  // The ancestor shapes here mirror the container list the in-page pickers
  // use (class mentioning field/upload, role=group, or a fieldset TAG): the
  // pickers decide which input is the resume's by its container, so a shape
  // they recognize and this lookup does not would pick the right input and
  // then click the wrong widget's button anyway.
  const scoped = input
    .locator(
      'xpath=ancestor::*[contains(@class, "field") or contains(@class, "upload") or @role="group" or self::fieldset][1]'
    )
    .getByRole("button", { name: UPLOAD_BUTTON })
    .first();
  const control =
    (await scoped.count().catch(() => 0)) > 0
      ? scoped
      : page.getByRole("button", { name: UPLOAD_BUTTON }).first();
  if ((await control.count().catch(() => 0)) === 0) return false;

  try {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: CHOOSER_TIMEOUT_MS }),
      control.click({ timeout: CHOOSER_TIMEOUT_MS })
    ]);
    await chooser.setFiles(file);
    return true;
  } catch {
    // A control that opens no chooser tells us nothing about the file; the plain
    // input is still worth a try.
    return false;
  }
}

/** Ask the page whether the upload took, never assuming from a lack of throw. */
async function resumeAccepted(page: Page, fileName: string, index: number): Promise<boolean> {
  const accepted = await page
    .evaluate(resumeAcceptedInPage, { fileName, index })
    .catch(() => false);
  // Strict: anything but a definite yes is a no, because the cost of a false
  // "attached" is a required field the user never knew was empty.
  return accepted === true;
}
