import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, fakeFrom } from "../helpers/supabase";

const holder = vi.hoisted(() => ({ service: null as unknown }));
/** Args declared so assertions can read the forward payload without a cast. */
const forwardInboundEmail = vi.hoisted(() =>
  vi.fn(
    async (_args: {
      to: string;
      alias: string;
      fromAddress: string;
      subject: string;
      text: string;
      html?: string;
    }) => true
  )
);
const completeRenderVerification = vi.hoisted(() =>
  vi.fn(
    async (_args: { userId: string; tenantHost: string; link?: string | null; code?: string | null }) =>
      ({ ok: true, data: { status: "authenticated" } }) as
        | { ok: true; data: { status: string } }
        | { ok: false; error: string }
  )
);
const markSiteAccountVerified = vi.hoisted(() => vi.fn(async () => true));
const resumeAccountVerification = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: string })
);

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceClient: vi.fn(() => holder.service)
}));
vi.mock("@/lib/email", () => ({ forwardInboundEmail }));
vi.mock("@/lib/render", () => ({ completeRenderVerification }));
vi.mock("@/lib/site-accounts", () => ({ markSiteAccountVerified }));
vi.mock("@/lib/arm", () => ({ resumeAccountVerification }));

import { POST } from "@/app/api/email/inbound/route";

const SECRET = "inbound-secret";
const ALIAS = "a-abcdefghjk@jobarms.com";

function post(body: unknown, auth: string | null = `Bearer ${SECRET}`) {
  return new Request("http://x/api/email/inbound", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

const payload = (over: Record<string, unknown> = {}) => ({
  to: ALIAS,
  from: "no-reply@myworkday.com",
  subject: "Verify your account",
  text: "Visit https://acme.wd1.myworkdayjobs.com/verify?token=t1 to continue.",
  messageId: "<m-1@myworkday.com>",
  ...over
});

/**
 * A service client whose profile lookup resolves and whose insert succeeds.
 * `profile` and `insert` are read with `in` so an explicit null (alias nobody
 * owns / duplicate delivery) is honored instead of falling back to the default.
 */
function serviceWith(
  over: { profile?: unknown; insert?: unknown; pendingRun?: unknown } = {}
) {
  return fakeClient({
    from: fakeFrom({
      profiles: [{ data: "profile" in over ? over.profile : { id: "u1", email: "user@gmail.com" } }],
      inbound_emails: [
        "insert" in over ? (over.insert as { data: unknown }) : { data: { id: "ie-1" } },
        { data: null }
      ],
      application_runs: [
        {
          data:
            "pendingRun" in over
              ? over.pendingRun
              : { id: "run-1", tenant_host: "acme.wd1.myworkdayjobs.com" }
        }
      ]
    })
  });
}

beforeEach(() => {
  process.env.EMAIL_INBOUND_SECRET = SECRET;
  holder.service = null;
  forwardInboundEmail.mockClear();
  forwardInboundEmail.mockResolvedValue(true);
  completeRenderVerification.mockClear();
  completeRenderVerification.mockResolvedValue({ ok: true, data: { status: "authenticated" } });
  markSiteAccountVerified.mockClear();
  markSiteAccountVerified.mockResolvedValue(true);
  resumeAccountVerification.mockClear();
  resumeAccountVerification.mockResolvedValue({ ok: true });
});

describe("auth", () => {
  it("401 without the shared bearer", async () => {
    expect((await POST(post(payload(), null))).status).toBe(401);
  });

  it("401 with the wrong bearer", async () => {
    expect((await POST(post(payload(), "Bearer nope"))).status).toBe(401);
  });

  it("throws when the secret is not configured, rather than accepting anything", async () => {
    delete process.env.EMAIL_INBOUND_SECRET;
    await expect(POST(post(payload()))).rejects.toThrow(/EMAIL_INBOUND_SECRET/);
  });
});

describe("body validation", () => {
  it("400 on a malformed body", async () => {
    expect((await POST(post({ to: ALIAS }))).status).toBe(400);
  });

  it("400 when the body is not JSON at all", async () => {
    expect((await POST(post(undefined))).status).toBe(400);
  });
});

describe("messages we accept but do not process", () => {
  it("drops mail from our own domain (loop guard)", async () => {
    const res = await POST(post(payload({ from: "hello@jobarms.com" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: "own_domain" });
    expect(forwardInboundEmail).not.toHaveBeenCalled();
  });

  it("drops mail to an alias nobody owns", async () => {
    holder.service = serviceWith({ profile: null });
    const res = await POST(post(payload()));
    expect(await res.json()).toEqual({ ok: true, skipped: "unknown_alias" });
    expect(forwardInboundEmail).not.toHaveBeenCalled();
  });

  it("does not forward a duplicate delivery twice", async () => {
    holder.service = serviceWith({ insert: { data: null, error: { code: "23505" } } });
    const res = await POST(post(payload()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: "duplicate" });
    expect(forwardInboundEmail).not.toHaveBeenCalled();
  });
});

describe("logging, extraction, and forwarding", () => {
  it("stores the message, extracts the verification link, and forwards it", async () => {
    const service = serviceWith();
    holder.service = service;

    const res = await POST(post(payload()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      forwarded: true,
      verification: true,
      consumed: "verified"
    });

    const insertArg = service.from.mock.results
      .map((r) => r.value)
      .find((q) => q.insert.mock.calls.length)!.insert.mock.calls[0][0];
    expect(insertArg).toMatchObject({
      user_id: "u1",
      alias: ALIAS,
      from_address: "no-reply@myworkday.com",
      from_domain: "myworkday.com",
      message_id: "<m-1@myworkday.com>",
      verification_link: "https://acme.wd1.myworkdayjobs.com/verify?token=t1"
    });

    expect(forwardInboundEmail).toHaveBeenCalledWith({
      to: "user@gmail.com",
      alias: ALIAS,
      fromAddress: "no-reply@myworkday.com",
      fromName: "",
      subject: "Verify your account",
      text: payload().text
    });
  });

  it("relays the sender's own name so the forward can identify them", async () => {
    holder.service = serviceWith();
    await POST(post({ ...payload(), fromName: "Workday Recruiting" }));

    expect(forwardInboundEmail).toHaveBeenCalledWith(
      expect.objectContaining({ fromName: "Workday Recruiting" })
    );
  });

  it("passes the HTML alternative through to the forward", async () => {
    holder.service = serviceWith();
    await POST(post(payload({ html: "<p>hi</p>" })));
    expect(forwardInboundEmail.mock.calls[0][0]).toMatchObject({ html: "<p>hi</p>" });
  });

  it("extracts a one-time code when the mail carries no link", async () => {
    const service = serviceWith();
    holder.service = service;

    await POST(post(payload({ text: "Your verification code is 483920" })));

    const insertArg = service.from.mock.results
      .map((r) => r.value)
      .find((q) => q.insert.mock.calls.length)!.insert.mock.calls[0][0];
    expect(insertArg.verification_code).toBe("483920");
    expect(insertArg.verification_link).toBeNull();
  });

  it("never extracts from a sender that is not a known ATS", async () => {
    const service = serviceWith();
    holder.service = service;

    // Same verification-shaped content, untrusted sender: logged and forwarded,
    // but nothing the arm could ever be told to click.
    const res = await POST(
      post(payload({ from: "phish@evil.com", text: "verify: https://evil.com/verify/1 code 111111" }))
    );

    expect(await res.json()).toMatchObject({ verification: false });
    const insertArg = service.from.mock.results
      .map((r) => r.value)
      .find((q) => q.insert.mock.calls.length)!.insert.mock.calls[0][0];
    expect(insertArg.verification_link).toBeNull();
    expect(insertArg.verification_code).toBeNull();
    expect(forwardInboundEmail).toHaveBeenCalled();
  });

  it("normalizes alias and sender casing before routing", async () => {
    const service = serviceWith();
    holder.service = service;

    await POST(post(payload({ to: " A-ABCDEFGHJK@JobArms.com ", from: "NO-REPLY@MyWorkday.com" })));

    const insertArg = service.from.mock.results
      .map((r) => r.value)
      .find((q) => q.insert.mock.calls.length)!.insert.mock.calls[0][0];
    expect(insertArg.alias).toBe(ALIAS);
    expect(insertArg.from_address).toBe("no-reply@myworkday.com");
  });

  it("reports a failed forward without losing the stored message", async () => {
    forwardInboundEmail.mockResolvedValueOnce(false);
    holder.service = serviceWith();

    const res = await POST(post(payload()));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, forwarded: false });
  });
});

describe("consuming an account verification", () => {
  it("completes it in the held session and resumes the parked run", async () => {
    holder.service = serviceWith();

    const res = await POST(post(payload()));

    expect(await res.json()).toMatchObject({ consumed: "verified" });
    expect(completeRenderVerification).toHaveBeenCalledWith({
      userId: "u1",
      tenantHost: "acme.wd1.myworkdayjobs.com",
      link: "https://acme.wd1.myworkdayjobs.com/verify?token=t1",
      code: null
    });
    expect(markSiteAccountVerified).toHaveBeenCalledWith(
      expect.anything(),
      "u1",
      "acme.wd1.myworkdayjobs.com"
    );
    expect(resumeAccountVerification).toHaveBeenCalledWith("run-1");
  });

  it("forwards the mail BEFORE touching the browser, so an outage cannot cost it", async () => {
    const order: string[] = [];
    forwardInboundEmail.mockImplementationOnce(async () => {
      order.push("forward");
      return true;
    });
    completeRenderVerification.mockImplementationOnce(async () => {
      order.push("verify");
      return { ok: true, data: { status: "authenticated" } };
    });
    holder.service = serviceWith();

    await POST(post(payload()));

    expect(order).toEqual(["forward", "verify"]);
  });

  it("does nothing when no run is waiting on a verification", async () => {
    holder.service = serviceWith({ pendingRun: null });
    const res = await POST(post(payload()));
    expect(await res.json()).toMatchObject({ consumed: "no_pending_run" });
    expect(completeRenderVerification).not.toHaveBeenCalled();
  });

  it("does nothing when the waiting run has no tenant recorded", async () => {
    holder.service = serviceWith({ pendingRun: { id: "run-1", tenant_host: null } });
    const res = await POST(post(payload()));
    expect(await res.json()).toMatchObject({ consumed: "no_pending_run" });
  });

  it("leaves the run parked when the tenant rejects the verification", async () => {
    completeRenderVerification.mockResolvedValueOnce({
      ok: true,
      data: { status: "needs_email_verification" }
    });
    holder.service = serviceWith();

    const res = await POST(post(payload()));

    expect(await res.json()).toMatchObject({ consumed: "failed" });
    // Another mail may still arrive, so nothing is marked verified or resumed.
    expect(markSiteAccountVerified).not.toHaveBeenCalled();
    expect(resumeAccountVerification).not.toHaveBeenCalled();
  });

  it("reports a sidecar outage without failing the delivery", async () => {
    completeRenderVerification.mockResolvedValueOnce({ ok: false, error: "render_unreachable" });
    holder.service = serviceWith();

    const res = await POST(post(payload()));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, forwarded: true, consumed: "sidecar_error" });
  });

  it("reports a failure to resume rather than marking the run done", async () => {
    resumeAccountVerification.mockResolvedValueOnce({ ok: false, reason: "arm_offline" });
    holder.service = serviceWith();
    const res = await POST(post(payload()));
    expect(await res.json()).toMatchObject({ consumed: "sidecar_error" });
  });

  it("swallows an unexpected error during consumption", async () => {
    completeRenderVerification.mockRejectedValueOnce(new Error("boom"));
    holder.service = serviceWith();
    const res = await POST(post(payload()));
    expect(await res.json()).toMatchObject({ ok: true, consumed: "sidecar_error" });
  });

  it("does not consume anything when the mail carried no verification", async () => {
    holder.service = serviceWith();
    const res = await POST(post(payload({ from: "recruiter@acme.com", text: "Hello there" })));
    expect(await res.json()).toMatchObject({ consumed: "none" });
    expect(completeRenderVerification).not.toHaveBeenCalled();
  });
});
