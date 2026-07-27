import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyReviewNeeded } from "../src/notify";
import type { Env, RunParams } from "../src/types";

const env = {
  APP_BASE_URL: "https://jobarms.com",
  ARM_WORKER_SHARED_SECRET: "shh"
} as Env;

const params = { runId: "r1", applicationId: "a1", userId: "u1" } as RunParams;

const mismatches = [
  { name: "q[]", label: "Sanctions", kind: "choice" as const, expected: "None", actual: "Cuba" },
  { name: "loc", label: "", kind: "text" as const, expected: "Phoenix", actual: "(empty)" }
];

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("notifyReviewNeeded", () => {
  it("asks the app to send the mail, with the shared secret", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await notifyReviewNeeded(env, params, mismatches);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://jobarms.com/api/internal/run-needs-review");
    expect(init.headers.authorization).toBe("Bearer shh");
    expect(JSON.parse(init.body)).toEqual({
      runId: "r1",
      applicationId: "a1",
      userId: "u1",
      // Labels only, falling back to the field name. No answer VALUES: there is
      // no reason for those to travel to an email sender.
      fields: ["Sanctions", "loc"]
    });
    expect(init.body).not.toContain("Cuba");
  });

  it("does not care how many slashes the base URL ends with", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await notifyReviewNeeded({ ...env, APP_BASE_URL: "https://jobarms.com//" }, params, mismatches);

    expect(fetchMock.mock.calls[0][0]).toBe("https://jobarms.com/api/internal/run-needs-review");
  });

  it("stays quiet when it has nowhere or no way to call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await notifyReviewNeeded({ ...env, APP_BASE_URL: undefined }, params, mismatches);
    await notifyReviewNeeded({ ...env, ARM_WORKER_SHARED_SECRET: undefined }, params, mismatches);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows a failure, because the run is parked either way", async () => {
    // Losing a parked run over a refused notification would be a bad trade: a
    // run nobody was told about is recoverable, a failed one is not.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("app down")));
    await expect(notifyReviewNeeded(env, params, mismatches)).resolves.toBeUndefined();
  });
});
