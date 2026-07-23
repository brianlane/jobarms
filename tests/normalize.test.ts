import { describe, expect, it } from "vitest";
import {
  fixShoutyField,
  fixShoutyProse,
  isShouty,
  normalizePhone,
  titleCase
} from "@/lib/normalize";

describe("isShouty", () => {
  it("detects all-caps strings", () => {
    expect(isShouty("BRIAN LANE")).toBe(true);
    expect(isShouty("SENIOR SOFTWARE ENGINEER")).toBe(true);
  });

  it("leaves normal and short strings alone", () => {
    expect(isShouty("Brian Lane")).toBe(false);
    expect(isShouty("AWS")).toBe(false); // short = probably an acronym
    expect(isShouty("QA")).toBe(false);
  });
});

describe("fixShoutyField / titleCase", () => {
  it("title-cases shouty names and titles", () => {
    expect(fixShoutyField("BRIAN LANE")).toBe("Brian Lane");
    expect(fixShoutyField("SENIOR SOFTWARE ENGINEER")).toBe("Senior Software Engineer");
  });

  it("keeps known acronyms uppercase and small words lowercase", () => {
    expect(fixShoutyField("VP OF ENGINEERING")).toBe("VP of Engineering");
    expect(fixShoutyField("AWS CLOUD ARCHITECT")).toBe("AWS Cloud Architect");
  });

  it("handles hyphenated compounds", () => {
    expect(fixShoutyField("FULL-STACK DEVELOPER")).toBe("Full-Stack Developer");
  });

  it("does not touch already-normal text", () => {
    expect(fixShoutyField("Brian Lane")).toBe("Brian Lane");
    expect(fixShoutyField("Engineer II at Acme")).toBe("Engineer II at Acme");
  });

  it("titleCase keeps roman numerals and acronyms", () => {
    expect(titleCase("ENGINEER III")).toBe("Engineer III");
  });
});

describe("fixShoutyProse", () => {
  it("fixes the leading shouty run in mixed prose", () => {
    expect(
      fixShoutyProse("SENIOR SOFTWARE ENGINEER with a track record of building scalable systems.")
    ).toBe("Senior Software Engineer with a track record of building scalable systems.");
  });

  it("sentence-cases fully shouty prose and restores acronyms", () => {
    expect(fixShoutyProse("BUILT SQL PIPELINES. SHIPPED FAST.")).toBe(
      "Built SQL pipelines. Shipped fast."
    );
  });

  it("leaves normal prose untouched", () => {
    const s = "Experienced in microservices and cloud solutions.";
    expect(fixShoutyProse(s)).toBe(s);
  });
});

describe("normalizePhone", () => {
  it("formats US 10-digit numbers from any separator style", () => {
    expect(normalizePhone("602.686.6672")).toBe("(602) 686-6672");
    expect(normalizePhone("602-686-6672")).toBe("(602) 686-6672");
    expect(normalizePhone("6026866672")).toBe("(602) 686-6672");
  });

  it("formats 11-digit with country code", () => {
    expect(normalizePhone("1 (602) 686-6672")).toBe("+1 (602) 686-6672");
    expect(normalizePhone("+16026866672")).toBe("+1 (602) 686-6672");
  });

  it("leaves non-US / odd lengths untouched", () => {
    expect(normalizePhone("+44 20 7946 0958")).toBe("+44 20 7946 0958");
    expect(normalizePhone("")).toBe("");
  });
});
