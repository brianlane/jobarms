import { describe, expect, it } from "vitest";
import { domainOf, isApplicantAlias } from "../src/alias";

describe("domainOf", () => {
  it("lowercases and trims the domain part", () => {
    expect(domainOf("Recruiter@Example.COM ")).toBe("example.com");
  });

  it("uses the LAST @ so a quoted local part cannot spoof the domain", () => {
    expect(domainOf('"weird@thing"@example.com')).toBe("example.com");
  });

  it("returns empty for an address with no @", () => {
    expect(domainOf("not-an-address")).toBe("");
  });
});

describe("isApplicantAlias", () => {
  it("accepts a well-formed managed alias", () => {
    expect(isApplicantAlias("a-abcdefghjk@jobarms.com", "jobarms.com")).toBe(true);
  });

  it("is case-insensitive on both parts", () => {
    expect(isApplicantAlias("A-ABCDEFGHJK@JobArms.com", "jobarms.com")).toBe(true);
  });

  it("rejects platform addresses that are not aliases", () => {
    expect(isApplicantAlias("hello@jobarms.com", "jobarms.com")).toBe(false);
  });

  it("rejects a matching shape on another domain", () => {
    expect(isApplicantAlias("a-abcdefghjk@evil.com", "jobarms.com")).toBe(false);
  });

  it("rejects the wrong random-part length", () => {
    expect(isApplicantAlias("a-abc@jobarms.com", "jobarms.com")).toBe(false);
    expect(isApplicantAlias("a-abcdefghjkmn@jobarms.com", "jobarms.com")).toBe(false);
  });

  it("rejects characters outside the alias alphabet", () => {
    // 'i', 'l', 'o', '0', and '1' are excluded as ambiguous glyphs.
    expect(isApplicantAlias("a-abcdefghji@jobarms.com", "jobarms.com")).toBe(false);
    expect(isApplicantAlias("a-abcdefgh01@jobarms.com", "jobarms.com")).toBe(false);
  });

  it("rejects an address with no @", () => {
    expect(isApplicantAlias("a-abcdefghjk", "jobarms.com")).toBe(false);
  });

  it("compares the platform domain case-insensitively", () => {
    expect(isApplicantAlias("a-abcdefghjk@jobarms.com", "JOBARMS.COM")).toBe(true);
  });
});
