import { describe, expect, it } from "vitest";
import { detectAts, normalizeJobUrl, SUPPORTED_ATS } from "@/lib/ats";

describe("detectAts", () => {
  it("detects the four known ATSes by hostname", () => {
    expect(detectAts("https://boards.greenhouse.io/acme/jobs/123")).toBe("greenhouse");
    expect(detectAts("https://job-boards.greenhouse.io/acme/jobs/456")).toBe("greenhouse");
    expect(detectAts("https://jobs.lever.co/acme/uuid-here")).toBe("lever");
    expect(detectAts("https://jobs.ashbyhq.com/acme/uuid")).toBe("ashby");
    expect(detectAts("https://apply.workable.com/acme/j/ABC123/")).toBe("workable");
  });

  it("company career pages are unknown", () => {
    expect(detectAts("https://careers.acme.com/jobs/123")).toBe("unknown");
  });

  it("garbage input is unknown", () => {
    expect(detectAts("not a url")).toBe("unknown");
  });

  it("v1 supports greenhouse + lever only", () => {
    expect(SUPPORTED_ATS.has("greenhouse")).toBe(true);
    expect(SUPPORTED_ATS.has("lever")).toBe(true);
    expect(SUPPORTED_ATS.has("ashby")).toBe(false);
    expect(SUPPORTED_ATS.has("unknown")).toBe(false);
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
