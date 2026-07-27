/**
 * Persistent browser sessions: the capability Cloudflare Browser Rendering could
 * not give us.
 *
 * A Workday application needs a candidate account on the employer's tenant, an
 * email verification round trip, and then a multi-page wizard, all inside ONE
 * logged-in session. Browser Rendering opened a throwaway browser per phase, so
 * nothing survived. Here, contexts are cached per `userId:tenantHost` and their
 * cookies are persisted to disk as Playwright `storageState`, so a session
 * survives both a process restart and the days-long review gate.
 *
 * Concurrency safety mirrors newCoworker's aiflow-render, which learned it the
 * hard way: entries store a context PROMISE (so concurrent first-callers dedupe
 * to one context instead of leaking duplicates) plus an `inUse` refcount, and
 * ONLY idle entries are ever evicted, so a context is never closed out from
 * under an in-flight request.
 */
import { chromium, type Browser, type BrowserContext } from "playwright";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { CONFIG } from "./config.js";

/** A realistic desktop UA: the headless default advertises automation. */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface Entry {
  ctx: Promise<BrowserContext>;
  context?: BrowserContext;
  lastUsed: number;
  inUse: number;
  doomed: boolean;
}

const sessions = new Map<string, Entry>();
let browserPromise: Promise<Browser> | null = null;

/** The shared Chromium, launched on first use. */
export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      args: [
        "--no-sandbox",
        // Strip the clearest automation tell. Full stealth hardening is a
        // separate concern; this alone measurably helps invisible captcha scores.
        "--disable-blink-features=AutomationControlled"
      ]
    });
  }
  return browserPromise;
}

/** Session key for a user on one employer tenant. */
export function sessionKey(userId: string, tenantHost: string): string {
  return `${userId}:${tenantHost.toLowerCase()}`;
}

/**
 * Where a session's cookies live. The key is hashed so a hostile tenant host
 * cannot escape the state directory through path traversal.
 */
export function storageStatePath(key: string): string {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return path.join(CONFIG.stateDir, `${digest}.json`);
}

/** Previously saved cookies for this key, or undefined when there are none. */
async function loadStorageState(key: string): Promise<string | undefined> {
  const file = storageStatePath(key);
  try {
    await readFile(file, "utf8");
    return file;
  } catch {
    // First run for this user+tenant, or the file was pruned. Start clean.
    return undefined;
  }
}

/**
 * Persist the session's cookies so a later phase (or a restart) resumes logged
 * in. Best-effort: a failed save only means the next run logs in again.
 */
export async function saveStorageState(key: string, context: BrowserContext): Promise<boolean> {
  try {
    await mkdir(CONFIG.stateDir, { recursive: true });
    await context.storageState({ path: storageStatePath(key) });
    return true;
  } catch {
    return false;
  }
}

function closeEntry(entry: Entry): void {
  Promise.resolve(entry.ctx)
    .then((c) => c.close())
    .catch(() => {});
}

/** Close idle sessions past their TTL, then trim to the size cap. */
export function evictStale(now = Date.now()): void {
  for (const [key, entry] of sessions) {
    if (entry.inUse === 0 && now - entry.lastUsed > CONFIG.sessionTtlMs) {
      sessions.delete(key);
      closeEntry(entry);
    }
  }
  if (sessions.size > CONFIG.maxSessions) {
    const idle = [...sessions.entries()]
      .filter(([, e]) => e.inUse === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (sessions.size > CONFIG.maxSessions && idle.length) {
      const [key, entry] = idle.shift()!;
      sessions.delete(key);
      closeEntry(entry);
    }
  }
}

/**
 * Acquire (creating if needed) the session for `key`, bumping its refcount.
 * Returns the entry itself so release operates on the shared object even after a
 * poisoned session has been dropped from the map.
 */
export async function acquireSession(key: string): Promise<Entry> {
  let entry = sessions.get(key);
  if (!entry) {
    // Reserve the map slot SYNCHRONOUSLY, before any await. Awaiting the browser
    // launch first would let two concurrent first-callers both miss the lookup
    // and leak a duplicate context (and, worse, a duplicate login) for the same
    // user+tenant. Everything async happens inside the stored promise instead.
    const created: Entry = {
      ctx: (async () => {
        const browser = await getBrowser();
        const statePath = await loadStorageState(key);
        return browser.newContext({
          userAgent: USER_AGENT,
          viewport: { width: 1440, height: 900 },
          locale: "en-US",
          ...(statePath ? { storageState: statePath } : {})
        });
      })(),
      lastUsed: Date.now(),
      inUse: 0,
      doomed: false
    };
    sessions.set(key, created);
    entry = created;
  }
  entry.inUse++;
  entry.lastUsed = Date.now();
  evictStale();
  try {
    entry.context = await entry.ctx;
    return entry;
  } catch (err) {
    // Context creation failed: drop the poisoned entry so the next call retries
    // cleanly instead of awaiting the same rejected promise forever.
    entry.inUse--;
    if (sessions.get(key) === entry) sessions.delete(key);
    throw err;
  }
}

/**
 * Release a session after a request finishes. On `poisoned` (a failed login, a
 * render error) the entry is removed so no NEW request reuses it, but the
 * underlying context is closed only once the LAST in-flight request releases it.
 */
export function finishSession(key: string, entry: Entry, poisoned: boolean): void {
  entry.inUse = Math.max(0, entry.inUse - 1);
  entry.lastUsed = Date.now();
  if (poisoned) {
    entry.doomed = true;
    if (sessions.get(key) === entry) sessions.delete(key);
  }
  if (entry.doomed && entry.inUse === 0) closeEntry(entry);
}

/**
 * Forget a session entirely: drop the cached context AND delete its cookies on
 * disk, so a later run for this user+tenant starts logged out.
 *
 * Used when the user disconnects an account they own (LinkedIn). Mirrors the
 * poison path so an in-flight request is never closed out from under: the entry
 * is removed from the map immediately, but the context is closed only once no
 * request still holds it. The cookie file is removed regardless (force, so a
 * missing file is not an error).
 */
export async function dropSession(key: string): Promise<void> {
  const entry = sessions.get(key);
  if (entry) {
    entry.doomed = true;
    sessions.delete(key);
    if (entry.inUse === 0) closeEntry(entry);
  }
  await rm(storageStatePath(key), { force: true }).catch(() => {});
}

/** Close every session and the browser. Used on shutdown and by tests. */
export async function shutdown(): Promise<void> {
  for (const [key, entry] of sessions) {
    sessions.delete(key);
    closeEntry(entry);
  }
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    browserPromise = null;
    await browser?.close().catch(() => {});
  }
}

/** Live session count, for /health and tests. */
export function sessionCount(): number {
  return sessions.size;
}
