/**
 * JobArms apply arm - HTTP surface.
 *
 *   POST /runs                 start a run (Workflow instance, id = runId)
 *   POST /runs/:id/approve     resume a review-gated run (optionally with
 *                              edited answers)
 *   POST /runs/:id/cancel      terminate a run
 *   GET  /health               unauthenticated liveness
 *
 * Every mutating request must carry the ARM_WORKER_SHARED_SECRET bearer -
 * the same secret the app uses to call us.
 */
import type { Answer, Env, RunParams } from "./types";
import { updateRun } from "./db";

export { ApplyRunWorkflow } from "./workflow";

/** Length-independent, constant-time string compare (no early-exit leak). */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // XOR the byte-length in so unequal lengths can't short-circuit; iterate the
  // longer of the two so total work does not depend on the match position.
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function authorized(request: Request, env: Env): boolean {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return Boolean(env.ARM_WORKER_SHARED_SECRET) && timingSafeEqual(token, env.ARM_WORKER_SHARED_SECRET ?? "");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "jobarms-apply-arm",
        arms: Boolean(env.APPLY_RUN && env.BROWSER)
      });
    }

    if (!authorized(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (request.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }
    if (!env.APPLY_RUN) {
      return Response.json(
        { error: "arm_offline", hint: "Workflows binding missing (Workers Paid not enabled yet)" },
        { status: 503 }
      );
    }

    // POST /runs
    if (url.pathname === "/runs") {
      const params = (await request.json().catch(() => null)) as RunParams | null;
      if (!params?.runId || !params.jobUrl || !params.ats) {
        return Response.json({ error: "invalid_body" }, { status: 400 });
      }
      const instance = await env.APPLY_RUN.create({ id: params.runId, params });
      return Response.json({ ok: true, instance_id: instance.id }, { status: 202 });
    }

    // POST /runs/:id/approve | /runs/:id/cancel
    const match = url.pathname.match(/^\/runs\/([0-9a-f-]{36})\/(approve|cancel)$/);
    if (match) {
      const [, runId, action] = match;
      let instance;
      try {
        instance = await env.APPLY_RUN.get(runId);
      } catch {
        return Response.json({ error: "run_not_found" }, { status: 404 });
      }

      if (action === "approve") {
        const body = (await request.json().catch(() => ({}))) as { answers?: Answer[] };
        await instance.sendEvent({ type: "approval", payload: { answers: body.answers } });
        return Response.json({ ok: true });
      }

      await instance.terminate();
      await updateRun(env, runId, { status: "canceled" });
      return Response.json({ ok: true });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
} satisfies ExportedHandler<Env>;
