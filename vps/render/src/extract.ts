/**
 * Field extraction: read a form's controls into `FormField[]`.
 *
 * MIGRATED from workers/apply-arm/src/browser.ts `collectFields`. The callback
 * is serialized and executed IN THE PAGE, so it is typed loosely on purpose:
 * this package has no DOM lib, and the page's own globals (document, CSS) are
 * what it runs against.
 */
import type { Page } from "playwright";
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
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Collect every answerable control under `scope`. Never throws. */
export async function collectFields(page: Page, scope: string): Promise<FormField[]> {
  try {
    return await page.$$eval(
      `${scope} input, ${scope} textarea, ${scope} select`,
      collectFieldsInPage
    );
  } catch {
    // A detached frame or a scope that matches nothing is a normal outcome
    // during recovery; the sanity check decides whether it mattered.
    return [];
  }
}
