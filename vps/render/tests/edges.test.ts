import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Page } from "playwright";

vi.mock("playwright", () => ({
  chromium: { launch: vi.fn(async () => ({ newContext: vi.fn(), close: vi.fn() })) }
}));

import { createApp, type AppDeps } from "../src/app";
import { CONFIG, str } from "../src/config";
import { applyStrategy, reachForm } from "../src/reach";
import { fillField } from "../src/fill";
import { collectFieldsInPage } from "../src/extract";
import { fakePage, goodFields, loc, TEST_CREDS } from "./helpers/fake-page";

const asPage = (p: ReturnType<typeof fakePage>) => p as unknown as Page;
const JOB_URL = "https://jobs.lever.co/acme/1/apply";
const WD_URL = "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/1";

function appWith(page: ReturnType<typeof fakePage>) {
  const runPhase = vi.fn(
    async <T>(_u: string, _h: string, fn: (c: never) => Promise<T>): Promise<T> =>
      fn({ page: page as unknown as Page, context: {}, key: "k" } as never)
  );
  return createApp({ runPhase } as AppDeps);
}

const authed = (app: ReturnType<typeof createApp>, path: string) =>
  request(app).post(path).set("authorization", `Bearer ${CONFIG.token}`);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("config str", () => {
  afterEach(() => delete process.env.RENDER_TEST_STR);

  it("falls back when unset or blank", () => {
    expect(str("RENDER_TEST_STR", "fb")).toBe("fb");
    process.env.RENDER_TEST_STR = "   ";
    expect(str("RENDER_TEST_STR", "fb")).toBe("fb");
  });

  it("uses the configured value", () => {
    process.env.RENDER_TEST_STR = "set";
    expect(str("RENDER_TEST_STR", "fb")).toBe("set");
  });
});

describe("auth middleware with no bearer configured", () => {
  it("lets requests through, for local dev only", async () => {
    vi.resetModules();
    vi.doMock("../src/config", async () => {
      const actual = await vi.importActual<typeof import("../src/config")>("../src/config");
      return { ...actual, CONFIG: { ...actual.CONFIG, token: "" } };
    });
    const { createApp: create } = await import("../src/app");
    const app = create({
      runPhase: (async (_u: string, _h: string, fn: (c: never) => Promise<unknown>) =>
        fn({ page: fakePage({ url: JOB_URL, eval$$: () => goodFields() }), context: {}, key: "k" } as never)) as never
    });

    // No authorization header at all.
    const res = await request(app).post("/extract").send({ userId: "u1", jobUrl: JOB_URL, ats: "lever" });
    expect(res.status).toBe(200);

    vi.doUnmock("../src/config");
    vi.resetModules();
  });
});

describe("request parsing edges", () => {
  const page = () => fakePage({ url: JOB_URL, eval$$: () => goodFields() });

  it("400s a completely empty body on every phase route", async () => {
    const app = appWith(page());
    for (const path of ["/session/ensure", "/extract", "/fill"]) {
      const res = await authed(app, path).send();
      expect(res.status, path).toBe(400);
    }
  });

  it("rejects a non-string jobUrl as unsafe", async () => {
    const app = appWith(page());
    const res = await authed(app, "/extract").send({ userId: "u1", jobUrl: 42, ats: "lever" });
    // A non-string collapses to "", which fails the URL guard rather than the
    // shape check, so it reports as unsafe.
    expect(res.body).toEqual({ error: "invalid_or_unsafe_url" });
  });

  it("400s a blank userId", async () => {
    const app = appWith(page());
    const res = await authed(app, "/extract").send({ userId: "   ", jobUrl: JOB_URL, ats: "lever" });
    expect(res.status).toBe(400);
  });

  it("reports an unsafe URL as a structured error on every phase route", async () => {
    const app = appWith(page());
    for (const path of ["/session/ensure", "/extract", "/fill"]) {
      const res = await authed(app, path).send({
        userId: "u1",
        jobUrl: "http://10.0.0.1/admin",
        ats: "workday",
        account: TEST_CREDS,
        answers: []
      });
      expect(res.status, path).toBe(200);
      expect(res.body, path).toEqual({ error: "invalid_or_unsafe_url" });
    }
  });

  it("treats a missing account object as missing credentials", async () => {
    const app = appWith(fakePage({ url: WD_URL }));
    const res = await authed(app, "/session/ensure").send({
      userId: "u1",
      jobUrl: WD_URL,
      ats: "workday"
    });
    expect(res.status).toBe(400);
  });

  it("ignores a non-string verification code or link", async () => {
    const app = appWith(fakePage());
    const res = await authed(app, "/verify").send({
      userId: "u1",
      tenantHost: "acme.com",
      link: 5,
      code: 9
    });
    expect(res.status).toBe(400);
  });

  it("defaults a missing playbook to none", async () => {
    const app = appWith(page());
    const res = await authed(app, "/extract").send({ userId: "u1", jobUrl: JOB_URL, ats: "lever" });
    expect(res.body.recovery).toBeNull();
  });
});

describe("reach edges", () => {
  it("keeps scrolling when an iframe has no src attribute", async () => {
    const embed = loc({ count: vi.fn(async () => 1), getAttribute: vi.fn(async () => null) });
    const page = fakePage({ locators: { "iframe[src*=": embed } });
    await applyStrategy(asPage(page), "form", { action: "iframe" }, "lever");
    // Never navigated; fell through to the scroll-and-retry loop.
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.mouse.wheel).toHaveBeenCalledTimes(5);
  });

  it("tolerates a load-state wait that rejects after a click", async () => {
    const target = loc({ count: vi.fn(async () => 1) });
    const page = fakePage({ locators: { ":has-text(": target } });
    page.waitForLoadState = vi.fn(async () => {
      throw new Error("navigation interrupted");
    });
    await expect(
      applyStrategy(asPage(page), "form", { action: "click" }, "lever")
    ).resolves.toBeUndefined();
    expect(target.click).toHaveBeenCalled();
  });

  it("tolerates a selector wait that rejects after scrolling", async () => {
    const page = fakePage();
    page.waitForSelector = vi.fn(async () => {
      throw new Error("timeout");
    });
    await expect(
      applyStrategy(asPage(page), "form", { action: "scroll" }, "lever")
    ).resolves.toBeUndefined();
  });

  it("proceeds when the initial form wait times out", async () => {
    // Greenhouse, whose openApplication does not itself await a selector, so the
    // rejection under test is reachForm's own best-effort wait.
    const url = "https://job-boards.greenhouse.io/acme/jobs/1";
    const page = fakePage({
      url,
      eval$$: () => goodFields(),
      locators: { 'form[id*="application"]': loc({ count: vi.fn(async () => 1) }) }
    });
    page.waitForSelector = vi.fn(async () => {
      throw new Error("timeout");
    });
    const result = await reachForm(asPage(page), url, "greenhouse", {}, { throwIfNotFound: true });
    expect(result.rawFields).toHaveLength(3);
  });

  it("keeps looking when vision claims a form but the page-wide sweep finds none", async () => {
    const page = fakePage({ url: JOB_URL, eval$$: () => [] });
    const diagnose = vi.fn(async () => ({
      action: "none" as const,
      form_visible: true,
      reason: "form is behind a login"
    }));
    await expect(
      reachForm(asPage(page), JOB_URL, "lever", { diagnose }, { throwIfNotFound: true })
    ).rejects.toThrow(/behind a login/);
  });

  it("keeps a failed-playbook flag through a successful vision recovery", async () => {
    let call = 0;
    // adapter, playbook+adapter, playbook body sweep, then vision succeeds.
    const seq = [[], [], [], goodFields()];
    const page = fakePage({
      url: JOB_URL,
      eval$$: () => seq[Math.min(call++, seq.length - 1)]
    });
    const result = await reachForm(
      asPage(page),
      JOB_URL,
      "lever",
      {
        playbook: { action: "scroll" },
        diagnose: async () => ({ action: "scroll" as const })
      },
      { throwIfNotFound: true }
    );
    expect(result.recovery?.source).toBe("vision");
    expect(result.playbookFailed).toBe(true);
  });
});

describe("fill edges", () => {
  const info = (over: Record<string, string> = {}) => ({
    tag: "input",
    type: "text",
    cls: "",
    role: "",
    autocomplete: "",
    ...over
  });

  it("routes a checkbox-typed field to the group filler", async () => {
    const el = loc({ count: vi.fn(async () => 1), evaluate: vi.fn(async () => info({ type: "checkbox" })) });
    const box = loc({ count: vi.fn(async () => 1) });
    const page = fakePage();
    page.locator = vi.fn((sel: string) => (sel.includes('type="checkbox"') ? box : el));
    await fillField(asPage(page), "form", { name: "agree", label: "Agree", value: "true" });
    expect(box.check).toHaveBeenCalled();
  });

  it("treats an unreadable radio label as no match", async () => {
    const radio = loc({
      count: vi.fn(async () => 1),
      getAttribute: vi.fn(async (a: string) => (a === "id" ? "r1" : "other"))
    });
    radio.nth = vi.fn(() => radio);
    const label = loc({
      textContent: vi.fn(async () => {
        throw new Error("detached");
      })
    });
    const el = loc({ count: vi.fn(async () => 1), evaluate: vi.fn(async () => info({ type: "radio" })) });
    const page = fakePage();
    page.locator = vi.fn((sel: string) => {
      if (sel.startsWith("label[for=")) return label;
      if (sel.includes('type="radio"')) return radio;
      return el;
    });
    await fillField(asPage(page), "form", { name: "r", label: "R", value: "Yes" });
    expect(radio.check).not.toHaveBeenCalled();
  });

  it("ticks a radio matched by label even when check rejects", async () => {
    const radio = loc({
      count: vi.fn(async () => 1),
      getAttribute: vi.fn(async (a: string) => (a === "id" ? "r1" : null)),
      check: vi.fn(async () => {
        throw new Error("intercepted");
      })
    });
    radio.nth = vi.fn(() => radio);
    const label = loc({ textContent: vi.fn(async () => " Yes ") });
    const el = loc({ count: vi.fn(async () => 1), evaluate: vi.fn(async () => info({ type: "radio" })) });
    const page = fakePage();
    page.locator = vi.fn((sel: string) => {
      if (sel.startsWith("label[for=")) return label;
      if (sel.includes('type="radio"')) return radio;
      return el;
    });
    await expect(
      fillField(asPage(page), "form", { name: "r", label: "R", value: "Yes" })
    ).resolves.toBeUndefined();
    expect(radio.check).toHaveBeenCalled();
  });
});

describe("extract in-page fallbacks", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  function withDom(opts: { byId?: Record<string, unknown>; label?: unknown }, run: () => unknown) {
    const g = globalThis as any;
    const prevDoc = g.document;
    const prevCss = g.CSS;
    g.document = {
      querySelector: () => opts.label ?? null,
      querySelectorAll: () => [],
      getElementById: (id: string) => opts.byId?.[id] ?? null
    };
    g.CSS = { escape: (v: string) => v };
    try {
      return run();
    } finally {
      g.document = prevDoc;
      g.CSS = prevCss;
    }
  }

  const node = (attrs: Record<string, string>, extra: Record<string, unknown> = {}) => ({
    tagName: "INPUT",
    getAttribute: (k: string) => attrs[k] ?? null,
    hasAttribute: (k: string) => k in attrs,
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    ...extra
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it("ignores an aria-labelledby id that resolves to nothing", () => {
    const fields = withDom({ byId: {} }, () =>
      collectFieldsInPage([node({ type: "text", name: "n", "aria-labelledby": "gone" })])
    ) as ReturnType<typeof collectFieldsInPage>;
    // Falls all the way through to the name.
    expect(fields[0].label).toBe("n");
  });

  it("ignores an aria-labelledby target with no text", () => {
    const fields = withDom({ byId: { l1: { textContent: "   " } } }, () =>
      collectFieldsInPage([node({ type: "text", name: "n", "aria-labelledby": "l1" })])
    ) as ReturnType<typeof collectFieldsInPage>;
    expect(fields[0].label).toBe("n");
  });

  it("ignores a label element with no textContent", () => {
    const fields = withDom({ label: { textContent: null } }, () =>
      collectFieldsInPage([node({ type: "text", name: "n", id: "i" })])
    ) as ReturnType<typeof collectFieldsInPage>;
    expect(fields[0].label).toBe("n");
  });

  it("treats a select option with no textContent as blank", () => {
    const select = {
      tagName: "SELECT",
      getAttribute: (k: string) => (k === "name" ? "s" : null),
      hasAttribute: () => false,
      closest: () => null,
      querySelector: () => null,
      querySelectorAll: () => [{ textContent: null }, { textContent: "Real" }]
    };
    const fields = withDom({}, () => collectFieldsInPage([select])) as ReturnType<
      typeof collectFieldsInPage
    >;
    expect(fields[0].options).toEqual(["Real"]);
  });
});
