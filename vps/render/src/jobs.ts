/**
 * Async phase jobs.
 *
 * Browser phases routinely outlive Cloudflare's 100-second cap on an origin
 * response: filling a 24-field Lever form measured 133s on the KVM1 box, and a
 * Workday wizard is longer still. Behind the Tunnel that cap becomes a 524 whose
 * body Cloudflare owns, so a phase that actually SUCCEEDED reached the worker as
 * an unreachable sidecar and failed the run.
 *
 * So a phase request STARTS the work and answers with a job id immediately, and
 * the caller polls for the outcome. Every HTTP exchange is short while the
 * browser takes as long as it needs.
 *
 * Deliberately in-process: a job is only meaningful while the browser context
 * that backs it is alive, so a restart SHOULD forget everything. The worker sees
 * a job it can no longer read as a transport failure and retries the phase,
 * which is exactly the right response to the box having restarted.
 */
import { randomUUID } from "node:crypto";

/** The JSON body a finished phase hands back: a success payload or `{ error }`. */
export type JobPayload = Record<string, unknown>;

export type JobEntry = { status: "running" } | { status: "done"; result: JobPayload };

interface JobRecord {
  startedAt: number;
  /** Null until the work settles. */
  finishedAt: number | null;
  result: JobPayload | null;
}

const jobs = new Map<string, JobRecord>();

/**
 * How long a settled result stays readable. Comfortably longer than the worker's
 * polling budget so a slow poller still finds its answer, short enough that the
 * screenshots each result carries (~600KB of base64) do not accumulate on a
 * shared 4GB box.
 */
export const RESULT_TTL_MS = 15 * 60_000;

/**
 * Ceiling on tracked jobs, reached only if callers abandon their polls en masse.
 * Settled results are dropped oldest-first; work still in flight is never
 * forgotten, so nothing being awaited can be lost to this cap.
 */
export const MAX_JOBS = 200;

/**
 * Begin `work` and return the id to poll. `work` is expected to RESOLVE with a
 * payload even when the phase failed (that is how structured errors travel), so
 * the rejection path here is a backstop: it turns an unexpected throw into a
 * readable outcome instead of a job that polls forever.
 */
export function startJob(work: () => Promise<JobPayload>): string {
  evictFinished();
  const id = randomUUID();
  const record: JobRecord = { startedAt: Date.now(), finishedAt: null, result: null };
  jobs.set(id, record);
  // Detached on purpose: the HTTP response is already on its way. The record is
  // captured directly rather than looked up again, so a job the cap has since
  // reclaimed settles harmlessly instead of needing a not-found branch.
  void work().then(
    (result) => settle(record, result),
    (err) => settle(record, { error: "render_failed", detail: String(err).slice(0, 400) })
  );
  return id;
}

function settle(record: JobRecord, result: JobPayload): void {
  record.finishedAt = Date.now();
  record.result = result;
}

/** The outcome so far, or null when the id is unknown (restarted or evicted). */
export function readJob(id: string): JobEntry | null {
  const record = jobs.get(id);
  if (!record) return null;
  if (record.result === null) return { status: "running" };
  return { status: "done", result: record.result };
}

/** Jobs still in flight. Surfaced on /health so a stuck box is visible. */
export function runningJobs(): number {
  let count = 0;
  for (const record of jobs.values()) if (record.result === null) count++;
  return count;
}

/**
 * Forget settled results past the TTL and then, only if still over the cap, the
 * oldest remaining settled ones.
 */
export function evictFinished(now = Date.now()): void {
  const settled: Array<[string, number]> = [];
  for (const [id, record] of jobs) {
    if (record.finishedAt === null) continue;
    if (now - record.finishedAt > RESULT_TTL_MS) {
      jobs.delete(id);
    } else {
      settled.push([id, record.finishedAt]);
    }
  }

  if (jobs.size <= MAX_JOBS) return;
  settled.sort((a, b) => a[1] - b[1]);
  for (const [id] of settled) {
    jobs.delete(id);
    if (jobs.size <= MAX_JOBS) return;
  }
}
