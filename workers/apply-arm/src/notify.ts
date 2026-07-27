/**
 * Telling the user their arm needs them.
 *
 * The mail is sent BY THE APP, not here. The app already owns the only Resend
 * client, the branding, and the Gmail display-name rules that took a day to get
 * right, so a second sender on the worker would be a second place to keep all of
 * that correct. This asks the app to send instead, with the same shared secret
 * the app uses to call us.
 */
import type { Env, RunParams } from "./types";
import type { Mismatch } from "./render";

/**
 * Ask the app to email the user that a run is waiting on them.
 *
 * Never throws and never reports failure, by design: this runs inside a step
 * that has already parked the run, and losing a run because a notification was
 * refused would be a bad trade. A run sitting unseen is recoverable; a run
 * failed for a mail is not.
 */
export async function notifyReviewNeeded(
  env: Env,
  params: RunParams,
  mismatches: Mismatch[]
): Promise<void> {
  const base = env.APP_BASE_URL;
  const secret = env.ARM_WORKER_SHARED_SECRET;
  if (!base || !secret) return;

  try {
    await fetch(`${base.replace(/\/+$/, "")}/api/internal/run-needs-review`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`
      },
      body: JSON.stringify({
        runId: params.runId,
        applicationId: params.applicationId,
        userId: params.userId,
        // Labels only. The app has the run row and can read anything else it
        // needs; there is no reason to put answer VALUES in an email payload.
        fields: mismatches.map((mismatch) => mismatch.label || mismatch.name)
      }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    // Unreachable app, timeout, anything: the run is parked either way.
  }
}
