import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  APPLICANT_EMAIL_DOMAIN,
  domainMatches,
  domainOf,
  ensureApplicantAlias,
  extractVerification,
  generateApplicantAlias,
  isApplicantAlias,
  isAtsAccountSender
} from "@/lib/applicant-email";

describe("generateApplicantAlias", () => {
  it("builds an a-prefixed alias on the platform domain", () => {
    const alias = generateApplicantAlias();
    expect(alias).toMatch(/^a-[abcdefghjkmnpqrstuvwxyz23456789]{10}@jobarms\.com$/);
    expect(alias.endsWith(`@${APPLICANT_EMAIL_DOMAIN}`)).toBe(true);
  });

  it("omits ambiguous glyphs so an alias survives being read aloud", () => {
    const locals = Array.from({ length: 50 }, () => generateApplicantAlias().split("@")[0]);
    for (const local of locals) {
      expect(local.slice(2)).not.toMatch(/[ilo01]/);
    }
  });

  it("does not repeat itself across calls", () => {
    const many = new Set(Array.from({ length: 200 }, generateApplicantAlias));
    expect(many.size).toBe(200);
  });

  it("round-trips through the recognizer", () => {
    expect(isApplicantAlias(generateApplicantAlias())).toBe(true);
  });

  it("rejects out-of-range bytes instead of taking a biased modulo", async () => {
    // 31 letters, so the unbiased ceiling is 248: a byte at or above it must be
    // discarded and redrawn rather than folded in with %, which would make the
    // early letters likelier. Feed 255 (rejected) then 0 (accepted, 'a').
    const bytes = [255, 0, 255, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    let i = 0;
    vi.doMock("node:crypto", () => ({
      randomBytes: () => Uint8Array.of(bytes[i++] ?? 0)
    }));
    vi.resetModules();
    const { generateApplicantAlias: gen } = await import("@/lib/applicant-email");

    // Both 255s were skipped, so the alias starts at byte 0 -> 'a', then 1 -> 'b'.
    expect(gen()).toBe("a-abcdefghjk@jobarms.com");
    vi.doUnmock("node:crypto");
    vi.resetModules();
  });
});

describe("isApplicantAlias", () => {
  it("accepts a well-formed alias regardless of case or padding", () => {
    expect(isApplicantAlias("  A-ABCDEFGHJK@JobArms.com ")).toBe(true);
  });

  it("rejects platform addresses, other domains, and bad shapes", () => {
    expect(isApplicantAlias("hello@jobarms.com")).toBe(false);
    expect(isApplicantAlias("a-abcdefghjk@evil.com")).toBe(false);
    expect(isApplicantAlias("a-short@jobarms.com")).toBe(false);
    expect(isApplicantAlias("b-abcdefghjk@jobarms.com")).toBe(false);
    expect(isApplicantAlias("no-at-sign")).toBe(false);
  });
});

describe("domainOf", () => {
  it("lowercases, trims, and uses the last @", () => {
    expect(domainOf(' "a@b"@Example.COM ')).toBe("example.com");
  });

  it("returns empty when there is no @", () => {
    expect(domainOf("bare")).toBe("");
  });
});

describe("domainMatches", () => {
  it("matches the domain itself and any subdomain", () => {
    expect(domainMatches("myworkday.com", ["myworkday.com"])).toBe(true);
    expect(domainMatches("notification.myworkday.com", ["myworkday.com"])).toBe(true);
  });

  it("does not match a lookalike suffix", () => {
    expect(domainMatches("evilmyworkday.com", ["myworkday.com"])).toBe(false);
    expect(domainMatches("myworkday.com.evil.com", ["myworkday.com"])).toBe(false);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(domainMatches(" MyWorkday.COM ", ["myworkday.com"])).toBe(true);
  });
});

describe("isAtsAccountSender", () => {
  it("accepts known ATS senders including subdomains", () => {
    expect(isAtsAccountSender("no-reply@myworkday.com")).toBe(true);
    expect(isAtsAccountSender("noreply@notification.myworkdayjobs.com")).toBe(true);
    expect(isAtsAccountSender("x@greenhouse.io")).toBe(true);
  });

  it("rejects everything else, including near-misses", () => {
    expect(isAtsAccountSender("recruiter@acme.com")).toBe(false);
    expect(isAtsAccountSender("phish@myworkday.com.evil.net")).toBe(false);
    expect(isAtsAccountSender("garbage")).toBe(false);
  });
});

describe("extractVerification", () => {
  it("finds a verification link by keyword", () => {
    const { link } = extractVerification(
      "Confirm here: https://acme.wd1.myworkdayjobs.com/verify?token=abc123"
    );
    expect(link).toBe("https://acme.wd1.myworkdayjobs.com/verify?token=abc123");
  });

  it("looks in the HTML part too", () => {
    const { link } = extractVerification("", '<a href="https://x.com/activate/9">go</a>');
    expect(link).toBe("https://x.com/activate/9");
  });

  it("skips unsubscribe and privacy links that share the domain", () => {
    const { link } = extractVerification(
      [
        "https://acme.com/unsubscribe?verify=1",
        "https://acme.com/privacy-confirm",
        "https://acme.com/confirm-account/7"
      ].join("\n")
    );
    expect(link).toBe("https://acme.com/confirm-account/7");
  });

  it("ignores links with no verification keyword", () => {
    expect(extractVerification("See https://acme.com/careers/123").link).toBeNull();
  });

  it("strips trailing sentence punctuation from a URL", () => {
    const { link } = extractVerification("Go to https://acme.com/verify/9.");
    expect(link).toBe("https://acme.com/verify/9");
  });

  it("stops a URL at quotes and angle brackets in markup", () => {
    const { link } = extractVerification("", '<a href="https://acme.com/verify/1">x</a>');
    expect(link).toBe("https://acme.com/verify/1");
  });

  it("finds a code that follows a cue word", () => {
    expect(extractVerification("Your code is 483920").code).toBe("483920");
    expect(extractVerification("One-time passcode: 1234").code).toBe("1234");
  });

  it("finds a code that precedes a cue word", () => {
    expect(extractVerification("483920 is your verification code").code).toBe("483920");
  });

  it("ignores digit runs with no cue word nearby", () => {
    expect(extractVerification("Req 12345 in Austin TX 78701").code).toBeNull();
  });

  it("ignores digit runs of the wrong length", () => {
    expect(extractVerification("Your code is 12").code).toBeNull();
    expect(extractVerification("Your code is 1234567890").code).toBeNull();
  });

  it("prefers the text part for codes so HTML attributes cannot masquerade", () => {
    const { code } = extractVerification(
      "Your code is 246810",
      '<td style="width:135791px">code 999999</td>'
    );
    expect(code).toBe("246810");
  });

  it("falls back to HTML for a code when there is no text part", () => {
    expect(extractVerification("", "<p>Your code is 314159</p>").code).toBe("314159");
  });

  it("returns nulls for an empty message", () => {
    expect(extractVerification("")).toEqual({ link: null, code: null });
  });

  it("can find both a link and a code", () => {
    const v = extractVerification("Code 778899 or visit https://acme.com/verify/5");
    expect(v).toEqual({ link: "https://acme.com/verify/5", code: "778899" });
  });
});

describe("ensureApplicantAlias", () => {
  /**
   * A client whose `claim_applicant_alias` RPC returns `results` in order. The
   * arg type is declared so assertions can read `p_candidate` without a cast.
   */
  function service(results: unknown[]) {
    const rpc = vi.fn(
      async (_name: string, _args: { p_user_id: string; p_candidate: string }) => ({
        data: results.shift() ?? null,
        error: null
      })
    );
    return { client: { rpc } as unknown as SupabaseClient, rpc };
  }

  it("returns the alias the RPC claimed", async () => {
    const { client, rpc } = service(["a-abcdefghjk@jobarms.com"]);
    expect(await ensureApplicantAlias(client, "u1")).toBe("a-abcdefghjk@jobarms.com");
    expect(rpc).toHaveBeenCalledWith("claim_applicant_alias", {
      p_user_id: "u1",
      p_candidate: expect.stringMatching(/@jobarms\.com$/)
    });
  });

  it("retries with a fresh candidate when one collides", async () => {
    const { client, rpc } = service([null, null, "a-mnpqrstuvw@jobarms.com"]);
    expect(await ensureApplicantAlias(client, "u1")).toBe("a-mnpqrstuvw@jobarms.com");
    expect(rpc).toHaveBeenCalledTimes(3);
    // Each attempt must offer a DIFFERENT candidate, else the retry is pointless.
    const offered = rpc.mock.calls.map((c) => c[1].p_candidate);
    expect(new Set(offered).size).toBe(3);
  });

  it("gives up after the attempt budget rather than inventing an alias", async () => {
    const { client, rpc } = service([]);
    expect(await ensureApplicantAlias(client, "u1")).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(5);
  });

  it("treats a non-string RPC result as a failure", async () => {
    const { client } = service([{ unexpected: true }, "", 42]);
    expect(await ensureApplicantAlias(client, "u1")).toBeNull();
  });
});
