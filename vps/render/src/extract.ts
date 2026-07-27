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
      // A lone checkbox is a boolean consent box, not a multi-option group.
      if (type === "checkbox" && group.length <= 1) {
        seen.add(name);
        fields.push({
          name,
          label: labelFor(el),
          type: "checkbox",
          required: isRequired(el),
          options: []
        });
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
