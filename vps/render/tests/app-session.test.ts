import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Covers the REAL phase runner (the one the service uses in production), which
 * every other app test replaces with an injected stub. The session layer is
 * mocked so the runner's own contract can be asserted: open a page, run the
 * phase, persist cookies, close the page, release the session, and poison the
 * cached context when the phase threw.
 */

const page = {
  goto: vi.fn(async () => {}),
  url: vi.fn(() => "https://jobs.lever.co/acme/1/apply"),
  setDefaultTimeout: vi.fn(),
  waitForSelector: vi.fn(async () => {}),
  waitForTimeout: vi.fn(async () => {}),
  waitForLoadState: vi.fn(async () => {}),
  screenshot: vi.fn(async () => Buffer.from([7])),
  locator: vi.fn(() => ({
    count: vi.fn(async () => 0),
    first: vi.fn(() => ({ count: vi.fn(async () => 0) }))
  })),
  $$eval: vi.fn(async () => [
    { name: "name", label: "Full name", type: "text", required: true, options: [] },
    { name: "email", label: "Email", type: "email", required: true, options: [] },
    { name: "resume", label: "Resume", type: "file", required: true, options: [] }
  ]),
  close: vi.fn(async () => {})
};

const context = { newPage: vi.fn(async () => page) };
const entry = { context, inUse: 1, lastUsed: 0, doomed: false, ctx: Promise.resolve(context) };

const acquireSession = vi.fn(async () => entry);
const finishSession = vi.fn();
const saveStorageState = vi.fn(async () => true);

vi.mock("playwright", () => ({ chromium: { launch: vi.fn() } }));
vi.mock("../src/sessions", () => ({
  acquireSession: (...a: unknown[]) => acquireSession(...(a as [])),
  finishSession: (...a: unknown[]) => finishSession(...(a as [])),
  saveStorageState: (...a: unknown[]) => saveStorageState(...(a as [])),
  sessionKey: (u: string, h: string) => `${u}:${h}`,
  sessionCount: () => 0
}));

import { createApp } from "../src/app";
import { CONFIG } from "../src/config";

const JOB_URL = "https://jobs.lever.co/acme/1/apply";
const body = { userId: "u1", jobUrl: JOB_URL, ats: "lever" };
const post = (app: ReturnType<typeof createApp>, path: string, b: unknown = body) =>
  request(app).post(path).set("authorization", `Bearer ${CONFIG.token}`).send(b);

beforeEach(() => {
  vi.clearAllMocks();
  context.newPage.mockResolvedValue(page);
  acquireSession.mockResolvedValue(entry);
});

describe("real runPhase", () => {
  it("opens a page, runs the phase, saves cookies, and releases the session", async () => {
    const app = createApp();
    const res = await post(app, "/extract");

    expect(res.status).toBe(200);
    expect(res.body.fields).toHaveLength(2);
    expect(acquireSession).toHaveBeenCalledWith("u1:jobs.lever.co");
    expect(page.setDefaultTimeout).toHaveBeenCalledWith(CONFIG.actionTimeoutMs);
    // Cookies are saved BEFORE the page closes, so a fresh login persists.
    expect(saveStorageState).toHaveBeenCalledWith("u1:jobs.lever.co", context);
    expect(page.close).toHaveBeenCalled();
    expect(finishSession).toHaveBeenCalledWith("u1:jobs.lever.co", entry, false);
  });

  it("poisons the cached context when the phase throws", async () => {
    // No fields anywhere: reachForm gives up with form_not_found, which throws
    // out of the phase and must mark the session poisoned.
    page.$$eval.mockResolvedValue([]);
    const app = createApp();

    const res = await post(app, "/extract");

    expect(res.body.error).toBe("form_not_found");
    expect(finishSession).toHaveBeenCalledWith("u1:jobs.lever.co", entry, true);
    expect(page.close).toHaveBeenCalled();
  });

  it("still releases the session when the page never opened", async () => {
    context.newPage.mockRejectedValueOnce(new Error("out of memory"));
    const app = createApp();

    const res = await post(app, "/extract");

    expect(res.body.error).toBe("render_failed");
    expect(page.close).not.toHaveBeenCalled();
    expect(finishSession).toHaveBeenCalledWith("u1:jobs.lever.co", entry, true);
  });

  it("tolerates a page that refuses to close", async () => {
    page.close.mockRejectedValueOnce(new Error("already closed"));
    const app = createApp();
    const res = await post(app, "/extract");
    expect(res.status).toBe(200);
  });

  it("surfaces a session that cannot be acquired as render_failed", async () => {
    acquireSession.mockRejectedValueOnce(new Error("browser gone"));
    const app = createApp();
    const res = await post(app, "/extract");
    expect(res.body).toMatchObject({ error: "render_failed" });
  });
});
