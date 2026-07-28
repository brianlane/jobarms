/**
 * JobArms apply arm - HTTP surface.
 *
 *   POST /runs                          start a run (Workflow instance, id = runId)
 *   POST /runs/:id/approve              resume a review-gated run (optionally
 *                                       with edited answers)
 *   POST /runs/:id/account-verified     resume a run parked on its ATS account
 *                                       email being confirmed
 *   POST /runs/:id/cancel               terminate a run
 *   POST /batches                       start a search-driven Easy Apply batch
 *   POST /batches/:id/login-code        hand a parked batch its LinkedIn PIN
 *   POST /batches/:id/cancel            terminate a batch (the app releases
 *                                       the unused metered slots)
 *   POST /internal/solve-captcha        the render sidecar asking which captcha
 *                                       grid cells to click (its own secret)
 *   GET  /health                        unauthenticated liveness
 *
 * Every mutating request must carry the ARM_WORKER_SHARED_SECRET bearer -
 * the same secret the app uses to call us.
 */
import type { Answer, BatchParams, Env, RunParams } from "./types";
import { markBatchCanceled, updateRun } from "./db";
import { solveImageGrid } from "./gemini";

export { ApplyRunWorkflow, BatchApplyWorkflow } from "./workflow";

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

function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

function authorized(request: Request, env: Env): boolean {
  const secret = env.ARM_WORKER_SHARED_SECRET;
  if (!secret) return false;
  return timingSafeEqual(bearer(request), secret);
}

/** Auth for the sidecar's captcha callback, on its own narrowly-scoped secret. */
function solverAuthorized(request: Request, env: Env): boolean {
  const secret = env.SOLVER_SHARED_SECRET;
  if (!secret) return false;
  return timingSafeEqual(bearer(request), secret);
}

/** Largest challenge screenshot we will decode, well past any real grid. */
const MAX_CHALLENGE_BYTES = 4 * 1024 * 1024;

/**
 * Run the vision model over a captcha grid and answer with the cells to click.
 *
 * Returns an empty tile list rather than an error when the model is unavailable
 * or the payload is unusable: the sidecar treats that as "reload and try another
 * grid", and ultimately as an honest `captcha_blocked`.
 */
async function solveCaptcha(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    imageBase64?: unknown;
    instruction?: unknown;
    rows?: unknown;
    cols?: unknown;
    userId?: unknown;
    runId?: unknown;
  } | null;

  const imageBase64 = typeof body?.imageBase64 === "string" ? body.imageBase64 : "";
  const instruction = typeof body?.instruction === "string" ? body.instruction.slice(0, 300) : "";
  const rows = typeof body?.rows === "number" ? body.rows : 0;
  const cols = typeof body?.cols === "number" ? body.cols : 0;
  // Bound the grid: these are 2x2 through 4x4 in the wild, and the tile indices
  // come back to be clicked, so an absurd grid is a bad payload, not a puzzle.
  if (!imageBase64 || !instruction || rows < 2 || cols < 2 || rows > 8 || cols > 8) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  let bytes: Uint8Array;
  try {
    // A non-empty base64 string always decodes to at least one byte, and the
    // guard above already rejected empty input, so only the size cap matters.
    const binary = atob(imageBase64);
    if (binary.length > MAX_CHALLENGE_BYTES) {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    const tiles = await solveImageGrid(env, bytes, instruction, rows, cols, {
      userId: typeof body?.userId === "string" ? body.userId : null,
      runId: typeof body?.runId === "string" ? body.runId : null
    });
    return Response.json({ tiles });
  } catch {
    // A model outage must not fail the run; the sidecar falls back to blocked.
    return Response.json({ tiles: [] });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "jobarms-apply-arm",
        // Arms need the durable orchestrator AND a reachable browser sidecar.
        arms: Boolean(env.APPLY_RUN && env.RENDER_URL && env.RENDER_TOKEN)
      });
    }

    // POST /internal/solve-captcha
    //
    // The render sidecar owns the live page but holds no AI credentials, so it
    // ships the challenge grid here and we run the vision model. Deliberately
    // placed BEFORE the shared-secret gate and authed with its OWN secret: the
    // sidecar should be able to ask for tile picks and nothing else, so a
    // compromise of that box never becomes the ability to start or cancel runs.
    if (url.pathname === "/internal/solve-captcha") {
      if (request.method !== "POST") {
        return Response.json({ error: "method_not_allowed" }, { status: 405 });
      }
      if (!solverAuthorized(request, env)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return solveCaptcha(request, env);
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

    // POST /runs/:id/approve | /runs/:id/account-verified | /runs/:id/login-code
    //     | /runs/:id/cancel
    const match = url.pathname.match(
      /^\/runs\/([0-9a-f-]{36})\/(approve|account-verified|login-code|cancel)$/
    );
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

      if (action === "account-verified") {
        // The app confirmed the employer's account email through the sidecar and
        // is releasing the run. No payload: the workflow just resumes.
        await instance.sendEvent({ type: "account-verified", payload: {} });
        return Response.json({ ok: true });
      }

      if (action === "login-code") {
        // A run parked on a LinkedIn PIN challenge: the user entered the code in
        // the dashboard, and it rides the event into the waiting workflow.
        const body = (await request.json().catch(() => ({}))) as { code?: string };
        const code = typeof body.code === "string" ? body.code.trim() : "";
        if (!code) return Response.json({ error: "invalid_body" }, { status: 400 });
        await instance.sendEvent({ type: "login-code", payload: { code } });
        return Response.json({ ok: true });
      }

      await instance.terminate();
      await updateRun(env, runId, { status: "canceled" });
      return Response.json({ ok: true });
    }

    // Batches ride a second Workflow binding; without it the feature is off.
    if (url.pathname.startsWith("/batches") && !env.BATCH_RUN) {
      return Response.json(
        { error: "arm_offline", hint: "BATCH_RUN workflows binding missing" },
        { status: 503 }
      );
    }

    // POST /batches
    if (url.pathname === "/batches") {
      const params = (await request.json().catch(() => null)) as BatchParams | null;
      if (!params?.batchId || !params.userId || !params.account || !(params.reserved > 0)) {
        return Response.json({ error: "invalid_body" }, { status: 400 });
      }
      const instance = await env.BATCH_RUN!.create({ id: params.batchId, params });
      return Response.json({ ok: true, instance_id: instance.id }, { status: 202 });
    }

    // POST /batches/:id/login-code | /batches/:id/cancel
    const batchMatch = url.pathname.match(/^\/batches\/([0-9a-f-]{36})\/(login-code|cancel)$/);
    if (batchMatch) {
      const [, batchId, action] = batchMatch;
      let instance;
      try {
        instance = await env.BATCH_RUN!.get(batchId);
      } catch {
        return Response.json({ error: "batch_not_found" }, { status: 404 });
      }

      if (action === "login-code") {
        const body = (await request.json().catch(() => ({}))) as { code?: string };
        const code = typeof body.code === "string" ? body.code.trim() : "";
        if (!code) return Response.json({ error: "invalid_body" }, { status: 400 });
        await instance.sendEvent({ type: "login-code", payload: { code } });
        return Response.json({ ok: true });
      }

      // cancel: stop the instance and mark the row; the APP releases the unused
      // slots, since it can read reserved/consumed and owns metering elsewhere.
      // markBatchCanceled only flips LIVE states, so a cancel racing the batch's
      // own settle step cannot clobber a completed row (or double-release).
      await instance.terminate();
      await markBatchCanceled(env, batchId);
      return Response.json({ ok: true });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
} satisfies ExportedHandler<Env>;
