import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { detectChallenge } from "../src/captcha";
import { fakePage, loc } from "./helpers/fake-page";

const asPage = (p: ReturnType<typeof fakePage>) => p as unknown as Page;
const present = () => loc({ count: vi.fn(async () => 1) });

describe("detectChallenge", () => {
  it("detects a reCAPTCHA v2 widget", async () => {
    const page = fakePage({
      locators: { 'iframe[src*="recaptcha/api2/anchor"]': present() }
    });
    expect(await detectChallenge(asPage(page))).toBe("recaptcha_v2");
  });

  it("detects an hCaptcha widget", async () => {
    const page = fakePage({ locators: { "hcaptcha.com": present() } });
    expect(await detectChallenge(asPage(page))).toBe("hcaptcha");
  });

  it("reports nothing on a clean page", async () => {
    expect(await detectChallenge(asPage(fakePage()))).toBeNull();
  });

  it("treats an unreadable page as no challenge rather than failing a submit", async () => {
    const page = fakePage();
    page.locator = vi.fn(() => {
      throw new Error("page detached");
    });
    expect(await detectChallenge(asPage(page))).toBeNull();
  });
});
