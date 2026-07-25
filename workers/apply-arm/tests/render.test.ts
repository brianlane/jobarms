import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import {
  decodeScreenshot,
  ensureSession,
  extractForm,
  fetchResumeBase64,
  fillForm
} from "../src/render";

const env: Env = { RENDER_URL: "https://browser.jobarms.com", RENDER_TOKEN: "render-token" };

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("classifying sidecar replies", () => {
  it("returns the payload on success, with the bearer attached", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ fields: [], pages: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractForm(env, { userId: "u1", jobUrl: "https://x/1", ats: "lever" });

    expect(result).toEqual({ ok: true, data: { fields: [], pages: 1 } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://browser.jobarms.com/extract");
    expect(init.headers.authorization).toBe("Bearer render-token");
  });

  it("strips trailing slashes from the configured URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({}));
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

  it("surfaces a structured 200 error as a typed failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ok({ error: "form_not_found", detail: "no fields" }))
    );
    expect(await extractForm(env, { userId: "u1", jobUrl: "https://x/1", ats: "lever" })).toEqual({
      ok: false,
      error: "form_not_found",
      detail: "no fields"
    });
  });

  it("passes the form_not_found screenshot through for vision", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ok({ error: "form_not_found", screenshotBase64: "AA==" }))
    );
    const result = await extractForm(env, { userId: "u1", jobUrl: "https://x/1", ats: "lever" });
    expect(result).toMatchObject({ error: "form_not_found", screenshotBase64: "AA==" });
  });

  it("classifies a non-2xx as unreachable, which IS worth retrying", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    expect(await extractForm(env, { userId: "u1", jobUrl: "https://x/1", ats: "lever" })).toEqual({
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
    expect(
      await extractForm(env, { userId: "u1", jobUrl: "https://x/1", ats: "lever" })
    ).toMatchObject({ error: "render_unreachable", detail: "unparseable body" });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("tunnel down")));
    const result = await extractForm(env, { userId: "u1", jobUrl: "https://x/1", ats: "lever" });
    expect(result).toMatchObject({ error: "render_unreachable" });
    expect((result as { detail: string }).detail).toContain("tunnel down");
  });
});

describe("the phase calls", () => {
  it("ensureSession posts to /session/ensure with the account", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ status: "authenticated" }));
    vi.stubGlobal("fetch", fetchMock);
    const account = { email: "a@jobarms.com", password: ["fixture", "v"].join("-") };

    await ensureSession(env, { userId: "u1", jobUrl: "https://x/1", ats: "workday", account });

    expect(fetchMock.mock.calls[0][0]).toBe("https://browser.jobarms.com/session/ensure");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).account).toEqual(account);
  });

  it("fillForm posts answers, resume bytes, and the submit flag", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ outcome: "filled", pages: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await fillForm(env, {
      userId: "u1",
      jobUrl: "https://x/1",
      ats: "lever",
      answers: [{ name: "a", label: "A", value: "v" }],
      resume: { contentBase64: "UERG", fileName: "cv.pdf", mimeType: "application/pdf" },
      submit: true
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchMock.mock.calls[0][0]).toBe("https://browser.jobarms.com/fill");
    expect(body).toMatchObject({
      submit: true,
      resume: { contentBase64: "UERG", fileName: "cv.pdf" }
    });
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
