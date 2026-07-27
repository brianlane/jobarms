import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** One fake BrowserContext per newContext() call, so identity can be asserted. */
const contexts: Array<{ close: ReturnType<typeof vi.fn>; storageState: ReturnType<typeof vi.fn> }> =
  [];
/** Options declared so assertions can read `storageState` without a cast. */
const newContext = vi.fn(async (_opts: { storageState?: string } = {}) => {
  const ctx = {
    close: vi.fn(async () => {}),
    storageState: vi.fn(async () => ({})),
    newPage: vi.fn(async () => ({}))
  };
  contexts.push(ctx);
  return ctx;
});
const browserClose = vi.fn(async () => {});
/** Launch args declared so the stealth-flag assertion needs no cast. */
const launch = vi.fn(async (_opts: { args: string[] } = { args: [] }) => ({
  newContext,
  close: browserClose
}));

vi.mock("playwright", () => ({ chromium: { launch: (...a: unknown[]) => launch(...a) } }));

const readFile = vi.fn(async () => "{}");
const mkdir = vi.fn(async () => undefined);
const writeFile = vi.fn(async () => undefined);
const rm = vi.fn(async () => undefined);
vi.mock("node:fs/promises", () => ({
  readFile: (...a: unknown[]) => readFile(...a),
  mkdir: (...a: unknown[]) => mkdir(...a),
  writeFile: (...a: unknown[]) => writeFile(...a),
  rm: (...a: unknown[]) => rm(...a)
}));

import {
  acquireSession,
  dropSession,
  evictStale,
  finishSession,
  getBrowser,
  saveStorageState,
  sessionCount,
  sessionKey,
  shutdown,
  storageStatePath
} from "../src/sessions";
import { CONFIG } from "../src/config";

beforeEach(() => {
  contexts.length = 0;
  launch.mockClear();
  newContext.mockClear();
  browserClose.mockClear();
  readFile.mockClear();
  readFile.mockResolvedValue("{}");
  mkdir.mockClear();
  rm.mockClear();
  rm.mockResolvedValue(undefined);
});
afterEach(async () => {
  await shutdown();
});

describe("sessionKey", () => {
  it("scopes a session to one user on one tenant, case-insensitively", () => {
    expect(sessionKey("u1", "ACME.wd1.myworkdayjobs.com")).toBe(
      "u1:acme.wd1.myworkdayjobs.com"
    );
    expect(sessionKey("u1", "a.com")).not.toBe(sessionKey("u2", "a.com"));
  });
});

describe("storageStatePath", () => {
  it("hashes the key so a hostile tenant host cannot escape the state dir", () => {
    const path = storageStatePath("u1:../../etc/passwd");
    expect(path.startsWith(CONFIG.stateDir)).toBe(true);
    expect(path).not.toContain("..");
    expect(path).toMatch(/[0-9a-f]{32}\.json$/);
  });

  it("is stable for the same key and distinct across keys", () => {
    expect(storageStatePath("a")).toBe(storageStatePath("a"));
    expect(storageStatePath("a")).not.toBe(storageStatePath("b"));
  });
});

describe("getBrowser", () => {
  it("launches once and reuses the instance", async () => {
    const first = await getBrowser();
    const second = await getBrowser();
    expect(first).toBe(second);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("disables the clearest automation tell", async () => {
    await getBrowser();
    expect(launch.mock.calls[0][0].args).toContain("--disable-blink-features=AutomationControlled");
  });
});

describe("acquireSession", () => {
  it("creates one context per key and reuses it", async () => {
    const a = await acquireSession("u1:acme.com");
    const b = await acquireSession("u1:acme.com");
    expect(a).toBe(b);
    expect(newContext).toHaveBeenCalledTimes(1);
    expect(sessionCount()).toBe(1);
  });

  it("keeps different users on different tenants isolated", async () => {
    await acquireSession("u1:acme.com");
    await acquireSession("u2:acme.com");
    expect(sessionCount()).toBe(2);
    expect(newContext).toHaveBeenCalledTimes(2);
  });

  it("restores saved cookies when a state file exists", async () => {
    await acquireSession("u1:acme.com");
    expect(newContext.mock.calls[0][0].storageState).toBe(storageStatePath("u1:acme.com"));
  });

  it("starts clean on the first run for a key", async () => {
    readFile.mockRejectedValueOnce(new Error("ENOENT"));
    await acquireSession("u1:fresh.com");
    expect(newContext.mock.calls[0][0].storageState).toBeUndefined();
  });

  it("dedupes concurrent first-callers into ONE context", async () => {
    const [a, b] = await Promise.all([
      acquireSession("u1:race.com"),
      acquireSession("u1:race.com")
    ]);
    expect(a).toBe(b);
    expect(newContext).toHaveBeenCalledTimes(1);
    expect(a.inUse).toBe(2);
  });

  it("drops a poisoned entry when context creation fails, so the next call retries", async () => {
    newContext.mockRejectedValueOnce(new Error("out of memory"));
    await expect(acquireSession("u1:bad.com")).rejects.toThrow("out of memory");
    expect(sessionCount()).toBe(0);

    // A retry gets a fresh context rather than awaiting the rejected promise.
    const entry = await acquireSession("u1:bad.com");
    expect(entry.context).toBeDefined();
  });
});

describe("finishSession", () => {
  it("decrements the refcount and keeps a healthy session cached", async () => {
    const entry = await acquireSession("u1:acme.com");
    finishSession("u1:acme.com", entry, false);
    expect(entry.inUse).toBe(0);
    expect(sessionCount()).toBe(1);
  });

  it("never lets the refcount go negative", async () => {
    const entry = await acquireSession("u1:acme.com");
    finishSession("u1:acme.com", entry, false);
    finishSession("u1:acme.com", entry, false);
    expect(entry.inUse).toBe(0);
  });

  it("evicts and closes a poisoned session once it is idle", async () => {
    const entry = await acquireSession("u1:acme.com");
    finishSession("u1:acme.com", entry, true);
    expect(sessionCount()).toBe(0);
    await vi.waitFor(() => expect(contexts[0].close).toHaveBeenCalled());
  });

  it("does NOT close a poisoned session while another request still holds it", async () => {
    const entry = await acquireSession("u1:acme.com");
    await acquireSession("u1:acme.com"); // second in-flight request
    finishSession("u1:acme.com", entry, true);

    // Dropped from the map so nothing NEW reuses it, but still open for the
    // in-flight caller: closing here is what used to break concurrent runs.
    expect(sessionCount()).toBe(0);
    expect(contexts[0].close).not.toHaveBeenCalled();

    finishSession("u1:acme.com", entry, false);
    await vi.waitFor(() => expect(contexts[0].close).toHaveBeenCalled());
  });
});

describe("dropSession", () => {
  it("evicts an idle session and deletes its cookie file", async () => {
    const entry = await acquireSession("u1:acme.com");
    finishSession("u1:acme.com", entry, false);

    await dropSession("u1:acme.com");

    expect(sessionCount()).toBe(0);
    await vi.waitFor(() => expect(contexts[0].close).toHaveBeenCalled());
    expect(rm).toHaveBeenCalledWith(storageStatePath("u1:acme.com"), { force: true });
  });

  it("keeps an in-use context open until the last holder releases it", async () => {
    const entry = await acquireSession("u1:acme.com");

    await dropSession("u1:acme.com");
    // Dropped from the map, but not closed while a request still holds it.
    expect(sessionCount()).toBe(0);
    expect(contexts[0].close).not.toHaveBeenCalled();

    finishSession("u1:acme.com", entry, false);
    await vi.waitFor(() => expect(contexts[0].close).toHaveBeenCalled());
  });

  it("still deletes the cookie file when nothing is cached", async () => {
    await dropSession("u1:never-loaded.com");
    expect(rm).toHaveBeenCalledWith(storageStatePath("u1:never-loaded.com"), { force: true });
  });

  it("tolerates a failed file removal", async () => {
    rm.mockRejectedValueOnce(new Error("permission denied"));
    await expect(dropSession("u1:acme.com")).resolves.toBeUndefined();
  });
});

describe("evictStale", () => {
  it("closes idle sessions past the TTL", async () => {
    const entry = await acquireSession("u1:acme.com");
    finishSession("u1:acme.com", entry, false);

    evictStale(Date.now() + CONFIG.sessionTtlMs + 1);

    expect(sessionCount()).toBe(0);
    await vi.waitFor(() => expect(contexts[0].close).toHaveBeenCalled());
  });

  it("leaves a session that is still in use, however old", async () => {
    await acquireSession("u1:acme.com"); // never released
    evictStale(Date.now() + CONFIG.sessionTtlMs * 10);
    expect(sessionCount()).toBe(1);
  });

  it("trims the oldest idle sessions once past the size cap", async () => {
    for (let i = 0; i <= CONFIG.maxSessions; i++) {
      const entry = await acquireSession(`u${i}:acme.com`);
      finishSession(`u${i}:acme.com`, entry, false);
    }
    // acquireSession calls evictStale itself, so the cap already holds.
    expect(sessionCount()).toBeLessThanOrEqual(CONFIG.maxSessions);
  });

  it("cannot trim below the cap when every session is busy", async () => {
    for (let i = 0; i <= CONFIG.maxSessions; i++) {
      await acquireSession(`busy${i}:acme.com`); // all held
    }
    evictStale();
    expect(sessionCount()).toBe(CONFIG.maxSessions + 1);
  });
});

describe("saveStorageState", () => {
  it("writes the cookie jar to the hashed path", async () => {
    const entry = await acquireSession("u1:acme.com");
    expect(await saveStorageState("u1:acme.com", entry.context!)).toBe(true);
    expect(mkdir).toHaveBeenCalledWith(CONFIG.stateDir, { recursive: true });
    expect(entry.context!.storageState).toHaveBeenCalledWith({
      path: storageStatePath("u1:acme.com")
    });
  });

  it("reports failure without throwing, so a run continues", async () => {
    const entry = await acquireSession("u1:acme.com");
    (entry.context!.storageState as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("disk full")
    );
    expect(await saveStorageState("u1:acme.com", entry.context!)).toBe(false);
  });
});

describe("shutdown", () => {
  it("closes every session and the browser", async () => {
    await acquireSession("u1:acme.com");
    await acquireSession("u2:acme.com");
    await getBrowser();

    await shutdown();

    expect(sessionCount()).toBe(0);
    expect(browserClose).toHaveBeenCalled();
  });

  it("is safe to call when nothing was ever launched", async () => {
    await expect(shutdown()).resolves.toBeUndefined();
  });

  it("tolerates a browser that failed to launch", async () => {
    launch.mockRejectedValueOnce(new Error("no chromium"));
    await expect(getBrowser()).rejects.toThrow("no chromium");
    await expect(shutdown()).resolves.toBeUndefined();
  });
});
