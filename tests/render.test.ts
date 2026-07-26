import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeRenderVerification, renderUrl } from "@/lib/render";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const verify = () =>
  completeRenderVerification({
    userId: "u1",
    tenantHost: "acme.wd1.myworkdayjobs.com",
    code: "483920"
  });

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

describe("completeRenderVerification", () => {
  it("posts the link with the bearer and returns the resulting status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ status: "authenticated" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await completeRenderVerification({
      userId: "u1",
      tenantHost: "acme.wd1.myworkdayjobs.com",
      link: "https://acme.wd1.myworkdayjobs.com/verify?t=1"
    });

    expect(result).toEqual({ ok: true, data: { status: "authenticated" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://browser.jobarms.com/verify");
    expect(init.headers.authorization).toBe("Bearer render-token");
    expect(JSON.parse(init.body)).toMatchObject({ tenantHost: "acme.wd1.myworkdayjobs.com" });
  });

  it("passes a one-time code through", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ status: "authenticated" }));
    vi.stubGlobal("fetch", fetchMock);
    await verify();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).code).toBe("483920");
  });

  it("reports render_unconfigured without attempting a call", async () => {
    delete process.env.RENDER_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await verify()).toEqual({ ok: false, error: "render_unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a structured 200 error as a typed failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ok({ error: "login_failed", detail: "bad credentials" }))
    );
    expect(await verify()).toEqual({
      ok: false,
      error: "login_failed",
      detail: "bad credentials"
    });
  });

  it("classifies a non-2xx as unreachable, which IS worth retrying", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    expect(await verify()).toEqual({
      ok: false,
      error: "render_unreachable",
      detail: "status 502"
    });
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
    expect(await verify()).toMatchObject({ ok: false, error: "render_unreachable" });
  });

  it("classifies a transport failure as unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("tunnel down")));
    const result = await verify();
    expect(result).toMatchObject({ ok: false, error: "render_unreachable" });
    expect((result as { detail: string }).detail).toContain("tunnel down");
  });

  it("throws when the token is missing, rather than calling out unauthenticated", async () => {
    delete process.env.RENDER_TOKEN;
    vi.stubGlobal("fetch", vi.fn());
    // requireEnv throws inside the try, so it surfaces as unreachable with the
    // env name in the detail: loud enough to diagnose, and no call is made.
    const result = await verify();
    expect(result).toMatchObject({ ok: false, error: "render_unreachable" });
    expect((result as { detail: string }).detail).toContain("RENDER_TOKEN");
  });
});
