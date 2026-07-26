import { beforeEach, describe, expect, it } from "vitest";
import {
  evictFinished,
  type JobPayload,
  MAX_JOBS,
  readJob,
  RESULT_TTL_MS,
  runningJobs,
  startJob
} from "../src/jobs";

/** Let the detached work settle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A promise a test can settle when it chooses, to hold a job open. */
function deferred() {
  let resolve!: (value: JobPayload) => void;
  const promise = new Promise<JobPayload>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The registry is module state, so start each test from an empty one. */
const clearSettled = () => evictFinished(Date.now() + RESULT_TTL_MS + 1);

function result(id: string): JobPayload {
  const entry = readJob(id);
  if (!entry || entry.status !== "done") throw new Error(`job ${id} is not done`);
  return entry.result;
}

beforeEach(clearSettled);

describe("startJob and readJob", () => {
  it("reads as running until the work settles, then yields the payload", async () => {
    const work = deferred();
    const id = startJob(() => work.promise);

    expect(readJob(id)).toEqual({ status: "running" });

    work.resolve({ outcome: "filled", pages: 1 });
    await tick();

    expect(readJob(id)).toEqual({ status: "done", result: { outcome: "filled", pages: 1 } });
  });

  it("is unknown for an id nobody was issued", () => {
    expect(readJob("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("hands back a structured error payload unchanged", async () => {
    const id = startJob(async () => ({ error: "form_not_found", detail: "no form here" }));
    await tick();
    expect(result(id)).toEqual({ error: "form_not_found", detail: "no form here" });
  });

  it("turns an unexpected throw into a readable failure instead of polling forever", async () => {
    const id = startJob(() => Promise.reject(new Error("browser context crashed")));
    await tick();

    expect(result(id).error).toBe("render_failed");
    expect(String(result(id).detail)).toContain("browser context crashed");
  });
});

describe("runningJobs", () => {
  it("counts only work still in flight", async () => {
    const held = deferred();
    startJob(() => held.promise);
    const done = startJob(async () => ({ ok: true }));
    await tick();

    expect(readJob(done)).toMatchObject({ status: "done" });
    expect(runningJobs()).toBe(1);

    held.resolve({ ok: true });
    await tick();
    expect(runningJobs()).toBe(0);
  });
});

describe("evictFinished", () => {
  it("keeps a settled result readable inside the TTL and forgets it after", async () => {
    const id = startJob(async () => ({ ok: true }));
    await tick();

    evictFinished(Date.now() + RESULT_TTL_MS - 1_000);
    expect(readJob(id)).toMatchObject({ status: "done" });

    evictFinished(Date.now() + RESULT_TTL_MS + 1_000);
    expect(readJob(id)).toBeNull();
  });

  it("never forgets work still in flight, however old", async () => {
    const held = deferred();
    const id = startJob(() => held.promise);

    evictFinished(Date.now() + RESULT_TTL_MS * 100);
    expect(readJob(id)).toEqual({ status: "running" });

    held.resolve({ ok: true });
    await tick();
  });

  it("drops the oldest settled results once the cap is exceeded", async () => {
    // Started in one synchronous burst, so none has settled yet and the sweep at
    // the head of startJob has nothing it is allowed to reclaim.
    const ids = Array.from({ length: MAX_JOBS + 5 }, (_, i) => startJob(async () => ({ i })));
    await tick();

    evictFinished();

    expect(ids.filter((id) => readJob(id) !== null)).toHaveLength(MAX_JOBS);
    expect(readJob(ids[0])).toBeNull();
    expect(readJob(ids[ids.length - 1])).toMatchObject({ status: "done" });
  });

  it("leaves the cap alone when everything over it is still running", async () => {
    const held = Array.from({ length: MAX_JOBS + 5 }, () => deferred());
    const ids = held.map((h) => startJob(() => h.promise));

    // Over the cap, but there is nothing settled to reclaim, so all survive.
    evictFinished();
    expect(ids.every((id) => readJob(id) !== null)).toBe(true);

    for (const h of held) h.resolve({ ok: true });
    await tick();
  });
});
