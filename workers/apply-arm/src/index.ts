/**
 * JobArms apply arm — Phase 0 skeleton.
 *
 * Phase 3 turns this into the real thing: a Workflow that opens the job
 * posting in Browser Rendering (Playwright), extracts the application form,
 * generates answers with Gemini from the user's profile, fills + screenshots
 * each step, pauses at the review gate, and submits on approval.
 *
 * Every request must carry the ARM_WORKER_SHARED_SECRET bearer — the same
 * secret the worker presents back to the app's callback routes.
 */
export interface Env {
  ARM_WORKER_SHARED_SECRET?: string;
}

function authorized(request: Request, env: Env): boolean {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return Boolean(env.ARM_WORKER_SHARED_SECRET) && token === env.ARM_WORKER_SHARED_SECRET;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "jobarms-apply-arm" });
    }

    if (!authorized(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    return Response.json({ error: "not_implemented", hint: "apply arm lands in Phase 3" }, { status: 501 });
  }
} satisfies ExportedHandler<Env>;
