import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
  }
}));

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
    sendMock.mockResolvedValueOnce({ id: "e_1" });
    const { sendWelcomeEmail } = await import("@/lib/email");
    expect(await sendWelcomeEmail("a@b.com", "Bri")).toBe(true);
    const arg = sendMock.mock.calls[0][0];
    expect(arg.to).toBe("a@b.com");
    expect(arg.text).toContain("Hi Bri,");
  });

  it("greets without a name when firstName is empty", async () => {
    sendMock.mockResolvedValueOnce({ id: "e_2" });
    const { sendWelcomeEmail } = await import("@/lib/email");
    expect(await sendWelcomeEmail("a@b.com", "")).toBe(true);
    expect(sendMock.mock.calls[0][0].text).toContain("Hi,");
  });

  it("returns false when the provider throws", async () => {
    sendMock.mockRejectedValueOnce(new Error("smtp down"));
    const { sendWelcomeEmail } = await import("@/lib/email");
    expect(await sendWelcomeEmail("a@b.com", "Bri")).toBe(false);
  });
});
