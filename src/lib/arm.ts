import { envOr, requireEnv } from "@/lib/env";

/**
 * App → apply-arm worker calls. The worker lives at ARM_WORKER_URL
 * (https://jobarms-apply-arm.<account>.workers.dev until a custom domain)
 * and authenticates with the shared secret in both directions.
 */
export function armWorkerUrl(): string {
  return envOr("ARM_WORKER_URL", "");
}

export interface DispatchRunPayload {
  runId: string;
  applicationId: string;
  userId: string;
  jobUrl: string;
  ats: string;
  autonomy: "review_gate" | "full_auto";
  jobTitle: string;
  jobCompany: string;
  jobDescription: string;
  profile: Record<string, unknown>;
  resume: { signedUrl: string | null; fileName: string; mimeType: string };
  /** Learning payloads: this user's remembered answers + anonymous platform lessons. */
  memory: {
    answers: Array<{ label: string; answer: string; source: string }>;
    lessons: string[];
  };
  /**
   * Credentials for the employer's own ATS tenant, sent only for account-gated
   * ATSes. The worker forwards them to the sidecar and never persists them.
   */
  account?: { email: string; password: string };
}

export type ArmDispatchResult =
  | { ok: true }
  | { ok: false; reason: "arm_unconfigured" | "arm_offline" | "arm_error" };

async function armPost(path: string, body: unknown): Promise<ArmDispatchResult> {
  const base = armWorkerUrl();
  if (!base) return { ok: false, reason: "arm_unconfigured" };
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${requireEnv("ARM_WORKER_SHARED_SECRET")}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    });
    if (res.ok) return { ok: true };
    if (res.status === 503) return { ok: false, reason: "arm_offline" };
    return { ok: false, reason: "arm_error" };
  } catch {
    return { ok: false, reason: "arm_error" };
  }
}

export function dispatchRun(payload: DispatchRunPayload): Promise<ArmDispatchResult> {
  return armPost("/runs", payload);
}

export interface DispatchBatchPayload {
  batchId: string;
  userId: string;
  keywords: string;
  location: string;
  remote: boolean;
  /** Slots metering granted: the batch applies to at most this many jobs. */
  reserved: number;
  /** The meter key the reservation was made under, for releasing unused slots. */
  monthKey: string;
  profile: Record<string, unknown>;
  resume: { signedUrl: string | null; fileName: string; mimeType: string };
  memory: {
    answers: Array<{ label: string; answer: string; source: string }>;
    lessons: string[];
  };
  /** The user's connected LinkedIn login (batches are LinkedIn-only). */
  account: { email: string; password: string };
}

/** Start a search-driven LinkedIn Easy Apply batch. */
export function dispatchBatch(payload: DispatchBatchPayload): Promise<ArmDispatchResult> {
  return armPost("/batches", payload);
}

/** Cancel a running batch. */
export function cancelBatch(batchId: string): Promise<ArmDispatchResult> {
  return armPost(`/batches/${batchId}/cancel`, {});
}

/** Hand a batch parked on a LinkedIn PIN the code the user entered. */
export function submitBatchLoginCode(batchId: string, code: string): Promise<ArmDispatchResult> {
  return armPost(`/batches/${batchId}/login-code`, { code });
}

export function approveRun(
  runId: string,
  answers: unknown[] | undefined
): Promise<ArmDispatchResult> {
  return armPost(`/runs/${runId}/approve`, { answers });
}

export function cancelRun(runId: string): Promise<ArmDispatchResult> {
  return armPost(`/runs/${runId}/cancel`, {});
}

/**
 * Release a run parked waiting for its ATS account email to be verified.
 *
 * Called by the inbound-email webhook once the sidecar has confirmed the account
 * inside the held session. The worker owns run state, so this only sends the
 * workflow event; a failure leaves the run parked to time out honestly rather
 * than marking it complete behind the worker's back.
 */
export function resumeAccountVerification(runId: string): Promise<ArmDispatchResult> {
  return armPost(`/runs/${runId}/account-verified`, {});
}

/**
 * Hand a run parked on a LinkedIn PIN challenge the code the user entered.
 *
 * The worker owns run state, so this only sends the workflow event; a failure
 * leaves the run parked to time out honestly rather than marking it resumed
 * behind the worker's back.
 */
export function submitLoginCode(runId: string, code: string): Promise<ArmDispatchResult> {
  return armPost(`/runs/${runId}/login-code`, { code });
}
