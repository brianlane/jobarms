import { describe, expect, it } from "vitest";
import {
  isUniqueViolation,
  pickVerificationRun,
  verificationHost
} from "@/lib/inbound-verification";

describe("isUniqueViolation", () => {
  it("recognizes the Postgres unique-violation code", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("treats every other failure as a write that did not happen", () => {
    expect(isUniqueViolation({ code: "57014" })).toBe(false);
    expect(isUniqueViolation({ message: "boom" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });
});

describe("verificationHost", () => {
  it("prefers the link, which names the tenant directly", () => {
    expect(
      verificationHost("https://ACME.wd1.myworkdayjobs.com/verify?t=1", "myworkday.com")
    ).toBe("acme.wd1.myworkdayjobs.com");
  });

  it("falls back to the sending domain when the link will not parse", () => {
    expect(verificationHost("not a url", "Mail.Workday.com")).toBe("mail.workday.com");
  });

  it("falls back to the sending domain when there is no link", () => {
    expect(verificationHost(null, "workday.com")).toBe("workday.com");
  });

  it("returns null with nothing to go on", () => {
    expect(verificationHost(null, null)).toBeNull();
    expect(verificationHost("also not a url", null)).toBeNull();
  });
});

describe("pickVerificationRun", () => {
  const acme = { id: "run-acme", tenant_host: "acme.wd1.myworkdayjobs.com" };
  const globex = { id: "run-globex", tenant_host: "globex.wd5.myworkdayjobs.com" };

  it("returns nothing when no run is parked", () => {
    expect(pickVerificationRun([], "acme.wd1.myworkdayjobs.com")).toEqual({
      run: null,
      ambiguous: false
    });
  });

  it("matches the run whose tenant the mail names", () => {
    expect(pickVerificationRun([globex, acme], "acme.wd1.myworkdayjobs.com").run).toBe(acme);
  });

  it("matches a subdomain in either direction", () => {
    expect(pickVerificationRun([acme], "mail.acme.wd1.myworkdayjobs.com").run).toBe(acme);
    expect(pickVerificationRun([{ tenant_host: "a.b.example.com" }], "example.com").run).toEqual({
      tenant_host: "a.b.example.com"
    });
  });

  it("ignores a parked run with no tenant recorded", () => {
    const blank = { id: "run-blank", tenant_host: null };
    expect(pickVerificationRun([blank, acme], "acme.wd1.myworkdayjobs.com").run).toBe(acme);
  });

  it("takes the lone parked run when the tenant cannot be matched", () => {
    expect(pickVerificationRun([acme], "unrelated.example.com").run).toBe(acme);
    expect(pickVerificationRun([acme], null).run).toBe(acme);
  });

  // Driving the wrong tenant's browser session is worse than letting the
  // intended run time out honestly.
  it("refuses to guess between several unmatched runs", () => {
    expect(pickVerificationRun([acme, globex], "unrelated.example.com")).toEqual({
      run: null,
      ambiguous: true
    });
    expect(pickVerificationRun([acme, globex], null)).toEqual({ run: null, ambiguous: true });
  });

  it("refuses to guess when several runs share the named tenant", () => {
    const dupe = { id: "run-dupe", tenant_host: "acme.wd1.myworkdayjobs.com" };
    expect(pickVerificationRun([acme, dupe], "acme.wd1.myworkdayjobs.com")).toEqual({
      run: null,
      ambiguous: true
    });
  });
});
