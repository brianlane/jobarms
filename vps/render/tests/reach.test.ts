import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { applyStrategy, FormNotFoundError, reachForm } from "../src/reach";
import { fakePage, goodFields, loc } from "./helpers/fake-page";

const asPage = (p: ReturnType<typeof fakePage>) => p as unknown as Page;
const LEVER_URL = "https://jobs.lever.co/acme/1/apply";

/**
 * A page whose extraction returns `sequence` in order, one entry per
 * collectFields call, so each recovery round can be driven precisely.
 */
function pageWithExtractions(sequence: unknown[][], over = {}) {
  let i = 0;
  return fakePage({
    url: LEVER_URL,
    eval$$: () => sequence[Math.min(i++, sequence.length - 1)] ?? [],
    ...over
  });
}

describe("reachForm", () => {
  it("returns straight away when the adapter selector finds a real form", async () => {
    const page = pageWithExtractions([goodFields()]);
    const result = await reachForm(asPage(page), LEVER_URL, "lever", {}, { throwIfNotFound: true });
    expect(result.recovery).toBeNull();
    expect(result.scope).toBe("form");
    expect(result.rawFields).toHaveLength(3);
    expect(result.playbookFailed).toBe(false);
  });

  it("throws FormNotFoundError when nothing is reachable and asked to", async () => {
    const page = pageWithExtractions([[]]);
    await expect(
      reachForm(asPage(page), LEVER_URL, "lever", {}, { throwIfNotFound: true })
    ).rejects.toThrow(FormNotFoundError);
  });

  it("stays lenient for fill/submit, handing back a page-wide scope", async () => {
    const page = pageWithExtractions([[]]);
    const result = await reachForm(asPage(page), LEVER_URL, "lever", {}, { throwIfNotFound: false });
    expect(result.scope).toBe("body");
    expect(result.recovery).toBeNull();
  });

  it("applies a stored playbook first and reports it as the recovery", async () => {
    // First extraction fails, the playbook runs, the second succeeds.
    const page = pageWithExtractions([[], goodFields()]);
    const result = await reachForm(
      asPage(page),
      LEVER_URL,
      "lever",
      { playbook: { action: "scroll" } },
      { throwIfNotFound: true }
    );
    expect(result.recovery).toEqual({
      source: "playbook",
      strategy: { action: "scroll" },
      domain: "jobs.lever.co"
    });
    expect(result.playbookFailed).toBe(false);
  });

  it("retries the page-wide sweep for a playbook that recorded a wide extract", async () => {
    // adapter scope, then playbook + adapter scope again, then the body sweep.
    const page = pageWithExtractions([[], [], goodFields()]);
    const result = await reachForm(
      asPage(page),
      LEVER_URL,
      "lever",
      { playbook: { action: "scroll" } },
      { throwIfNotFound: true }
    );
    expect(result.scope).toBe("body");
    expect(result.recovery?.source).toBe("playbook");
  });

  it("flags a playbook that no longer works so the caller can decay it", async () => {
    const page = pageWithExtractions([[]]);
    const result = await reachForm(
      asPage(page),
      LEVER_URL,
      "lever",
      { playbook: { action: "click", click_text: "Apply" } },
      { throwIfNotFound: false }
    );
    expect(result.playbookFailed).toBe(true);
  });

  it("uses vision to widen extraction when it sees a form our selector missed", async () => {
    const page = pageWithExtractions([[], goodFields()]);
    const diagnose = vi.fn(async () => ({ action: "none" as const, form_visible: true }));
    const result = await reachForm(
      asPage(page),
      LEVER_URL,
      "lever",
      { diagnose },
      { throwIfNotFound: true }
    );
    expect(result).toMatchObject({
      scope: "body",
      recovery: { source: "vision", strategy: { action: "scroll" } }
    });
  });

  it("acts on a vision-suggested click and reports the winning strategy", async () => {
    const page = pageWithExtractions([[], goodFields()]);
    const diagnose = vi.fn(async () => ({
      action: "click" as const,
      click_text: "Apply now",
      form_visible: false
    }));
    const result = await reachForm(
      asPage(page),
      LEVER_URL,
      "lever",
      { diagnose },
      { throwIfNotFound: true }
    );
    expect(result.recovery).toEqual({
      source: "vision",
      strategy: { action: "click", click_text: "Apply now" },
      domain: "jobs.lever.co"
    });
  });

  it("falls back to a page-wide sweep after a vision action", async () => {
    // adapter (fail), vision action, adapter (fail), body sweep (succeed).
    const page = pageWithExtractions([[], [], goodFields()]);
    const diagnose = vi.fn(async () => ({ action: "scroll" as const }));
    const result = await reachForm(
      asPage(page),
      LEVER_URL,
      "lever",
      { diagnose },
      { throwIfNotFound: true }
    );
    expect(result.scope).toBe("body");
  });

  it("stops when vision says there is nothing to do", async () => {
    const page = pageWithExtractions([[]]);
    const diagnose = vi.fn(async () => ({ action: "none" as const, reason: "login wall" }));
    await expect(
      reachForm(asPage(page), LEVER_URL, "lever", { diagnose }, { throwIfNotFound: true })
    ).rejects.toThrow(/login wall/);
    expect(diagnose).toHaveBeenCalledTimes(1);
  });

  it("keeps the prior reason when vision offers none", async () => {
    const page = pageWithExtractions([[]]);
    const diagnose = vi.fn(async () => ({ action: "none" as const }));
    await expect(
      reachForm(asPage(page), LEVER_URL, "lever", { diagnose }, { throwIfNotFound: true })
    ).rejects.toThrow(/no fields extracted/);
  });

  it("stops when vision is unavailable or fails", async () => {
    const nullDiagnose = vi.fn(async () => null);
    await expect(
      reachForm(
        asPage(pageWithExtractions([[]])),
        LEVER_URL,
        "lever",
        { diagnose: nullDiagnose },
        { throwIfNotFound: true }
      )
    ).rejects.toThrow(FormNotFoundError);

    const throwing = vi.fn(async () => {
      throw new Error("model down");
    });
    await expect(
      reachForm(
        asPage(pageWithExtractions([[]])),
        LEVER_URL,
        "lever",
        { diagnose: throwing },
        { throwIfNotFound: true }
      )
    ).rejects.toThrow(FormNotFoundError);
  });

  it("gives vision at most two rounds", async () => {
    const page = pageWithExtractions([[]]);
    const diagnose = vi.fn(async () => ({ action: "scroll" as const }));
    await expect(
      reachForm(asPage(page), LEVER_URL, "lever", { diagnose }, { throwIfNotFound: true })
    ).rejects.toThrow(FormNotFoundError);
    expect(diagnose).toHaveBeenCalledTimes(2);
  });
});

describe("applyStrategy", () => {
  it("clicks matching text, stripping quotes that would break the selector", async () => {
    const target = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({ locators: { ":has-text(": target } });
    await applyStrategy(asPage(page), "form", { action: "click", click_text: 'Ap"ply' }, "lever");
    expect(target.click).toHaveBeenCalled();
    // The quote is removed rather than escaped, so the selector stays valid.
    const selector = (page.locator as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(selector).toContain('has-text("Apply")');
  });

  it("defaults the click text to Apply", async () => {
    const target = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({ locators: { ':has-text(': target } });
    await applyStrategy(asPage(page), "form", { action: "click" }, "lever");
    expect((page.locator as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("Apply");
  });

  it("does nothing when the click target is absent", async () => {
    const page = fakePage();
    await expect(
      applyStrategy(asPage(page), "form", { action: "click" }, "lever")
    ).resolves.toBeUndefined();
  });

  it("navigates into a provider iframe, choosing the host per ATS", async () => {
    for (const [ats, host] of [
      ["greenhouse", "greenhouse.io"],
      ["lever", "lever.co"],
      ["workday", "myworkdayjobs.com"],
      ["ashby", "ashbyhq.com"]
    ] as const) {
      const embed = loc({
        count: vi.fn(async () => 1),
        getAttribute: vi.fn(async () => `https://embed.${host}/form`)
      });
      const page = fakePage({ locators: { "iframe[src*=": embed } });
      await applyStrategy(asPage(page), "form", { action: "iframe" }, ats);
      expect((page.locator as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(host);
      expect(page.goto).toHaveBeenCalledWith(`https://embed.${host}/form`, {
        waitUntil: "domcontentloaded"
      });
    }
  });

  it("takes any iframe with a src for the generic ATS (no provider to anchor on)", async () => {
    const embed = loc({
      count: vi.fn(async () => 1),
      getAttribute: vi.fn(async () => "https://forms.example.com/apply")
    });
    const page = fakePage({ locators: { "iframe[src]": embed } });
    await applyStrategy(asPage(page), "form", { action: "iframe" }, "generic");
    expect((page.locator as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("iframe[src]");
    expect(page.goto).toHaveBeenCalledWith("https://forms.example.com/apply", {
      waitUntil: "domcontentloaded"
    });
  });

  it("refuses to navigate into an unsafe embed src", async () => {
    // The embed src comes from the PAGE, not the caller, so a loopback or
    // metadata target here would turn the recovery into an SSRF vector.
    const embed = loc({
      count: vi.fn(async () => 1),
      getAttribute: vi.fn(async () => "http://169.254.169.254/latest/meta-data/")
    });
    const page = fakePage({ locators: { "iframe[src]": embed } });
    await applyStrategy(asPage(page), "form", { action: "iframe" }, "generic");
    expect(page.goto).not.toHaveBeenCalled();
    // The unsafe embed is skipped and the scroll-and-look loop runs out.
    expect(page.mouse.wheel).toHaveBeenCalledTimes(5);
  });

  it("scrolls looking for a lazy embed, then gives up", async () => {
    const page = fakePage();
    await applyStrategy(asPage(page), "form", { action: "iframe" }, "lever");
    expect(page.mouse.wheel).toHaveBeenCalledTimes(5);
  });

  it("scrolls the page for the scroll strategy", async () => {
    const page = fakePage();
    await applyStrategy(asPage(page), "form", { action: "scroll" }, "lever");
    expect(page.mouse.wheel).toHaveBeenCalledTimes(4);
  });

  it("swallows a strategy failure so the sanity re-check decides", async () => {
    const page = fakePage();
    page.mouse.wheel = vi.fn(async () => {
      throw new Error("page closed");
    });
    await expect(
      applyStrategy(asPage(page), "form", { action: "scroll" }, "lever")
    ).resolves.toBeUndefined();
  });
});
