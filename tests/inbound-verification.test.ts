import { describe, expect, it } from "vitest";
import {
  isUniqueViolation,
  pickVerificationRun,
  verificationOrigin
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

describe("verificationOrigin", () => {
  it("takes the host from the link and says it names a tenant", () => {
    expect(
      verificationOrigin("https://ACME.wd1.myworkdayjobs.com/verify?t=1", "myworkday.com")
    ).toEqual({ host: "acme.wd1.myworkdayjobs.com", namesTenant: true });
  });

  it("falls back to the sending domain, which names no tenant", () => {
    expect(verificationOrigin("not a url", "Mail.Workday.com")).toEqual({
      host: "mail.workday.com",
      namesTenant: false
    });
    expect(verificationOrigin(null, "workday.com")).toEqual({
      host: "workday.com",
      namesTenant: false
    });
  });

  it("returns nothing to go on when there is neither", () => {
    expect(verificationOrigin(null, null)).toEqual({ host: null, namesTenant: false });
  });
});

describe("pickVerificationRun", () => {
  const acme = { id: "run-acme", tenant_host: "acme.wd1.myworkdayjobs.com" };
  const globex = { id: "run-globex", tenant_host: "globex.wd5.myworkdayjobs.com" };
  const fromLink = (host: string) => ({ host, namesTenant: true });
  const fromSender = (host: string | null) => ({ host, namesTenant: false });

  it("returns nothing when no run is parked", () => {
    expect(pickVerificationRun([], fromLink("acme.wd1.myworkdayjobs.com"))).toEqual({
      run: null,
      ambiguous: false
    });
  });

  it("takes the lone parked run whatever the mail says", () => {
    expect(pickVerificationRun([acme], fromLink("unrelated.example.com")).run).toBe(acme);
    expect(pickVerificationRun([acme], fromSender(null)).run).toBe(acme);
  });

  it("matches the run whose tenant the link names", () => {
    expect(pickVerificationRun([globex, acme], fromLink("acme.wd1.myworkdayjobs.com")).run).toBe(
      acme
    );
  });

  it("matches a subdomain in either direction", () => {
    expect(pickVerificationRun([acme, globex], fromLink("mail.acme.wd1.myworkdayjobs.com")).run).toBe(
      acme
    );
    const nested = { tenant_host: "a.b.example.com" };
    expect(pickVerificationRun([nested, globex], fromLink("example.com")).run).toBe(nested);
  });

  it("ignores a parked run with no tenant recorded", () => {
    const blank = { id: "run-blank", tenant_host: null };
    expect(pickVerificationRun([blank, acme], fromLink("acme.wd1.myworkdayjobs.com")).run).toBe(
      acme
    );
  });

  // The sidecar cannot be driven without a host, so a run missing one is not
  // a candidate at all. Returning it and letting the caller bail meant a
  // usable run could be passed over for an unusable one.
  it("treats a run with no tenant as no candidate rather than the answer", () => {
    const blank = { id: "run-blank", tenant_host: null };
    expect(pickVerificationRun([blank], fromSender("myworkday.com"))).toEqual({
      run: null,
      ambiguous: false
    });
    // And the usable one still wins when it is the only real candidate.
    expect(pickVerificationRun([blank, acme], fromSender("myworkday.com")).run).toBe(acme);
  });

  // A code-only mail comes from a generic sender that can never equal a
  // tenant host. Treating that as "matches nothing" would strand every parked
  // run, which is worse than the wrong-tenant bug it was meant to prevent.
  it("falls back to the newest run when the mail names no tenant", () => {
    expect(pickVerificationRun([acme, globex], fromSender("myworkday.com")).run).toBe(acme);
    expect(pickVerificationRun([acme, globex], fromSender(null)).run).toBe(acme);
  });

  it("refuses to guess when a link names a tenant it cannot pin down", () => {
    expect(pickVerificationRun([acme, globex], fromLink("unrelated.example.com"))).toEqual({
      run: null,
      ambiguous: true
    });
  });

  it("refuses to guess when several runs share the named tenant", () => {
    const dupe = { id: "run-dupe", tenant_host: "acme.wd1.myworkdayjobs.com" };
    expect(pickVerificationRun([acme, dupe], fromLink("acme.wd1.myworkdayjobs.com"))).toEqual({
      run: null,
      ambiguous: true
    });
  });
});
