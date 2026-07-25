import { describe, expect, it, vi } from "vitest";
import { collectFields, collectFieldsInPage } from "../src/extract";
import { fakePage } from "./helpers/fake-page";
import type { Page } from "playwright";

/**
 * A minimal fake DOM element. The in-page callback only uses getAttribute,
 * hasAttribute, closest, querySelector(All), tagName, and textContent, so this
 * models exactly that surface.
 */
interface El {
  tagName: string;
  attrs: Record<string, string>;
  id?: string;
  textContent?: string;
  closestMap?: Record<string, El | null>;
  children?: El[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function el(tagName: string, attrs: Record<string, string> = {}, extra: Partial<El> = {}): any {
  const node: any = {
    tagName,
    getAttribute: (k: string) => attrs[k] ?? null,
    hasAttribute: (k: string) => k in attrs,
    closest: (sel: string) => extra.closestMap?.[sel] ?? null,
    querySelector: (sel: string) =>
      (extra.children ?? []).find((c) => c.tagName.toLowerCase() === sel.toLowerCase()) ?? null,
    querySelectorAll: (sel: string) =>
      (extra.children ?? []).filter((c) => c.tagName.toLowerCase() === sel.toLowerCase()),
    textContent: extra.textContent ?? ""
  };
  return node;
}

/** Install a fake `document`/`CSS` for the duration of one callback run. */
function withDom(
  opts: {
    labels?: Record<string, string>;
    byId?: Record<string, string>;
    groups?: Record<string, any[]>;
  },
  run: () => unknown
) {
  const doc = {
    querySelector: (sel: string) => {
      const m = /^label\[for="(.*)"\]$/.exec(sel);
      if (m && opts.labels?.[m[1]] !== undefined) {
        return { textContent: opts.labels[m[1]] };
      }
      return null;
    },
    querySelectorAll: (sel: string) => {
      const m = /name="([^"]+)"/.exec(sel);
      return (m && opts.groups?.[m[1]]) || [];
    },
    getElementById: (id: string) =>
      opts.byId?.[id] !== undefined ? { textContent: opts.byId[id] } : null
  };
  const g = globalThis as any;
  const prevDoc = g.document;
  const prevCss = g.CSS;
  g.document = doc;
  g.CSS = { escape: (v: string) => v };
  try {
    return run();
  } finally {
    g.document = prevDoc;
    g.CSS = prevCss;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("collectFieldsInPage", () => {
  it("reads a text input labelled by a <label for>", () => {
    const input = el("INPUT", { type: "text", name: "first_name", id: "fn", required: "" });
    const fields = withDom({ labels: { fn: "  First   Name " } }, () =>
      collectFieldsInPage([input])
    ) as ReturnType<typeof collectFieldsInPage>;
    expect(fields).toEqual([
      { name: "first_name", label: "First Name", type: "text", required: true, options: [] }
    ]);
  });

  it("skips structural input types", () => {
    const inputs = ["hidden", "submit", "button", "image", "reset"].map((type) =>
      el("INPUT", { type, name: `n-${type}` })
    );
    expect(withDom({}, () => collectFieldsInPage(inputs))).toEqual([]);
  });

  it("skips a control with no name and no id", () => {
    expect(withDom({}, () => collectFieldsInPage([el("INPUT", { type: "text" })]))).toEqual([]);
  });

  it("falls back to the id when there is no name", () => {
    const fields = withDom({}, () =>
      collectFieldsInPage([el("INPUT", { type: "text", id: "only_id" })])
    ) as ReturnType<typeof collectFieldsInPage>;
    expect(fields[0].name).toBe("only_id");
  });

  it("defaults a typeless input to text", () => {
    const fields = withDom({}, () =>
      collectFieldsInPage([el("INPUT", { name: "x" })])
    ) as ReturnType<typeof collectFieldsInPage>;
    expect(fields[0].type).toBe("text");
  });

  it("resolves a label through aria-labelledby", () => {
    const input = el("INPUT", { type: "text", name: "n", "aria-labelledby": "l1 l2" });
    const fields = withDom({ byId: { l1: "Preferred", l2: "Name" } }, () =>
      collectFieldsInPage([input])
    ) as ReturnType<typeof collectFieldsInPage>;
    expect(fields[0].label).toBe("Preferred Name");
  });

  it("falls back through wrapping label, aria-label, placeholder, then name", () => {
    const wrapped = el(
      "INPUT",
      { type: "text", name: "a" },
      { closestMap: { label: { textContent: " Wrapped " } as never } }
    );
    expect(
      (withDom({}, () => collectFieldsInPage([wrapped])) as ReturnType<typeof collectFieldsInPage>)[0]
        .label
    ).toBe("Wrapped");

    const aria = el("INPUT", { type: "text", name: "b", "aria-label": "Aria" });
    expect(
      (withDom({}, () => collectFieldsInPage([aria])) as ReturnType<typeof collectFieldsInPage>)[0]
        .label
    ).toBe("Aria");

    const ph = el("INPUT", { type: "text", name: "c", placeholder: "Ph" });
    expect(
      (withDom({}, () => collectFieldsInPage([ph])) as ReturnType<typeof collectFieldsInPage>)[0]
        .label
    ).toBe("Ph");

    const bare = el("INPUT", { type: "text", name: "d" });
    expect(
      (withDom({}, () => collectFieldsInPage([bare])) as ReturnType<typeof collectFieldsInPage>)[0]
        .label
    ).toBe("d");
  });

  it("ignores an empty <label for> and keeps looking", () => {
    const input = el("INPUT", { type: "text", name: "n", id: "i", "aria-label": "Aria" });
    const fields = withDom({ labels: { i: "" } }, () =>
      collectFieldsInPage([input])
    ) as ReturnType<typeof collectFieldsInPage>;
    expect(fields[0].label).toBe("Aria");
  });

  it("treats aria-required as required", () => {
    const input = el("INPUT", { type: "text", name: "n", "aria-required": "true" });
    const fields = withDom({}, () => collectFieldsInPage([input])) as ReturnType<
      typeof collectFieldsInPage
    >;
    expect(fields[0].required).toBe(true);
  });

  it("treats a react-select input as a select so the filler operates the widget", () => {
    for (const attrs of [
      { class: "select__input other" },
      { role: "combobox" },
      { "aria-autocomplete": "list" }
    ]) {
      const input = el("INPUT", { type: "text", name: "country", ...attrs });
      const fields = withDom({}, () => collectFieldsInPage([input])) as ReturnType<
        typeof collectFieldsInPage
      >;
      expect(fields[0].type).toBe("select");
    }
  });

  it("does not treat a non-input as a combobox", () => {
    const ta = el("TEXTAREA", { name: "cover", role: "combobox" });
    const fields = withDom({}, () => collectFieldsInPage([ta])) as ReturnType<
      typeof collectFieldsInPage
    >;
    expect(fields[0].type).toBe("textarea");
  });

  it("reads select options, dropping the placeholder", () => {
    const select = el(
      "SELECT",
      { name: "years" },
      {
        children: [
          { tagName: "OPTION", textContent: "Select one" } as never,
          { tagName: "OPTION", textContent: " 1-3 " } as never,
          { tagName: "OPTION", textContent: "" } as never,
          { tagName: "OPTION", textContent: "4+" } as never
        ]
      }
    );
    const fields = withDom({}, () => collectFieldsInPage([select])) as ReturnType<
      typeof collectFieldsInPage
    >;
    expect(fields[0]).toMatchObject({ type: "select", options: ["1-3", "4+"] });
  });

  it("aggregates a radio group into one field with option labels", () => {
    const a = el("INPUT", { type: "radio", name: "auth", id: "a", required: "" });
    const b = el("INPUT", { type: "radio", name: "auth", id: "b" });
    const fields = withDom(
      { groups: { auth: [a, b] }, labels: { a: "Yes", b: "No" } },
      () => collectFieldsInPage([a, b])
    ) as ReturnType<typeof collectFieldsInPage>;
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      name: "auth",
      type: "radio",
      required: true,
      options: ["Yes", "No"]
    });
  });

  it("prefers a description attribute as the group prompt", () => {
    const a = el("INPUT", {
      type: "radio",
      name: "g",
      id: "a",
      description: "Are  you   authorized?"
    });
    const fields = withDom({ groups: { g: [a] }, labels: { a: "Yes" } }, () =>
      collectFieldsInPage([a])
    ) as ReturnType<typeof collectFieldsInPage>;
    expect(fields[0].label).toBe("Are you authorized?");
  });

  it("uses a fieldset legend as the group prompt", () => {
    const a = el(
      "INPUT",
      { type: "radio", name: "g", id: "a" },
      {
        closestMap: {
          fieldset: {
            querySelector: (sel: string) =>
              sel === "legend" ? { textContent: " Legend  prompt " } : null
          } as never
        }
      }
    );
    const fields = withDom({ groups: { g: [a] }, labels: { a: "Yes" } }, () =>
      collectFieldsInPage([a])
    ) as ReturnType<typeof collectFieldsInPage>;
    expect(fields[0].label).toBe("Legend prompt");
  });

  it("uses aria-describedby as the group prompt", () => {
    const a = el("INPUT", { type: "radio", name: "g", id: "a", "aria-describedby": "d1" });
    const fields = withDom(
      { groups: { g: [a] }, labels: { a: "Yes" }, byId: { d1: "Described  prompt" } },
      () => collectFieldsInPage([a])
    ) as ReturnType<typeof collectFieldsInPage>;
    expect(fields[0].label).toBe("Described prompt");
  });

  it("falls back to the option label when a group has no prompt source", () => {
    const a = el("INPUT", { type: "radio", name: "g", id: "a" });
    const fields = withDom({ groups: { g: [a] }, labels: { a: "Only label" } }, () =>
      collectFieldsInPage([a])
    ) as ReturnType<typeof collectFieldsInPage>;
    expect(fields[0].label).toBe("Only label");
  });

  it("ignores an empty legend and an empty aria-describedby lookup", () => {
    const a = el(
      "INPUT",
      { type: "radio", name: "g", id: "a", "aria-describedby": "missing" },
      { closestMap: { fieldset: { querySelector: () => ({ textContent: "" }) } as never } }
    );
    const fields = withDom({ groups: { g: [a] }, labels: { a: "Fallback" } }, () =>
      collectFieldsInPage([a])
    ) as ReturnType<typeof collectFieldsInPage>;
    expect(fields[0].label).toBe("Fallback");
  });

  it("falls back to aria-label then value for an option label", () => {
    const a = el("INPUT", { type: "radio", name: "g", id: "a", "aria-label": "Aria opt" });
    const b = el("INPUT", { type: "radio", name: "g", id: "b", value: "Val opt" });
    const fields = withDom({ groups: { g: [a, b] } }, () =>
      collectFieldsInPage([a])
    ) as ReturnType<typeof collectFieldsInPage>;
    expect(fields[0].options).toEqual(["Aria opt", "Val opt"]);
  });

  it("treats a lone checkbox as a boolean consent box", () => {
    const box = el("INPUT", { type: "checkbox", name: "agree", id: "ag" });
    const fields = withDom({ groups: { agree: [box] }, labels: { ag: "I agree" } }, () =>
      collectFieldsInPage([box])
    ) as ReturnType<typeof collectFieldsInPage>;
    expect(fields[0]).toMatchObject({ type: "checkbox", label: "I agree", options: [] });
  });

  it("aggregates a multi-checkbox group", () => {
    const a = el("INPUT", { type: "checkbox", name: "src", id: "a", description: "How?" });
    const b = el("INPUT", { type: "checkbox", name: "src", id: "b" });
    const fields = withDom(
      { groups: { src: [a, b] }, labels: { a: "LinkedIn", b: "Referral" } },
      () => collectFieldsInPage([a, b])
    ) as ReturnType<typeof collectFieldsInPage>;
    expect(fields[0]).toMatchObject({ type: "checkbox", options: ["LinkedIn", "Referral"] });
  });

  it("deduplicates repeated names", () => {
    const a = el("INPUT", { type: "text", name: "dup" });
    const b = el("INPUT", { type: "text", name: "dup" });
    expect(withDom({}, () => collectFieldsInPage([a, b]))).toHaveLength(1);
  });

  it("truncates a pathologically long label", () => {
    const input = el("INPUT", { type: "text", name: "n", "aria-label": "x".repeat(500) });
    const fields = withDom({}, () => collectFieldsInPage([input])) as ReturnType<
      typeof collectFieldsInPage
    >;
    expect(fields[0].label).toHaveLength(300);
  });
});

describe("collectFields", () => {
  it("scopes the selector to the form and returns the callback result", async () => {
    const page = fakePage({ eval$$: () => [{ name: "a" }] });
    const result = await collectFields(page as unknown as Page, "#form");
    expect(result).toEqual([{ name: "a" }]);
    expect((page.$$eval as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "#form input, #form textarea, #form select"
    );
  });

  it("returns an empty list instead of throwing when the scope is gone", async () => {
    const page = fakePage();
    page.$$eval = vi.fn(async () => {
      throw new Error("detached frame");
    });
    expect(await collectFields(page as unknown as Page, "#form")).toEqual([]);
  });
});
