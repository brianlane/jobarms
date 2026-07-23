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
