// `Workflow` (the binding type) is an ambient global from
// @cloudflare/workers-types; `WorkflowEntrypoint` is imported from
// "cloudflare:workers" where it's used.
export interface Env {
  // Bindings (require Workers Paid - configured in wrangler.jsonc Phase 3)
  BROWSER?: Fetcher;
  APPLY_RUN?: Workflow;

  // Secrets (wrangler secret put)
  ARM_WORKER_SHARED_SECRET?: string;
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  GEMINI_API_KEY?: string;
  GEMINI_TEXT_MODEL?: string;
}

/** Everything a run needs, snapshotted at dispatch time by the app. */
export interface RunParams {
  runId: string;
  applicationId: string;
  userId: string;
  jobUrl: string;
  ats: "greenhouse" | "lever";
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
