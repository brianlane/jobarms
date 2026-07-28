import { afterEach, describe, expect, it } from "vitest";
import {
  checkboxLabelInPage,
  comboboxValueInPage,
  elementInfoInPage,
  fileInputIsWidgetOwnedInPage,
  resumeAcceptedInPage,
  resumeFileInputIndexInPage
} from "../src/fill";
import { collectFieldsInPage, readFilledStateInPage } from "../src/extract";
import { visibleTextInPage } from "../src/account";

/**
 * Every function here is handed to Playwright, which SERIALIZES it and rebuilds
 * it inside the browser. Rebuilding drops the module it came from, so any
 * reference to a module-level constant or helper throws a ReferenceError in the
 * page. The caller catches that and reports a false answer, which is how a
 * working resume upload came back as "failed": the acceptance check reached for a
 * regex declared one line above it.
 *
 * Calling these directly, as the other tests do, cannot catch that. The function
 * still has its module scope in this process, so the reference resolves and
 * everything passes. So this rebuilds each one from its own source, the way the
 * browser does, and runs it against a DOM stub.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
function asTheBrowserWouldSeeIt<T extends (...args: any[]) => any>(fn: T): T {
  // Function() compiles in global scope, so nothing from this module comes along,
  // exactly like the page.
  return new Function(`return (${fn.toString()})`)() as T;
}

const NO_DOM = {
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { textContent: "" }
};

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
});

describe("in-page callbacks survive being rebuilt in the browser", () => {
  it("resumeAcceptedInPage carries everything it needs", () => {
    (globalThis as any).document = {
      ...NO_DOM,
      body: { textContent: "cv.pdf" }
    };
    const rebuilt = asTheBrowserWouldSeeIt(resumeAcceptedInPage);
    // A module-scope reference would throw here instead of answering.
    expect(rebuilt({ fileName: "cv.pdf" })).toBe(true);

    (globalThis as any).document = {
      querySelector: () => null,
      querySelectorAll: (sel: string) =>
        sel.startsWith("input") ? [] : [{ textContent: "cv.pdf Upload failed" }],
      body: { textContent: "cv.pdf Upload failed" }
    };
    expect(asTheBrowserWouldSeeIt(resumeAcceptedInPage)({ fileName: "cv.pdf" })).toBe(false);
  });

  it("resumeFileInputIndexInPage carries everything it needs", () => {
    (globalThis as any).document = {
      querySelectorAll: () => [
        { closest: () => ({ textContent: "Autofill from resume", className: "autofill" }) },
        { closest: () => ({ textContent: "Resume Upload File", className: "" }) }
      ]
    };
    expect(asTheBrowserWouldSeeIt(resumeFileInputIndexInPage)()).toBe(1);
  });

  it("fileInputIsWidgetOwnedInPage carries everything it needs", () => {
    (globalThis as any).document = {
      querySelector: () => ({ getBoundingClientRect: () => ({ width: 0, height: 0 }) })
    };
    (globalThis as any).getComputedStyle = () => ({
      display: "block",
      visibility: "visible",
      opacity: "1"
    });
    expect(asTheBrowserWouldSeeIt(fileInputIsWidgetOwnedInPage)()).toBe(true);
  });

  it("the readers and the collector carry everything they need", () => {
    (globalThis as any).document = NO_DOM;
    (globalThis as any).CSS = { escape: (v: string) => v };

    expect(asTheBrowserWouldSeeIt(collectFieldsInPage)([])).toEqual([]);
    expect(asTheBrowserWouldSeeIt(readFilledStateInPage)([])).toEqual([]);

    delete (globalThis as { CSS?: unknown }).CSS;
  });

  it("the element helpers carry everything they need", () => {
    const node = {
      tagName: "INPUT",
      value: "",
      getAttribute: () => null,
      closest: () => null,
      querySelector: () => null,
      ownerDocument: { querySelector: () => null }
    };
    expect(asTheBrowserWouldSeeIt(elementInfoInPage)(node)).toMatchObject({ tag: "input" });
    expect(asTheBrowserWouldSeeIt(comboboxValueInPage)(node)).toBe(false);
    expect(asTheBrowserWouldSeeIt(checkboxLabelInPage)(node)).toBe("");
  });

  it("visibleTextInPage carries everything it needs", () => {
    (globalThis as any).document = { body: { innerText: "hello" } };
    expect(asTheBrowserWouldSeeIt(visibleTextInPage)()).toContain("hello");
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
