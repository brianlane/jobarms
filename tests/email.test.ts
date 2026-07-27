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
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    sendMock.mockResolvedValueOnce(
      rejectedWith("daily_quota_exceeded", "You have reached your daily sending quota")
    );
    const { sendWelcomeEmail } = await import("@/lib/email");

    expect(await sendWelcomeEmail("a@b.com", "Bri")).toBe(false);
    expect(logged).toHaveBeenCalledWith(
      "welcome email rejected by email provider",
      "daily_quota_exceeded",
      "You have reached your daily sending quota"
    );
    logged.mockRestore();
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

    expect(await forwardInboundEmail(base)).toEqual({ ok: true });
    const arg = sendMock.mock.calls[0][0];
    // Local part only. Google lists an email domain in the display name among
    // the deceptive practices it treats as spoofing.
    expect(arg.from).toBe('"recruiter (via JobArms)" <a-abcdefghjk@jobarms.com>');
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
    expect(from).toBe('"evil attacker (via JobArms)" <a-abcdefghjk@jobarms.com>');
    // Exactly one quoted phrase, one address, and no comma to split it on.
    expect(from.match(/"/g)).toHaveLength(2);
    expect(from).not.toContain(",");
    expect(from.match(/@/g)).toHaveLength(1);
  });

  it("prefers the sender's own name over their address", async () => {
    sendMock.mockResolvedValueOnce(acceptedBy("e_7"));
    const { forwardInboundEmail } = await import("@/lib/email");

    await forwardInboundEmail({ ...base, fromName: "Dana Recruiter" });
    expect(sendMock.mock.calls[0][0].from).toBe(
      '"Dana Recruiter (via JobArms)" <a-abcdefghjk@jobarms.com>'
    );
  });

  it("never lets an email domain reach the display name", async () => {
    sendMock.mockResolvedValueOnce(acceptedBy("e_8"));
    const { forwardInboundEmail } = await import("@/lib/email");

    // A sender whose NAME is itself an address, which is the shape Gmail reads
    // as spoofing and the reason a forward was silently discarded.
    await forwardInboundEmail({
      ...base,
      fromName: "brianlanefanmail@gmail.com",
      fromAddress: "brianlanefanmail@gmail.com"
    });
    const from = sendMock.mock.calls[0][0].from;
    expect(from).toBe('"brianlanefanmail (via JobArms)" <a-abcdefghjk@jobarms.com>');
    expect(from).not.toContain("gmail.com");
  });

  it("truncates an absurdly long sender name", async () => {
    sendMock.mockResolvedValueOnce(acceptedBy("e_9"));
    const { forwardInboundEmail } = await import("@/lib/email");

    await forwardInboundEmail({ ...base, fromName: "z".repeat(300) });
    expect(sendMock.mock.calls[0][0].from).toBe(
      `"${"z".repeat(100)} (via JobArms)" <a-abcdefghjk@jobarms.com>`
    );
  });

  it("omits Reply-To and names us when the sender is unknown", async () => {
    sendMock.mockResolvedValueOnce(acceptedBy("e_4"));
    const { forwardInboundEmail } = await import("@/lib/email");

    await forwardInboundEmail({ ...base, fromAddress: "", fromName: "" });
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

  it("says which precondition stopped it, rather than a bare false", async () => {
    const { forwardInboundEmail } = await import("@/lib/email");

    delete process.env.RESEND_API_KEY;
    expect(await forwardInboundEmail(base)).toEqual({
      ok: false,
      reason: "email_unconfigured"
    });

    process.env.RESEND_API_KEY = "re_test";
    expect(await forwardInboundEmail({ ...base, to: "" })).toEqual({
      ok: false,
      reason: "no_recipient_on_file"
    });
    expect(await forwardInboundEmail({ ...base, alias: "" })).toEqual({
      ok: false,
      reason: "no_alias"
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("carries the thrown message through as the reason", async () => {
    sendMock.mockRejectedValueOnce(new Error("resend down"));
    const { forwardInboundEmail } = await import("@/lib/email");

    const outcome = await forwardInboundEmail(base);
    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toContain("resend down");
  });

  it("truncates a runaway reason", async () => {
    sendMock.mockRejectedValueOnce(new Error("z".repeat(900)));
    const { forwardInboundEmail } = await import("@/lib/email");

    const outcome = await forwardInboundEmail(base);
    expect((outcome as { reason: string }).reason).toHaveLength(300);
  });

  it("returns the provider's reason when it REJECTS without throwing", async () => {
    // The failure mode that hid: the SDK resolves with { data: null, error },
    // so a refused send used to be recorded against the message as forwarded.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    sendMock.mockResolvedValueOnce(
      rejectedWith("validation_error", "The from address is not valid")
    );
    const { forwardInboundEmail } = await import("@/lib/email");

    expect(await forwardInboundEmail(base)).toEqual({
      ok: false,
      reason: "validation_error: The from address is not valid"
    });
    expect(logged).toHaveBeenCalledWith(
      "inbound forward rejected by email provider",
      "validation_error",
      "The from address is not valid"
    );
    // The reason is diagnosable without leaking who it was for.
    const logLine = logged.mock.calls[0].join(" ");
    expect(logLine).not.toContain(base.to);
    logged.mockRestore();
  });
});

describe("sendReviewNeededEmail", () => {
  const args = {
    to: "user@example.com",
    firstName: "Brian",
    company: "Databricks",
    jobTitle: "Staff Engineer",
    applicationId: "app-1",
    fields: ["Sanctions and export controls"]
  };

  beforeEach(() => {
    sendMock.mockReset();
    process.env.RESEND_API_KEY = "re_test";
  });
  afterEach(() => {
    delete process.env.RESEND_API_KEY;
  });

  it("explains why an arm that never asks is asking", async () => {
    sendMock.mockResolvedValueOnce(acceptedBy("e_9"));
    const { sendReviewNeededEmail } = await import("@/lib/email");

    expect(await sendReviewNeededEmail(args)).toEqual({ ok: true });

    const sent = sendMock.mock.calls[0][0];
    expect(sent.to).toBe("user@example.com");
    expect(sent.subject).toBe("Your arm needs you: Staff Engineer at Databricks");
    expect(sent.text).toContain("Hi Brian,");
    expect(sent.text).toContain("checked its work");
    expect(sent.text).toContain("Sanctions and export controls");
    // The two things a surprised reader most needs to know.
    expect(sent.text).toContain("Nothing has been sent to this employer");
    expect(sent.text).toContain("7 days");
    expect(sent.text).toContain("/dashboard/applications/app-1");
  });

  it("keeps its paragraphs when there are no field names to give", async () => {
    sendMock.mockResolvedValueOnce(acceptedBy("e_10"));
    const { sendReviewNeededEmail } = await import("@/lib/email");

    await sendReviewNeededEmail({ ...args, fields: [] });

    const text = sendMock.mock.calls[0][0].text as string;
    expect(text).not.toContain("could not set");
    expect(text).toContain("Hi Brian,\n\nYour arm filled out");
  });

  it("counts the questions it names", async () => {
    sendMock.mockResolvedValueOnce(acceptedBy("e_11"));
    const { sendReviewNeededEmail } = await import("@/lib/email");

    await sendReviewNeededEmail({ ...args, fields: ["One", "Two"] });

    expect(sendMock.mock.calls[0][0].text).toContain("The questions it could not set: One, Two.");
  });

  it("still reads properly with no name, and no job to name either", async () => {
    sendMock.mockResolvedValueOnce(acceptedBy("e_12"));
    const { sendReviewNeededEmail } = await import("@/lib/email");

    await sendReviewNeededEmail({ ...args, firstName: "", company: "", jobTitle: "" });

    const sent = sendMock.mock.calls[0][0];
    expect(sent.subject).toBe("Your arm needs you: an application");
    expect(sent.text).toContain("Hi,");
  });

  it("names the company alone when there is no title", async () => {
    sendMock.mockResolvedValueOnce(acceptedBy("e_13"));
    const { sendReviewNeededEmail } = await import("@/lib/email");

    await sendReviewNeededEmail({ ...args, jobTitle: "" });

    expect(sendMock.mock.calls[0][0].subject).toBe("Your arm needs you: Databricks");
  });

  it("reports why the provider refused it", async () => {
    sendMock.mockResolvedValueOnce(rejectedWith("daily_quota_exceeded", "too many"));
    const { sendReviewNeededEmail } = await import("@/lib/email");

    expect(await sendReviewNeededEmail(args)).toEqual({
      ok: false,
      reason: "daily_quota_exceeded: too many"
    });
  });

  it("reports a thrown transport failure instead of pretending", async () => {
    sendMock.mockRejectedValueOnce(new Error("socket hang up"));
    const { sendReviewNeededEmail } = await import("@/lib/email");

    const outcome = await sendReviewNeededEmail(args);
    expect(outcome.ok).toBe(false);
  });

  it("does not attempt a send it cannot make", async () => {
    const { sendReviewNeededEmail } = await import("@/lib/email");

    expect(await sendReviewNeededEmail({ ...args, to: "" })).toEqual({
      ok: false,
      reason: "no_recipient_on_file"
    });

    delete process.env.RESEND_API_KEY;
    expect(await sendReviewNeededEmail(args)).toEqual({
      ok: false,
      reason: "email_unconfigured"
    });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
