import { vi } from "vitest";

/** PostgREST-shaped result. */
export interface Result {
  data?: unknown;
  error?: unknown;
}

/**
 * A chainable, awaitable PostgREST query-builder stub. Every filter/mutation
 * method returns the same object; the terminal (`single`, `maybeSingle`, or
 * awaiting the builder directly) resolves to `result`.
 */
export function query(result: Result = { data: null, error: null }) {
  const c: Record<string, unknown> = {};
  const passthrough = [
    "select", "insert", "update", "upsert", "delete",
    "eq", "neq", "in", "order", "limit", "gte", "lte", "like", "ilike", "match", "is"
  ];
  for (const m of passthrough) c[m] = vi.fn(() => c);
  c.single = vi.fn(() => Promise.resolve(result));
  c.maybeSingle = vi.fn(() => Promise.resolve(result));
  const p = Promise.resolve(result);
  c.then = p.then.bind(p);
  return c;
}

/**
 * A `from()` stub backed by per-table FIFO queues: each call to
 * `client.from("applications")` pops the next configured result for that
 * table, so a route that touches the same table several times gets the
 * results in call order. Unconfigured tables resolve to `{ data: null }`.
 */
export function fakeFrom(tableResults: Record<string, Result[]> = {}) {
  const queues: Record<string, Result[]> = {};
  for (const k of Object.keys(tableResults)) queues[k] = [...tableResults[k]];
  return vi.fn((table: string) => {
    const q = queues[table];
    return query(q && q.length ? q.shift()! : { data: null, error: null });
  });
}

/**
 * An `rpc()` stub backed by per-name FIFO queues. Each entry is the value the
 * RPC resolves to (PostgREST returns `{ data, error }`); pass the raw payload
 * and it is wrapped as `{ data }`.
 */
export function fakeRpc(byName: Record<string, unknown[]> = {}) {
  const queues: Record<string, unknown[]> = {};
  for (const k of Object.keys(byName)) queues[k] = [...byName[k]];
  return vi.fn(async (name: string) => {
    const q = queues[name];
    const value = q && q.length ? q.shift() : null;
    return { data: value, error: null };
  });
}

/** A storage bucket stub (upload + createSignedUrl). */
export function fakeBucket(
  over: Partial<{ upload: ReturnType<typeof vi.fn>; createSignedUrl: ReturnType<typeof vi.fn> }> = {}
) {
  return {
    upload: over.upload ?? vi.fn(async () => ({ data: { path: "p" }, error: null })),
    createSignedUrl:
      over.createSignedUrl ??
      vi.fn(async () => ({ data: { signedUrl: "https://signed.example/x" }, error: null }))
  };
}

/** Build a fake Supabase client from parts. */
export function fakeClient(parts: {
  user?: { id: string; email?: string } | null;
  from?: ReturnType<typeof fakeFrom>;
  rpc?: ReturnType<typeof fakeRpc>;
  bucket?: ReturnType<typeof fakeBucket>;
  claims?: { sub?: string; email?: string } | null;
}) {
  const bucket = parts.bucket ?? fakeBucket();
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: parts.user ?? null } })),
      getClaims: vi.fn(async () => ({
        data: parts.claims ? { claims: parts.claims } : null,
        error: null
      })),
      signOut: vi.fn(async () => ({ error: null as unknown })),
      exchangeCodeForSession: vi.fn(async () => ({ error: null as unknown }))
    },
    from: parts.from ?? fakeFrom(),
    rpc: parts.rpc ?? fakeRpc(),
    storage: { from: vi.fn(() => bucket) }
  };
}
