import { vi } from "vitest";

/**
 * A Playwright-locator stub. Every method resolves to a benign default; pass
 * overrides to drive a specific branch. `first`/`nth`/`filter` return the same
 * locator so chains work.
 */
export function loc(over: Record<string, unknown> = {}) {
  const l: Record<string, unknown> = {
    count: vi.fn(async () => 0),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
    uncheck: vi.fn(async () => {}),
    selectOption: vi.fn(async () => {}),
    getAttribute: vi.fn(async () => null),
    textContent: vi.fn(async () => null),
    evaluate: vi.fn(async () => ({})),
    scrollIntoViewIfNeeded: vi.fn(async () => {}),
    boundingBox: vi.fn(async () => null),
    pressSequentially: vi.fn(async () => {}),
    setInputFiles: vi.fn(async () => {}),
    waitFor: vi.fn(async () => {}),
    screenshot: vi.fn(async () => new Uint8Array([1])),
    ...over
  };
  // Chain methods default to returning the same locator, but honor overrides
  // (e.g. a per-index `nth` that returns distinct option/box locators).
  l.first = over.first ?? vi.fn(() => l);
  l.nth = over.nth ?? vi.fn(() => l);
  l.filter = over.filter ?? vi.fn(() => l);
  return l;
}

export interface FakePageConfig {
  url?: string;
  content?: string;
  /** selector -> locator; unmatched selectors get an empty (count 0) locator. */
  locators?: Record<string, ReturnType<typeof loc>>;
  frameLocators?: Record<string, ReturnType<typeof loc>>;
  getByRole?: () => ReturnType<typeof loc>;
  eval$$?: (selector: string, fn: (els: unknown[]) => unknown) => unknown;
  screenshot?: () => Uint8Array;
}

/** Build a fake Playwright Page. Selector lookups are substring-matched. */
export function fakePage(cfg: FakePageConfig = {}) {
  const pick = (map: Record<string, ReturnType<typeof loc>> | undefined, selector: string) => {
    if (map) {
      for (const key of Object.keys(map)) {
        if (selector.includes(key)) return map[key];
      }
    }
    return loc();
  };
  let currentUrl = cfg.url ?? "https://jobs.lever.co/acme/1";
  const page: Record<string, unknown> = {
    goto: vi.fn(async (u: string) => {
      currentUrl = u;
    }),
    url: vi.fn(() => currentUrl),
    content: vi.fn(async () => cfg.content ?? ""),
    setDefaultTimeout: vi.fn(),
    waitForSelector: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    screenshot: vi.fn(async () => cfg.screenshot?.() ?? new Uint8Array([1])),
    locator: vi.fn((selector: string) => pick(cfg.locators, selector)),
    frameLocator: vi.fn((selector: string) => pick(cfg.frameLocators, selector)),
    getByRole: cfg.getByRole ?? vi.fn(() => loc()),
    mouse: { wheel: vi.fn(async () => {}), move: vi.fn(async () => {}) },
    keyboard: { press: vi.fn(async () => {}) },
    $$eval: vi.fn(async (selector: string, fn: (els: unknown[]) => unknown) =>
      cfg.eval$$ ? cfg.eval$$(selector, fn) : []
    )
  };
  return page;
}
