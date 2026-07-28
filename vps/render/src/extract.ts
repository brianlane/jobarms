/**
 * Field extraction: read a form's controls into `FormField[]`.
 *
 * MIGRATED from workers/apply-arm/src/browser.ts `collectFields`. The callback
 * is serialized and executed IN THE PAGE, so it is typed loosely on purpose:
 * this package has no DOM lib, and the page's own globals (document, CSS) are
 * what it runs against.
 */
import type { Page } from "playwright";
import { scopedSelector } from "./scope.js";
import type { FormField } from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Runs in the browser. Exported so tests can drive it against a fake DOM. */
export const collectFieldsInPage = (elements: any[]): FormField[] => {
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

  /** The visible label for one option (radio/checkbox) within a group. */
  const optionLabel = (el: any): string => {
    const oid = el.getAttribute("id");
    const l = oid ? doc.querySelector(`label[for="${cssEscape(oid)}"]`) : null;
    return (
      (l?.textContent ?? el.getAttribute("aria-label") ?? el.getAttribute("value")) ?? ""
    ).trim();
  };

  /**
   * The prompt for a radio/checkbox GROUP (not one option's label): a
   * description attribute (Greenhouse), a fieldset legend, or aria-describedby.
   */
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

  /**
   * The element delimiting ONE question. Deliberately narrower than
   * `[class*="field"]`: a section wrapper that happens to carry "field" in its
   * class would merge separate questions into one.
   */
  const fieldContainer = (el: any): any =>
    el.closest?.(
      '[class*="fieldEntry"], [class*="field-entry"], fieldset, [role="group"], [role="radiogroup"]'
    ) ?? null;

  /**
   * The question a field container asks, skipping the labels that belong to its
   * member inputs. On Ashby the question is a plain `<label>` above the options,
   * and each option has its own `label[for]`; reading "the first label" without
   * the skip returned an OPTION ("Under 30") as the question for a whole radio
   * group, which is exactly the junk the review screen showed.
   */
  const containerQuestion = (container: any, members: any[]): string => {
    if (!container) return "";
    const memberIds = new Set(
      members.map((m: any) => m.getAttribute("id")).filter(Boolean)
    );
    for (const label of Array.from(container.querySelectorAll("label")) as any[]) {
      const forId = label.getAttribute("for");
      if (forId && memberIds.has(forId)) continue;
      const txt = (label.textContent ?? "").replace(/\s+/g, " ").trim();
      if (txt) return txt;
    }
    const legend = container.querySelector("legend");
    return ((legend?.textContent ?? "") as string).replace(/\s+/g, " ").trim();
  };

  /** Short, plausible option buttons inside a toggle-style widget. */
  const optionButtons = (container: any): any[] =>
    container
      ? (Array.from(container.querySelectorAll("button")) as any[]).filter((b: any) => {
          const t = ((b.textContent ?? "") as string).trim();
          return t.length > 0 && t.length <= 30;
        })
      : [];

  const isRequired = (el: any): boolean =>
    el.hasAttribute("required") || el.getAttribute("aria-required") === "true";

  /** A text input that is really a dropdown (react-select, ARIA combobox). */
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

    // Radio and checkbox GROUPS: one field per name, options aggregated so the
    // model picks a real option and the filler ticks the right box.
    if (type === "radio" || type === "checkbox") {
      if (seen.has(name)) continue;
      const group: any[] = Array.from(
        doc.querySelectorAll(`input[type="${type}"][name="${cssEscape(name)}"]`)
      );
      if (type === "checkbox" && group.length <= 1) {
        const container = fieldContainer(el);
        const siblings: any[] = container
          ? Array.from(container.querySelectorAll('input[type="checkbox"]'))
          : [];

        // Ashby gives every option of a "select all that apply" its OWN input,
        // named by the option's text, so name-grouping sees a pile of lone
        // consent boxes ("Male", "I prefer not to answer", ...). The field
        // container is what actually delimits the question there: one field,
        // the container's question as the label, the members as options.
        if (siblings.length > 1) {
          for (const member of siblings) {
            seen.add(member.getAttribute("name") ?? member.getAttribute("id") ?? "");
          }
          seen.add(name);
          fields.push({
            name,
            label: (containerQuestion(container, siblings) || groupLabel(el) || labelFor(el))
              .replace(/\s+/g, " ")
              .slice(0, 300),
            type: "checkbox",
            required: siblings.some(isRequired),
            options: siblings.map(optionLabel).filter(Boolean)
          });
          continue;
        }

        // A lone checkbox whose container offers option BUTTONS is a toggle
        // widget (Ashby's Yes/No work-authorization control): the hidden
        // checkbox stores the state, the buttons are the real options. Typed
        // as radio so the model picks exactly one option verbatim.
        const buttons = optionButtons(container);
        if (buttons.length >= 2) {
          seen.add(name);
          fields.push({
            name,
            label: (containerQuestion(container, [el]) || labelFor(el))
              .replace(/\s+/g, " ")
              .slice(0, 300),
            type: "radio",
            required: isRequired(el),
            options: buttons.map((b: any) => (b.textContent as string).trim())
          });
          continue;
        }

        // A genuinely lone checkbox is a boolean consent box. Its own label
        // first; the container's question when it has none, because falling
        // back to `name` turned Ashby's unlabeled controls into UUID "questions".
        seen.add(name);
        const own = labelFor(el);
        fields.push({
          name,
          label: own !== name ? own : containerQuestion(container, [el]) || own,
          type: "checkbox",
          required: isRequired(el),
          options: []
        });
        continue;
      }
      seen.add(name);
      fields.push({
        name,
        label: (groupLabel(el) || containerQuestion(fieldContainer(el), group) || labelFor(el))
          .replace(/\s+/g, " ")
          .slice(0, 300),
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
/** What a control is HOLDING right now, as opposed to what it accepts. */
export interface FilledState {
  name: string;
  /** choice = radio/checkbox group, text = anything typed or picked. */
  kind: "choice" | "text" | "file";
  /** For a choice: the labels of the options actually ticked. */
  checked: string[];
  /** For text: the value on screen, which for a dropdown is rendered outside the input. */
  value: string;
  /** Controls sharing the name, so a lone consent box is not read as a group. */
  count: number;
}

/**
 * Runs IN THE PAGE. Read back what the form is holding, so a fill can be checked
 * against the answers it was given instead of assumed to have worked.
 *
 * Deliberately a separate callback from `collectFieldsInPage` rather than an
 * option on it: an in-page function is serialized whole, so the two cannot share
 * helpers, and conflating "what can this form take" with "what does it hold" is
 * how you end up with one function that does neither well. The small duplication
 * of label and escape helpers is the cost of running in the page at all.
 */
export const readFilledStateInPage = (elements: any[]): FilledState[] => {
  const doc = (globalThis as any).document;
  const cssEscape = (globalThis as any).CSS.escape as (v: string) => string;
  const out: FilledState[] = [];
  const seen = new Set<string>();

  const optionLabel = (el: any): string => {
    const oid = el.getAttribute("id");
    const l = oid ? doc.querySelector(`label[for="${cssEscape(oid)}"]`) : null;
    return (
      (l?.textContent ?? el.getAttribute("aria-label") ?? el.getAttribute("value")) ?? ""
    ).trim();
  };

  /**
   * What a react-select style widget is holding. It commits into a rendered
   * value node and CLEARS its own input, so reading `el.value` on one of those
   * reports empty on a field that is correctly filled.
   */
  const committed = (el: any): string => {
    const control = el.closest('[class*="select__control"]') ?? el.closest('[class*="control"]');
    const value = control?.querySelector('[class*="single-value"], [class*="multi-value"]');
    return (value?.textContent ?? "").trim();
  };

  for (const el of elements) {
    const tag = el.tagName.toLowerCase();
    const type = tag === "input" ? (el.getAttribute("type") ?? "text").toLowerCase() : tag;
    if (["hidden", "submit", "button", "image", "reset"].includes(type)) continue;

    const name = el.getAttribute("name") ?? el.getAttribute("id") ?? "";
    if (!name || seen.has(name)) continue;
    seen.add(name);

    if (type === "radio" || type === "checkbox") {
      const group: any[] = Array.from(
        doc.querySelectorAll(`input[type="${type}"][name="${cssEscape(name)}"]`)
      );

      // The same container grouping the collector applies (see
      // collectFieldsInPage): per-option inputs and button toggles must read
      // back under the SAME name and shape they were extracted as, or the
      // interlock compares an answer against a field that does not exist.
      if (type === "checkbox" && group.length <= 1) {
        const container =
          el.closest?.(
            '[class*="fieldEntry"], [class*="field-entry"], fieldset, [role="group"], [role="radiogroup"]'
          ) ?? null;
        const siblings: any[] = container
          ? Array.from(container.querySelectorAll('input[type="checkbox"]'))
          : [];

        if (siblings.length > 1) {
          for (const member of siblings) {
            seen.add(member.getAttribute("name") ?? member.getAttribute("id") ?? "");
          }
          out.push({
            name,
            kind: "choice",
            checked: siblings.filter((b: any) => b.checked).map(optionLabel).filter(Boolean),
            value: "",
            count: siblings.length
          });
          continue;
        }

        const buttons: any[] = container
          ? (Array.from(container.querySelectorAll("button")) as any[]).filter((b: any) => {
              const t = ((b.textContent ?? "") as string).trim();
              return t.length > 0 && t.length <= 30;
            })
          : [];
        if (buttons.length >= 2) {
          // The selected option is the button the widget marks active; the
          // hidden checkbox cannot tell "No" apart from "never touched".
          const active = buttons.filter(
            (b: any) =>
              /(^|[\s_-])active|(^|[\s_-])selected/i.test(b.className ?? "") ||
              b.getAttribute("aria-pressed") === "true" ||
              b.getAttribute("aria-checked") === "true"
          );
          out.push({
            name,
            kind: "choice",
            // The length filter above already guarantees every button has text.
            checked: active.map((b: any) => (b.textContent as string).trim()),
            value: "",
            count: buttons.length
          });
          continue;
        }
      }

      const boxes = group.length > 0 ? group : [el];
      out.push({
        name,
        kind: "choice",
        checked: boxes.filter((b: any) => b.checked).map(optionLabel).filter(Boolean),
        value: "",
        count: boxes.length
      });
      continue;
    }

    if (type === "file") {
      out.push({
        name,
        kind: "file",
        checked: [],
        value: (el.files?.length ?? 0) > 0 ? "file" : "",
        count: 1
      });
      continue;
    }

    out.push({
      name,
      kind: "text",
      checked: [],
      value: committed(el) || String(el.value ?? "").trim(),
      count: 1
    });
  }
  return out;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Read back what every control under `scope` currently holds. Never throws. */
export async function readFilledState(page: Page, scope: string): Promise<FilledState[]> {
  try {
    return await page.$$eval(
      scopedSelector(scope, ["input", "textarea", "select"]),
      readFilledStateInPage
    );
  } catch {
    // Nothing readable means nothing to compare. The caller treats an empty read
    // as "no evidence of a problem" rather than inventing one.
    return [];
  }
}

/** Collect every answerable control under `scope`. Never throws. */
export async function collectFields(page: Page, scope: string): Promise<FormField[]> {
  try {
    return await page.$$eval(
      scopedSelector(scope, ["input", "textarea", "select"]),
      collectFieldsInPage
    );
  } catch {
    // A detached frame or a scope that matches nothing is a normal outcome
    // during recovery; the sanity check decides whether it mattered.
    return [];
  }
}
