import { describe, expect, it } from "vitest";
import {
  ACCOUNT_REQUIRED_ATS,
  detectAts,
  normalizeJobUrl,
  parseWorkdayUrl,
  SUPPORTED_ATS,
  tenantHostOf
} from "@/lib/ats";

describe("detectAts", () => {
  it("detects every known ATS by hostname", () => {
    expect(detectAts("https://boards.greenhouse.io/acme/jobs/123")).toBe("greenhouse");
    expect(detectAts("https://job-boards.greenhouse.io/acme/jobs/456")).toBe("greenhouse");
    expect(detectAts("https://jobs.lever.co/acme/uuid-here")).toBe("lever");
    expect(detectAts("https://jobs.ashbyhq.com/acme/uuid")).toBe("ashby");
    expect(detectAts("https://apply.workable.com/acme/j/ABC123/")).toBe("workable");
    expect(detectAts("https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/x_JR1")).toBe("workday");
    expect(detectAts("https://acme.wd5.myworkdaysite.com/Careers/job/x_JR1")).toBe("workday");
  });

  it("matches a bare apex domain as well as a subdomain", () => {
    expect(detectAts("https://greenhouse.io/acme/jobs/1")).toBe("greenhouse");
  });

  it("does NOT match a lookalike host that merely ends with the suffix", () => {
    // A bare endsWith() would route these into a real adapter, and for Workday
    // into the account-creation path, on an attacker-chosen page.
    expect(detectAts("https://evilgreenhouse.io/acme/jobs/1")).toBe("unknown");
    expect(detectAts("https://notmyworkdayjobs.com/x/job/y")).toBe("unknown");
    expect(detectAts("https://myworkdayjobs.com.evil.net/x/job/y")).toBe("unknown");
  });

  it("company career pages are unknown", () => {
    expect(detectAts("https://careers.acme.com/jobs/123")).toBe("unknown");
  });

  it("garbage input is unknown", () => {
    expect(detectAts("not a url")).toBe("unknown");
  });

  it("supports greenhouse, lever, and workday", () => {
    expect(SUPPORTED_ATS.has("greenhouse")).toBe(true);
    expect(SUPPORTED_ATS.has("lever")).toBe(true);
    expect(SUPPORTED_ATS.has("workday")).toBe(true);
    expect(SUPPORTED_ATS.has("ashby")).toBe(false);
    expect(SUPPORTED_ATS.has("unknown")).toBe(false);
  });

  it("marks only workday as needing an account per employer tenant", () => {
    expect(ACCOUNT_REQUIRED_ATS.has("workday")).toBe(true);
    expect(ACCOUNT_REQUIRED_ATS.has("greenhouse")).toBe(false);
    expect(ACCOUNT_REQUIRED_ATS.has("lever")).toBe(false);
  });
});

describe("parseWorkdayUrl", () => {
  const parse = (raw: string) => parseWorkdayUrl(new URL(raw));

  it("parses the locale + site + job form", () => {
    expect(
      parse(
        "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Engineer_JR123"
      )
    ).toEqual({
      tenant: "nvidia",
      site: "NVIDIAExternalCareerSite",
      externalPath: "/US-CA-Santa-Clara/Engineer_JR123",
      host: "nvidia.wd5.myworkdayjobs.com"
    });
  });

  it("parses the form with no locale segment", () => {
    expect(parse("https://acme.wd1.myworkdayjobs.com/Careers/job/Remote/Engineer_JR9")).toEqual({
      tenant: "acme",
      site: "Careers",
      externalPath: "/Remote/Engineer_JR9",
      host: "acme.wd1.myworkdayjobs.com"
    });
  });

  it("accepts the /details/ variant some sites use", () => {
    expect(parse("https://acme.wd1.myworkdayjobs.com/en-US/Careers/details/Engineer_JR9")?.externalPath).toBe(
      "/Engineer_JR9"
    );
  });

  it("rejects a listing page with no job segment", () => {
    expect(parse("https://acme.wd1.myworkdayjobs.com/en-US/Careers")).toBeNull();
  });

  it("rejects a job segment with nothing after it", () => {
    expect(parse("https://acme.wd1.myworkdayjobs.com/en-US/Careers/job")).toBeNull();
  });

  it("rejects a URL whose site segment is really a locale", () => {
    // /en-US/job/... has no site id, so the CXS path could not be built.
    expect(parse("https://acme.wd1.myworkdayjobs.com/en-US/job/Engineer_JR9")).toBeNull();
  });

  it("rejects a job segment at the very start of the path", () => {
    expect(parse("https://acme.wd1.myworkdayjobs.com/job/Engineer_JR9")).toBeNull();
  });
});

describe("tenantHostOf", () => {
  it("lowercases the host", () => {
    expect(tenantHostOf("https://ACME.WD1.myworkdayjobs.com/en-US/Careers/job/x_JR1")).toBe(
      "acme.wd1.myworkdayjobs.com"
    );
  });

  it("returns null for an unparseable URL", () => {
    expect(tenantHostOf("nope")).toBeNull();
  });
});

describe("normalizeJobUrl", () => {
  it("strips tracking params and fragments", () => {
    expect(
      normalizeJobUrl("https://jobs.lever.co/acme/123?utm_source=x&ref=tw#apply")
    ).toBe("https://jobs.lever.co/acme/123");
  });

  it("keeps gh_jid (embedded greenhouse boards)", () => {
    expect(
      normalizeJobUrl("https://acme.com/careers?gh_jid=999&utm_campaign=y")
    ).toBe("https://acme.com/careers?gh_jid=999");
  });

  it("rejects non-http(s) and invalid urls", () => {
    expect(normalizeJobUrl("ftp://example.com/job")).toBeNull();
    expect(normalizeJobUrl("nope")).toBeNull();
  });
});
