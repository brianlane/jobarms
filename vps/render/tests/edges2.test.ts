import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Page } from "playwright";

/** Fake browser whose contexts can be told to fail on close. */
const contexts: Array<{ close: ReturnType<typeof vi.fn> }> = [];
let closeRejects = false;
let newContextRejects = false;
const newContext = vi.fn(async () => {
  if (newContextRejects) throw new Error("no context");
  const ctx = {
    close: vi.fn(async () => {
      if (closeRejects) throw new Error("close failed");
    }),
    storageState: vi.fn(async () => ({})),
    newPage: vi.fn(async () => ({}))
  };
  contexts.push(ctx);
  return ctx;
});
let browserCloseRejects = false;
const browserClose = vi.fn(async () => {
  if (browserCloseRejects) throw new Error("browser close failed");
});
vi.mock("playwright", () => ({
  chromium: { launch: vi.fn(async () => ({ newContext, close: browserClose })) }
}));
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => "{}"),
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined)
}));

import {
  acquireSession,
  finishSession,
  getBrowser,
  sessionCount,
  shutdown
} from "../src/sessions";
import { ensureAccount } from "../src/account";
import { collectFieldsInPage } from "../src/extract";
import { createApp, type AppDeps } from "../src/app";
import { CONFIG } from "../src/config";
import { fakePage, goodFields, loc, TEST_CREDS } from "./helpers/fake-page";

const asPage = (p: ReturnType<typeof fakePage>) => p as unknown as Page;
const WD_URL = "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/1";

beforeEach(() => {
  contexts.length = 0;
  closeRejects = false;
  newContextRejects = false;
  browserCloseRejects = false;
  vi.clearAllMocks();
});
afterEach(async () => {
  closeRejects = false;
  browserCloseRejects = false;
  await shutdown();
});

describe("session teardown resilience", () => {
  it("swallows a context that refuses to close", async () => {
    const entry = await acquireSession("u1:acme.com");
    closeRejects = true;
    finishSession("u1:acme.com", entry, true);
    // The rejection is contained; nothing escapes to crash the process.
    await vi.waitFor(() => expect(contexts[0].close).toHaveBeenCalled());
  });

  it("swallows a browser that refuses to close", async () => {
    await getBrowser();
    browserCloseRejects = true;
    await expect(shutdown()).resolves.toBeUndefined();
  });

  it("tolerates the map being cleared while a context is still being created", async () => {
    newContextRejects = true;
    const pending = acquireSession("u1:racy.com");
    // Clear the map before the rejection lands, so the cleanup finds no entry
    // of its own to remove.
    await shutdown();
    await expect(pending).rejects.toThrow("no context");
    expect(sessionCount()).toBe(0);
  });

  it("tolerates releasing a session that is no longer cached", async () => {
    const entry = await acquireSession("u1:acme.com");
    await shutdown(); // drops it from the map
    expect(() => finishSession("u1:acme.com", entry, true)).not.toThrow();
  });
});

describe("account probe resilience", () => {
  it("treats a rejecting selector probe as no match and proceeds", async () => {
    // The password probe succeeds but every email-selector probe rejects, so no
    // username field is ever found. Without one this is not a credentials form,
    // so the phase proceeds rather than guessing at a login; if the session
    // really is signed out, the next phase fails honestly with form_not_found.
    const page = fakePage({ evaluate: () => "" });
    page.locator = vi.fn((sel: string) => {
      if (sel === 'input[type="password"]') return loc({ count: vi.fn(async () => 1) });
      return loc({
        count: vi.fn(async () => {
          throw new Error("detached");
        })
      });
    });
    expect(await ensureAccount(asPage(page), TEST_CREDS)).toBe("authenticated");
  });

  it("treats a rejecting consent-checkbox probe as absent", async () => {
    const page = fakePage({ evaluate: () => "Check your email" });
    page.locator = vi.fn((sel: string) => {
      if (sel.includes("Checkbox") || sel.includes('type="checkbox"')) {
        return loc({
          count: vi.fn(async () => {
            throw new Error("gone");
          })
        });
      }
      if (/password|email|verify/i.test(sel)) return loc({ count: vi.fn(async () => 1) });
      return loc({ count: vi.fn(async () => 1) });
    });
    expect(await ensureAccount(asPage(page), TEST_CREDS)).toBe("needs_email_verification");
  });
});

describe("extract option-label fallbacks", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  function withDom(groups: Record<string, any[]>, run: () => unknown) {
    const g = globalThis as any;
    const prevDoc = g.document;
    const prevCss = g.CSS;
    g.document = {
      querySelector: () => null,
      querySelectorAll: (sel: string) => {
        const m = /name="([^"]+)"/.exec(sel);
        return (m && groups[m[1]]) || [];
      },
      getElementById: () => null
    };
    g.CSS = { escape: (v: string) => v };
    try {
      return run();
    } finally {
      g.document = prevDoc;
      g.CSS = prevCss;
    }
  }

  const opt = (attrs: Record<string, string>) => ({
    tagName: "INPUT",
    getAttribute: (k: string) => attrs[k] ?? null,
    hasAttribute: (k: string) => k in attrs,
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it("drops a group option that has no id, aria-label, or value", () => {
    const a = opt({ type: "radio", name: "g" });
    const b = opt({ type: "radio", name: "g", value: "Real" });
    const fields = withDom({ g: [a, b] }, () => collectFieldsInPage([a])) as ReturnType<
      typeof collectFieldsInPage
    >;
    // The unlabelled option contributes nothing rather than an empty choice.
    expect(fields[0].options).toEqual(["Real"]);
  });
});

describe("wizard that cannot advance", () => {
  function appWith(page: ReturnType<typeof fakePage>) {
    const runPhase = vi.fn(
      async <T>(_u: string, _h: string, fn: (c: never) => Promise<T>): Promise<T> =>
        fn({ page: page as unknown as Page, context: {}, key: "k" } as never)
    );
    return createApp({ runPhase } as AppDeps);
  }
  const authed = (app: ReturnType<typeof createApp>, path: string) =>
    request(app).post(path).set("authorization", `Bearer ${CONFIG.token}`);

  it("stops extracting when the wizard offers no way forward", async () => {
    // Neither a next nor a submit control: a single-page Workday application.
    const page = fakePage({ url: WD_URL, eval$$: () => goodFields() });
    const res = await authed(appWith(page), "/extract").send({
      userId: "u1",
      jobUrl: WD_URL,
      ats: "workday"
    });
    expect(res.body.pages).toBe(1);
  });

  it("stops filling when the wizard offers no way forward", async () => {
    const page = fakePage({ url: WD_URL, eval$$: () => goodFields() });
    const res = await authed(appWith(page), "/fill").send({
      userId: "u1",
      jobUrl: WD_URL,
      ats: "workday",
      answers: []
    });
    expect(res.body).toMatchObject({ pages: 1, outcome: "filled" });
  });

  it("400s /verify when the request carries no JSON body at all", async () => {
    const app = appWith(fakePage());
    const res = await request(app)
      .post("/verify")
      .set("authorization", `Bearer ${CONFIG.token}`)
      .send();
    expect(res.status).toBe(400);
  });

  it("continues a code verification even if the tenant root will not load", async () => {
    const page = fakePage({
      locators: { '[data-automation-id="verificationCode"]': loc({ count: vi.fn(async () => 1) }) },
      evaluate: () => ""
    });
    page.goto = vi.fn(async () => {
      throw new Error("dns failure");
    });
    const res = await authed(appWith(page), "/verify").send({
      userId: "u1",
      tenantHost: "acme.wd1.myworkdayjobs.com",
      code: "483920"
    });
    expect(res.body.status).toBe("authenticated");
  });
});
