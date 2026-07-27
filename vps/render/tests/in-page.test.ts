import { afterEach, describe, expect, it } from "vitest";
import {
  checkboxLabelInPage,
  comboboxValueInPage,
  elementInfoInPage,
  resumeAcceptedInPage
} from "../src/fill";
import { visibleTextInPage } from "../src/account";
import { num } from "../src/config";

/**
 * These callbacks are serialized and executed INSIDE the browser, so a Playwright
 * mock never runs them. They are exported and exercised here directly against
 * fake DOM nodes, the same way extract.ts's collector is tested.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
function node(over: Record<string, unknown> = {}): any {
  return {
    tagName: "INPUT",
    id: "",
    value: "",
    attrs: {} as Record<string, string>,
    getAttribute(this: any, k: string) {
      return this.attrs[k] ?? null;
    },
    closest: () => null,
    querySelector: () => null,
    ownerDocument: { querySelector: () => null },
    ...over
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("comboboxValueInPage", () => {
  it("reports committed when react-select rendered a single value node", () => {
    const control = { querySelector: (sel: string) => (sel.includes("single-value") ? {} : null) };
    expect(comboboxValueInPage(node({ closest: (s: string) => (s.includes("select__control") ? control : null) }))).toBe(true);
  });

  it("reports NOT committed when react-select shows no value node", () => {
    // The input keeps stale typed text after a failed select, so typed text alone
    // must never read as committed.
    const control = { querySelector: () => null };
    expect(
      comboboxValueInPage(
        node({
          value: "Canada",
          closest: (s: string) => (s.includes("select__control") ? control : null)
        })
      )
    ).toBe(false);
  });

  it("accepts a generic control wrapper that rendered a multi-value node", () => {
    const control = { querySelector: (sel: string) => (sel.includes("multi-value") ? {} : null) };
    expect(
      comboboxValueInPage(
        node({ closest: (s: string) => (s === '[class*="control"]' ? control : null) })
      )
    ).toBe(true);
  });

  it("trusts a non-placeholder value on a plain ARIA combobox", () => {
    expect(comboboxValueInPage(node({ value: " Canada " }))).toBe(true);
  });

  it("treats a value equal to the placeholder as empty", () => {
    const n = node({ value: "Select..." });
    n.attrs.placeholder = "Select...";
    expect(comboboxValueInPage(n)).toBe(false);
  });

  it("treats a blank or absent value as empty", () => {
    expect(comboboxValueInPage(node({ value: "   " }))).toBe(false);
    expect(comboboxValueInPage(node({ value: undefined }))).toBe(false);
  });

  it("ignores a generic wrapper with no value node", () => {
    const control = { querySelector: () => null };
    expect(
      comboboxValueInPage(
        node({ value: "", closest: (s: string) => (s === '[class*="control"]' ? control : null) })
      )
    ).toBe(false);
  });
});

describe("checkboxLabelInPage", () => {
  const g = globalThis as unknown as { CSS?: { escape: (s: string) => string } };
  const original = g.CSS;
  afterEach(() => {
    g.CSS = original;
  });

  it("resolves a label[for] using the page's own CSS.escape", () => {
    // Backslashes first, then the colon, so the stand-in does not double-escape
    // what it just inserted (the real CSS.escape handles both).
    g.CSS = { escape: (s: string) => s.replace(/\\/g, "\\\\").replace(/:/g, "\\:") };
    const n = node({
      id: "opt:1",
      ownerDocument: {
        querySelector: (sel: string) =>
          sel === 'label[for="opt\\:1"]' ? { textContent: "  LinkedIn " } : null
      }
    });
    expect(checkboxLabelInPage(n)).toBe("LinkedIn");
  });

  it("works when the page has no CSS.escape", () => {
    delete g.CSS;
    const n = node({
      id: "plain",
      ownerDocument: {
        querySelector: (sel: string) => (sel === 'label[for="plain"]' ? { textContent: "Ref" } : null)
      }
    });
    expect(checkboxLabelInPage(n)).toBe("Ref");
  });

  it("falls back to a wrapping label, then aria-label, then empty", () => {
    expect(checkboxLabelInPage(node({ closest: () => ({ textContent: " Wrapped " }) }))).toBe(
      "Wrapped"
    );

    const aria = node();
    aria.attrs["aria-label"] = "Aria";
    expect(checkboxLabelInPage(aria)).toBe("Aria");

    expect(checkboxLabelInPage(node())).toBe("");
  });

  it("ignores an empty label[for] and an empty wrapping label", () => {
    const n = node({
      id: "x",
      ownerDocument: { querySelector: () => ({ textContent: "" }) },
      closest: () => ({ textContent: "" })
    });
    expect(checkboxLabelInPage(n)).toBe("");
  });
});

describe("elementInfoInPage", () => {
  it("lowercases the tag and type and defaults every attribute", () => {
    expect(elementInfoInPage(node({ tagName: "TEXTAREA" }))).toEqual({
      tag: "textarea",
      type: "",
      cls: "",
      role: "",
      autocomplete: ""
    });
  });

  it("reports the attributes a react-select input carries", () => {
    const n = node();
    n.attrs = {
      type: "TEXT",
      class: "select__input",
      role: "combobox",
      "aria-autocomplete": "list"
    };
    expect(elementInfoInPage(n)).toEqual({
      tag: "input",
      type: "text",
      cls: "select__input",
      role: "combobox",
      autocomplete: "list"
    });
  });
});

describe("visibleTextInPage", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const g = globalThis as any;
  const original = g.document;
  afterEach(() => {
    g.document = original;
  });

  it("returns the body's innerText", () => {
    g.document = { body: { innerText: "Verify your email" } };
    expect(visibleTextInPage()).toBe("Verify your email");
  });

  it("returns empty when there is no body or no document", () => {
    g.document = {};
    expect(visibleTextInPage()).toBe("");
    g.document = undefined;
    expect(visibleTextInPage()).toBe("");
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

describe("num", () => {
  afterEach(() => {
    delete process.env.RENDER_TEST_NUM;
  });

  it("falls back when unset or empty", () => {
    expect(num("RENDER_TEST_NUM", 7)).toBe(7);
    process.env.RENDER_TEST_NUM = "";
    expect(num("RENDER_TEST_NUM", 7)).toBe(7);
  });

  it("parses a numeric value", () => {
    process.env.RENDER_TEST_NUM = "42";
    expect(num("RENDER_TEST_NUM", 7)).toBe(42);
  });

  it("falls back on a non-numeric value rather than yielding NaN", () => {
    process.env.RENDER_TEST_NUM = "soon";
    expect(num("RENDER_TEST_NUM", 7)).toBe(7);
  });
});

describe("resumeAcceptedInPage", () => {
  const withDoc = (doc: unknown, styles: Record<string, string> = {}) => {
    (globalThis as unknown as { document: unknown }).document = doc;
    (globalThis as unknown as { getComputedStyle: unknown }).getComputedStyle = () => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
      ...styles
    });
  };
  const rect = (w: number, h: number) => () => ({ width: w, height: h });

  it("trusts the file list only when the input is a plain visible one", () => {
    withDoc({
      querySelector: () => ({
        getBoundingClientRect: rect(200, 30),
        files: { length: 1 },
        closest: () => null
      }),
      body: { textContent: "" }
    });
    expect(resumeAcceptedInPage("cv.pdf")).toBe(true);
  });

  it("is false for a plain input holding nothing", () => {
    withDoc({
      querySelector: () => ({
        getBoundingClientRect: rect(200, 30),
        files: { length: 0 },
        closest: () => null
      }),
      body: { textContent: "" }
    });
    expect(resumeAcceptedInPage("cv.pdf")).toBe(false);
  });

  it("is false for a plain input with no file list at all", () => {
    withDoc({
      querySelector: () => ({ getBoundingClientRect: rect(200, 30), closest: () => null }),
      body: { textContent: "" }
    });
    expect(resumeAcceptedInPage("cv.pdf")).toBe(false);
  });

  it("is false when the container has no text to read", () => {
    withDoc({
      querySelector: () => ({
        getBoundingClientRect: rect(1, 1),
        files: { length: 0 },
        closest: () => ({ textContent: null })
      }),
      body: { textContent: "" }
    });
    expect(resumeAcceptedInPage("cv.pdf")).toBe(false);
  });

  it("ignores the file list when a widget owns a hidden input", () => {
    // The failure that hid: the file sits on the node and the widget refused it.
    withDoc({
      querySelector: () => ({
        getBoundingClientRect: rect(1, 1),
        files: { length: 1 },
        closest: () => ({ textContent: "Attach Dropbox Enter manually" })
      }),
      body: { textContent: "" }
    });
    expect(resumeAcceptedInPage("cv.pdf")).toBe(false);
  });

  it("accepts a hidden input once the widget renders the name", () => {
    withDoc({
      querySelector: () => ({
        getBoundingClientRect: rect(1, 1),
        files: { length: 0 },
        closest: () => ({ textContent: "Resume/CV* cv.pdf" })
      }),
      body: { textContent: "" }
    });
    expect(resumeAcceptedInPage("cv.pdf")).toBe(true);
  });

  it("falls back to the whole page when the hidden input has no container", () => {
    withDoc({
      querySelector: () => ({
        getBoundingClientRect: rect(1, 1),
        files: { length: 0 },
        closest: () => null
      }),
      body: { textContent: "cv.pdf uploaded" }
    });
    expect(resumeAcceptedInPage("cv.pdf")).toBe(true);
  });

  it("reads the rendered name after the widget removed its own input", () => {
    withDoc({ querySelector: () => null, body: { textContent: "Resume/CV* cv.pdf" } });
    expect(resumeAcceptedInPage("cv.pdf")).toBe(true);

    withDoc({ querySelector: () => null, body: { textContent: "Attach" } });
    expect(resumeAcceptedInPage("cv.pdf")).toBe(false);

    withDoc({ querySelector: () => null, body: null });
    expect(resumeAcceptedInPage("cv.pdf")).toBe(false);
  });

  it("treats a display:none input as widget-owned", () => {
    withDoc(
      {
        querySelector: () => ({
          getBoundingClientRect: rect(200, 30),
          files: { length: 1 },
          closest: () => ({ textContent: "no name here" })
        }),
        body: { textContent: "" }
      },
      { display: "none" }
    );
    expect(resumeAcceptedInPage("cv.pdf")).toBe(false);
  });

  it("treats visibility:hidden and opacity:0 as widget-owned too", () => {
    for (const style of [{ visibility: "hidden" }, { opacity: "0" }]) {
      withDoc(
        {
          querySelector: () => ({
            getBoundingClientRect: rect(200, 30),
            files: { length: 1 },
            closest: () => ({ textContent: "cv.pdf" })
          }),
          body: { textContent: "" }
        },
        style
      );
      expect(resumeAcceptedInPage("cv.pdf")).toBe(true);
    }
  });
});
