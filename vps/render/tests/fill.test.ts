import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import {
  alternativeTactics,
  attachResume,
  fileInputIsWidgetOwnedInPage,
  fillAnswers,
  fillCheckboxGroup,
  fillCombobox,
  fillField,
  resumeFileInputIndexInPage
} from "../src/fill";
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
      locators: { 'input[name="q[]"]': boxes, 'type="checkbox"': boxes, '[id="q[]"]': fieldset }
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
    const page = fakePage({ locators: { 'input[id="weird"]': byId } });

    await fillField(asPage(page), "form", { name: "weird", label: "W", value: "v" });
    expect(byId.pressSequentially).toHaveBeenCalled();
  });

  it("resolves a UUID-named field without building an invalid #id selector", async () => {
    // The regression: Ashby names custom fields with UUIDs, and a CSS identifier
    // cannot start with a digit, so `input#329cb038-...` threw a SyntaxError from
    // querySelectorAll that failed the entire fill phase on every Ashby posting.
    const uuid = "329cb038-3f1e-431e-94c6-49e9b166c581_cf0f1bc7-7ce6-4eb3-aebc-b6562141cb68";
    const byId = loc({
      count: vi.fn(async () => 1),
      evaluate: vi.fn(async () => ({ tag: "input", type: "text", cls: "", role: "", autocomplete: "" }))
    });
    const page = fakePage({ locators: { [`input[id="${uuid}"]`]: byId } });

    await fillField(asPage(page), "form", { name: uuid, label: "Custom", value: "v" });
    expect(byId.pressSequentially).toHaveBeenCalled();

    // No selector anywhere in the resolution used the #id form.
    for (const [selector] of (page.locator as unknown as { mock: { calls: string[][] } }).mock
      .calls) {
      expect(selector).not.toContain("#");
    }
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

  it("resolves per-option siblings through the field container (Ashby)", async () => {
    // Ashby names each option's input by the option text, so the name lookup
    // finds ONE box; the question's other options live in the same container
    // and must be driven to exactly the wanted set like any other group.
    const optA = loc({ evaluate: vi.fn(async () => "Bisexual") });
    const optB = loc({ evaluate: vi.fn(async () => "Queer") });
    const optC = loc({ evaluate: vi.fn(async () => "I prefer not to answer") });
    const siblings = loc({ count: vi.fn(async () => 3) });
    siblings.nth = vi.fn((i: number) => [optA, optB, optC][i]);
    const container = loc({ locator: vi.fn(() => siblings) });
    const byName = loc({ count: vi.fn(async () => 1), locator: vi.fn(() => container) });
    const page = fakePage({ locators: { 'type="checkbox"': byName } });

    await fillCheckboxGroup(asPage(page), "Bisexual", "Bisexual; Queer");

    expect(optA.check).toHaveBeenCalled();
    expect(optB.check).toHaveBeenCalled();
    expect(optC.uncheck).toHaveBeenCalled();
  });

  it("clicks the toggle button matching the answer instead of the checkbox", async () => {
    // The hidden checkbox is only state storage for Ashby's Yes/No widget;
    // clicking the button is what updates the widget's own rendering.
    const yesButton = loc({ count: vi.fn(async () => 1) });
    const container = loc({ getByRole: vi.fn(() => yesButton) });
    const box = loc({ count: vi.fn(async () => 1), locator: vi.fn(() => container) });
    const page = fakePage({ locators: { 'type="checkbox"': box } });

    await fillCheckboxGroup(asPage(page), "auth-uuid", "Yes");

    expect(yesButton.click).toHaveBeenCalled();
    expect(box.check).not.toHaveBeenCalled();
    expect(container.getByRole).toHaveBeenCalledWith("button", { name: "Yes", exact: true });
  });

  it("falls back to the checkbox when the toggle button cannot be counted", async () => {
    const badButton = loc({
      count: vi.fn(async () => {
        throw new Error("detached");
      })
    });
    const container = loc({ getByRole: vi.fn(() => badButton) });
    const box = loc({ count: vi.fn(async () => 1), locator: vi.fn(() => container) });
    const page = fakePage({ locators: { 'type="checkbox"': box } });

    await fillCheckboxGroup(asPage(page), "agree", "true");
    expect(box.check).toHaveBeenCalled();
  });

  it("treats an uncountable container as having no siblings", async () => {
    const siblings = loc({
      count: vi.fn(async () => {
        throw new Error("detached");
      })
    });
    const container = loc({ locator: vi.fn(() => siblings) });
    const box = loc({ count: vi.fn(async () => 1), locator: vi.fn(() => container) });
    const page = fakePage({ locators: { 'type="checkbox"': box } });

    await fillCheckboxGroup(asPage(page), "agree", "true");
    expect(box.check).toHaveBeenCalled();
  });

  it("does nothing with an empty answer on a lone box", async () => {
    const box = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({ locators: { 'type="checkbox"': box } });
    await fillCheckboxGroup(asPage(page), "agree", "   ");
    expect(box.check).not.toHaveBeenCalled();
  });

  it("swallows a toggle button whose click is refused", async () => {
    const yesButton = loc({
      count: vi.fn(async () => 1),
      click: vi.fn(async () => {
        throw new Error("intercepted");
      })
    });
    const container = loc({ getByRole: vi.fn(() => yesButton) });
    const box = loc({ count: vi.fn(async () => 1), locator: vi.fn(() => container) });
    const page = fakePage({ locators: { 'type="checkbox"': box } });

    await expect(fillCheckboxGroup(asPage(page), "auth", "Yes")).resolves.toBeUndefined();
    expect(box.check).not.toHaveBeenCalled();
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
  const ref = (over = {}) => ({
    contentBase64: PDF,
    fileName: "cv.pdf",
    mimeType: "application/pdf",
    ...over
  });
  /** `evaluate` drives resumeAcceptedInPage, i.e. what the widget reports. */
  const uploadPage = (accepted: boolean, over = {}) => {
    const input = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({
      locators: { 'input[type="file"]': input },
      evaluate: () => accepted,
      ...over
    });
    return { page, input };
  };

  it("uploads the supplied bytes and waits for ATS parsing once accepted", async () => {
    const { page, input } = uploadPage(true);

    await expect(attachResume(asPage(page), ref())).resolves.toBe("attached");

    const arg = (input.setInputFiles as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toMatchObject({ name: "cv.pdf", mimeType: "application/pdf" });
    expect(arg.buffer.toString()).toBe("%PDF-1.7 fake");
    // The dwell exists so ATS autofill cannot overwrite the answers we type next.
    expect(page.waitForTimeout).toHaveBeenCalledWith(3000);
  });

  it("retries, because handing the file over too early is silently ignored", async () => {
    // Measured on Greenhouse: an instant attach is dropped without a word, and a
    // moment later the same call is accepted.
    let accepted = false;
    const input = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({
      locators: { 'input[type="file"]': input },
      evaluate: (fn) => {
        // A plain visible input, so the widget path is skipped and this stays a
        // test about the retry rather than about which control gets clicked.
        if (fn === fileInputIsWidgetOwnedInPage) return false;
        if (fn === resumeFileInputIndexInPage) return 0;
        const now = accepted;
        accepted = true; // the widget finishes mounting between attempts
        return now;
      }
    });

    await expect(attachResume(asPage(page), ref())).resolves.toBe("attached");
    // Handed over twice: the first was dropped, the second stuck.
    expect(input.setInputFiles).toHaveBeenCalledTimes(2);
  });

  it("gives up after a bounded number of attempts", async () => {
    const { page, input } = uploadPage(false);
    await expect(attachResume(asPage(page), ref())).resolves.toBe("failed");
    expect((input.setInputFiles as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
  });

  it("stops early when the input disappears without being accepted", async () => {
    const page = fakePage({ evaluate: () => false });
    await expect(attachResume(asPage(page), ref())).resolves.toBe("failed");
  });

  it("reports failure when the widget refuses, even though nothing threw", async () => {
    // The failure that hid: setInputFiles succeeds, the file sits on the node,
    // and the widget has quietly rejected it.
    const { page } = uploadPage(false, {});
    await expect(attachResume(asPage(page), ref())).resolves.toBe("failed");
  });

  it("treats an unreadable page as a refusal", async () => {
    const input = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({
      locators: { 'input[type="file"]': input },
      evaluate: () => {
        throw new Error("detached frame");
      }
    });
    await expect(attachResume(asPage(page), ref())).resolves.toBe("failed");
  });

  it("survives an upload widget that throws on assignment", async () => {
    const input = loc({
      count: vi.fn(async () => 1),
      setInputFiles: vi.fn(async () => {
        throw new Error("custom widget");
      })
    });
    const page = fakePage({ locators: { 'input[type="file"]': input }, evaluate: () => false });
    await expect(attachResume(asPage(page), ref())).resolves.toBe("failed");
  });

  it("makes no outbound request of its own", async () => {
    // The whole point of taking bytes: this service can never be used to fetch
    // a URL an attacker chose.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { page } = uploadPage(true);

    await attachResume(asPage(page), ref());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("defaults the filename and mime type", async () => {
    const { page, input } = uploadPage(true);
    await attachResume(asPage(page), ref({ fileName: "", mimeType: "" }));
    expect(input.setInputFiles).toHaveBeenCalledWith(
      expect.objectContaining({ name: "resume.pdf", mimeType: "application/pdf" })
    );
  });

  it("distinguishes a resume nobody asked for from one that failed", async () => {
    const { page, input } = uploadPage(true);
    await expect(
      attachResume(asPage(page), ref({ contentBase64: null }))
    ).resolves.toBe("not_requested");
    await expect(attachResume(asPage(page), { fileName: "", mimeType: "" })).resolves.toBe(
      "not_requested"
    );
    expect(input.setInputFiles).not.toHaveBeenCalled();
  });

  it("rejects a payload that decodes to nothing or is absurdly large", async () => {
    const { page, input } = uploadPage(true);

    // Base64 decoding is lenient, so junk decodes to zero bytes rather than
    // throwing; treat that as a failure instead of uploading an empty file.
    await expect(attachResume(asPage(page), ref({ contentBase64: "!!!!" }))).resolves.toBe(
      "failed"
    );
    await expect(
      attachResume(asPage(page), ref({ contentBase64: "A".repeat(21 * 1024 * 1024) }))
    ).resolves.toBe("failed");

    expect(input.setInputFiles).not.toHaveBeenCalled();
  });
});

describe("driving a choice the other way", () => {
  const box = (over: Record<string, unknown> = {}) =>
    loc({
      evaluate: vi.fn(async () => "None of the above"),
      getAttribute: vi.fn(async () => "opt-1"),
      isChecked: vi.fn(async () => false),
      ...over
    });

  it("clicks the visible label instead of the hidden input", async () => {
    // Some widgets leave the real input hidden and wire everything to the label,
    // so ticking the input does nothing while clicking the label works.
    const target = box();
    const label = loc();
    const boxes = loc({ count: vi.fn(async () => 2) });
    boxes.nth = vi.fn(() => target);
    const page = fakePage({ locators: { 'type="checkbox"': boxes, "label[for=": label } });

    await fillCheckboxGroup(asPage(page), "q[]", "None of the above", "label");

    expect(label.click).toHaveBeenCalled();
    expect(target.check).not.toHaveBeenCalled();
  });

  it("shrugs off a label that refuses the click", async () => {
    const target = box();
    const label = loc({
      click: vi.fn(async () => {
        throw new Error("intercepted");
      })
    });
    const boxes = loc({ count: vi.fn(async () => 2) });
    boxes.nth = vi.fn(() => target);
    const page = fakePage({ locators: { 'type="checkbox"': boxes, "label[for=": label } });

    // Never throws: the read-back is what decides whether this worked.
    await expect(
      fillCheckboxGroup(asPage(page), "q[]", "None of the above", "label")
    ).resolves.toBeUndefined();
  });

  it("leaves a box alone when it already reads correctly", async () => {
    // Clicking a label TOGGLES, so acting on a correct box would break it.
    const target = box({ isChecked: vi.fn(async () => true) });
    const label = loc();
    const boxes = loc({ count: vi.fn(async () => 2) });
    boxes.nth = vi.fn(() => target);
    const page = fakePage({ locators: { 'type="checkbox"': boxes, "label[for=": label } });

    await fillCheckboxGroup(asPage(page), "q[]", "None of the above", "label");
    expect(label.click).not.toHaveBeenCalled();
  });

  it("falls back to the input when there is no label to click", async () => {
    const target = box({ getAttribute: vi.fn(async () => null) });
    const boxes = loc({ count: vi.fn(async () => 2) });
    boxes.nth = vi.fn(() => target);
    const page = fakePage({ locators: { 'type="checkbox"': boxes } });

    await fillCheckboxGroup(asPage(page), "q[]", "None of the above", "label");
    expect(target.check).toHaveBeenCalled();
  });

  it("uses the label for a lone consent box too", async () => {
    const only = box();
    const label = loc();
    const boxes = loc({ count: vi.fn(async () => 1) });
    boxes.first = vi.fn(() => only);
    const page = fakePage({ locators: { 'type="checkbox"': boxes, "label[for=": label } });

    await fillCheckboxGroup(asPage(page), "agree", "true", "label");
    expect(label.click).toHaveBeenCalled();
  });

  it("still clears a stray tick when the checked state cannot be read", async () => {
    const target = box({
      isChecked: vi.fn(async () => {
        throw new Error("detached");
      })
    });
    const label = loc();
    const boxes = loc({ count: vi.fn(async () => 2) });
    boxes.nth = vi.fn(() => target);
    const page = fakePage({ locators: { 'type="checkbox"': boxes, "label[for=": label } });

    await fillCheckboxGroup(asPage(page), "q[]", "None of the above", "label");
    // Clicking a label blind could flip a correct box, but doing nothing would
    // leave a stray tick standing, so it drives the control instead.
    expect(label.click).not.toHaveBeenCalled();
    expect(target.check).toHaveBeenCalled();
  });

  it("clears the boxes it does not want, not just ticks the ones it does", async () => {
    const wrong = loc({
      evaluate: vi.fn(async () => "Some other option"),
      getAttribute: vi.fn(async () => "opt-9"),
      isChecked: vi.fn(async () => true)
    });
    const label = loc();
    const boxes = loc({ count: vi.fn(async () => 2) });
    boxes.nth = vi.fn(() => wrong);
    const page = fakePage({ locators: { 'type="checkbox"': boxes, "label[for=": label } });

    await fillCheckboxGroup(asPage(page), "q[]", "None of the above", "label");
    // Ticked but unwanted, so the label click unticks it.
    expect(label.click).toHaveBeenCalled();
  });
});

describe("alternativeTactics", () => {
  it("is the other way round for each kind, both directions", () => {
    expect(alternativeTactics({ choice: "control", text: "type" })).toEqual({
      choice: "label",
      text: "set"
    });
    expect(alternativeTactics({ choice: "label", text: "set" })).toEqual({
      choice: "control",
      text: "type"
    });
  });
});

describe("filling text the other way", () => {
  it("sets the value in one go instead of typing it", async () => {
    const field = loc({
      count: vi.fn(async () => 1),
      evaluate: vi.fn(async () => ({ tag: "input", type: "text", cls: "", role: "", autocomplete: "" }))
    });
    const page = fakePage({ locators: { 'input[name="q"]': field } });

    await fillField(asPage(page), "form", { name: "q", label: "Q", value: "Brian" }, {
      choice: "control",
      text: "set"
    });

    expect(field.fill).toHaveBeenCalledWith("Brian");
    expect(field.pressSequentially).not.toHaveBeenCalled();
  });
});

describe("driving a choice when the element misbehaves", () => {
  it("does not guess when the id cannot even be read", async () => {
    const target = loc({
      evaluate: vi.fn(async () => "None of the above"),
      getAttribute: vi.fn(async () => {
        throw new Error("detached");
      }),
      isChecked: vi.fn(async () => false)
    });
    const boxes = loc({ count: vi.fn(async () => 2) });
    boxes.nth = vi.fn(() => target);
    const page = fakePage({ locators: { 'type="checkbox"': boxes } });

    await fillCheckboxGroup(asPage(page), "q[]", "None of the above", "label");
    // No id means no label, so it falls back to driving the control.
    expect(target.check).toHaveBeenCalled();
  });
});

describe("handing the resume to a widget that owns its own input", () => {
  const ref = () => ({
    contentBase64: Buffer.from("%PDF-1.7 fake").toString("base64"),
    fileName: "cv.pdf",
    mimeType: "application/pdf"
  });

  /** A page whose file input is hidden behind a custom uploader. */
  function widgetPage(over: { chooser?: boolean; attachControl?: boolean; accepts?: boolean } = {}) {
    const setFiles = vi.fn(async () => {});
    const control = loc({ count: vi.fn(async () => (over.attachControl === false ? 0 : 1)) });
    const input = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({
      locators: { 'input[type="file"]': input },
      getByRole: () => control,
      evaluate: (fn) => (fn === fileInputIsWidgetOwnedInPage ? true : (over.accepts ?? true)),
      ...(over.chooser === false ? {} : { waitForEvent: () => ({ setFiles }) })
    });
    return { page, input, control, setFiles };
  }

  it("clicks the widget's own control instead of writing to the hidden input", async () => {
    // Writing to the input behind the widget's back is what left a Greenhouse
    // upload dead on "reading 'uploadFile'" while still showing the filename.
    const { page, input, control, setFiles } = widgetPage();

    await expect(attachResume(asPage(page), ref())).resolves.toBe("attached");

    expect(control.click).toHaveBeenCalled();
    expect(setFiles).toHaveBeenCalledWith(
      expect.objectContaining({ name: "cv.pdf", mimeType: "application/pdf" })
    );
    expect(input.setInputFiles).not.toHaveBeenCalled();
  });

  it("falls back to the input when the widget offers nothing to click", async () => {
    const { page, input } = widgetPage({ attachControl: false });

    await expect(attachResume(asPage(page), ref())).resolves.toBe("attached");
    expect(input.setInputFiles).toHaveBeenCalled();
  });

  it("falls back when the click opens no chooser at all", async () => {
    // A control that opens nothing says nothing about the file, so the plain
    // input is still worth a try rather than skipping the resume entirely.
    const { page, input } = widgetPage({ chooser: false });

    await expect(attachResume(asPage(page), ref())).resolves.toBe("attached");
    expect(input.setInputFiles).toHaveBeenCalled();
  });

  it("falls back when the widget cannot even be counted", async () => {
    const input = loc({ count: vi.fn(async () => 1) });
    const control = loc({
      count: vi.fn(async () => {
        throw new Error("detached");
      })
    });
    const page = fakePage({
      locators: { 'input[type="file"]': input },
      getByRole: () => control,
      evaluate: (fn) => (fn === fileInputIsWidgetOwnedInPage ? true : true)
    });

    await expect(attachResume(asPage(page), ref())).resolves.toBe("attached");
    expect(input.setInputFiles).toHaveBeenCalled();
  });

  it("leaves a plain visible input alone", async () => {
    // No widget to drive, so there is nothing to be clever about.
    const input = loc({ count: vi.fn(async () => 1) });
    const control = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({
      locators: { 'input[type="file"]': input },
      getByRole: () => control,
      evaluate: (fn) => (fn === fileInputIsWidgetOwnedInPage ? false : true)
    });

    await expect(attachResume(asPage(page), ref())).resolves.toBe("attached");
    expect(input.setInputFiles).toHaveBeenCalled();
    expect(control.click).not.toHaveBeenCalled();
  });

  it("feeds the Resume field's widget, never the autofill pane's", async () => {
    // The Ashby failure: TWO hidden file inputs, and both the page-wide first
    // input and the page-wide first "upload" button belong to the autofill
    // pane. The attach must follow the picker's index to the Resume field's
    // input and click the button inside THAT widget, or a convenience pane
    // eats the file while the required field stays empty.
    const setFiles = vi.fn(async () => {});
    const scopedControl = loc({ count: vi.fn(async () => 1) });
    const container = loc({ getByRole: vi.fn(() => scopedControl) });
    const fieldInput = loc({ count: vi.fn(async () => 1), locator: vi.fn(() => container) });
    const inputs = loc({});
    inputs.nth = vi.fn(() => fieldInput);
    const pageWideControl = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({
      locators: { 'input[type="file"]': inputs },
      getByRole: () => pageWideControl,
      evaluate: (fn) => (fn === resumeFileInputIndexInPage ? 1 : true),
      waitForEvent: () => ({ setFiles })
    });

    await expect(attachResume(asPage(page), ref())).resolves.toBe("attached");

    expect(inputs.nth).toHaveBeenCalledWith(1);
    expect(scopedControl.click).toHaveBeenCalled();
    expect(pageWideControl.click).not.toHaveBeenCalled();
    // The ancestor scope must recognize every container shape the in-page
    // pickers do, fieldset TAGS included, or a picked input inside one would
    // fall back to the page-wide button and feed the wrong widget.
    expect(fieldInput.locator).toHaveBeenCalledWith(expect.stringContaining("self::fieldset"));
    expect(setFiles).toHaveBeenCalledWith(
      expect.objectContaining({ name: "cv.pdf", mimeType: "application/pdf" })
    );
  });

  it("falls back page-wide when the scoped widget cannot even be counted", async () => {
    // A detached container must degrade to the old page-wide button lookup,
    // not fail the attach.
    const setFiles = vi.fn(async () => {});
    const scopedControl = loc({
      count: vi.fn(async () => {
        throw new Error("detached");
      })
    });
    const container = loc({ getByRole: vi.fn(() => scopedControl) });
    const input = loc({ count: vi.fn(async () => 1), locator: vi.fn(() => container) });
    const pageWideControl = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({
      locators: { 'input[type="file"]': input },
      getByRole: () => pageWideControl,
      evaluate: () => true,
      waitForEvent: () => ({ setFiles })
    });

    await expect(attachResume(asPage(page), ref())).resolves.toBe("attached");
    expect(pageWideControl.click).toHaveBeenCalled();
  });

  it("falls back to the first input when the picked index went stale mid-attempt", async () => {
    // A widget can swap its inputs between the pick and the look. An empty
    // nth() while an input still exists means stale, not gone, so the attach
    // must not abandon the resume over it.
    const gone = loc({ count: vi.fn(async () => 0) });
    const remaining = loc({ count: vi.fn(async () => 1) });
    const inputs = loc({});
    inputs.nth = vi.fn(() => gone);
    inputs.first = vi.fn(() => remaining);
    const page = fakePage({
      locators: { 'input[type="file"]': inputs },
      evaluate: (fn) =>
        fn === resumeFileInputIndexInPage ? 1 : fn === fileInputIsWidgetOwnedInPage ? false : true
    });

    await expect(attachResume(asPage(page), ref())).resolves.toBe("attached");
    expect(remaining.setInputFiles).toHaveBeenCalled();
    expect(gone.setInputFiles).not.toHaveBeenCalled();
    // The checks must follow the fallback: judging widget ownership or
    // acceptance at the stale index would inspect a control nobody fed.
    expect(page.evaluate).toHaveBeenCalledWith(fileInputIsWidgetOwnedInPage, 0);
  });

  it("treats a picker answer that is not a usable index as the first input", async () => {
    // page.evaluate can hand back anything on a hostile page; a junk index must
    // degrade to the old behavior, not become nth(NaN).
    const input = loc({ count: vi.fn(async () => 1) });
    const inputs = loc({});
    inputs.nth = vi.fn(() => input);
    const page = fakePage({
      locators: { 'input[type="file"]': inputs },
      evaluate: (fn) => (fn === resumeFileInputIndexInPage ? "junk" : fn === fileInputIsWidgetOwnedInPage ? false : true)
    });

    await expect(attachResume(asPage(page), ref())).resolves.toBe("attached");
    expect(inputs.nth).toHaveBeenCalledWith(0);
  });
});
