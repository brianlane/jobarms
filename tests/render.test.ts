import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeRenderVerification,
  ensureRenderSession,
  renderUrl
} from "@/lib/render";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  process.env.RENDER_URL = "https://browser.jobarms.com";
  process.env.RENDER_TOKEN = "render-token";
});
afterEach(() => {
  delete process.env.RENDER_URL;
  delete process.env.RENDER_TOKEN;
  vi.unstubAllGlobals();
});

describe("renderUrl", () => {
  it("strips trailing slashes so paths never double up", () => {
    process.env.RENDER_URL = "https://browser.jobarms.com///";
    expect(renderUrl()).toBe("https://browser.jobarms.com");
  });

  it("is empty when unconfigured", () => {
    delete process.env.RENDER_URL;
    expect(renderUrl()).toBe("");
  });
});

describe("ensureRenderSession", () => {
  it("posts with the bearer and returns the payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      ok({ status: "authenticated", accountRequired: true })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureRenderSession({
      userId: "u1",
      jobUrl: "https://acme.wd1.myworkdayjobs.com/job/1",
      ats: "workday",
      account: { email: "a@jobarms.com", password: "pw" }
    });

    expect(result).toEqual({ ok: true, data: { status: "authenticated", accountRequired: true } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://browser.jobarms.com/session/ensure");
    expect(init.headers.authorization).toBe("Bearer render-token");
  });

  it("reports render_unconfigured without attempting a call", async () => {
    delete process.env.RENDER_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await ensureRenderSession({ userId: "u1", jobUrl: "https://x/1", ats: "lever" })).toEqual(
      { ok: false, error: "render_unconfigured" }
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a structured 200 error as a typed failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ok({ error: "login_failed", detail: "bad credentials" }))
    );
    expect(
      await ensureRenderSession({ userId: "u1", jobUrl: "https://x/1", ats: "workday" })
    ).toEqual({ ok: false, error: "login_failed", detail: "bad credentials" });
  });

  it("classifies a non-2xx as unreachable, which IS worth retrying", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    const result = await ensureRenderSession({
      userId: "u1",
      jobUrl: "https://x/1",
      ats: "lever"
    });
    expect(result).toEqual({ ok: false, error: "render_unreachable", detail: "status 502" });
  });

  it("classifies an unparseable body as unreachable", async () => {
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
    const result = await ensureRenderSession({ userId: "u1", jobUrl: "https://x/1", ats: "lever" });
    expect(result).toMatchObject({ ok: false, error: "render_unreachable" });
  });

  it("classifies a transport failure as unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("tunnel down")));
    const result = await ensureRenderSession({ userId: "u1", jobUrl: "https://x/1", ats: "lever" });
    expect(result).toMatchObject({ ok: false, error: "render_unreachable" });
    expect((result as { detail: string }).detail).toContain("tunnel down");
  });

  it("throws when the token is missing, rather than calling out unauthenticated", async () => {
    delete process.env.RENDER_TOKEN;
    vi.stubGlobal("fetch", vi.fn());
    // requireEnv throws inside the try, so it surfaces as unreachable with the
    // env name in the detail: loud enough to diagnose, and no call is made.
    const result = await ensureRenderSession({ userId: "u1", jobUrl: "https://x/1", ats: "lever" });
    expect(result).toMatchObject({ ok: false, error: "render_unreachable" });
    expect((result as { detail: string }).detail).toContain("RENDER_TOKEN");
  });
});

describe("completeRenderVerification", () => {
  it("posts the link and returns the resulting status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ status: "authenticated" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await completeRenderVerification({
      userId: "u1",
      tenantHost: "acme.wd1.myworkdayjobs.com",
      link: "https://acme.wd1.myworkdayjobs.com/verify?t=1"
    });

    expect(result).toEqual({ ok: true, data: { status: "authenticated" } });
    expect(fetchMock.mock.calls[0][0]).toBe("https://browser.jobarms.com/verify");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      tenantHost: "acme.wd1.myworkdayjobs.com"
    });
  });

  it("passes a one-time code through", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ status: "authenticated" }));
    vi.stubGlobal("fetch", fetchMock);
    await completeRenderVerification({ userId: "u1", tenantHost: "acme.com", code: "483920" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).code).toBe("483920");
  });
});
