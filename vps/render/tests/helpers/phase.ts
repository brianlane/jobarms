import request from "supertest";
import type { Express } from "express";
import { CONFIG } from "../../src/config";

/** Guard so a phase that never settles fails the test instead of hanging it. */
const MAX_POLLS = 500;

/**
 * Drive a phase the way the worker does: start it, then poll /jobs/:id until it
 * settles, and hand back the result as if it had been the response body.
 *
 * Responses that are already final pass straight through unchanged (validation
 * errors, and the no-account short circuit), so a call site can assert on either
 * shape without caring which it got.
 */
export async function phase(
  app: Express,
  path: string,
  body: unknown
  // supertest types `body` as any, and assertions here read arbitrary fields off
  // whatever the phase returned.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
  const start = request(app).post(path);
  if (CONFIG.token) start.set("authorization", `Bearer ${CONFIG.token}`);
  const started = await start.send(body);

  if (started.status !== 200 || typeof started.body?.jobId !== "string") return started;

  for (let i = 0; i < MAX_POLLS; i++) {
    const read = request(app).get(`/jobs/${started.body.jobId}`);
    if (CONFIG.token) read.set("authorization", `Bearer ${CONFIG.token}`);
    const polled = await read;
    if (polled.body?.status === "done") return { status: 200, body: polled.body.result };
    // Let the detached phase make progress before looking again.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`phase ${path} never settled`);
}
