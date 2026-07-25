// `Workflow` (the binding type) is an ambient global from
// @cloudflare/workers-types; `WorkflowEntrypoint` is imported from
// "cloudflare:workers" where it's used.
export interface Env {
  // Bindings
  APPLY_RUN?: Workflow;

  // Secrets (wrangler secret put)
  ARM_WORKER_SHARED_SECRET?: string;
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  GEMINI_API_KEY?: string;
  GEMINI_TEXT_MODEL?: string;
  /**
   * The render sidecar (vps/render), which owns the browser. There is no
   * Browser Rendering binding: it could not hold a session across phases, which
   * is what account-gated and multi-page ATSes require.
   */
  RENDER_URL?: string;
  RENDER_TOKEN?: string;
}

/** ATSes the arm can drive. */
export type Ats = "greenhouse" | "lever" | "workday";

/** Everything a run needs, snapshotted at dispatch time by the app. */
export interface RunParams {
  runId: string;
  applicationId: string;
  userId: string;
  jobUrl: string;
  ats: Ats;
  autonomy: "review_gate" | "full_auto";
  jobTitle: string;
  jobCompany: string;
  jobDescription: string;
  profile: Record<string, unknown>;
  resume: {
    signedUrl: string | null;
    fileName: string;
    mimeType: string;
  };
  /** Learning payloads (optional for runs dispatched by older app builds). */
  memory?: {
    answers: Array<{ label: string; answer: string; source: string }>;
    lessons: string[];
  };
  /**
   * Credentials for the employer's own ATS tenant, present only for
   * account-gated ATSes (Workday). Forwarded to the sidecar, never persisted
   * here: the app's `site_accounts` vault is the system of record.
   */
  account?: { email: string; password: string };
}

export interface FormField {
  name: string;        // input name/id used to locate it
  label: string;       // human label the question shows
  type: string;        // text | textarea | select | radio | checkbox | file | email | tel
  required: boolean;
  options: string[];   // for select/radio/checkbox
}

export interface Answer {
  name: string;
  label: string;
  value: string;       // for checkbox: "true"/"false"; for select/radio: the option text
  skipped?: boolean;   // arm couldn't answer (left for review)
}

/** A recovery strategy for reaching a form, recorded per domain as a playbook. */
export interface RecoveryStrategy {
  action: "click" | "iframe" | "scroll";
  click_text?: string;
}
