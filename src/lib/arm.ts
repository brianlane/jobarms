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
