/**
 * Wire types for the render sidecar.
 *
 * `FormField` and `Answer` are intentionally IDENTICAL to the shapes in
 * workers/apply-arm/src/types.ts: the apply-arm Workflow forwards them straight
 * through to Gemini and to the review gate, so any drift here would surface as
 * silently-unanswered questions.
 */

/** ATSes the sidecar can drive; `generic` is the best-effort adapter for the rest. */
export type Ats = "greenhouse" | "lever" | "workday" | "ashby" | "generic";

export interface FormField {
  /** input name/id used to locate the control. */
  name: string;
  /** the human label the question shows. */
  label: string;
  /** text | textarea | select | radio | checkbox | file | email | tel */
  type: string;
  required: boolean;
  /** for select/radio/checkbox. */
  options: string[];
}

export interface Answer {
  name: string;
  label: string;
  /** for checkbox: "true"/"false"; for select/radio: the option text. */
  value: string;
  /** the arm could not answer it, so it is left for the review gate. */
  skipped?: boolean;
}

/**
 * Resume the arm attaches, as BYTES rather than a URL.
 *
 * The caller (the apply-arm Worker) already holds the signed Storage URL and the
 * credentials to read it, so it downloads the file and sends the content. That
 * keeps the sidecar a pure browser: it makes no outbound requests of its own, so
 * it cannot be turned into a fetcher for arbitrary URLs by a buggy or
 * compromised caller. Same principle as the playbook and vision diagnosis
 * arriving in the request instead of the box holding Supabase or Gemini keys.
 */
export interface ResumeRef {
  /** base64-encoded file content; absent means "no resume to attach". */
  contentBase64?: string | null;
  fileName: string;
  mimeType: string;
}

/** How the sidecar reached a form, recorded per domain as a playbook. */
export interface RecoveryStrategy {
  action: "click" | "iframe" | "scroll";
  click_text?: string;
}

export interface Recovery {
  source: "playbook" | "vision";
  strategy: RecoveryStrategy;
  domain: string;
}

/** An answer the form does not agree with, read back after filling. */
export interface Mismatch {
  name: string;
  label: string;
  /**
   * What kind of control disagreed, carried HERE rather than re-derived later.
   *
   * A wizard's earlier pages are gone from the DOM by the time submit happens, so
   * asking the live page "was this a choice field?" answers no for every mismatch
   * found before the last page, and the interlock would wave through the exact
   * wrong ticks it exists to stop.
   */
  kind: "choice" | "text";
  /** What the user approved. */
  expected: string;
  /** What the form actually holds. */
  actual: string;
}

/**
 * A way of driving a control that worked on a site where the default did not.
 *
 * Recorded per domain and ATS by the caller, and handed back in on later runs so
 * a site that needed the other approach once never pays for the discovery again.
 * The same shape as the recovery playbooks that already remember how to REACH a
 * form; this remembers how to OPERATE one.
 */
export interface TacticWin {
  kind: "choice" | "text";
  tactic: "control" | "label" | "type" | "set";
}

/**
 * Outcome of a submit attempt.
 * - filled: review-gate fill only (submit was not requested).
 * - submitted: the employer confirmed receipt.
 * - captcha_blocked: filled, but an anti-bot check could not be cleared. Counts
 *   as work done, not a system failure.
 * - unconfirmed: submit clicked, no confirmation and no captcha signal.
 * - verification_failed: filled, but a choice field disagrees with the approved
 *   answer, so submit was REFUSED. Counts as work done: the application is
 *   reviewable, it just must not be sent as it stands.
 */
export type SubmitOutcome =
  | "filled"
  | "submitted"
  | "captcha_blocked"
  | "unconfirmed"
  | "verification_failed";

/** Structured error codes the worker classifies on (see the module doc in app.ts). */
export type RenderErrorCode =
  | "invalid_or_unsafe_url"
  | "invalid_body"
  | "form_not_found"
  | "account_required"
  | "needs_email_verification"
  | "login_failed"
  | "render_failed";
