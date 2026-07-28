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
  completeLoginCode,
  decodeScreenshot,
  ensureSession,
  extractForm,
  fetchResumeBase64,
  fillForm,
  type ExtractResponse,
  type Mismatch,
  type RenderResult
} from "./render";
import { diagnosePage, generateAnswers } from "./gemini";
import { notifyReviewNeeded } from "./notify";
import {
  appendScreenshot,
  type FillTactics,
  getFillTactics,
  getPlaybook,
  logStep,
  recordFillTactic,
  recordFillTacticFailure,
  recordPlaybook,
  recordPlaybookFailure,
  releaseArmRunSlot,
  updateApplication,
  updateRun,
  uploadScreenshot
} from "./db";

/** ATSes whose applications require an account on the employer's own tenant. */
const ACCOUNT_REQUIRED: ReadonlySet<string> = new Set(["workday", "linkedin"]);

/**
 * How long to wait for the user to enter a LinkedIn PIN.
 *
 * Longer than the email-verification wait (nobody has to fetch a code there),
 * shorter than the review gate: a login PIN expires in minutes, so waiting days
 * would only hold a browser slot for a code that stopped working. A timeout here
 * is a SYSTEM outcome (no application work happened), so it refunds.
 */
const LOGIN_CODE_TIMEOUT = "30 minutes";

/**
 * How many PIN attempts before giving up. LinkedIn re-prompts on a mistyped
 * code, so one wrong digit should not burn the run; a code that never works
 * still cannot hold a browser slot indefinitely.
 */
const LOGIN_CODE_MAX_ATTEMPTS = 3;

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
    // Generic (best-effort) runs are review-gate only whatever the app sent:
    // an untuned board must never be submitted without a human look. The app
    // enforces this at dispatch; this is the defense in depth.
    const params: RunParams =
      event.payload.ats === "generic" && event.payload.autonomy === "full_auto"
        ? { ...event.payload, autonomy: "review_gate" }
        : event.payload;
    const env = this.env;
    const domain = hostOf(params.jobUrl);

    try {
      // ------------------------------------------------- candidate account
      if (ACCOUNT_REQUIRED.has(params.ats)) {
        // What the session needs before the run can proceed:
        //  none  -> already authenticated
        //  email -> an employer account-confirmation mail (Workday)
        //  code  -> a LinkedIn PIN the user must type (checkpointUrl says where)
        const gate = await step.do("ensure account", async () => {
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
            // Bad credentials, MFA, or a challenge we cannot drive: retrying
            // burns a browser slot to fail identically.
            await logStep(env, params.runId, "account_login_failed");
            throw new NonRetryableError(
              "ats_login_failed: the sign-in was not accepted (check the connected account)"
            );
          }
          if (result.data.status === "needs_email_verification") {
            await updateRun(env, params.runId, { status: "needs_account_verification" });
            await logStep(env, params.runId, "account_verification_pending");
            return { wait: "email" as const };
          }
          if (result.data.status === "needs_login_code") {
            await updateRun(env, params.runId, { status: "needs_login_code" });
            await logStep(env, params.runId, "login_code_pending");
            return { wait: "code" as const, checkpointUrl: result.data.checkpointUrl ?? null };
          }
          await logStep(env, params.runId, "account_ready");
          return { wait: "none" as const };
        });

        if (gate.wait === "email") {
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
        } else if (gate.wait === "code") {
          // LinkedIn re-prompts on a mistyped PIN, so give the user a few tries
          // rather than fail the whole run (and the browser session) on one
          // fat-fingered digit. Bounded so a code that never works cannot hold a
          // browser slot forever. Step names carry the attempt number because a
          // step name is the Workflows cache key: reusing one would replay the
          // first attempt's result and never wait for the next code.
          for (let attempt = 1; ; attempt++) {
            let codeEvent: { payload?: { code?: string } };
            try {
              codeEvent = await step.waitForEvent<{ code?: string }>(`await login code ${attempt}`, {
                type: "login-code",
                timeout: LOGIN_CODE_TIMEOUT
              });
            } catch {
              // The user stopped entering codes. No application work happened, so
              // this refunds via the outer catch, like the email-verify timeout.
              throw new Error(
                "login_code_timeout: the sign-in code was never entered, so nothing was submitted"
              );
            }
            const verdict = await step.do(`submit login code ${attempt}`, async () => {
              const code = (codeEvent.payload?.code ?? "").trim();
              const result = await completeLoginCode(env, {
                userId: params.userId,
                tenantHost: hostOf(params.jobUrl),
                code,
                checkpointUrl: gate.checkpointUrl
              });
              if (!result.ok) throw renderFailure(result, "login code");
              if (result.data.status === "authenticated") {
                await updateRun(env, params.runId, { status: "running", error: null });
                await logStep(env, params.runId, "account_verified");
                return "authenticated" as const;
              }
              // LinkedIn still wants a code (a wrong or expired digit): re-park
              // for another try, up to the cap.
              if (result.data.status === "needs_login_code" && attempt < LOGIN_CODE_MAX_ATTEMPTS) {
                await updateRun(env, params.runId, { status: "needs_login_code" });
                await logStep(env, params.runId, "login_code_retry");
                return "retry" as const;
              }
              // Out of tries, or a hard rejection. A fresh run can ask for a new
              // code; this one ends honestly (and refunds via the outer catch).
              await logStep(env, params.runId, "account_login_failed");
              throw new NonRetryableError("ats_login_failed: the sign-in code was not accepted");
            });
            if (verdict === "authenticated") break;
          }
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
          const applied = await getFillTactics(env, domain, params.ats);
          const result = await fillForm(env, {
            userId: params.userId,
            runId: params.runId,
            jobUrl: params.jobUrl,
            ats: params.ats,
            answers,
            resume: await resumePayload(params),
            submit: false,
            playbook: await getPlaybook(env, domain, params.ats),
            tactics: applied
          });
          if (!result.ok) throw renderFailure(result, "fill for review");

          await saveShot(env, params, "filled", result.data.screenshotBase64);
          // A resume that did not attach leaves a REQUIRED field empty. Logged
          // BEFORE the review request so the timeline reads in order and the user
          // sees it while deciding, rather than discovering it after approving.
          if (result.data.resume === "failed") {
            await logStep(
              env,
              params.runId,
              "resume_not_attached",
              "this employer's upload widget refused the file, so attach it yourself before submitting"
            );
          }

          await learnTactics(env, domain, params.ats, applied, result.data);

          // Answers the form did not accept. Advisory here, because the person
          // deciding is about to look at them anyway; the point is that they are
          // told rather than left to spot it in a screenshot.
          const mismatches = result.data.mismatches ?? [];
          if (mismatches.length > 0) {
            await logStep(env, params.runId, "fill_mismatch", describeMismatches(mismatches));
          }
          // error: null clears residue from a transient earlier attempt
          // (e.g. a mid-run worker deploy) once the run recovers.
          await updateRun(env, params.runId, {
            status: "needs_review",
            error: null,
            fill_mismatches: mismatches
          });
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

      /**
       * The interlock refused to submit. Hand the run to the user instead of
       * failing it, and wait for corrected answers.
       *
       * Returns the corrected answers, or null when the wait expired (in which
       * case the run has already been closed out).
       *
       * Waits on the SAME `approval` event type as the review gate, so the app's
       * existing approve endpoint and review UI work untouched: both key off
       * `status = needs_review` and neither asks about autonomy. Only the step
       * NAMES differ, because those are cache keys.
       */
      const parkForCorrection = async (mismatches: Mismatch[]): Promise<Answer[] | null> => {
        await step.do("request correction", async () => {
          await updateRun(env, params.runId, {
            status: "needs_review",
            error: null,
            fill_mismatches: mismatches
          });
          await updateApplication(env, params.applicationId, { status: "needs_review" });
          await logStep(
            env,
            params.runId,
            "review_requested",
            `the form did not accept ${describeMismatches(mismatches)}, so nothing was submitted`
          );
          // A full-auto user is not watching for a review request, so telling
          // them is what makes the wait worth having. Best effort: a mail that
          // does not send must not cost them the run.
          await notifyReviewNeeded(env, params, mismatches);
        });

        let approval: { payload?: { answers?: Answer[] } };
        try {
          approval = await step.waitForEvent<{ answers?: Answer[] }>("await correction", {
            type: "approval",
            timeout: "7 days"
          });
        } catch {
          // Nobody corrected it. Ends exactly where this run ended before the
          // fallback existed, so ignoring the mail is never worse than not
          // being asked. Real work happened, so the run is CONSUMED.
          await step.do("correction timeout", async () => {
            await updateRun(env, params.runId, {
              status: "failed",
              error: `verification_failed: the form did not accept your answer for ${describeMismatches(mismatches)}, and the correction was never made, so nothing was submitted`
            });
            await updateApplication(env, params.applicationId, { status: "failed" });
            await logStep(env, params.runId, "fill_mismatch", describeMismatches(mismatches));
          });
          return null;
        }

        const corrected = approval.payload?.answers?.length
          ? approval.payload.answers
          : approvedAnswers;
        await step.do("record correction", async () => {
          await updateRun(env, params.runId, { status: "approved", answers: corrected });
          await logStep(env, params.runId, "approved");
        });
        return corrected;
      };

      // ------------------------------------------------ submit
      // NO retries: the submit phase clicks the employer's real submit control
      // and is not idempotent. A retry after a partial failure could send the
      // SAME application twice (the first attempt may have landed even when a
      // later await threw). A submit crash fails the run honestly and refunds
      // via the outer catch; the user can retry with a fresh arm.
      //
      // `stepName` is a PARAMETER because a step name is the Workflows cache key:
      // calling this twice under one name would hand back the first attempt's
      // result and silently skip the second submit.
      const submitAttempt = (stepName: string) =>
        step.do(stepName, { retries: { limit: 0, delay: "30 seconds" } }, async () => {
          await updateRun(env, params.runId, { status: "submitting" });
          const applied = await getFillTactics(env, domain, params.ats);
          const result = await fillForm(env, {
            userId: params.userId,
            runId: params.runId,
            jobUrl: params.jobUrl,
            ats: params.ats,
            answers: approvedAnswers,
            resume: await resumePayload(params),
            submit: true,
            playbook: await getPlaybook(env, domain, params.ats),
            tactics: applied
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
          await learnTactics(env, domain, params.ats, applied, result.data);
          return { outcome: result.data.outcome, mismatches: result.data.mismatches ?? [] };
        });

      let outcome = await submitAttempt("submit");

      // A refused submit is not the end of the road for a full-auto run. The
      // fill is done and the application is one edit from correct, so ask the
      // user rather than throwing the work away. Review-gate runs do NOT come
      // back here: they already had their review, and the sidecar already tried
      // the alternative tactic, so asking the same person for the same answers
      // would only spend another week to reach the same place.
      if (outcome.outcome === "verification_failed" && params.autonomy === "full_auto") {
        const corrected = await parkForCorrection(outcome.mismatches);
        // Expired. The run is already closed out, and nothing was submitted.
        if (!corrected) return;
        approvedAnswers = corrected;
        outcome = await submitAttempt("submit after correction");
      }

      await step.do("finalize", async () => {
        if (outcome.outcome === "verification_failed") {
          // The arm filled the form, read it back, and the form disagreed with an
          // approved answer on a choice field, so it refused to send it. That is
          // real work and it CONSUMES the run (no refund), on the same reasoning
          // as captcha_blocked.
          //
          // Recorded as failed rather than parked for review, even though review
          // is what it deserves: this run's workflow ends here, so nothing would
          // be listening for the approval event and the Approve button would do
          // nothing forever. RunPanel matches the "verification_failed:" prefix.
          // Letting full auto fall back into the review gate is the better answer
          // and is worth doing on its own.
          await updateRun(env, params.runId, {
            status: "failed",
            error: `verification_failed: the form did not accept your answer for ${describeMismatches(outcome.mismatches)}, so nothing was submitted`,
            fill_mismatches: outcome.mismatches
          });
          await updateApplication(env, params.applicationId, { status: "failed" });
          await logStep(env, params.runId, "fill_mismatch", describeMismatches(outcome.mismatches));
        } else if (outcome.outcome === "submitted") {
          await updateRun(env, params.runId, { status: "submitted", error: null });
          await updateApplication(env, params.applicationId, {
            status: "applied",
            applied_at: new Date().toISOString()
          });
          await logStep(env, params.runId, "submitted", "confirmation detected");
        } else if (outcome.outcome === "captcha_blocked") {
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
 * Remember how this site wanted its controls driven.
 *
 * Best effort, and `recordFillTactic` is what makes it so: the application
 * already worked by the time this runs, and failing a run over a bookkeeping
 * write would trade a real outcome for a nicety.
 */
async function learnTactics(
  env: Env,
  domain: string,
  ats: string,
  applied: FillTactics,
  result: { tactics?: { kind: string; tactic: string }[]; mismatches?: { kind: string }[] }
): Promise<void> {
  for (const won of result.tactics ?? []) {
    await recordFillTactic(env, domain, ats, won.kind, won.tactic);
  }

  // The other half, without which a stored tactic is never allowed to be wrong:
  // if we led with a remembered way of driving a control and that kind is STILL
  // disagreeing after the retry, it has stopped working on this site. Counting
  // that against it is what eventually retires it, the same way a playbook that
  // keeps failing stops being applied.
  const stillWrong = new Set((result.mismatches ?? []).map((mismatch) => mismatch.kind));
  for (const kind of ["choice", "text"] as const) {
    if (applied[kind] && stillWrong.has(kind)) {
      await recordFillTacticFailure(env, domain, ats, kind);
    }
  }
}

/**
 * Name the fields the form disagreed with, for the timeline and the run error.
 *
 * Labels, not field names: the person reading this is looking at a form, and
 * "question_35110798002[]" tells them nothing about which question it was.
 */
function describeMismatches(mismatches: { name: string; label: string }[]): string {
  const named = mismatches.map((m) => m.label.trim() || m.name).filter(Boolean);
  if (named.length <= 3) return named.join(", ");
  return `${named.slice(0, 3).join(", ")} and ${named.length - 3} more`;
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
