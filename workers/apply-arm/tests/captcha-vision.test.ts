import { beforeEach, describe, expect, it, vi } from "vitest";
import { loc } from "./helpers/fake-page";
import type { Page } from "@cloudflare/playwright";
import type { Env } from "../src/types";

const gemini = vi.hoisted(() => ({ solveImageGrid: vi.fn() }));
vi.mock("../src/gemini", () => gemini);

import { detectInteractiveChallenge, solveInteractiveChallenge } from "../src/captcha-vision";

const env = {} as Env;

beforeEach(() => {
  vi.clearAllMocks();
  gemini.solveImageGrid.mockResolvedValue([0, 1]);
});

/** page.locator resolved from a substring map. */
function pageWith(locators: Record<string, ReturnType<typeof loc>>, frame: (inner: string) => ReturnType<typeof loc>) {
  const pick = (sel: string) => {
    for (const k of Object.keys(locators)) if (sel.includes(k)) return locators[k];
    return loc();
  };
  return {
    locator: vi.fn(pick),
    frameLocator: vi.fn(() => ({ locator: vi.fn((inner: string) => frame(inner)) })),
    keyboard: { press: vi.fn(async () => {}) },
    waitForTimeout: vi.fn(async () => {})
  } as unknown as Page;
}

describe("detectInteractiveChallenge", () => {
  it("detects reCAPTCHA v2", async () => {
    const p = pageWith({ "recaptcha/api2/anchor": loc({ count: async () => 1 }) }, () => loc());
    expect(await detectInteractiveChallenge(p)).toBe("recaptcha_v2");
  });
  it("detects hCaptcha", async () => {
    const p = pageWith({ "recaptcha/api2/anchor": loc({ count: async () => 0 }), "hcaptcha.com": loc({ count: async () => 1 }) }, () => loc());
    expect(await detectInteractiveChallenge(p)).toBe("hcaptcha");
  });
  it("returns null when no widget is present", async () => {
    expect(await detectInteractiveChallenge(pageWith({}, () => loc()))).toBeNull();
  });
  it("returns null when detection throws", async () => {
    const p = { locator: vi.fn(() => { throw new Error("boom"); }) } as unknown as Page;
    expect(await detectInteractiveChallenge(p)).toBeNull();
  });
});

describe("solveInteractiveChallenge dispatch", () => {
  it("returns false for a null kind", async () => {
    expect(await solveInteractiveChallenge(env, pageWith({}, () => loc()), null)).toBe(false);
  });
});

describe("solveRecaptchaV2", () => {
  const anchorFrame = (getAttribute: () => Promise<string>, grid: ReturnType<typeof loc>) => (inner: string) =>
    inner.includes("#recaptcha-anchor") ? loc({ getAttribute }) : grid;

  it("returns false when the checkbox click fails", async () => {
    const frame = (inner: string) =>
      inner.includes("#recaptcha-anchor") ? loc({ click: async () => { throw new Error("no"); } }) : loc();
    expect(await solveInteractiveChallenge(env, pageWith({}, frame), "recaptcha_v2")).toBe(false);
  });

  it("passes immediately when the checkbox goes checked (no grid)", async () => {
    const frame = anchorFrame(async () => "true", loc());
    expect(await solveInteractiveChallenge(env, pageWith({}, frame), "recaptcha_v2")).toBe(true);
  });

  it("solves a grid: picks tiles, verifies, and passes", async () => {
    const getAttr = vi.fn().mockResolvedValueOnce("false").mockResolvedValue("true");
    const grid = loc({ textContent: async () => "select all crosswalks", count: async () => 9, screenshot: async () => new Uint8Array([1]) });
    const frame = (inner: string) => (inner.includes("#recaptcha-anchor") ? loc({ getAttribute: getAttr }) : grid);
    expect(await solveInteractiveChallenge(env, pageWith({}, frame), "recaptcha_v2")).toBe(true);
  });

  it("reloads when no tiles match, then gives up", async () => {
    gemini.solveImageGrid.mockResolvedValue([]);
    const grid = loc({ textContent: async () => "select all buses", count: async () => 9, screenshot: async () => new Uint8Array([1]) });
    const frame = anchorFrame(async () => "false", grid);
    expect(await solveInteractiveChallenge(env, pageWith({}, frame), "recaptcha_v2")).toBe(false);
  });

  it("breaks out when no instruction is present", async () => {
    const grid = loc({ textContent: async () => null });
    const frame = anchorFrame(async () => "false", grid);
    expect(await solveInteractiveChallenge(env, pageWith({}, frame), "recaptcha_v2")).toBe(false);
  });

  it("breaks out when there are no tiles", async () => {
    const grid = loc({ textContent: async () => "instruction", count: async () => 0 });
    const frame = anchorFrame(async () => "false", grid);
    expect(await solveInteractiveChallenge(env, pageWith({}, frame), "recaptcha_v2")).toBe(false);
  });

  it("breaks out when the challenge screenshot cannot be captured", async () => {
    const grid = loc({
      textContent: async () => "instruction",
      count: async () => 16,
      screenshot: async () => { throw new Error("no shot"); }
    });
    const frame = anchorFrame(async () => "false", grid);
    expect(await solveInteractiveChallenge(env, pageWith({}, frame), "recaptcha_v2")).toBe(false);
  });

  it("treats a getAttribute failure as unchecked (defensive catch)", async () => {
    const grid = loc({ textContent: async () => null });
    const frame = (inner: string) =>
      inner.includes("#recaptcha-anchor") ? loc({ getAttribute: async () => { throw new Error("x"); } }) : grid;
    expect(await solveInteractiveChallenge(env, pageWith({}, frame), "recaptcha_v2")).toBe(false);
  });

  it("treats a textContent failure as no instruction (defensive catch)", async () => {
    const grid = loc({ textContent: async () => { throw new Error("x"); } });
    const frame = anchorFrame(async () => "false", grid);
    expect(await solveInteractiveChallenge(env, pageWith({}, frame), "recaptcha_v2")).toBe(false);
  });

  it("recovers from a solveImageGrid failure (reloads, then gives up)", async () => {
    gemini.solveImageGrid.mockRejectedValue(new Error("model down"));
    const grid = loc({
      textContent: async () => "select all cars",
      count: async () => 9,
      screenshot: async () => new Uint8Array([1]),
      click: async () => { throw new Error("click failed"); } // exercises the tile/reload .catch
    });
    const frame = anchorFrame(async () => "false", grid);
    expect(await solveInteractiveChallenge(env, pageWith({}, frame), "recaptcha_v2")).toBe(false);
  });

  it("treats a tile-count failure as zero tiles (defensive catch)", async () => {
    const grid = loc({ textContent: async () => "instruction", count: async () => { throw new Error("no count"); } });
    const frame = anchorFrame(async () => "false", grid);
    expect(await solveInteractiveChallenge(env, pageWith({}, frame), "recaptcha_v2")).toBe(false);
  });

  it("treats a null aria-checked as unchecked (the ?? default)", async () => {
    const grid = loc({ textContent: async () => null });
    const frame = anchorFrame(async () => null as unknown as string, grid);
    expect(await solveInteractiveChallenge(env, pageWith({}, frame), "recaptcha_v2")).toBe(false);
  });

  it("clicks matching tiles + verify (whose failures are swallowed) across rounds and gives up", async () => {
    gemini.solveImageGrid.mockResolvedValue([0, 1]);
    const grid = loc({
      textContent: async () => "select all cars",
      count: async () => 9,
      screenshot: async () => new Uint8Array([1]),
      click: async () => { throw new Error("click failed"); } // tile + verify .catch fire
    });
    const frame = anchorFrame(async () => "false", grid); // never becomes checked -> all 3 rounds
    expect(await solveInteractiveChallenge(env, pageWith({}, frame), "recaptcha_v2")).toBe(false);
  });
});

describe("solveHcaptcha", () => {
  it("returns false when the checkbox click fails", async () => {
    const frame = (inner: string) => (inner.includes("#checkbox") ? loc({ click: async () => { throw new Error("no"); } }) : loc());
    expect(await solveInteractiveChallenge(env, pageWith({}, frame), "hcaptcha")).toBe(false);
  });

  it("runs the grid loop; passes when the challenge iframe disappears", async () => {
    const grid = loc({ textContent: async () => "pick all boats", count: async () => 9, screenshot: async () => new Uint8Array([1]) });
    const frame = (inner: string) => (inner.includes("#checkbox") ? loc() : grid);
    const p = pageWith({ "hcaptcha.com": loc({ count: async () => 0 }) }, frame);
    expect(await solveInteractiveChallenge(env, p, "hcaptcha")).toBe(true);
  });

  it("treats an hcaptcha tile-count failure as zero tiles", async () => {
    const grid = loc({ textContent: async () => "pick boats", count: async () => { throw new Error("no count"); } });
    const frame = (inner: string) => (inner.includes("#checkbox") ? loc() : grid);
    const p = pageWith({ "hcaptcha.com": loc({ count: async () => 1 }) }, frame);
    expect(await solveInteractiveChallenge(env, p, "hcaptcha")).toBe(false);
  });

  it("breaks the hcaptcha loop with no instruction/tiles", async () => {
    const grid = loc({ textContent: async () => null, count: async () => 0 });
    const frame = (inner: string) => (inner.includes("#checkbox") ? loc() : grid);
    const p = pageWith({ "hcaptcha.com": loc({ count: async () => 1 }) }, frame);
    expect(await solveInteractiveChallenge(env, p, "hcaptcha")).toBe(false);
  });

  it("breaks when the hcaptcha screenshot cannot be captured", async () => {
    const grid = loc({ textContent: async () => "pick boats", count: async () => 4, screenshot: async () => { throw new Error("no"); } });
    const frame = (inner: string) => (inner.includes("#checkbox") ? loc() : grid);
    const p = pageWith({ "hcaptcha.com": loc({ count: async () => 1 }) }, frame);
    expect(await solveInteractiveChallenge(env, p, "hcaptcha")).toBe(false);
  });

  it("recovers from an hcaptcha textContent failure and clicks that reject", async () => {
    gemini.solveImageGrid.mockRejectedValue(new Error("model down"));
    const grid = loc({
      textContent: async () => { throw new Error("x"); },
      count: async () => 9,
      screenshot: async () => new Uint8Array([1]),
      click: async () => { throw new Error("click failed"); }
    });
    const frame = (inner: string) => (inner.includes("#checkbox") ? loc() : grid);
    const p = pageWith({ "hcaptcha.com": loc({ count: async () => 1 }) }, frame);
    expect(await solveInteractiveChallenge(env, p, "hcaptcha")).toBe(false);
  });

  it("hcaptcha solves and clicks tiles when the grid matches", async () => {
    gemini.solveImageGrid.mockResolvedValue([0, 1]);
    const grid = loc({ textContent: async () => "pick boats", count: async () => 4, screenshot: async () => new Uint8Array([1]) });
    const frame = (inner: string) => (inner.includes("#checkbox") ? loc() : grid);
    const p = pageWith({ "hcaptcha.com": loc({ count: async () => 0 }) }, frame);
    expect(await solveInteractiveChallenge(env, p, "hcaptcha")).toBe(true);
  });

  it("hcaptcha clicks matching tiles + submit whose failures are swallowed", async () => {
    gemini.solveImageGrid.mockResolvedValue([0, 1]);
    const grid = loc({
      textContent: async () => "pick boats",
      count: async () => 9,
      screenshot: async () => new Uint8Array([1]),
      click: async () => { throw new Error("click failed"); } // tile + submit .catch fire
    });
    const frame = (inner: string) => (inner.includes("#checkbox") ? loc() : grid);
    const p = pageWith({ "hcaptcha.com": loc({ count: async () => 1 }) }, frame);
    expect(await solveInteractiveChallenge(env, p, "hcaptcha")).toBe(false);
  });

  it("hcaptcha recovers when solveImageGrid rejects on a valid grid", async () => {
    gemini.solveImageGrid.mockRejectedValue(new Error("model down"));
    const grid = loc({ textContent: async () => "pick boats", count: async () => 9, screenshot: async () => new Uint8Array([1]) });
    const frame = (inner: string) => (inner.includes("#checkbox") ? loc() : grid);
    const p = pageWith({ "hcaptcha.com": loc({ count: async () => 1 }) }, frame);
    expect(await solveInteractiveChallenge(env, p, "hcaptcha")).toBe(false);
  });
});
