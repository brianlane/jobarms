import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const parseMock = vi.fn();
vi.mock("postal-mime", () => ({
  default: { parse: (...args: unknown[]) => parseMock(...args) }
}));

import worker, { type Env, type ForwardableEmailMessage } from "../src/index";

const ALIAS = "a-abcdefghjk@jobarms.com";

const env: Env = {
  APP_INBOUND_URL: "https://jobarms.com/api/email/inbound",
  PLATFORM_EMAIL_DOMAIN: "jobarms.com",
  FALLBACK_FORWARD_TO: "jobarmsteam@gmail.com",
  EMAIL_INBOUND_SECRET: "inbound-secret"
};

function message(over: Partial<ForwardableEmailMessage> = {}): ForwardableEmailMessage {
  return {
    from: "recruiter@acme.com",
    to: ALIAS,
    headers: new Headers({ "message-id": "<m-1@acme.com>" }),
    raw: undefined as unknown as ReadableStream<Uint8Array>,
    forward: vi.fn(async () => {}),
    ...over
  };
}

/** The JSON body the worker POSTed to the webhook. */
function postedBody(fetchMock: ReturnType<typeof vi.fn>) {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

beforeEach(() => {
  parseMock.mockReset();
  parseMock.mockResolvedValue({
    text: "Please verify your account.",
    html: "<p>Please verify your account.</p>",
    subject: "Verify your account",
    from: { address: "no-reply@myworkday.com" },
    messageId: "<parsed@myworkday.com>"
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("loop guard", () => {
  it("drops mail from the platform domain without parsing or forwarding", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const msg = message({ from: "hello@jobarms.com" });

    await worker.email(msg, env);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(msg.forward).not.toHaveBeenCalled();
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("falls back to jobarms.com when PLATFORM_EMAIL_DOMAIN is unset", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const msg = message({ from: "bounce@jobarms.com" });

    await worker.email(msg, { ...env, PLATFORM_EMAIL_DOMAIN: "" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(msg.forward).not.toHaveBeenCalled();
  });
});

describe("non-alias catch-all mail", () => {
  it("forwards to the fallback destination and never calls the webhook", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const msg = message({ to: "someone@jobarms.com" });

    await worker.email(msg, env);

    expect(msg.forward).toHaveBeenCalledWith("jobarmsteam@gmail.com");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops it when no fallback is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const msg = message({ to: "someone@jobarms.com" });

    await worker.email(msg, { ...env, FALLBACK_FORWARD_TO: "" });

    expect(msg.forward).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("managed alias mail", () => {
  it("posts the parsed message with the bearer and envelope recipient", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await worker.email(message(), env);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(env.APP_INBOUND_URL);
    expect(init.headers.authorization).toBe("Bearer inbound-secret");
    expect(postedBody(fetchMock)).toMatchObject({
      to: ALIAS,
      from: "no-reply@myworkday.com",
      subject: "Verify your account",
      text: "Please verify your account.",
      html: "<p>Please verify your account.</p>",
      messageId: "<m-1@acme.com>"
    });
  });

  it("prefers the envelope From when the MIME carries no address", async () => {
    parseMock.mockResolvedValue({ text: "hi", subject: "s", from: null });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await worker.email(message(), env);

    expect(postedBody(fetchMock).from).toBe("recruiter@acme.com");
    expect(postedBody(fetchMock).fromName).toBe("");
  });

  it("relays the sender's own name, which the forward uses instead of a domain", async () => {
    parseMock.mockResolvedValue({
      text: "hi",
      subject: "s",
      from: { address: "r@acme.com", name: "Dana Recruiter" }
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await worker.email(message(), env);

    expect(postedBody(fetchMock).fromName).toBe("Dana Recruiter");
  });

  it("defaults a missing subject to empty", async () => {
    parseMock.mockResolvedValue({ text: "hi", from: { address: "r@acme.com" } });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await worker.email(message(), env);

    expect(postedBody(fetchMock).subject).toBe("");
  });

  it("derives text from HTML when there is no text part", async () => {
    parseMock.mockResolvedValue({
      html: '<a href="https://acme.wd1.myworkdayjobs.com/verify?t=1">Verify</a>',
      subject: "s",
      from: { address: "no-reply@myworkday.com" }
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await worker.email(message(), env);

    expect(postedBody(fetchMock).text).toBe(
      "Verify (https://acme.wd1.myworkdayjobs.com/verify?t=1)"
    );
  });

  it("re-derives text when the text part is flattened template source", async () => {
    parseMock.mockResolvedValue({
      text: "a{color:red;} b{width:1px;} c{margin:0;}",
      html: "<p>Your code is 123456</p>",
      subject: "s",
      from: { address: "no-reply@myworkday.com" }
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await worker.email(message(), env);

    expect(postedBody(fetchMock).text).toBe("Your code is 123456");
  });

  it("keeps the flattened-looking text when there is no HTML alternative", async () => {
    parseMock.mockResolvedValue({
      text: "a{color:red;} b{width:1px;} c{margin:0;}",
      subject: "s",
      from: { address: "r@acme.com" }
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await worker.email(message(), env);

    expect(postedBody(fetchMock).text).toBe("a{color:red;} b{width:1px;} c{margin:0;}");
  });

  it("falls back to the plain text when the HTML collapses to nothing", async () => {
    parseMock.mockResolvedValue({
      text: "*|MERGE|*",
      html: "<style>.a{color:red;}</style>",
      subject: "s",
      from: { address: "r@acme.com" }
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await worker.email(message(), env);

    expect(postedBody(fetchMock).text).toBe("*|MERGE|*");
  });

  it("sends an empty text body when the message has neither part", async () => {
    parseMock.mockResolvedValue({ subject: "s", from: { address: "r@acme.com" } });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await worker.email(message(), env);

    expect(postedBody(fetchMock).text).toBe("");
  });

  it("drops an over-long HTML body but still sends the text", async () => {
    parseMock.mockResolvedValue({
      text: "short text",
      html: `<p>${"x".repeat(500_001)}</p>`,
      subject: "s",
      from: { address: "r@acme.com" }
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await worker.email(message(), env);

    const body = postedBody(fetchMock);
    expect(body.html).toBeUndefined();
    expect(body.text).toBe("short text");
  });

  it("clips an over-long text body rather than dropping it", async () => {
    parseMock.mockResolvedValue({
      text: "y".repeat(900_050),
      subject: "s",
      from: { address: "r@acme.com" }
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await worker.email(message(), env);

    expect(postedBody(fetchMock).text).toHaveLength(900_000);
  });

  it("uses the parsed messageId when the header is absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await worker.email(message({ headers: new Headers() }), env);

    expect(postedBody(fetchMock).messageId).toBe("<parsed@myworkday.com>");
  });

  it("synthesizes a messageId when neither source has one", async () => {
    parseMock.mockResolvedValue({ text: "hi", subject: "s", from: { address: "r@acme.com" } });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await worker.email(message({ headers: new Headers() }), env);

    expect(postedBody(fetchMock).messageId).toMatch(/^cf-\d+-/);
  });

  it("throws on a non-2xx webhook so the sender retries", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502 }));

    await expect(worker.email(message(), env)).rejects.toThrow(
      "inbound webhook returned 502"
    );
  });
});
