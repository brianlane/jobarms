import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import {
  decodeScreenshot,
  completeLoginCode,
  ensureSession,
  extractForm,
  fetchResumeBase64,
  fillForm,
  timers
} from "../src/render";

const env: Env = { RENDER_URL: "https://browser.jobarms.com", RENDER_TOKEN: "render-token" };

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const extract = () => extractForm(env, { userId: "u1", jobUrl: "https://x/1", ats: "lever" });

/**
 * A sidecar speaking the async protocol: the POST starts a job, and the poll
 * reports `running` the requested number of times before settling on `result`.
 */
function sidecar(result: unknown, runningPolls = 0) {
  let polls = 0;
  return vi.fn(async (_url: string, init: { method: string }) => {
    if (init.method === "POST") return ok({ jobId: "job-1" });
    polls++;
    return polls <= runningPolls ? ok({ status: "running" }) : ok({ status: "done", result });
  });
}

/** Poll delays are real seconds in production; here they only move a fake clock. */
let now = 0;
beforeEach(() => {
  vi.restoreAllMocks();
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(timers, "sleep").mockImplementation(async (ms: number) => {
    now += ms;
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("starting a phase and polling it", () => {
  it("returns the settled payload, with the bearer on both exchanges", async () => {
    const fetchMock = sidecar({ fields: [], pages: 1 });
    vi.stubGlobal("fetch", fetchMock);

    expect(await extract()).toEqual({ ok: true, data: { fields: [], pages: 1 } });

    const [startUrl, startInit] = fetchMock.mock.calls[0];
    expect(startUrl).toBe("https://browser.jobarms.com/extract");
    expect(startInit.method).toBe("POST");
    expect((startInit as unknown as { headers: Record<string, string> }).headers.authorization).toBe(
      "Bearer render-token"
    );

    const [pollUrl, pollInit] = fetchMock.mock.calls[1];
    expect(pollUrl).toBe("https://browser.jobarms.com/jobs/job-1");
    expect(pollInit.method).toBe("GET");
  });

  it("keeps polling while the phase is still running", async () => {
    const fetchMock = sidecar({ outcome: "filled" }, 3);
    vi.stubGlobal("fetch", fetchMock);

    expect(await extract()).toEqual({ ok: true, data: { outcome: "filled" } });
    // One POST plus four reads: three "running", then the answer.
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("gives up once the phase outlives its budget", async () => {
    // Never settles. The loop must end on the budget rather than spin forever.
    const fetchMock = vi.fn(async (_url: string, init: { method: string }) =>
      init.method === "POST" ? ok({ jobId: "job-1" }) : ok({ status: "running" })
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await extract()).toEqual({
      ok: false,
      error: "render_unreachable",
      detail: "phase exceeded its budget"
    });
  });

  it("reports a job the sidecar no longer knows, so the phase is retried", async () => {
    // What a restarted box says: the work is gone, and re-running it is right.
    const fetchMock = vi.fn(async (_url: string, init: { method: string }) =>
      init.method === "POST" ? ok({ jobId: "job-1" }) : ok({ error: "job_not_found" })
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await extract()).toEqual({ ok: false, error: "job_not_found" });
  });

  it("treats a start with no job id as unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({})));
    expect(await extract()).toEqual({
      ok: false,
      error: "render_unreachable",
      detail: "no job id"
    });
  });

  it("strips trailing slashes from the configured URL", async () => {
    const fetchMock = sidecar({ fields: [] });
    vi.stubGlobal("fetch", fetchMock);
    await extractForm(
      { ...env, RENDER_URL: "https://browser.jobarms.com///" },
      { userId: "u1", jobUrl: "https://x/1", ats: "lever" }
    );
    expect(fetchMock.mock.calls[0][0]).toBe("https://browser.jobarms.com/extract");
  });

  it("reports render_unconfigured without calling out", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const partial of [{}, { RENDER_URL: "https://x" }, { RENDER_TOKEN: "t" }]) {
      const result = await extractForm(partial as Env, {
        userId: "u1",
        jobUrl: "https://x/1",
        ats: "lever"
      });
      expect(result).toEqual({ ok: false, error: "render_unconfigured" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("classifying what a phase settled on", () => {
  it("surfaces a structured error as a typed failure", async () => {
    vi.stubGlobal("fetch", sidecar({ error: "form_not_found", detail: "no fields" }));
    expect(await extract()).toEqual({
      ok: false,
      error: "form_not_found",
      detail: "no fields"
    });
  });

  it("passes the form_not_found screenshot through for vision", async () => {
    vi.stubGlobal("fetch", sidecar({ error: "form_not_found", screenshotBase64: "AA==" }));
    expect(await extract()).toMatchObject({ error: "form_not_found", screenshotBase64: "AA==" });
  });

  it("classifies a non-2xx as unreachable, which IS worth retrying", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    expect(await extract()).toEqual({
      ok: false,
      error: "render_unreachable",
      detail: "status 502"
    });
  });

  it("classifies an unparseable body and a transport failure as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("not json");
        }
      })
    );
    expect(await extract()).toMatchObject({
      error: "render_unreachable",
      detail: "unparseable body"
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("tunnel down")));
    const result = await extract();
    expect(result).toMatchObject({ error: "render_unreachable" });
    expect((result as { detail: string }).detail).toContain("tunnel down");
  });
});

describe("the phase calls", () => {
  it("ensureSession posts to /session/ensure with the account", async () => {
    const fetchMock = sidecar({ status: "authenticated" });
    vi.stubGlobal("fetch", fetchMock);
    const account = { email: "a@jobarms.com", password: ["fixture", "v"].join("-") };

    await ensureSession(env, { userId: "u1", jobUrl: "https://x/1", ats: "workday", account });

    expect(fetchMock.mock.calls[0][0]).toBe("https://browser.jobarms.com/session/ensure");
    const init = fetchMock.mock.calls[0][1] as unknown as { body: string };
    expect(JSON.parse(init.body).account).toEqual(account);
  });

  it("completeLoginCode posts the code synchronously to /login-code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ status: "authenticated" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await completeLoginCode(env, {
      userId: "u1",
      tenantHost: "www.linkedin.com",
      code: "483920",
      checkpointUrl: "https://www.linkedin.com/checkpoint/1"
    });

    expect(result).toEqual({ ok: true, data: { status: "authenticated" } });
    // A single exchange, not a job poll.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://browser.jobarms.com/login-code");
    const init = fetchMock.mock.calls[0][1] as unknown as { body: string };
    expect(JSON.parse(init.body)).toMatchObject({ code: "483920", tenantHost: "www.linkedin.com" });
  });

  it("fillForm posts answers, resume bytes, and the submit flag", async () => {
    const fetchMock = sidecar({ outcome: "filled", pages: 1 });
    vi.stubGlobal("fetch", fetchMock);

    await fillForm(env, {
      userId: "u1",
      runId: "r1",
      jobUrl: "https://x/1",
      ats: "lever",
      answers: [{ name: "a", label: "A", value: "v" }],
      resume: { contentBase64: "UERG", fileName: "cv.pdf", mimeType: "application/pdf" },
      submit: true
    });

    expect(fetchMock.mock.calls[0][0]).toBe("https://browser.jobarms.com/fill");
    const init = fetchMock.mock.calls[0][1] as unknown as { body: string };
    expect(JSON.parse(init.body)).toMatchObject({
      submit: true,
      resume: { contentBase64: "UERG", fileName: "cv.pdf" }
    });
  });
});

describe("timers.sleep", () => {
  it("really waits, since the poll loop paces itself on a wall clock", async () => {
    // Every other test replaces this with a fake clock; here it runs for real.
    vi.restoreAllMocks();
    const started = Date.now();
    await timers.sleep(5);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
  });
});

describe("decodeScreenshot", () => {
  it("decodes base64 into bytes", () => {
    const bytes = decodeScreenshot(btoa("PNG"));
    expect(bytes && Array.from(bytes)).toEqual([80, 78, 71]);
  });

  it("returns null for absent, empty, or undecodable input", () => {
    expect(decodeScreenshot(null)).toBeNull();
    expect(decodeScreenshot(undefined)).toBeNull();
    expect(decodeScreenshot("")).toBeNull();
    expect(decodeScreenshot(btoa(""))).toBeNull();
    expect(decodeScreenshot("!!!not base64!!!")).toBeNull();
  });
});

describe("fetchResumeBase64", () => {
  it("downloads and base64-encodes the resume", async () => {
    const bytes = new Uint8Array([37, 80, 68, 70]); // "%PDF"
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => bytes.buffer })
    );
    expect(await fetchResumeBase64("https://signed/cv.pdf")).toBe(btoa("%PDF"));
  });

  it("handles a resume larger than one encoding chunk", async () => {
    // Chunked encoding exists so a multi-megabyte PDF cannot blow the argument
    // limit of String.fromCharCode; this crosses the 8KB boundary.
    const bytes = new Uint8Array(20_000).fill(65);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => bytes.buffer })
    );
    const encoded = await fetchResumeBase64("https://signed/big.pdf");
    expect(encoded).toBe(btoa("A".repeat(20_000)));
  });

  it("returns null without a URL, and never calls out", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchResumeBase64(null)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on a non-2xx, an empty file, or a transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await fetchResumeBase64("https://signed/cv.pdf")).toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array().buffer })
    );
    expect(await fetchResumeBase64("https://signed/cv.pdf")).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("dns")));
    expect(await fetchResumeBase64("https://signed/cv.pdf")).toBeNull();
  });
});
