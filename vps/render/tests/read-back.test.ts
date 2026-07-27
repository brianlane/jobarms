import { afterEach, describe, expect, it, vi } from "vitest";
import { readFilledState, readFilledStateInPage } from "../src/extract";
import { fakePage } from "./helpers/fake-page";
import type { Page } from "playwright";

/**
 * `readFilledStateInPage` is serialized and executed INSIDE the browser, so a
 * Playwright mock never runs it. It is exercised here directly against fake DOM
 * nodes, the same way the field collector is.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
interface NodeOver {
  tagName?: string;
  attrs?: Record<string, string>;
  value?: string;
  checked?: boolean;
  files?: { length: number };
  closest?: (sel: string) => unknown;
}

function node(over: NodeOver = {}): any {
  return {
    tagName: over.tagName ?? "INPUT",
    value: over.value ?? "",
    checked: over.checked ?? false,
    files: over.files,
    attrs: over.attrs ?? {},
    getAttribute(this: any, k: string) {
      return this.attrs[k] ?? null;
    },
    closest: over.closest ?? (() => null),
    querySelector: () => null
  };
}

/** Install a document whose querySelectorAll answers with the given groups. */
function withDoc(groups: Record<string, any[]> = {}, labels: Record<string, string> = {}) {
  (globalThis as any).document = {
    querySelectorAll: (sel: string) => {
      for (const [name, nodes] of Object.entries(groups)) {
        if (sel.includes(name)) return nodes;
      }
      return [];
    },
    querySelector: (sel: string) => {
      for (const [id, textContent] of Object.entries(labels)) {
        if (sel.includes(id)) return { textContent };
      }
      return null;
    }
  };
  (globalThis as any).CSS = { escape: (v: string) => v };
}

afterEach(() => {
  delete (globalThis as any).document;
  delete (globalThis as any).CSS;
});

describe("readFilledStateInPage", () => {
  it("reads a text input's own value", () => {
    withDoc();
    const el = node({ attrs: { name: "email" }, value: " a@b.com " });
    expect(readFilledStateInPage([el])).toEqual([
      { name: "email", kind: "text", checked: [], value: "a@b.com", count: 1 }
    ]);
  });

  it("prefers a dropdown's RENDERED value, since it clears its own input", () => {
    // react-select commits into a value node and empties the input, so reading
    // el.value reports empty on a field that is correctly filled.
    withDoc();
    const control = {
      querySelector: (sel: string) =>
        sel.includes("single-value") ? { textContent: " United States " } : null
    };
    const el = node({
      attrs: { name: "country" },
      value: "",
      closest: (s: string) => (s.includes("select__control") ? control : null)
    });
    expect(readFilledStateInPage([el])[0].value).toBe("United States");
  });

  it("reports the labels of the options actually ticked", () => {
    const a = node({ attrs: { name: "q[]", type: "checkbox", id: "opt-a" }, checked: false });
    const b = node({ attrs: { name: "q[]", type: "checkbox", id: "opt-b" }, checked: true });
    withDoc({ 'name="q[]"': [a, b] }, { "opt-a": "First option", "opt-b": "None of the above" });

    expect(readFilledStateInPage([a])).toEqual([
      { name: "q[]", kind: "choice", checked: ["None of the above"], value: "", count: 2 }
    ]);
  });

  it("reports an untouched group as holding nothing", () => {
    const a = node({ attrs: { name: "q[]", type: "checkbox", id: "opt-a" } });
    withDoc({ 'name="q[]"': [a] }, { "opt-a": "First option" });
    expect(readFilledStateInPage([a])[0].checked).toEqual([]);
  });

  it("counts a lone consent box as one, so it is not read as a group", () => {
    const only = node({ attrs: { name: "agree", type: "checkbox", id: "agree" }, checked: true });
    withDoc({ 'name="agree"': [only] }, { agree: "I agree" });
    expect(readFilledStateInPage([only])[0].count).toBe(1);
  });

  it("falls back to the element itself when the group query finds nothing", () => {
    const el = node({ attrs: { name: "solo", type: "radio", id: "solo" }, checked: true });
    withDoc({}, { solo: "Yes" });
    expect(readFilledStateInPage([el])[0]).toMatchObject({ checked: ["Yes"], count: 1 });
  });

  it("names an option by aria-label or value when no label points at it", () => {
    const byAria = node({
      attrs: { name: "a[]", type: "checkbox", "aria-label": "From ARIA" },
      checked: true
    });
    withDoc({ 'name="a[]"': [byAria] });
    expect(readFilledStateInPage([byAria])[0].checked).toEqual(["From ARIA"]);

    const byValue = node({
      attrs: { name: "b[]", type: "checkbox", value: "From value" },
      checked: true
    });
    withDoc({ 'name="b[]"': [byValue] });
    expect(readFilledStateInPage([byValue])[0].checked).toEqual(["From value"]);

    const nameless = node({ attrs: { name: "c[]", type: "checkbox" }, checked: true });
    withDoc({ 'name="c[]"': [nameless] });
    expect(readFilledStateInPage([nameless])[0].checked).toEqual([]);
  });

  it("reports whether a file input holds anything", () => {
    withDoc();
    const withFile = node({ attrs: { name: "resume", type: "file" }, files: { length: 1 } });
    const without = node({ attrs: { name: "cv", type: "file" } });
    expect(readFilledStateInPage([withFile])[0]).toMatchObject({ kind: "file", value: "file" });
    expect(readFilledStateInPage([without])[0]).toMatchObject({ kind: "file", value: "" });
  });

  it("skips controls that hold no answer and names that repeat", () => {
    withDoc();
    const hidden = node({ attrs: { name: "csrf", type: "hidden" } });
    const button = node({ attrs: { name: "go", type: "submit" } });
    const nameless = node({ attrs: {} });
    const first = node({ attrs: { name: "dupe" }, value: "one" });
    const second = node({ attrs: { name: "dupe" }, value: "two" });

    const out = readFilledStateInPage([hidden, button, nameless, first, second]);
    expect(out.map((e) => e.name)).toEqual(["dupe"]);
    expect(out[0].value).toBe("one");
  });

  it("reads a control with no value property at all as empty", () => {
    withDoc();
    const el = node({ attrs: { name: "odd" } });
    delete (el as { value?: unknown }).value;
    expect(readFilledStateInPage([el])[0].value).toBe("");
  });

  it("falls back to the id when a control carries no name", () => {
    withDoc();
    const el = node({ attrs: { id: "candidate-location" }, value: "Phoenix" });
    expect(readFilledStateInPage([el])[0].name).toBe("candidate-location");
  });

  it("treats a select and a textarea by their tag", () => {
    withDoc();
    const select = node({ tagName: "SELECT", attrs: { name: "years" }, value: "4+" });
    const area = node({ tagName: "TEXTAREA", attrs: { name: "why" }, value: "because" });
    expect(readFilledStateInPage([select, area]).map((e) => e.kind)).toEqual(["text", "text"]);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("readFilledState", () => {
  it("hands back whatever the page reported", async () => {
    const page = fakePage({ eval$$: () => [{ name: "email", kind: "text" }] });
    expect(await readFilledState(page as unknown as Page, "form")).toEqual([
      { name: "email", kind: "text" }
    ]);
  });

  it("reads as empty when the page cannot be queried at all", async () => {
    // A detached frame. Empty means "no evidence of a problem", never a
    // manufactured mismatch.
    const page = fakePage();
    (page as unknown as { $$eval: unknown }).$$eval = vi.fn(async () => {
      throw new Error("detached frame");
    });
    expect(await readFilledState(page as unknown as Page, "form")).toEqual([]);
  });
});
