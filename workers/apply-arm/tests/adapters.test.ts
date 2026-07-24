import { describe, expect, it, vi } from "vitest";
import { ADAPTERS } from "../src/adapters";
import { fakePage, loc } from "./helpers/fake-page";
import type { Page } from "@cloudflare/playwright";

const gh = ADAPTERS.greenhouse;
const lever = ADAPTERS.lever;

describe("greenhouse adapter", () => {
  it("returns immediately when the form is already present", async () => {
    const page = fakePage({ locators: { 'form[id*="application"]': loc({ count: async () => 1 }) } });
    await gh.openApplication(page as unknown as Page);
    expect(page.locator).toHaveBeenCalled();
  });

  it("navigates into a greenhouse iframe embed", async () => {
    const embed = loc({ count: async () => 1, getAttribute: async () => "https://boards.greenhouse.io/acme/embed" });
    const page = fakePage({
      locators: { 'form[id*="application"]': loc({ count: async () => 0 }), 'iframe[src*="greenhouse.io"]': embed }
    });
    await gh.openApplication(page as unknown as Page);
    expect(page.goto).toHaveBeenCalledWith("https://boards.greenhouse.io/acme/embed", expect.anything());
  });

  it("clicks Apply at attempt 4 and exhausts the loop when nothing mounts", async () => {
    const applyBtn = loc({ count: async () => 1, click: vi.fn(async () => { throw new Error("click failed"); }) });
    const page = fakePage({
      locators: {
        'form[id*="application"]': loc({ count: async () => 0 }),
        'iframe[src*="greenhouse.io"]': loc({ count: async () => 0 }),
        "Apply": applyBtn
      }
    });
    await gh.openApplication(page as unknown as Page);
    expect(applyBtn.click).toHaveBeenCalled();
    expect(page.waitForTimeout).toHaveBeenCalled();
  });

  it("ignores an iframe that has no src", async () => {
    const embed = loc({ count: async () => 1, getAttribute: async () => null });
    const page = fakePage({
      locators: { 'form[id*="application"]': loc({ count: async () => 0 }), 'iframe[src*="greenhouse.io"]': embed }
    });
    await gh.openApplication(page as unknown as Page);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("submit clicks the submit control", async () => {
    const btn = loc();
    const page = fakePage({ locators: { "submit": btn } });
    await gh.submit(page as unknown as Page);
    expect(btn.click).toHaveBeenCalled();
  });

  it("confirmSubmitted true when the confirmation node appears", async () => {
    const page = fakePage({ locators: { confirmation: loc({ waitFor: async () => {} }) } });
    expect(await gh.confirmSubmitted(page as unknown as Page)).toBe(true);
  });

  it("confirmSubmitted falls back to url/content sniffing", async () => {
    const page = fakePage({
      url: "https://x/confirmation",
      locators: { confirmation: loc({ waitFor: async () => { throw new Error("timeout"); } }) }
    });
    expect(await gh.confirmSubmitted(page as unknown as Page)).toBe(true);

    const page2 = fakePage({
      url: "https://x/nope",
      content: "Thank you for applying",
      locators: { confirmation: loc({ waitFor: async () => { throw new Error("timeout"); } }) }
    });
    expect(await gh.confirmSubmitted(page2 as unknown as Page)).toBe(true);

    const page3 = fakePage({
      url: "https://x/nope",
      content: "nothing",
      locators: { confirmation: loc({ waitFor: async () => { throw new Error("timeout"); } }) }
    });
    expect(await gh.confirmSubmitted(page3 as unknown as Page)).toBe(false);
  });
});

describe("lever adapter", () => {
  it("navigates to the /apply page when not already there", async () => {
    const page = fakePage({ url: "https://jobs.lever.co/acme/1" });
    await lever.openApplication(page as unknown as Page);
    expect(page.goto).toHaveBeenCalledWith("https://jobs.lever.co/acme/1/apply", expect.anything());
  });

  it("does not re-navigate when already on /apply", async () => {
    const page = fakePage({ url: "https://jobs.lever.co/acme/1/apply" });
    await lever.openApplication(page as unknown as Page);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("submit clicks the submit control", async () => {
    const btn = loc();
    const page = fakePage({ locators: { "submit": btn } });
    await lever.submit(page as unknown as Page);
    expect(btn.click).toHaveBeenCalled();
  });

  it("confirmSubmitted true when the confirmation text appears", async () => {
    const page = fakePage({ locators: { "application submitted": loc({ waitFor: async () => {} }) } });
    expect(await lever.confirmSubmitted(page as unknown as Page)).toBe(true);
  });

  it("confirmSubmitted falls back to a thanks URL", async () => {
    const page = fakePage({
      url: "https://jobs.lever.co/acme/thanks",
      locators: { "application submitted": loc({ waitFor: async () => { throw new Error("t"); } }) }
    });
    expect(await lever.confirmSubmitted(page as unknown as Page)).toBe(true);

    const page2 = fakePage({
      url: "https://jobs.lever.co/acme/1/apply",
      locators: { "application submitted": loc({ waitFor: async () => { throw new Error("t"); } }) }
    });
    expect(await lever.confirmSubmitted(page2 as unknown as Page)).toBe(false);
  });
});
