import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
  }
}));

/** What the SDK really resolves with. It does NOT throw on a rejected send. */
const acceptedBy = (id: string) => ({ data: { id }, error: null });
const rejectedWith = (name: string, message: string) => ({
  data: null,
  error: { name, message }
});

describe("sendWelcomeEmail", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.RESEND_API_KEY = "re_test";
  });
  afterEach(() => {
    delete process.env.RESEND_API_KEY;
  });

  it("no-ops (returns false) when RESEND_API_KEY is unset", async () => {
    delete process.env.RESEND_API_KEY;
    const { sendWelcomeEmail } = await import("@/lib/email");
    expect(await sendWelcomeEmail("a@b.com", "Bri")).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("no-ops when there is no recipient", async () => {
    const { sendWelcomeEmail } = await import("@/lib/email");
    expect(await sendWelcomeEmail("", "Bri")).toBe(false);
  });

  it("sends and returns true, greeting by first name when present", async () => {
    sendMock.mockResolvedValueOnce(acceptedBy("e_1"));
    const { sendWelcomeEmail } = await import("@/lib/email");
    expect(await sendWelcomeEmail("a@b.com", "Bri")).toBe(true);
    const arg = sendMock.mock.calls[0][0];
    expect(arg.to).toBe("a@b.com");
    expect(arg.text).toContain("Hi Bri,");
  });

  it("greets without a name when firstName is empty", async () => {
    sendMock.mockResolvedValueOnce(acceptedBy("e_2"));
    const { sendWelcomeEmail } = await import("@/lib/email");
    expect(await sendWelcomeEmail("a@b.com", "")).toBe(true);
    expect(sendMock.mock.calls[0][0].text).toContain("Hi,");
  });

  it("returns false when the provider throws", async () => {
    sendMock.mockRejectedValueOnce(new Error("smtp down"));
    const { sendWelcomeEmail } = await import("@/lib/email");
    expect(await sendWelcomeEmail("a@b.com", "Bri")).toBe(false);
  });

  it("returns false when the provider REJECTS without throwing", async () => {
    sendMock.mockResolvedValueOnce(
      rejectedWith("daily_quota_exceeded", "You have reached your daily sending quota")
    );
    const { sendWelcomeEmail } = await import("@/lib/email");
    expect(await sendWelcomeEmail("a@b.com", "Bri")).toBe(false);
  });
});

describe("forwardInboundEmail", () => {
  const base = {
    to: "user@gmail.com",
    alias: "a-abcdefghjk@jobarms.com",
    fromAddress: "recruiter@acme.com",
    subject: "About your application",
    text: "Hello there"
  };

  beforeEach(() => {
    sendMock.mockReset();
    process.env.RESEND_API_KEY = "re_test";
  });
  afterEach(() => {
    delete process.env.RESEND_API_KEY;
  });

  it("sends from the alias with Reply-To the original sender", async () => {
    sendMock.mockResolvedValueOnce(acceptedBy("e_1"));
    const { forwardInboundEmail } = await import("@/lib/email");

    expect(await forwardInboundEmail(base)).toBe(true);
    const arg = sendMock.mock.calls[0][0];
    // Quoted, and the sender's @ spelled out: a bare address in a display name
    // ahead of a different real address is invalid and reads as spoofing.
    expect(arg.from).toBe('"recruiter at acme.com via JobArms" <a-abcdefghjk@jobarms.com>');
    expect(arg.replyTo).toBe("recruiter@acme.com");
    expect(arg.to).toBe("user@gmail.com");
    expect(arg.subject).toBe("About your application");
    expect(arg.text).toBe("Hello there");
    expect(arg.html).toBeUndefined();
  });

  it("relays the HTML alternative when present", async () => {
    sendMock.mockResolvedValueOnce(acceptedBy("e_2"));
    const { forwardInboundEmail } = await import("@/lib/email");

    await forwardInboundEmail({ ...base, html: "<p>Hello there</p>" });
    expect(sendMock.mock.calls[0][0].html).toBe("<p>Hello there</p>");
  });

  it("strips header-significant characters from the display name", async () => {
    sendMock.mockResolvedValueOnce(acceptedBy("e_3"));
    const { forwardInboundEmail } = await import("@/lib/email");

    await forwardInboundEmail({
      ...base,
      fromAddress: 'evil" <attacker@bad.com>, victim@x.com'
    });
    const from = sendMock.mock.calls[0][0].from;
    expect(from).toBe(
      '"evil attacker at bad.com victim at x.com via JobArms" <a-abcdefghjk@jobarms.com>'
    );
    // Exactly one quoted phrase, one address, and no comma to split it on.
    expect(from.match(/"/g)).toHaveLength(2);
    expect(from).not.toContain(",");
    expect(from.match(/@/g)).toHaveLength(1);
  });

  it("omits Reply-To and names us when the sender is unknown", async () => {
    sendMock.mockResolvedValueOnce(acceptedBy("e_4"));
    const { forwardInboundEmail } = await import("@/lib/email");

    await forwardInboundEmail({ ...base, fromAddress: "" });
    const arg = sendMock.mock.calls[0][0];
    expect(arg.from).toBe('"JobArms" <a-abcdefghjk@jobarms.com>');
    expect(arg.replyTo).toBeUndefined();
  });

  it("substitutes a subject and body when the message had neither", async () => {
    sendMock.mockResolvedValueOnce(acceptedBy("e_5"));
    const { forwardInboundEmail } = await import("@/lib/email");

    await forwardInboundEmail({ ...base, subject: "", text: "" });
    const arg = sendMock.mock.calls[0][0];
    expect(arg.subject).toBe("(no subject)");
    expect(arg.text).toContain("no text body");
  });

  it("clips an enormous body rather than refusing to forward", async () => {
    sendMock.mockResolvedValueOnce(acceptedBy("e_6"));
    const { forwardInboundEmail } = await import("@/lib/email");

    await forwardInboundEmail({ ...base, text: "z".repeat(200_050) });
    expect(sendMock.mock.calls[0][0].text).toHaveLength(200_000);
  });

  it("no-ops without an API key, a recipient, or an alias", async () => {
    const { forwardInboundEmail } = await import("@/lib/email");

    delete process.env.RESEND_API_KEY;
    expect(await forwardInboundEmail(base)).toBe(false);

    process.env.RESEND_API_KEY = "re_test";
    expect(await forwardInboundEmail({ ...base, to: "" })).toBe(false);
    expect(await forwardInboundEmail({ ...base, alias: "" })).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns false when the provider throws", async () => {
    sendMock.mockRejectedValueOnce(new Error("resend down"));
    const { forwardInboundEmail } = await import("@/lib/email");
    expect(await forwardInboundEmail(base)).toBe(false);
  });

  it("returns false when the provider REJECTS without throwing", async () => {
    // The failure mode that hid: the SDK resolves with { data: null, error },
    // so a refused send used to be recorded against the message as forwarded.
    sendMock.mockResolvedValueOnce(
      rejectedWith("validation_error", "The from address is not valid")
    );
    const { forwardInboundEmail } = await import("@/lib/email");
    expect(await forwardInboundEmail(base)).toBe(false);
  });
});
