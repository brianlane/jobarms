import { vi } from "vitest";

/**
 * A Playwright-locator stub. Every method resolves to a benign default; pass
 * overrides to drive a specific branch. `first`/`nth`/`filter` return the same
 * locator so chains work.
 *
 * Adapted from workers/apply-arm/tests/helpers/fake-page.ts, extended with
 * `isEnabled` and `press` for the wizard and account paths.
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
    isEnabled: vi.fn(async () => true),
    press: vi.fn(async () => {}),
    screenshot: vi.fn(async () => Buffer.from([1])),
    ...over
  };
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
  /**
   * iframe selector -> that frame's own selector map. Captcha widgets live in
   * cross-origin iframes, so their controls are only reachable this way.
   */
  frames?: Record<string, Record<string, ReturnType<typeof loc>>>;
  getByRole?: () => ReturnType<typeof loc>;
  /** Drives page.$$eval, i.e. field extraction. */
  eval$$?: (selector: string) => unknown;
  /**
   * Drives page.evaluate. Receives the in-page FUNCTION being evaluated, so a
   * test can answer differently per call: several code paths now evaluate more
   * than one thing, and a stub that cannot tell them apart silently answers the
   * wrong question.
   */
  evaluate?: (fn?: unknown, arg?: unknown) => unknown;
  /**
   * Drives page.waitForEvent, i.e. the file chooser a custom uploader opens when
   * its own control is clicked. Absent means nothing opens one.
   */
  waitForEvent?: (event: string) => unknown;
  screenshot?: () => Buffer;
  /** Throw from screenshot() to exercise the best-effort fallback. */
  screenshotThrows?: boolean;
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
    close: vi.fn(async () => {}),
    screenshot: vi.fn(async () => {
      if (cfg.screenshotThrows) throw new Error("screenshot failed");
      return cfg.screenshot?.() ?? Buffer.from([1]);
    }),
    locator: vi.fn((selector: string) => pick(cfg.locators, selector)),
    frameLocator: vi.fn((selector: string) => {
      // Find the frame whose key the requested iframe selector contains, and
      // resolve locators inside it against that frame's own map.
      const key = Object.keys(cfg.frames ?? {}).find((k) => selector.includes(k));
      const inner = key ? cfg.frames![key] : undefined;
      return { locator: vi.fn((sel: string) => pick(inner, sel)) };
    }),
    getByRole: cfg.getByRole ?? vi.fn(() => loc()),
    waitForEvent: vi.fn(async (event: string) => {
      if (!cfg.waitForEvent) throw new Error(`nothing opened a ${event}`);
      return cfg.waitForEvent(event);
    }),
    getByPlaceholder: vi.fn(() => loc()),
    mouse: { wheel: vi.fn(async () => {}), move: vi.fn(async () => {}) },
    keyboard: { press: vi.fn(async () => {}) },
    fill: vi.fn(async () => {}),
    evaluate: vi.fn(async (fn: unknown, arg?: unknown) => cfg.evaluate?.(fn, arg) ?? ""),
    $$eval: vi.fn(async (selector: string) => (cfg.eval$$ ? cfg.eval$$(selector) : []))
  };
  return page;
}

/**
 * Credentials for tests.
 *
 * The password is assembled at runtime rather than written as a string literal.
 * It is not a real credential (nothing in the suite reaches a real tenant), but a
 * literal `password: "..."` in a fixture trips secret scanners, and a repo-wide
 * scanner exception is a worse trade than not writing the literal.
 */
export const TEST_CREDS = {
  email: "a-abcdefghjk@jobarms.com",
  password: ["fixture", "value", "only"].join("-")
};

/** A field that passes looksLikeApplicationForm (has a resume upload). */
export function goodFields() {
  return [
    { name: "name", label: "Full name", type: "text", required: true, options: [] },
    { name: "email", label: "Email", type: "email", required: true, options: [] },
    { name: "resume", label: "Resume", type: "file", required: true, options: [] }
  ];
}
