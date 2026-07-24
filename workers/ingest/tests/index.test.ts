import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";

const SECRET = "cron-secret";
const env: Env = { SUPABASE_URL: "https://db", SUPABASE_SECRET_KEY: "svc", INTERNAL_CRON_SECRET: SECRET };

const jsonOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });

/** Route fetch by URL so ingestAll's Supabase + ATS calls resolve. */
function routedFetch(over: { companies?: unknown; greenhouse?: unknown; jobsOk?: boolean } = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/rest/v1/companies") && (!init || init.method !== "PATCH")) {
      return jsonOk(over.companies ?? []);
    }
    if (url.includes("boards-api.greenhouse.io")) return jsonOk(over.greenhouse ?? { jobs: [{ id: 1, title: "Eng" }] });
    if (url.includes("/rest/v1/jobs")) {
      return over.jobsOk === false ? { ok: false, status: 500, text: async () => "err" } : jsonOk({});
    }
    // markIngested PATCH + anything else
    return jsonOk({});
  });
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

function req(path: string, init: RequestInit = {}) {
  return new Request(`https://ingest.example${path}`, init);
}
const auth = { authorization: `Bearer ${SECRET}` };

describe("ingest worker HTTP", () => {
  it("GET /health", async () => {
    vi.stubGlobal("fetch", routedFetch());
    expect((await (await worker.fetch(req("/health"), env)).json())).toMatchObject({ ok: true });
  });

  it("rejects /ingest without the cron secret", async () => {
    vi.stubGlobal("fetch", routedFetch());
    expect((await worker.fetch(req("/ingest", { method: "POST" }), env)).status).toBe(401);
    expect((await worker.fetch(req("/ingest", { method: "POST", headers: { authorization: "Bearer nope" } }), env)).status).toBe(401);
  });

  it("401 when no cron secret is configured", async () => {
    vi.stubGlobal("fetch", routedFetch());
    const res = await worker.fetch(req("/ingest", { method: "POST", headers: auth }), { ...env, INTERNAL_CRON_SECRET: undefined });
    expect(res.status).toBe(401);
  });

  it("runs ingestion across all ATS types and reports counts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/rest/v1/companies") && (!init || init.method !== "PATCH")) {
          return jsonOk([
            { id: "c1", name: "A", ats: "greenhouse", board_token: "a" },
            { id: "c2", name: "B", ats: "lever", board_token: "b" },
            { id: "c3", name: "C", ats: "ashby", board_token: "c" },
            { id: "c4", name: "D", ats: "workable", board_token: "d" }
          ]);
        }
        if (url.includes("boards-api.greenhouse.io")) return jsonOk({ jobs: [{ id: 1, title: "Eng" }] });
        if (url.includes("api.lever.co")) return jsonOk([{ hostedUrl: "https://jobs.lever.co/b/1", text: "L" }]);
        if (url.includes("api.ashbyhq.com")) return jsonOk({ jobs: [{ jobUrl: "https://ashby/1", title: "AsH" }] });
        if (url.includes("apply.workable.com")) return jsonOk({ jobs: [{ url: "https://wk/1", title: "W" }] });
        return jsonOk({}); // jobs upsert + markIngested
      })
    );
    const res = await worker.fetch(req("/ingest", { method: "POST", headers: auth }), env);
    const body = await res.json();
    expect(body.companies).toBe(4);
    expect(body.jobs).toBe(4);
    expect(body.errors).toEqual([]);
  });

  it("collects per-company errors without aborting the sweep", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/rest/v1/companies") && (!init || init.method !== "PATCH")) {
          return jsonOk([{ id: "c1", name: "A", ats: "greenhouse", board_token: "a" }]);
        }
        if (url.includes("boards-api.greenhouse.io")) return { ok: false, status: 500 };
        return jsonOk({});
      })
    );
    const body = await (await worker.fetch(req("/ingest", { method: "POST", headers: auth }), env)).json();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toContain("greenhouse/a");
  });

  it("404 for an unknown path", async () => {
    vi.stubGlobal("fetch", routedFetch());
    expect((await worker.fetch(req("/nope"), env)).status).toBe(404);
  });

  it("rejects a token longer than the secret (constant-time compare)", async () => {
    vi.stubGlobal("fetch", routedFetch());
    const longToken = { authorization: `Bearer ${SECRET}-with-extra-suffix` };
    expect((await worker.fetch(req("/ingest", { method: "POST", headers: longToken }), env)).status).toBe(401);
  });

  it("skips the jobs upsert when a company yields no postings", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/rest/v1/companies") && (!init || init.method !== "PATCH")) {
        return jsonOk([{ id: "c1", name: "A", ats: "greenhouse", board_token: "a" }]);
      }
      if (url.includes("boards-api.greenhouse.io")) return jsonOk({ jobs: [] });
      if (url.includes("/rest/v1/jobs")) throw new Error("upsert should not run for 0 jobs");
      return jsonOk({});
    }));
    const body = await (await worker.fetch(req("/ingest", { method: "POST", headers: auth }), env)).json();
    expect(body.jobs).toBe(0);
    expect(body.errors).toEqual([]);
  });

  it("stringifies a non-Error thrown by a fetcher", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/rest/v1/companies") && (!init || init.method !== "PATCH")) {
        return jsonOk([{ id: "c1", name: "A", ats: "greenhouse", board_token: "a" }]);
      }
      if (url.includes("boards-api.greenhouse.io")) return Promise.reject("string failure");
      return jsonOk({});
    }));
    const body = await (await worker.fetch(req("/ingest", { method: "POST", headers: auth }), env)).json();
    expect(body.errors[0]).toContain("string failure");
  });

  it("scheduled() logs a summary (with and without errors)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/rest/v1/companies") && (!init || init.method !== "PATCH")) {
        return jsonOk([{ id: "c1", name: "A", ats: "greenhouse", board_token: "a" }]);
      }
      if (url.includes("boards-api.greenhouse.io")) return jsonOk({ jobs: [{ id: 1, title: "Eng" }] });
      return jsonOk({});
    }));
    await worker.scheduled({} as ScheduledController, env);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("1 jobs from 1 companies"));

    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/rest/v1/companies") && (!init || init.method !== "PATCH")) {
        return jsonOk([{ id: "c1", name: "A", ats: "greenhouse", board_token: "a" }]);
      }
      if (url.includes("boards-api.greenhouse.io")) return { ok: false, status: 500 };
      return jsonOk({});
    }));
    await worker.scheduled({} as ScheduledController, env);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("errors:"));
  });

  it("upsertJobs throws propagate into the error list (jobs upsert failure)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/rest/v1/companies") && (!init || init.method !== "PATCH")) {
        return jsonOk([{ id: "c1", name: "A", ats: "greenhouse", board_token: "a" }]);
      }
      if (url.includes("boards-api.greenhouse.io")) return jsonOk({ jobs: [{ id: 1, title: "Eng" }] });
      if (url.includes("/rest/v1/jobs")) return { ok: false, status: 500, text: async () => "nope" };
      return jsonOk({});
    }));
    const body = await (await worker.fetch(req("/ingest", { method: "POST", headers: auth }), env)).json();
    expect(body.errors[0]).toContain("jobs upsert failed");
  });

  it("defaults the service key header and no-ops an unknown ATS", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/rest/v1/companies") && (!init || init.method !== "PATCH")) {
        // ats outside the known four -> the dispatch chain falls through, jobs stays []
        return jsonOk([{ id: "c1", name: "A", ats: "smartrecruiters", board_token: "a" }]);
      }
      return jsonOk({});
    }));
    // env without SUPABASE_SECRET_KEY exercises the `?? ""` header default
    const noKey = { SUPABASE_URL: "https://db", INTERNAL_CRON_SECRET: SECRET } as Env;
    const body = await (await worker.fetch(req("/ingest", { method: "POST", headers: auth }), noKey)).json();
    expect(body.companies).toBe(1);
    expect(body.jobs).toBe(0);
  });

  it("throws when the companies fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    // ingestAll rejects -> the POST handler surfaces it; assert it rejects
    await expect(worker.fetch(req("/ingest", { method: "POST", headers: auth }), env)).rejects.toThrow(/companies fetch failed/);
  });
});
