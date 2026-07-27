import { describe, expect, it } from "vitest";
import { blocksSubmit, findMismatches } from "../src/verify";
import type { FilledState } from "../src/extract";
import type { Answer } from "../src/types";

const answer = (over: Partial<Answer> & { name: string }): Answer => ({
  label: "Q",
  value: "v",
  ...over
});

const choice = (name: string, checked: string[], count = 4): FilledState => ({
  name,
  kind: "choice",
  checked,
  value: "",
  count
});

const text = (name: string, value: string): FilledState => ({
  name,
  kind: "text",
  checked: [],
  value,
  count: 1
});

describe("findMismatches on choice fields", () => {
  // The real group from the Databricks run that went wrong.
  const SANCTIONS = [
    "Citizen or permanent resident of Cuba, Iran, North Korea, or Syria",
    "Ordinarily a resident of Cuba, Iran, North Korea, Syria or the Crimea, Donetsk, Luhansk, Zaporizhzhia, or Kherson regions of Ukraine",
    "Ordinarily a resident of Russia or Belarus and not willing to relocate for a Databricks role",
    "None of the above"
  ];
  const approved = answer({ name: "q[]", label: "Sanctions", value: "None of the above" });

  it("agrees when exactly the approved option is ticked", () => {
    expect(findMismatches([approved], [choice("q[]", [SANCTIONS[3]])])).toEqual([]);
  });

  it("catches the box we never asked for, which is the whole point", () => {
    // Exactly what shipped: option two ticked, "None of the above" left alone.
    const found = findMismatches([approved], [choice("q[]", [SANCTIONS[1]])]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      name: "q[]",
      label: "Sanctions",
      expected: "None of the above"
    });
    expect(found[0].actual).toContain("Ordinarily a resident of Cuba");
  });

  it("catches a group left entirely empty", () => {
    const found = findMismatches([approved], [choice("q[]", [])]);
    expect(found[0].actual).toBe("(nothing)");
  });

  it("catches the right option ticked alongside a wrong one", () => {
    // Half right is still a false statement, so this must not pass.
    const found = findMismatches([approved], [choice("q[]", [SANCTIONS[3], SANCTIONS[0]])]);
    expect(found).toHaveLength(1);
  });

  it("accepts a multi-select answer once every wanted option is ticked", () => {
    const multi = answer({ name: "q[]", value: "U.S. citizen; None of these apply to me" });
    const state = choice("q[]", ["U.S. citizen", "None of these apply to me"]);
    expect(findMismatches([multi], [state])).toEqual([]);
  });

  it("tolerates the wording drift the matcher already allows", () => {
    const a = answer({ name: "q[]", value: "U.S. citizen" });
    expect(findMismatches([a], [choice("q[]", ["U.S. citizen (current)"])])).toEqual([]);
  });

  it("reads a lone consent box as a boolean", () => {
    const yes = answer({ name: "agree", value: "true" });
    const no = answer({ name: "agree", value: "false" });

    expect(findMismatches([yes], [choice("agree", ["I agree"], 1)])).toEqual([]);
    expect(findMismatches([no], [choice("agree", [], 1)])).toEqual([]);
    expect(findMismatches([yes], [choice("agree", [], 1)])).toHaveLength(1);
    expect(findMismatches([no], [choice("agree", ["I agree"], 1)])).toHaveLength(1);
  });
});

describe("findMismatches on text fields", () => {
  it("flags a field we answered that came back empty", () => {
    const a = answer({ name: "email", label: "Email", value: "a@b.com" });
    expect(findMismatches([a], [text("email", "")])).toHaveLength(1);
  });

  it("does NOT flag a form that rewrote what we typed", () => {
    // A location autocomplete really does this, and comparing strictly would cry
    // wolf on a healthy run. A warning that is usually noise gets ignored.
    const a = answer({ name: "loc", value: "Phoenix, Arizona" });
    expect(findMismatches([a], [text("loc", "Phoenix, Arizona, United States")])).toEqual([]);
  });

  it("does NOT flag a reformatted phone number", () => {
    const a = answer({ name: "phone", value: "6026866672" });
    expect(findMismatches([a], [text("phone", "(602) 686-6672")])).toEqual([]);
  });
});

describe("what findMismatches deliberately ignores", () => {
  it("ignores skipped and blank answers", () => {
    const skipped = answer({ name: "a", value: "x", skipped: true });
    const blank = answer({ name: "b", value: "   " });
    expect(findMismatches([skipped, blank], [text("a", ""), text("b", "")])).toEqual([]);
  });

  it("ignores an answer whose control could not be read", () => {
    // A later wizard page, or a control the reader could not name. Unreadable is
    // not the same as wrong, and guessing would manufacture false alarms.
    expect(findMismatches([answer({ name: "ghost" })], [])).toEqual([]);
  });

  it("leaves the resume to attachResume, which checks the widget itself", () => {
    const a = answer({ name: "resume", value: "cv.pdf" });
    const state: FilledState = {
      name: "resume",
      kind: "file",
      checked: [],
      value: "",
      count: 1
    };
    expect(findMismatches([a], [state])).toEqual([]);
  });
});

describe("blocksSubmit", () => {
  it("blocks on a choice field, because that is a false statement", () => {
    const mismatches = findMismatches(
      [answer({ name: "q[]", value: "None of the above" })],
      [choice("q[]", ["Something else"])]
    );
    expect(blocksSubmit(mismatches)).toBe(true);
  });

  it("does not block on an empty text field", () => {
    // Visible in the screenshot, and the employer's own validation will catch it.
    const mismatches = findMismatches(
      [answer({ name: "email", value: "a@b.com" })],
      [text("email", "")]
    );
    expect(mismatches).toHaveLength(1);
    expect(blocksSubmit(mismatches)).toBe(false);
  });

  it("does not block when nothing disagrees", () => {
    expect(blocksSubmit([])).toBe(false);
  });

  it("still blocks a wizard page that is no longer on screen", () => {
    // The regression: deciding this from a fresh read of the CURRENT page meant a
    // choice mismatch found on page one stopped counting the moment we advanced,
    // and submit went ahead with the wrong ticks.
    const pageOne = findMismatches(
      [answer({ name: "q[]", value: "None of the above" })],
      [choice("q[]", ["Ordinarily a resident of Cuba"])]
    );
    expect(pageOne[0].kind).toBe("choice");
    // Page two is all that remains readable, and it is clean.
    expect(blocksSubmit([...pageOne])).toBe(true);
  });

  it("labels each mismatch with the kind of control it came from", () => {
    const found = findMismatches(
      [answer({ name: "q[]", value: "Yes" }), answer({ name: "email", value: "a@b.com" })],
      [choice("q[]", []), text("email", "")]
    );
    expect(found.map((m) => m.kind)).toEqual(["choice", "text"]);
  });
});
