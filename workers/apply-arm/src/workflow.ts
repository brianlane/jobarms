/**
 * ApplyRunWorkflow - one instance per arm run.
 *
 * queued -> [ensure account -> await verification] -> running (extract + answer)
 *        -> [review gate] -> submitting -> submitted | failed
 *
 * The Workflow owns everything DURABLE: the two waiting states (the seven-day
 * review gate and the account-verification wait), step retries, and the refund
 * policy. Every browser phase is one HTTPS call to the render sidecar, so a crash
 * costs a step, not a run, and the sidecar keeps the logged-in session alive
 * between them. Steps return only small JSON; screenshots go to storage inside
 * the step.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Answer, Env, RecoveryStrategy, RunParams } from "./types";
import {
  decodeScreenshot,
  ensureSession,
  extractForm,
  fetchResumeBase64,
  fillForm,
  type ExtractResponse,
  type RenderResult
} from "./render";
import { diagnosePage, generateAnswers } from "./gemini";
import {
  appendScreenshot,
  getPlaybook,
  logStep,
  recordPlaybook,
  recordPlaybookFailure,
  releaseArmRunSlot,
  updateApplication,
  updateRun,
  uploadScreenshot
} from "./db";

/** ATSes whose applications require an account on the employer's own tenant. */
const ACCOUNT_REQUIRED: ReadonlySet<string> = new Set(["workday"]);

/**
 * How long to wait for an employer's account-verification email.
 *
 * Short compared to the review gate because nobody is being asked to do
 * anything: the mail either arrives in minutes or the tenant is not going to
 * send it. Timing out here is a SYSTEM failure, so the slot is refunded.
 */
const VERIFICATION_TIMEOUT = "30 minutes";

export class ApplyRunWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  async run(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const params = event.payload;
    const env = this.env;
    const domain = hostOf(params.jobUrl);

    try {
      // ------------------------------------------------- candidate account
      if (ACCOUNT_REQUIRED.has(params.ats)) {
        const needsVerification = await step.do("ensure account", async () => {
          await updateRun(env, params.runId, { status: "running" });
          await logStep(env, params.runId, "account_check", domain);

          const result = await ensureSession(env, {
            userId: params.userId,
            jobUrl: params.jobUrl,
            ats: params.ats,
            ...(params.account ? { account: params.account } : {})
          });
          if (!result.ok) throw renderFailure(result, "account setup");

          await saveShot(env, params, "account", result.data.screenshotBase64);

          if (result.data.status === "login_failed") {
            // Bad credentials, MFA, or a captcha at sign-in: retrying burns a
            // browser slot to fail identically.
            await logStep(env, params.runId, "account_login_failed");
            throw new NonRetryableError(
              "ats_login_failed: this employer's site would not accept the account we created"
            );
          }
          if (result.data.status === "needs_email_verification") {
            await updateRun(env, params.runId, { status: "needs_account_verification" });
            await logStep(env, params.runId, "account_verification_pending");
            return true;
          }
          await logStep(env, params.runId, "account_ready");
          return false;
        });

        if (needsVerification) {
          try {
            await step.waitForEvent("await account verification", {
              type: "account-verified",
              timeout: VERIFICATION_TIMEOUT
            });
          } catch {
            // The mail never arrived (or the tenant never sent it). Nothing was
            // submitted and the user did nothing wrong, so this refunds via the
            // outer catch.
            throw new Error(
              "account_verification_timeout: the employer never confirmed the application email"
            );
          }
          await step.do("account verified", async () => {
            await updateRun(env, params.runId, { status: "running", error: null });
            await logStep(env, params.runId, "account_verified");
          });
        }
      }

      // ------------------------------------------------ extract + answer
      const { fields } = await step.do(
        "extract form",
        { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
        async () => {
          await updateRun(env, params.runId, { status: "running" });
          await logStep(env, params.runId, "navigate", params.jobUrl);

          const result = await reachWithVision(env, params, domain);
          const shot = decodeScreenshot(result.screenshotBase64);
          if (shot) {
            await appendScreenshot(
              env,
              params.runId,
              await uploadScreenshot(env, params.userId, params.runId, "form", shot)
            );
          }
          await updateRun(env, params.runId, { form_fields: result.fields });
          await logStep(
            env,
            params.runId,
            "form_extracted",
            `${result.fields.length} fields across ${result.pages} page(s)`
          );
          return { fields: result.fields };
        }
      );

      const answers = await step.do(
        "generate answers",
        { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
        async () => {
          const generated = await generateAnswers(env, params, fields);
          await updateRun(env, params.runId, { answers: generated });
          await logStep(env, params.runId, "answers_generated", `${generated.length} answers`);
          return generated;
        }
      );

      // ------------------------------------------------ fill (no submit) for review
      let approvedAnswers: Answer[] = answers;

      if (params.autonomy === "review_gate") {
        await step.do("fill for review", async () => {
          const result = await fillForm(env, {
            userId: params.userId,
            jobUrl: params.jobUrl,
            ats: params.ats,
            answers,
            resume: await resumePayload(params),
            submit: false,
            playbook: await getPlaybook(env, domain, params.ats)
          });
          if (!result.ok) throw renderFailure(result, "fill for review");

          await saveShot(env, params, "filled", result.data.screenshotBase64);
          // error: null clears residue from a transient earlier attempt
          // (e.g. a mid-run worker deploy) once the run recovers.
          await updateRun(env, params.runId, { status: "needs_review", error: null });
          await updateApplication(env, params.applicationId, { status: "needs_review" });
          await logStep(env, params.runId, "review_requested");
        });

        let approval: { payload?: { answers?: Answer[] } };
        try {
          approval = await step.waitForEvent<{ answers?: Answer[] }>("await approval", {
            type: "approval",
            timeout: "7 days"
          });
        } catch {
          // Review-gate timeout = the user walked away. That COUNTS against
          // quota (compute was spent on their behalf), so no refund: mark
          // canceled and end the run cleanly.
          await step.do("review timeout", async () => {
            await updateRun(env, params.runId, {
              status: "canceled",
              error: "review_timeout: the review gate expired after 7 days"
            });
            await updateApplication(env, params.applicationId, { status: "saved" });
            await logStep(env, params.runId, "review_timeout");
          });
          return;
        }
        if (approval.payload?.answers?.length) {
          approvedAnswers = approval.payload.answers;
        }
        await step.do("record approval", async () => {
          await updateRun(env, params.runId, { status: "approved", answers: approvedAnswers });
          await logStep(env, params.runId, "approved");
        });
      }

      // ------------------------------------------------ submit
      // NO retries: the submit phase clicks the employer's real submit control
      // and is not idempotent. A retry after a partial failure could send the
      // SAME application twice (the first attempt may have landed even when a
      // later await threw). A submit crash fails the run honestly and refunds
      // via the outer catch; the user can retry with a fresh arm.
      const outcome = await step.do(
        "submit",
        { retries: { limit: 0, delay: "30 seconds" } },
        async () => {
          await updateRun(env, params.runId, { status: "submitting" });
          const result = await fillForm(env, {
            userId: params.userId,
            jobUrl: params.jobUrl,
            ats: params.ats,
            answers: approvedAnswers,
            resume: await resumePayload(params),
            submit: true,
            playbook: await getPlaybook(env, domain, params.ats)
          });
          if (!result.ok) throw renderFailure(result, "submit");

          // Post-submit bookkeeping is best-effort: once the application has
          // been submitted, a screenshot/storage hiccup must never fail this
          // step (a missing proof shot is cosmetic; a failed step is not).
          try {
            await saveShot(env, params, "submitted", result.data.screenshotBase64);
          } catch {
            // keep the outcome; the confirmation state is what matters
          }
          return result.data.outcome;
        }
      );

      await step.do("finalize", async () => {
        if (outcome === "submitted") {
          await updateRun(env, params.runId, { status: "submitted", error: null });
          await updateApplication(env, params.applicationId, {
            status: "applied",
            applied_at: new Date().toISOString()
          });
          await logStep(env, params.runId, "submitted", "confirmation detected");
        } else if (outcome === "captcha_blocked") {
          // The arm did the full application; only the employer's anti-bot
          // check stopped the final send. That is real work, so it CONSUMES
          // the run (no refund). RunPanel matches the "captcha_blocked:" prefix.
          await updateRun(env, params.runId, {
            status: "failed",
            error:
              "captcha_blocked: the employer's anti-bot check blocked the automated submit; answers are saved, finish on the employer's site"
          });
          await updateApplication(env, params.applicationId, { status: "failed" });
          await logStep(env, params.runId, "captcha_blocked");
        } else {
          // unconfirmed: submit clicked, no confirmation shown. The submit most
          // likely went through and the fill was the expensive work, so this
          // CONSUMES the run (no refund) per "work done = paid".
          await updateRun(env, params.runId, {
            status: "failed",
            error: "submit_unconfirmed - the ATS never showed a confirmation; verify manually"
          });
          await updateApplication(env, params.applicationId, { status: "failed" });
          await logStep(env, params.runId, "submit_unconfirmed");
        }
      });
    } catch (err) {
      // Terminal SYSTEM failure (retries exhausted): record honestly and
      // refund the metered slot - the user only pays quota for runs that
      // actually submit. (Review-gate timeouts exit above WITHOUT a refund.)
      const message = err instanceof Error ? err.message : String(err);
      await updateRun(env, params.runId, { status: "failed", error: message.slice(0, 500) });
      await updateApplication(env, params.applicationId, { status: "failed" });
      await releaseArmRunSlot(env, params.runId);
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------

/** The job URL's hostname, which keys both playbooks and browser sessions. */
function hostOf(jobUrl: string): string {
  try {
    return new URL(jobUrl).hostname;
  } catch {
    return "";
  }
}

/**
 * Turn a sidecar failure into a retryable error.
 *
 * Only TRANSIENT failures reach here (a tunnel blip, a crashed context), so they
 * get the retry budget the step was given. The two deterministic outcomes are
 * handled where they occur, because each needs to do more than throw:
 * `form_not_found` first spends the vision budget in `reachWithVision`, and
 * `login_failed` logs the account step before giving up. Both raise
 * NonRetryableError there.
 */
function renderFailure(result: RenderResult<unknown> & { ok: false }, phase: string): Error {
  const detail = result.detail ? `: ${result.detail}` : "";
  return new Error(`${result.error} during ${phase}${detail}`);
}

/** Store one screenshot against the run. Best-effort at the call sites. */
async function saveShot(
  env: Env,
  params: RunParams,
  label: string,
  base64: string | null | undefined
): Promise<void> {
  const bytes = decodeScreenshot(base64);
  if (!bytes) return;
  const path = await uploadScreenshot(env, params.userId, params.runId, label, bytes);
  await appendScreenshot(env, params.runId, path);
}

/** The resume as bytes, so the sidecar never fetches anything itself. */
async function resumePayload(params: RunParams): Promise<{
  contentBase64: string | null;
  fileName: string;
  mimeType: string;
}> {
  return {
    contentBase64: await fetchResumeBase64(params.resume.signedUrl),
    fileName: params.resume.fileName,
    mimeType: params.resume.mimeType
  };
}

/**
 * Reach the form, healing with vision when the page hides it.
 *
 * The sidecar applies a strategy and reports what it found; the vision model
 * lives HERE because the box holds no AI credentials. So the loop is: try the
 * stored playbook, and if the form is unreachable, look at the screenshot the
 * sidecar returned, ask the model what stands in the way, and call back with that
 * strategy. A strategy that works becomes this domain's playbook, so the next run
 * skips vision entirely.
 */
async function reachWithVision(
  env: Env,
  params: RunParams,
  domain: string
): Promise<ExtractResponse> {
  const playbook = await getPlaybook(env, domain, params.ats);
  const base = { userId: params.userId, jobUrl: params.jobUrl, ats: params.ats };

  const attempt = await extractForm(env, { ...base, playbook });
  if (attempt.ok) {
    if (attempt.data.playbookFailed) await recordPlaybookFailure(env, domain, params.ats);
    if (attempt.data.recovery) {
      await recordPlaybook(env, domain, params.ats, attempt.data.recovery.strategy);
      await logStep(
        env,
        params.runId,
        attempt.data.recovery.source === "vision" ? "recovery_vision" : "recovery_playbook",
        attempt.data.recovery.strategy.action
      );
    }
    return attempt.data;
  }
  if (attempt.error !== "form_not_found") throw renderFailure(attempt, "form extraction");
  if (playbook) await recordPlaybookFailure(env, domain, params.ats);

  // Up to two vision rounds, same budget the in-process version had. `failure`
  // holds the most recent unsuccessful attempt, which is where the screenshot to
  // look at comes from.
  let failure: RenderResult<ExtractResponse> & { ok: false } = attempt;
  let reason = failure.detail ?? "form not reachable";
  for (let round = 0; round < 2; round++) {
    const shot = decodeScreenshot(failure.screenshotBase64);
    if (!shot) break;

    const diagnosis = await diagnosePage(env, shot, params.jobUrl, reason).catch(() => null);
    if (!diagnosis || diagnosis.action === "none") {
      reason = diagnosis?.reason || reason;
      break;
    }

    const strategy: RecoveryStrategy = {
      action: diagnosis.action,
      ...(diagnosis.click_text ? { click_text: diagnosis.click_text } : {})
    };
    const next = await extractForm(env, { ...base, playbook: strategy });
    if (next.ok) {
      await recordPlaybook(env, domain, params.ats, strategy);
      await logStep(env, params.runId, "recovery_vision", strategy.action);
      return next.data;
    }
    if (next.error !== "form_not_found") throw renderFailure(next, "form extraction");
    failure = next;
    reason = next.detail ?? reason;
  }

  // Deterministic: there is no application form here we can drive.
  await logStep(env, params.runId, "form_not_found", reason);
  throw new NonRetryableError(`form_not_found: ${reason}`);
}
