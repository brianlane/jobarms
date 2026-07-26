import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { attachResume, fillAnswers, fillCheckboxGroup, fillCombobox, fillField } from "../src/fill";
import { fakePage, loc } from "./helpers/fake-page";

const asPage = (p: ReturnType<typeof fakePage>) => p as unknown as Page;

/** Element info the filler reads via evaluate(), with sane defaults. */
function info(over: Record<string, string> = {}) {
  return { tag: "input", type: "text", cls: "", role: "", autocomplete: "", ...over };
}

/** A locator that exists and reports `over` as its element info. */
function control(elInfo: Record<string, string>, over: Record<string, unknown> = {}) {
  return loc({
    count: vi.fn(async () => 1),
    evaluate: vi.fn(async () => info(elInfo)),
    ...over
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("fillField", () => {
  it("types a short answer character by character for keystroke realism", async () => {
    const el = control({});
    const page = fakePage({ locators: { "[name=": el } });
    await fillField(asPage(page), "form", { name: "q", label: "Q", value: "Brian" });
    expect(el.pressSequentially).toHaveBeenCalledWith("Brian", expect.anything());
    expect(el.fill).toHaveBeenCalledWith("");
  });

  it("fills a long answer instantly instead of typing it out", async () => {
    const el = control({});
    const page = fakePage({ locators: { "[name=": el } });
    const long = "x".repeat(41);
    await fillField(asPage(page), "form", { name: "q", label: "Q", value: long });
    expect(el.pressSequentially).not.toHaveBeenCalled();
    expect(el.fill).toHaveBeenLastCalledWith(long);
  });

  it("does nothing when the field is nowhere on the page", async () => {
    const page = fakePage();
    await expect(
      fillField(asPage(page), "form", { name: "missing", label: "M", value: "v" })
    ).resolves.toBeUndefined();
  });

  it("falls back to a page-wide match for a recovered custom form", async () => {
    const scoped = loc({ count: vi.fn(async () => 0) });
    const wide = control({});
    let call = 0;
    const page = fakePage();
    page.locator = vi.fn(() => (call++ === 0 ? scoped : wide));
    await fillField(asPage(page), "form", { name: "q", label: "Q", value: "v" });
    expect(wide.pressSequentially).toHaveBeenCalled();
  });

  it("selects a native select by label, falling back to value", async () => {
    const failing = vi.fn(async (arg: unknown) => {
      if (typeof arg === "object") throw new Error("no such label");
    });
    const el = control({ tag: "select" }, { selectOption: failing });
    const page = fakePage({ locators: { "[name=": el } });
    await fillField(asPage(page), "form", { name: "years", label: "Years", value: "4+" });
    expect(failing).toHaveBeenCalledWith({ label: "4+" });
    expect(failing).toHaveBeenLastCalledWith("4+");
  });

  it("swallows a select that rejects both label and value", async () => {
    const el = control(
      { tag: "select" },
      {
        selectOption: vi.fn(async () => {
          throw new Error("nope");
        })
      }
    );
    const page = fakePage({ locators: { "[name=": el } });
    await expect(
      fillField(asPage(page), "form", { name: "s", label: "S", value: "x" })
    ).resolves.toBeUndefined();
  });

  it("operates a react-select combobox rather than typing into it", async () => {
    const el = control({ cls: "select__input" });
    // Committing requires the value node to render; report it as committed.
    el.evaluate = vi
      .fn()
      .mockResolvedValueOnce(info({ cls: "select__input" }))
      .mockResolvedValue(true);
    const option = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({ locators: { "[name=": el }, getByRole: () => option });
    await fillField(asPage(page), "form", { name: "country", label: "Country", value: "Canada" });
    expect(option.click).toHaveBeenCalled();
  });

  it("recognizes a combobox by role and by aria-autocomplete", async () => {
    for (const attrs of [{ role: "combobox" }, { autocomplete: "list" }]) {
      const el = control(attrs);
      el.evaluate = vi.fn().mockResolvedValueOnce(info(attrs)).mockResolvedValue(true);
      const option = loc({ count: vi.fn(async () => 1) });
      const page = fakePage({ locators: { "[name=": el }, getByRole: () => option });
      await fillField(asPage(page), "form", { name: "c", label: "C", value: "v" });
      expect(option.click).toHaveBeenCalled();
    }
  });

  it("ticks the matching radio by label, else by value", async () => {
    const byLabel = loc({
      count: vi.fn(async () => 1),
      getAttribute: vi.fn(async () => "r1"),
      nth: vi.fn(() => byLabel)
    });
    const label = loc({ textContent: vi.fn(async () => " Yes ") });
    const el = control({ type: "radio" });
    const page = fakePage();
    page.locator = vi.fn((sel: string) => {
      if (sel.includes('type="radio"')) return byLabel;
      if (sel.startsWith("label[for=")) return label;
      return el;
    });
    await fillField(asPage(page), "form", { name: "auth", label: "Auth", value: "Yes" });
    expect(byLabel.check).toHaveBeenCalled();
  });

  it("matches a radio by its value attribute when it has no label", async () => {
    const radio = loc({ count: vi.fn(async () => 1) });
    radio.nth = vi.fn(() => radio);
    radio.getAttribute = vi.fn(async (attr: string) => (attr === "value" ? "No" : null));
    const el = control({ type: "radio" });
    const page = fakePage();
    page.locator = vi.fn((sel: string) => (sel.includes('type="radio"') ? radio : el));
    await fillField(asPage(page), "form", { name: "auth", label: "Auth", value: "No" });
    expect(radio.check).toHaveBeenCalled();
  });

  it("leaves a radio group alone when nothing matches", async () => {
    const radio = loc({ count: vi.fn(async () => 1), getAttribute: vi.fn(async () => "other") });
    radio.nth = vi.fn(() => radio);
    const el = control({ type: "radio" });
    const page = fakePage();
    page.locator = vi.fn((sel: string) => (sel.includes('type="radio"') ? radio : el));
    await fillField(asPage(page), "form", { name: "auth", label: "Auth", value: "Yes" });
    expect(radio.check).not.toHaveBeenCalled();
  });

  it("never types into a file input (attachResume owns it)", async () => {
    const el = control({ type: "file" });
    const page = fakePage({ locators: { "[name=": el } });
    await fillField(asPage(page), "form", { name: "resume", label: "Resume", value: "x" });
    expect(el.pressSequentially).not.toHaveBeenCalled();
    expect(el.fill).not.toHaveBeenCalled();
  });

  it("leaves a visible but uninteractable field for review", async () => {
    const el = control(
      {},
      {
        fill: vi.fn(async () => {
          throw new Error("not interactable");
        })
      }
    );
    const page = fakePage({ locators: { "[name=": el } });
    await expect(
      fillField(asPage(page), "form", { name: "q", label: "Q", value: "v" })
    ).resolves.toBeUndefined();
  });

  it("moves the mouse to the field when it has a bounding box", async () => {
    const el = control({}, { boundingBox: vi.fn(async () => ({ x: 10, y: 20, width: 100, height: 40 })) });
    const page = fakePage({ locators: { "[name=": el } });
    await fillField(asPage(page), "form", { name: "q", label: "Q", value: "v" });
    expect(page.mouse.move).toHaveBeenCalledWith(60, 40, { steps: 3 });
  });

  it("escapes quotes in a field name so the selector stays valid", async () => {
    const el = control({});
    const page = fakePage({ locators: { "[name=": el } });
    await fillField(asPage(page), "form", { name: 'we"ird', label: "W", value: "v" });
    const selector = (page.locator as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(selector).toContain('we\\"ird');
  });
});

describe("fillCombobox", () => {
  it("ignores a blank value", async () => {
    const el = loc();
    await fillCombobox(asPage(fakePage()), el as never, "   ");
    expect(el.click).not.toHaveBeenCalled();
  });

  it("types to filter a long list when no exact option is present initially", async () => {
    const el = loc({ evaluate: vi.fn(async () => true) });
    let calls = 0;
    const option = loc({ count: vi.fn(async () => (++calls > 1 ? 1 : 0)) });
    const page = fakePage({ getByRole: () => option });
    await fillCombobox(asPage(page), el as never, "United States");
    expect(el.pressSequentially).toHaveBeenCalled();
    expect(option.click).toHaveBeenCalled();
  });

  it("falls back to a looser hasText match", async () => {
    const el = loc({ evaluate: vi.fn(async () => true) });
    const filtered = loc({ count: vi.fn(async () => 1) });
    const exact = loc({ count: vi.fn(async () => 0), filter: vi.fn(() => filtered) });
    const page = fakePage({ getByRole: () => exact });
    await fillCombobox(asPage(page), el as never, "United States");
    expect(filtered.click).toHaveBeenCalled();
  });

  it("presses Enter when no option can be found at all", async () => {
    const el = loc({ evaluate: vi.fn(async () => true) });
    const none = loc({ count: vi.fn(async () => 0) });
    none.filter = vi.fn(() => none);
    const page = fakePage({ getByRole: () => none });
    await fillCombobox(asPage(page), el as never, "Nowhere");
    expect(page.keyboard.press).toHaveBeenCalledWith("Enter");
  });

  it("retries once when the first attempt does not commit", async () => {
    const el = loc({ evaluate: vi.fn(async () => false) });
    const option = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({ getByRole: () => option });
    await fillCombobox(asPage(page), el as never, "Canada");
    expect(el.click).toHaveBeenCalledTimes(2);
    expect(page.keyboard.press).toHaveBeenCalledWith("Escape");
  });

  it("treats an evaluate failure as not committed", async () => {
    const el = loc({
      evaluate: vi.fn(async () => {
        throw new Error("detached");
      })
    });
    const option = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({ getByRole: () => option });
    await fillCombobox(asPage(page), el as never, "Canada");
    expect(el.click).toHaveBeenCalledTimes(2);
  });

  it("tolerates a count() failure while probing options", async () => {
    const el = loc({ evaluate: vi.fn(async () => true) });
    const option = loc({
      count: vi.fn(async () => {
        throw new Error("gone");
      })
    });
    option.filter = vi.fn(() => option);
    const page = fakePage({ getByRole: () => option });
    await expect(fillCombobox(asPage(page), el as never, "X")).resolves.toBeUndefined();
  });
});

describe("resolving which element to fill", () => {
  /** A checkbox input, and the fieldset wrapper that shares the field's name. */
  const groupPage = () => {
    const boxes = loc({
      count: vi.fn(async () => 2),
      evaluate: vi.fn(async () => ({ tag: "input", type: "checkbox", cls: "", role: "", autocomplete: "" }))
    });
    const wanted = loc({ evaluate: vi.fn(async () => "None of the above") });
    const other = loc({ evaluate: vi.fn(async () => "Ordinarily a resident of Cuba") });
    boxes.nth = vi.fn((i: number) => (i === 0 ? other : wanted));

    // Greenhouse gives the wrapper the SAME id as the field name.
    const fieldset = loc({
      count: vi.fn(async () => 1),
      evaluate: vi.fn(async () => ({ tag: "fieldset", type: "", cls: "checkbox", role: "", autocomplete: "" }))
    });
    const page = fakePage({
      locators: { 'input[name="q[]"]': boxes, 'type="checkbox"': boxes, "#q": fieldset }
    });
    return { page, boxes, wanted, other, fieldset };
  };

  it("drives the inputs, never the wrapper that shares the field name", async () => {
    // The regression: an unrestricted #<name> match resolved the FIELDSET, whose
    // missing `type` sent a checkbox group down the text path, and the resulting
    // click at the container's centre ticked whichever option sat there. On a US
    // sanctions question that answered the opposite of what was approved.
    const { page, wanted, other, fieldset } = groupPage();

    await fillField(asPage(page), "form", { name: "q[]", label: "Q", value: "None of the above" });

    expect(wanted.check).toHaveBeenCalled();
    expect(other.uncheck).toHaveBeenCalled();
    expect(fieldset.click).not.toHaveBeenCalled();
    expect(fieldset.fill).not.toHaveBeenCalled();
    expect(fieldset.pressSequentially).not.toHaveBeenCalled();
  });

  it("only ever selects real controls, so a wrapper cannot be picked at all", async () => {
    const { page } = groupPage();
    await fillField(asPage(page), "form", { name: "q[]", label: "Q", value: "None of the above" });

    // Every selector we asked for is tag-qualified: input, select, or textarea.
    for (const [selector] of (page.locator as unknown as { mock: { calls: string[][] } }).mock.calls) {
      for (const fragment of selector.split(", ")) {
        expect(fragment).toMatch(/(^|\s)(input|select|textarea)[[#]/);
      }
    }
  });

  it("falls back to matching by id when nothing carries the name", async () => {
    const byId = loc({
      count: vi.fn(async () => 1),
      evaluate: vi.fn(async () => ({ tag: "input", type: "text", cls: "", role: "", autocomplete: "" }))
    });
    const page = fakePage({ locators: { "input#weird": byId } });

    await fillField(asPage(page), "form", { name: "weird", label: "W", value: "v" });
    expect(byId.pressSequentially).toHaveBeenCalled();
  });
});

describe("fillCheckboxGroup", () => {
  it("checks a lone consent box for a truthy answer", async () => {
    const box = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({ locators: { 'type="checkbox"': box } });
    await fillCheckboxGroup(asPage(page), "agree", "true");
    expect(box.check).toHaveBeenCalled();
  });

  it("leaves a lone consent box alone for a falsy answer", async () => {
    const box = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({ locators: { 'type="checkbox"': box } });
    await fillCheckboxGroup(asPage(page), "agree", "no");
    expect(box.check).not.toHaveBeenCalled();
  });

  it("does nothing when the group does not exist", async () => {
    const page = fakePage();
    await expect(fillCheckboxGroup(asPage(page), "none", "x")).resolves.toBeUndefined();
  });

  it("does nothing when the answer names no options", async () => {
    const boxes = loc({ count: vi.fn(async () => 2) });
    const page = fakePage({ locators: { 'type="checkbox"': boxes } });
    await fillCheckboxGroup(asPage(page), "src", " ; ");
    expect(boxes.check).not.toHaveBeenCalled();
  });

  it("drives the group to exactly the wanted set, clearing the rest", async () => {
    const wanted = loc({ evaluate: vi.fn(async () => "LinkedIn") });
    const other = loc({ evaluate: vi.fn(async () => "Referral") });
    const boxes = loc({ count: vi.fn(async () => 2) });
    boxes.nth = vi.fn((i: number) => (i === 0 ? wanted : other));
    const page = fakePage({ locators: { 'type="checkbox"': boxes } });

    await fillCheckboxGroup(asPage(page), "src", "LinkedIn");

    expect(wanted.check).toHaveBeenCalled();
    expect(other.uncheck).toHaveBeenCalled();
  });

  it("falls back to click when check() is refused", async () => {
    const box = loc({
      evaluate: vi.fn(async () => "LinkedIn"),
      check: vi.fn(async () => {
        throw new Error("intercepted");
      })
    });
    const boxes = loc({ count: vi.fn(async () => 2) });
    boxes.nth = vi.fn(() => box);
    const page = fakePage({ locators: { 'type="checkbox"': boxes } });
    await fillCheckboxGroup(asPage(page), "src", "LinkedIn");
    expect(box.click).toHaveBeenCalled();
  });

  it("clears a box whose label cannot be read", async () => {
    const box = loc({
      evaluate: vi.fn(async () => {
        throw new Error("detached");
      })
    });
    const boxes = loc({ count: vi.fn(async () => 2) });
    boxes.nth = vi.fn(() => box);
    const page = fakePage({ locators: { 'type="checkbox"': boxes } });
    await fillCheckboxGroup(asPage(page), "src", "LinkedIn");
    expect(box.uncheck).toHaveBeenCalled();
  });
});

describe("fillAnswers", () => {
  it("fills answered fields and skips blanks and skipped ones", async () => {
    const el = control({});
    const page = fakePage({ locators: { "[name=": el } });
    await fillAnswers(asPage(page), "form", [
      { name: "a", label: "A", value: "one" },
      { name: "b", label: "B", value: "", skipped: false },
      { name: "c", label: "C", value: "three", skipped: true }
    ]);
    expect(el.pressSequentially).toHaveBeenCalledTimes(1);
    expect(el.pressSequentially).toHaveBeenCalledWith("one", expect.anything());
  });
});

describe("attachResume", () => {
  const PDF = Buffer.from("%PDF-1.7 fake").toString("base64");

  it("uploads the supplied bytes and waits for ATS parsing", async () => {
    const input = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({ locators: { 'input[type="file"]': input } });

    await attachResume(asPage(page), {
      contentBase64: PDF,
      fileName: "cv.pdf",
      mimeType: "application/pdf"
    });

    const arg = (input.setInputFiles as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({ name: "cv.pdf", mimeType: "application/pdf" });
    expect(arg.buffer.toString()).toBe("%PDF-1.7 fake");
    expect(page.waitForTimeout).toHaveBeenCalledWith(3000);
  });

  it("makes no outbound request of its own", async () => {
    // The whole point of taking bytes: this service can never be used to fetch
    // a URL an attacker chose.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const input = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({ locators: { 'input[type="file"]': input } });

    await attachResume(asPage(page), { contentBase64: PDF, fileName: "", mimeType: "" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("defaults the filename and mime type", async () => {
    const input = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({ locators: { 'input[type="file"]': input } });
    await attachResume(asPage(page), { contentBase64: PDF, fileName: "", mimeType: "" });
    expect(input.setInputFiles).toHaveBeenCalledWith(
      expect.objectContaining({ name: "resume.pdf", mimeType: "application/pdf" })
    );
  });

  it("no-ops when no content was supplied", async () => {
    const input = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({ locators: { 'input[type="file"]': input } });
    await attachResume(asPage(page), { contentBase64: null, fileName: "", mimeType: "" });
    await attachResume(asPage(page), { fileName: "", mimeType: "" });
    expect(input.setInputFiles).not.toHaveBeenCalled();
  });

  it("rejects a payload that decodes to nothing or is absurdly large", async () => {
    const input = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({ locators: { 'input[type="file"]': input } });

    // Base64 decoding is lenient, so junk decodes to zero bytes rather than
    // throwing; treat that as "no resume" instead of uploading an empty file.
    await attachResume(asPage(page), { contentBase64: "!!!!", fileName: "", mimeType: "" });
    await attachResume(asPage(page), {
      contentBase64: "A".repeat(21 * 1024 * 1024),
      fileName: "",
      mimeType: ""
    });

    expect(input.setInputFiles).not.toHaveBeenCalled();
  });

  it("reports failure when the form has no file input", async () => {
    await expect(
      attachResume(asPage(fakePage()), { contentBase64: PDF, fileName: "", mimeType: "" })
    ).resolves.toBe("failed");
  });

  it("reports failure when the widget threw and the input holds nothing", async () => {
    const input = loc({
      count: vi.fn(async () => 1),
      setInputFiles: vi.fn(async () => {
        throw new Error("custom widget");
      }),
      evaluate: vi.fn(async () => false)
    });
    const page = fakePage({ locators: { 'input[type="file"]': input } });
    await expect(
      attachResume(asPage(page), { contentBase64: PDF, fileName: "", mimeType: "" })
    ).resolves.toBe("failed");
  });

  it("reports failure when the call SUCCEEDED but no file landed", async () => {
    // Greenhouse's widget swallows the assignment and re-renders without it, so
    // "setInputFiles did not throw" is not evidence of anything.
    const input = loc({ count: vi.fn(async () => 1), evaluate: vi.fn(async () => false) });
    const page = fakePage({ locators: { 'input[type="file"]': input } });

    await expect(
      attachResume(asPage(page), { contentBase64: PDF, fileName: "", mimeType: "" })
    ).resolves.toBe("failed");
    expect(input.setInputFiles).toHaveBeenCalled();
  });

  it("reports failure when the input cannot even be inspected", async () => {
    // A detached input throws on evaluate. Unknown is treated as absent, since
    // the cost of guessing "attached" is a required field silently empty.
    const input = loc({
      count: vi.fn(async () => 1),
      evaluate: vi.fn(async () => {
        throw new Error("detached frame");
      })
    });
    const page = fakePage({ locators: { 'input[type="file"]': input } });
    await expect(
      attachResume(asPage(page), { contentBase64: PDF, fileName: "", mimeType: "" })
    ).resolves.toBe("failed");
  });

  it("reports attached only when the input really holds a file", async () => {
    const input = loc({ count: vi.fn(async () => 1), evaluate: vi.fn(async () => true) });
    const page = fakePage({ locators: { 'input[type="file"]': input } });
    await expect(
      attachResume(asPage(page), { contentBase64: PDF, fileName: "", mimeType: "" })
    ).resolves.toBe("attached");
  });

  it("distinguishes a resume nobody asked for from one that failed", async () => {
    const page = fakePage();
    await expect(
      attachResume(asPage(page), { contentBase64: null, fileName: "", mimeType: "" })
    ).resolves.toBe("not_requested");
  });
});
