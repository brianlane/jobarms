/**
 * ApplyRunWorkflow - one instance per arm run.
 *
 * queued → running (extract + answer) → [review gate] → submitting →
 * submitted | failed. Each step is retryable and returns only small JSON;
 * screenshots are uploaded to storage inside the step.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Answer, Env, RunParams } from "./types";
import { extractForm, fillAndMaybeSubmit } from "./browser";
import { generateAnswers } from "./gemini";
import { appendScreenshot, logStep, updateApplication, updateRun, uploadScreenshot } from "./db";

export class ApplyRunWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  async run(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const params = event.payload;
    const env = this.env;

    try {
      // ------------------------------------------------ extract + answer
      const { fields } = await step.do(
        "extract form",
        { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
        async () => {
          await updateRun(env, params.runId, { status: "running" });
          await logStep(env, params.runId, "navigate", params.jobUrl);
          const result = await extractForm(env, params);
          const shot = await uploadScreenshot(
            env, params.userId, params.runId, "form", result.screenshot
          );
          await appendScreenshot(env, params.runId, shot);
          await updateRun(env, params.runId, { form_fields: result.fields });
          await logStep(env, params.runId, "form_extracted", `${result.fields.length} fields`);
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
          const result = await fillAndMaybeSubmit(env, params, answers, false);
          const shot = await uploadScreenshot(
            env, params.userId, params.runId, "filled", result.screenshot
          );
          await appendScreenshot(env, params.runId, shot);
          await updateRun(env, params.runId, { status: "needs_review" });
          await updateApplication(env, params.applicationId, { status: "needs_review" });
          await logStep(env, params.runId, "review_requested");
        });

        const approval = await step.waitForEvent<{ answers?: Answer[] }>("await approval", {
          type: "approval",
          timeout: "7 days"
        });
        if (approval.payload?.answers?.length) {
          approvedAnswers = approval.payload.answers;
        }
        await step.do("record approval", async () => {
          await updateRun(env, params.runId, { status: "approved", answers: approvedAnswers });
          await logStep(env, params.runId, "approved");
        });
      }

      // ------------------------------------------------ submit
      const confirmed = await step.do(
        "submit",
        { retries: { limit: 1, delay: "30 seconds" } },
        async () => {
          await updateRun(env, params.runId, { status: "submitting" });
          const result = await fillAndMaybeSubmit(env, params, approvedAnswers, true);
          const shot = await uploadScreenshot(
            env, params.userId, params.runId, "submitted", result.screenshot
          );
          await appendScreenshot(env, params.runId, shot);
          return result.confirmed;
        }
      );

      await step.do("finalize", async () => {
        if (confirmed) {
          await updateRun(env, params.runId, { status: "submitted" });
          await updateApplication(env, params.applicationId, {
            status: "applied",
            applied_at: new Date().toISOString()
          });
          await logStep(env, params.runId, "submitted", "confirmation detected");
        } else {
          await updateRun(env, params.runId, {
            status: "failed",
            error: "submit_unconfirmed - the ATS never showed a confirmation; verify manually"
          });
          await updateApplication(env, params.applicationId, { status: "failed" });
          await logStep(env, params.runId, "submit_unconfirmed");
        }
      });
    } catch (err) {
      // Terminal failure (retries exhausted or review-gate timeout): record
      // honestly so the user can retry or apply manually.
      const message = err instanceof Error ? err.message : String(err);
      await updateRun(env, params.runId, { status: "failed", error: message.slice(0, 500) });
      await updateApplication(env, params.applicationId, { status: "failed" });
      throw err;
    }
  }
}
