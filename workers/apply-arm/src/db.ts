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

// --- Batch support (search-driven Easy Apply) -------------------------------
// A batch discovers its jobs at run time, so the WORKER creates the job,
// application, and run rows per card (the app only knows them for single runs).

/** Update an apply_batches row (status, counters, error). */
export async function updateBatch(
  env: Env,
  batchId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/apply_batches?id=eq.${encodeURIComponent(batchId)}`,
    { method: "PATCH", headers: headers(env), body: JSON.stringify(patch) }
  );
  if (!res.ok) {
    throw new Error(`updateBatch ${batchId} failed: ${res.status}`);
  }
}

/**
 * Mark a batch canceled, but only if it is still in a live state. A cancel that
 * races the batch's own settle step must not overwrite "completed"/"failed"
 * (the app decides whether to release slots by whether this landed).
 */
export async function markBatchCanceled(env: Env, batchId: string): Promise<void> {
  const filter =
    `id=eq.${encodeURIComponent(batchId)}` +
    `&status=in.(queued,searching,running,needs_login_code)`;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/apply_batches?${filter}`, {
    method: "PATCH",
    headers: headers(env),
    body: JSON.stringify({ status: "canceled" })
  });
  if (!res.ok) {
    throw new Error(`markBatchCanceled ${batchId} failed: ${res.status}`);
  }
}

/**
 * Claim a batch for execution: queued -> running, reporting whether the claim
 * landed ("running" also passes so a retried first step is not a false loss).
 *
 * This is one side of the dispatch-timeout race: the app's POST can time out
 * AFTER the worker accepted the batch. The app then gives up ONLY via a
 * guarded queued-only write, and this claim ONLY wins live rows, so exactly
 * one of them does - a batch never runs on quota the app already released.
 */
export async function claimBatch(env: Env, batchId: string): Promise<boolean> {
  const filter = `id=eq.${encodeURIComponent(batchId)}&status=in.(queued,running)`;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/apply_batches?${filter}`, {
    method: "PATCH",
    headers: { ...headers(env), Prefer: "return=representation" },
    body: JSON.stringify({ status: "running" })
  });
  if (!res.ok) {
    throw new Error(`claimBatch ${batchId} failed: ${res.status}`);
  }
  const rows = (await res.json()) as unknown[];
  return rows.length > 0;
}

/**
 * Mark a batch failed, but only if it is still in a live state, reporting
 * whether the write landed. The batch's failure path releases the unspent
 * reservation ONLY when it landed: a batch the user already canceled had its
 * release done by the app's cancel route, and doing it again here would
 * double-credit the quota (and overwrite "canceled" with "failed").
 */
export async function settleBatchFailure(
  env: Env,
  batchId: string,
  patch: Record<string, unknown>
): Promise<boolean> {
  const filter =
    `id=eq.${encodeURIComponent(batchId)}` +
    `&status=in.(queued,searching,running,needs_login_code)`;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/apply_batches?${filter}`, {
    method: "PATCH",
    headers: { ...headers(env), Prefer: "return=representation" },
    body: JSON.stringify({ ...patch, status: "failed" })
  });
  if (!res.ok) {
    throw new Error(`settleBatchFailure ${batchId} failed: ${res.status}`);
  }
  const rows = (await res.json()) as unknown[];
  return rows.length > 0;
}

/**
 * Ensure a jobs row for this URL and return its id.
 *
 * ignore-duplicates, never merge: `jobs` is shared across users, so a batch must
 * not overwrite metadata another user (or ingest) already recorded. A conflict
 * skips the insert and the follow-up read returns the winner.
 */
export async function upsertJob(
  env: Env,
  job: { url: string; ats: string; company: string; title: string; location: string }
): Promise<string | null> {
  await fetch(`${env.SUPABASE_URL}/rest/v1/jobs?on_conflict=url`, {
    method: "POST",
    headers: { ...headers(env), Prefer: "resolution=ignore-duplicates" },
    body: JSON.stringify({
      url: job.url,
      ats: job.ats,
      source: "arm",
      company: job.company,
      title: job.title,
      location: job.location
    })
  }).catch(() => {});
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/jobs?url=eq.${encodeURIComponent(job.url)}&select=id`,
    { headers: headers(env) }
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/** This user's existing application for a job, if any (for batch dedup). */
export async function findApplication(
  env: Env,
  userId: string,
  jobId: string
): Promise<{ id: string; status: string } | null> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/applications?user_id=eq.${encodeURIComponent(userId)}&job_id=eq.${encodeURIComponent(jobId)}&select=id,status`,
    { headers: headers(env) }
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ id: string; status: string }>;
  return rows[0] ?? null;
}

/** Create an application row (arm-sourced), returning its id. */
export async function createApplication(
  env: Env,
  userId: string,
  jobId: string
): Promise<string | null> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/applications`, {
    method: "POST",
    headers: { ...headers(env), Prefer: "return=representation" },
    body: JSON.stringify({ user_id: userId, job_id: jobId, source: "arm", status: "applying" })
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/** Create a run row for a batch job, returning its id. */
export async function createRun(
  env: Env,
  args: {
    applicationId: string;
    userId: string;
    monthKey: string;
    batchId: string;
    tenantHost: string;
  }
): Promise<string | null> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/application_runs`, {
    method: "POST",
    headers: { ...headers(env), Prefer: "return=representation" },
    body: JSON.stringify({
      application_id: args.applicationId,
      user_id: args.userId,
      autonomy: "full_auto",
      month_key: args.monthKey,
      batch_id: args.batchId,
      tenant_host: args.tenantHost,
      status: "running"
    })
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/** Hand back reserved-but-unused batch slots (release_arm_runs RPC). Best-effort. */
export async function releaseArmRuns(
  env: Env,
  userId: string,
  monthKey: string,
  count: number
): Promise<void> {
  if (count <= 0) return;
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/release_arm_runs`, {
      method: "POST",
      headers: headers(env),
      body: JSON.stringify({ p_user_id: userId, p_month_key: monthKey, p_count: count })
    });
  } catch {
    // advisory only
  }
}

// --- AI spend ledger --------------------------------------------------------

/**
 * Dollars per million tokens for the model that served a call. The worker cannot
 * import the app's pricing table (separate bundle), so the primary model's rate
 * is duplicated here and everything else is priced at it, which overestimates
 * rather than flatters. Keep in step with src/lib/ai-cost.ts.
 */
const INPUT_USD_PER_MILLION = 1.5;
const OUTPUT_USD_PER_MILLION = 7.5;

export interface SpendUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Dollars per million tokens equals micros per token, so this is just tokens times rate. */
export function spendCostMicros(usage: SpendUsage): number {
  return Math.round(
    Math.max(usage.inputTokens, 0) * INPUT_USD_PER_MILLION +
      Math.max(usage.outputTokens, 0) * OUTPUT_USD_PER_MILLION
  );
}

/**
 * Append one row to the AI spend ledger. Best effort: a run that already
 * produced answers must never fail because the bookkeeping did.
 */
export async function recordAiSpend(
  env: Env,
  entry: SpendUsage & { kind: string; userId?: string | null; runId?: string | null }
): Promise<void> {
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/record_ai_spend`, {
      method: "POST",
      headers: headers(env),
      body: JSON.stringify({
        p_user_id: entry.userId ?? null,
        p_run_id: entry.runId ?? null,
        p_kind: entry.kind,
        p_model: entry.model,
        p_used_fallback: false,
        p_input_tokens: entry.inputTokens,
        p_output_tokens: entry.outputTokens,
        p_cost_micros: spendCostMicros(entry)
      })
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

/** How a control wants to be driven on a given site. */
export interface FillTactics {
  choice?: "control" | "label";
  text?: "type" | "set";
}

/**
 * What has worked on this site before.
 *
 * The other half of a playbook: that one remembers how to REACH a form, this
 * remembers how to OPERATE one. Sites disagree about whether a control listens to
 * its input or only to its visible label, so leading with the known answer saves
 * every later run the rediscovery.
 */
export async function getFillTactics(
  env: Env,
  domain: string,
  ats: string
): Promise<FillTactics> {
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/arm_fill_tactics?domain=eq.${encodeURIComponent(domain)}&ats=eq.${encodeURIComponent(ats)}&select=kind,tactic,success_count,failure_count`,
      { headers: headers(env) }
    );
    if (!res.ok) return {};
    const rows = (await res.json()) as Array<{
      kind: "choice" | "text";
      tactic: "control" | "label" | "type" | "set";
      success_count: number;
      failure_count: number;
    }>;
    const tactics: FillTactics = {};
    for (const row of rows) {
      // A tactic that keeps failing has gone stale, same rule as playbooks.
      if (row.failure_count > row.success_count) continue;
      if (row.kind === "choice" && (row.tactic === "control" || row.tactic === "label")) {
        tactics.choice = row.tactic;
      }
      if (row.kind === "text" && (row.tactic === "type" || row.tactic === "set")) {
        tactics.text = row.tactic;
      }
    }
    return tactics;
  } catch {
    return {};
  }
}

/** Remember a way of driving a control that worked where the default did not. */
export async function recordFillTactic(
  env: Env,
  domain: string,
  ats: string,
  kind: string,
  tactic: string
): Promise<void> {
  await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/record_fill_tactic`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ p_domain: domain, p_ats: ats, p_kind: kind, p_tactic: tactic })
  }).catch(() => {});
}

/** Count a stored tactic against itself after it failed to drive the control. */
export async function recordFillTacticFailure(
  env: Env,
  domain: string,
  ats: string,
  kind: string
): Promise<void> {
  await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/record_fill_tactic_failure`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ p_domain: domain, p_ats: ats, p_kind: kind })
  }).catch(() => {});
}

export async function recordPlaybookFailure(env: Env, domain: string, ats: string): Promise<void> {
  await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/record_arm_playbook_failure`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ p_domain: domain, p_ats: ats })
  }).catch(() => {});
}
