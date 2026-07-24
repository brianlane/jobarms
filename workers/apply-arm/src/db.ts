/**
 * Minimal Supabase REST + Storage client for the worker (service key -
 * bypasses RLS; the worker only ever touches rows for the run it was given).
 * Plain fetch keeps the bundle small.
 */
import type { Env } from "./types";

function headers(env: Env): Record<string, string> {
  const key = env.SUPABASE_SECRET_KEY ?? "";
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json"
  };
}

export async function updateRun(
  env: Env,
  runId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/application_runs?id=eq.${encodeURIComponent(runId)}`,
    { method: "PATCH", headers: headers(env), body: JSON.stringify(patch) }
  );
  if (!res.ok) {
    throw new Error(`updateRun ${runId} failed: ${res.status} ${await res.text()}`);
  }
}

export async function updateApplication(
  env: Env,
  applicationId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/applications?id=eq.${encodeURIComponent(applicationId)}`,
    { method: "PATCH", headers: headers(env), body: JSON.stringify(patch) }
  );
  if (!res.ok) {
    throw new Error(`updateApplication ${applicationId} failed: ${res.status}`);
  }
}

/** Append a step to the run's step log atomically (append_run_step RPC). */
export async function logStep(env: Env, runId: string, step: string, detail = ""): Promise<void> {
  const entry = { at: new Date().toISOString(), step, detail };
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/append_run_step`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ p_run_id: runId, p_step: entry })
  });
  if (!res.ok) {
    throw new Error(`logStep ${runId} failed: ${res.status}`);
  }
}

/** Upload a screenshot to the private run-artifacts bucket; returns its path. */
export async function uploadScreenshot(
  env: Env,
  userId: string,
  runId: string,
  label: string,
  png: ArrayBuffer | Uint8Array
): Promise<string> {
  const path = `${userId}/${runId}/${Date.now()}-${label}.png`;
  const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/run-artifacts/${path}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SECRET_KEY ?? "",
      authorization: `Bearer ${env.SUPABASE_SECRET_KEY ?? ""}`,
      "content-type": "image/png"
    },
    body: png as BodyInit
  });
  if (!res.ok) {
    throw new Error(`screenshot upload failed: ${res.status}`);
  }
  return path;
}

/** Append a screenshot path atomically (append_run_screenshot RPC). */
export async function appendScreenshot(env: Env, runId: string, path: string): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/append_run_screenshot`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ p_run_id: runId, p_path: path })
  });
  if (!res.ok) {
    throw new Error(`appendScreenshot ${runId} failed: ${res.status}`);
  }
}

/**
 * Refund the run's metered slot (release_arm_run RPC). Called ONLY for
 * system failures: quota counts successful runs, so workflow errors and
 * unconfirmed submits give the slot back. User cancels do NOT refund.
 * Best-effort: a refund failure must never mask the original error.
 */
export async function releaseArmRunSlot(env: Env, runId: string): Promise<void> {
  try {
    // refund_arm_run is idempotent per run (slot_refunded flag set atomically
    // with the usage decrement), so worker retries and the app's retry/cancel
    // cleanup can all call it without ever double-crediting.
    await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/refund_arm_run`, {
      method: "POST",
      headers: headers(env),
      body: JSON.stringify({ p_run_id: runId })
    });
  } catch {
    // advisory only
  }
}

// --- Self-healing playbooks -------------------------------------------------

export interface PlaybookStrategy {
  action: "click" | "iframe" | "scroll";
  click_text?: string;
}

/** Known recovery strategy for a domain, if one has succeeded before. */
export async function getPlaybook(
  env: Env,
  domain: string,
  ats: string
): Promise<PlaybookStrategy | null> {
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/arm_playbooks?domain=eq.${encodeURIComponent(domain)}&ats=eq.${encodeURIComponent(ats)}&select=strategy,success_count,failure_count`,
      { headers: headers(env) }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{
      strategy: PlaybookStrategy;
      success_count: number;
      failure_count: number;
    }>;
    const row = rows[0];
    if (!row) return null;
    // A playbook that keeps failing has gone stale; stop applying it.
    if (row.failure_count > row.success_count) return null;
    return row.strategy;
  } catch {
    return null;
  }
}

export async function recordPlaybook(
  env: Env,
  domain: string,
  ats: string,
  strategy: PlaybookStrategy
): Promise<void> {
  await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/record_arm_playbook`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ p_domain: domain, p_ats: ats, p_strategy: strategy })
  }).catch(() => {});
}

export async function recordPlaybookFailure(env: Env, domain: string, ats: string): Promise<void> {
  await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/record_arm_playbook_failure`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ p_domain: domain, p_ats: ats })
  }).catch(() => {});
}
