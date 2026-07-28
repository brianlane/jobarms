import { afterEach, describe, expect, it } from "vitest";
import {
  checkboxLabelInPage,
  comboboxValueInPage,
  elementInfoInPage,
  fileInputIsWidgetOwnedInPage,
  resumeAcceptedInPage,
  resumeFileInputIndexInPage
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
    // Default the collection query so every case does not have to declare one.
    // A real document always has it; only these stubs need reminding.
    (globalThis as unknown as { document: unknown }).document =
      doc && typeof doc === "object" ? { querySelectorAll: () => [], ...doc } : doc;
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
    expect(resumeAcceptedInPage({ fileName: "cv.pdf" })).toBe(true);
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
    expect(resumeAcceptedInPage({ fileName: "cv.pdf" })).toBe(false);
  });

  it("is false for a plain input with no file list at all", () => {
    withDoc({
      querySelector: () => ({ getBoundingClientRect: rect(200, 30), closest: () => null }),
      body: { textContent: "" }
    });
    expect(resumeAcceptedInPage({ fileName: "cv.pdf" })).toBe(false);
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
    expect(resumeAcceptedInPage({ fileName: "cv.pdf" })).toBe(false);
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
    expect(resumeAcceptedInPage({ fileName: "cv.pdf" })).toBe(false);
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
    expect(resumeAcceptedInPage({ fileName: "cv.pdf" })).toBe(true);
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
    expect(resumeAcceptedInPage({ fileName: "cv.pdf" })).toBe(true);
  });

  it("reads the rendered name after the widget removed its own input", () => {
    withDoc({ querySelector: () => null, body: { textContent: "Resume/CV* cv.pdf" } });
    expect(resumeAcceptedInPage({ fileName: "cv.pdf" })).toBe(true);

    withDoc({ querySelector: () => null, body: { textContent: "Attach" } });
    expect(resumeAcceptedInPage({ fileName: "cv.pdf" })).toBe(false);

    withDoc({ querySelector: () => null, body: null });
    expect(resumeAcceptedInPage({ fileName: "cv.pdf" })).toBe(false);
  });

  it("does NOT call a filename beside an error an upload", () => {
    // The exact state a real Greenhouse run produced: the name is rendered off
    // input.files before their uploader throws, so it sits next to the error
    // with nothing uploaded. Reading the name alone reported this as attached.
    withDoc({
      querySelector: () => ({
        getBoundingClientRect: rect(0, 0),
        files: { length: 1 },
        closest: () => ({
          textContent:
            "Resume/CV* cv.pdf Cannot read properties of undefined (reading 'uploadFile')"
        })
      }),
      body: { textContent: "" }
    });
    expect(resumeAcceptedInPage({ fileName: "cv.pdf" })).toBe(false);
  });

  it("is not put off by the widget's own help text", () => {
    // "Accepted file types: pdf, doc..." sits in the same container on a healthy
    // upload, so the complaint check must not fire on ordinary wording.
    withDoc({
      querySelector: () => ({
        getBoundingClientRect: rect(0, 0),
        files: { length: 1 },
        closest: () => ({
          textContent: "Resume/CV* cv.pdf Accepted file types: pdf, doc, docx, txt, rtf"
        })
      }),
      body: { textContent: "" }
    });
    expect(resumeAcceptedInPage({ fileName: "cv.pdf" })).toBe(true);
  });

  it("catches an error left behind after the widget removed its input", () => {
    // The stubs answer per-selector now that the function ALSO queries for file
    // inputs by index: a selector-blind stub would hand the complaint node back
    // as the input itself.
    const bySelector = (nodes: unknown[]) => (sel: string) =>
      sel.startsWith("input") ? [] : nodes;

    withDoc({
      querySelector: () => null,
      querySelectorAll: bySelector([{ textContent: "cv.pdf Upload failed, try again" }]),
      body: { textContent: "cv.pdf Upload failed, try again" }
    });
    expect(resumeAcceptedInPage({ fileName: "cv.pdf" })).toBe(false);

    // The same shape, but the complaining node is about something else entirely.
    withDoc({
      querySelector: () => null,
      querySelectorAll: bySelector([{ textContent: "cv.pdf" }]),
      body: { textContent: "cv.pdf" }
    });
    expect(resumeAcceptedInPage({ fileName: "cv.pdf" })).toBe(true);

    // A node carrying no text at all is not evidence of anything.
    withDoc({
      querySelector: () => null,
      querySelectorAll: bySelector([{}]),
      body: { textContent: "cv.pdf" }
    });
    expect(resumeAcceptedInPage({ fileName: "cv.pdf" })).toBe(true);
  });

  it("judges the upload by the input the attach targeted, not the first one", () => {
    // Ashby: the autofill pane's input comes first and never shows the name;
    // the Resume field's own widget (index 1) renders it. Reading index 0 here
    // called a successful upload a failure.
    const paneInput = {
      getBoundingClientRect: rect(1, 1),
      files: { length: 0 },
      closest: () => ({ textContent: "Autofill from resume Upload file" })
    };
    const fieldInput = {
      getBoundingClientRect: rect(1, 1),
      files: { length: 0 },
      closest: () => ({ textContent: "Resume cv.pdf Replace" })
    };
    withDoc({
      querySelector: () => paneInput,
      querySelectorAll: (sel: string) => (sel.startsWith("input") ? [paneInput, fieldInput] : []),
      body: { textContent: "" }
    });
    expect(resumeAcceptedInPage({ fileName: "cv.pdf", index: 1 })).toBe(true);
    expect(resumeAcceptedInPage({ fileName: "cv.pdf", index: 0 })).toBe(false);
    // An index the page no longer has falls back to the first input.
    expect(resumeAcceptedInPage({ fileName: "cv.pdf", index: 9 })).toBe(false);
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
    expect(resumeAcceptedInPage({ fileName: "cv.pdf" })).toBe(false);
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
      expect(resumeAcceptedInPage({ fileName: "cv.pdf" })).toBe(true);
    }
  });
});

describe("fileInputIsWidgetOwnedInPage", () => {
  const withDoc = (doc: unknown, styles: Record<string, string> = {}) => {
    (globalThis as unknown as { document: unknown }).document = doc;
    (globalThis as unknown as { getComputedStyle: unknown }).getComputedStyle = () => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
      ...styles
    });
  };
  const input = (w: number, h: number) => ({
    getBoundingClientRect: () => ({ width: w, height: h })
  });

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
  });

  it("calls a hidden input a widget's, because something else is driving it", () => {
    withDoc({ querySelector: () => input(0, 0) });
    expect(fileInputIsWidgetOwnedInPage()).toBe(true);

    withDoc({ querySelector: () => input(200, 30) }, { display: "none" });
    expect(fileInputIsWidgetOwnedInPage()).toBe(true);

    withDoc({ querySelector: () => input(200, 30) }, { visibility: "hidden" });
    expect(fileInputIsWidgetOwnedInPage()).toBe(true);

    withDoc({ querySelector: () => input(200, 30) }, { opacity: "0" });
    expect(fileInputIsWidgetOwnedInPage()).toBe(true);
  });

  it("leaves a plain visible input to be filled directly", () => {
    withDoc({ querySelector: () => input(200, 30) });
    expect(fileInputIsWidgetOwnedInPage()).toBe(false);
  });

  it("has nothing to say when there is no file input", () => {
    withDoc({ querySelector: () => null });
    expect(fileInputIsWidgetOwnedInPage()).toBe(false);
  });

  it("answers about the indexed input when the page carries several", () => {
    const hidden = input(1, 1);
    const visible = input(200, 30);
    withDoc({
      querySelector: () => hidden,
      querySelectorAll: () => [hidden, visible]
    });
    expect(fileInputIsWidgetOwnedInPage(1)).toBe(false);
    expect(fileInputIsWidgetOwnedInPage(0)).toBe(true);
    // An index the page no longer has falls back to the first input.
    expect(fileInputIsWidgetOwnedInPage(5)).toBe(true);
    // No index at all reads the first entry of the collection.
    expect(fileInputIsWidgetOwnedInPage()).toBe(true);
  });
});

describe("resumeFileInputIndexInPage", () => {
  const withDoc = (doc: unknown) => {
    (globalThis as unknown as { document: unknown }).document = doc;
  };
  const fileInput = (containerText: string, containerCls = "") => ({
    closest: () => ({ textContent: containerText, className: containerCls })
  });

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  it("prefers the Resume field's input over Ashby's autofill pane", () => {
    // The exact shape that failed live: the pane's input comes FIRST in the
    // DOM, so `.first()` fed a convenience widget while the required Resume
    // field stayed empty.
    withDoc({
      querySelectorAll: () => [
        fileInput("Autofill from resume Upload your resume here", "autofill-uploader"),
        fileInput("Resume Upload File or drag and drop here")
      ]
    });
    expect(resumeFileInputIndexInPage()).toBe(1);
  });

  it("keeps index 0 for the single-input ATSes", () => {
    withDoc({ querySelectorAll: () => [fileInput("Resume/CV Attach")] });
    expect(resumeFileInputIndexInPage()).toBe(0);
    withDoc({ querySelectorAll: () => [] });
    expect(resumeFileInputIndexInPage()).toBe(0);
    // A document stub with no collection query at all still answers.
    withDoc({});
    expect(resumeFileInputIndexInPage()).toBe(0);
  });

  it("keeps the first input when nothing distinguishes them", () => {
    withDoc({
      querySelectorAll: () => [fileInput("Attach a document"), fileInput("Attach another")]
    });
    expect(resumeFileInputIndexInPage()).toBe(0);
  });

  it("survives inputs with no recognizable container", () => {
    withDoc({
      querySelectorAll: () => [
        { closest: () => null },
        fileInput("Resume Upload File")
      ]
    });
    expect(resumeFileInputIndexInPage()).toBe(1);
  });
});
