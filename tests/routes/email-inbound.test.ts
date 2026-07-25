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
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceClient: vi.fn(() => holder.service)
}));
vi.mock("@/lib/email", () => ({ forwardInboundEmail }));

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
function serviceWith(over: { profile?: unknown; insert?: unknown } = {}) {
  return fakeClient({
    from: fakeFrom({
      profiles: [{ data: "profile" in over ? over.profile : { id: "u1", email: "user@gmail.com" } }],
      inbound_emails: [
        "insert" in over ? (over.insert as { data: unknown }) : { data: { id: "ie-1" } },
        { data: null }
      ]
    })
  });
}

beforeEach(() => {
  process.env.EMAIL_INBOUND_SECRET = SECRET;
  holder.service = null;
  forwardInboundEmail.mockClear();
  forwardInboundEmail.mockResolvedValue(true);
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
    expect(await res.json()).toEqual({ ok: true, forwarded: true, verification: true });

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
      subject: "Verify your account",
      text: payload().text
    });
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
