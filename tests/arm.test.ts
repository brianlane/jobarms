import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveRun, armWorkerUrl, cancelRun, dispatchRun } from "@/lib/arm";

const BASE = "https://arm.example.com";
const payload = {
  runId: "r1",
  applicationId: "a1",
  userId: "u1",
  jobUrl: "https://jobs.lever.co/acme/1",
  ats: "lever",
  autonomy: "review_gate" as const,
  jobTitle: "Engineer",
  jobCompany: "Acme",
  jobDescription: "desc",
  profile: {},
  resume: { signedUrl: null, fileName: "r.pdf", mimeType: "application/pdf" },
  memory: { answers: [], lessons: [] }
};

describe("arm worker client", () => {
  beforeEach(() => {
    process.env.ARM_WORKER_URL = BASE;
    process.env.ARM_WORKER_SHARED_SECRET = "secret";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ARM_WORKER_URL;
    delete process.env.ARM_WORKER_SHARED_SECRET;
  });

  it("armWorkerUrl reads the env (empty default)", () => {
    expect(armWorkerUrl()).toBe(BASE);
    delete process.env.ARM_WORKER_URL;
    expect(armWorkerUrl()).toBe("");
  });

  it("returns arm_unconfigured when no worker URL is set", async () => {
    delete process.env.ARM_WORKER_URL;
    expect(await dispatchRun(payload)).toEqual({ ok: false, reason: "arm_unconfigured" });
  });

  it("dispatchRun posts with bearer auth and returns ok on 2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);
    expect(await dispatchRun(payload)).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/runs`);
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer secret");
  });

  it("maps 503 to arm_offline and other non-2xx to arm_error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    expect(await dispatchRun(payload)).toEqual({ ok: false, reason: "arm_offline" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    expect(await dispatchRun(payload)).toEqual({ ok: false, reason: "arm_error" });
  });

  it("maps a thrown fetch (network/timeout) to arm_error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    expect(await dispatchRun(payload)).toEqual({ ok: false, reason: "arm_error" });
  });

  it("approveRun and cancelRun hit the right paths", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await approveRun("r1", [{ name: "x", label: "X", value: "y" }]);
    await cancelRun("r1");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/runs/r1/approve`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/runs/r1/cancel`);
  });
});
