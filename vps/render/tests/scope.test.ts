import { describe, expect, it } from "vitest";
import { scopedSelector, splitSelectorList } from "../src/scope";
import { ADAPTERS } from "../src/adapters";

describe("splitSelectorList", () => {
  it("splits a plain list and trims the fragments", () => {
    expect(splitSelectorList("form, #app , .board")).toEqual(["form", "#app", ".board"]);
  });

  it("returns a single selector unchanged", () => {
    expect(splitSelectorList("form")).toEqual(["form"]);
  });

  it("drops empty fragments from stray or trailing commas", () => {
    expect(splitSelectorList("form, , #app,")).toEqual(["form", "#app"]);
    expect(splitSelectorList("   ")).toEqual([]);
  });

  it("keeps commas inside attribute brackets", () => {
    expect(splitSelectorList('[data-x="a,b"], form')).toEqual(['[data-x="a,b"]', "form"]);
  });

  it("keeps commas inside functional pseudo-classes", () => {
    expect(splitSelectorList(":is(a, b) input, form")).toEqual([":is(a, b) input", "form"]);
  });

  it("keeps commas inside single-quoted strings", () => {
    expect(splitSelectorList("[data-x='a,b'], form")).toEqual(["[data-x='a,b']", "form"]);
  });

  it("does not treat a quote character inside another quote as a delimiter", () => {
    expect(splitSelectorList(`[data-x="it's, fine"], form`)).toEqual([
      `[data-x="it's, fine"]`,
      "form"
    ]);
  });
});

describe("scopedSelector", () => {
  it("pairs every suffix with every scope, which plain interpolation does not", () => {
    // `${scope} input` would read as "form" OR "#app input": the bug this fixes.
    expect(scopedSelector("form, #app", ["input"])).toBe("form input, #app input");
  });

  it("keeps suffix order within each scope", () => {
    expect(scopedSelector("form", ["input", "textarea", "select"])).toBe(
      "form input, form textarea, form select"
    );
  });

  it("expands a multi-scope, multi-suffix pair fully", () => {
    expect(scopedSelector("a, b", ["input", "select"])).toBe(
      "a input, a select, b input, b select"
    );
  });
});

describe("every adapter scope survives expansion", () => {
  it.each(Object.entries(ADAPTERS))(
    "%s scopes each fragment to the controls beneath it",
    (_ats, adapter) => {
      const fragments = splitSelectorList(adapter.formSelector);
      const expanded = scopedSelector(adapter.formSelector, ["input"]);

      // The regression guard: no fragment may survive as a bare element match,
      // which is what made a Greenhouse form extract as one field.
      for (const fragment of fragments) {
        expect(expanded).toContain(`${fragment} input`);
      }
      expect(expanded.split(", ")).toHaveLength(fragments.length);
    }
  );
});
