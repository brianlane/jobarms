/**
 * Worker -> render sidecar. One phase per call.
 *
 * Two conventions the sidecar imposes, both because Cloudflare sits in between:
 *
 *  1. Application failures arrive as HTTP 200 with an `{ error, detail }` body,
 *     since Cloudflare replaces the body of an origin 5xx with its own error
 *     page. So "ok" means 2xx AND no `error` field, and a genuine non-2xx is
 *     classified separately as a transport problem (worth retrying, unlike a
 *     permanent `form_not_found`).
 *
 *  2. The phases that drive a form are STARTED, not awaited. Cloudflare caps an
 *     origin response at 100 seconds and these phases regularly run longer (a
 *     24-field Lever fill measured 133s), which surfaced as a 524 on work that
 *     had actually succeeded. So the sidecar answers with a job id and this
 *     client polls until the outcome is ready.
 */
import type { Answer, Env, FormField, RecoveryStrategy } from "./types";

export type RenderErrorCode =
  | "invalid_or_unsafe_url"
  | "invalid_body"
  | "form_not_found"
  | "needs_email_verification"
  | "login_failed"
  | "render_failed"
  /**
   * The job id is unknown to the sidecar: it restarted, or the result aged out
   * from under a slow poll. Not in the deterministic set, so the workflow retries
   * the phase, which is the right answer to a box that bounced.
   */
  | "job_not_found"
  /** Set here, not by the sidecar: RENDER_URL / RENDER_TOKEN not configured. */
  | "render_unconfigured"
  /** Set here: transport failure, timeout, or a non-2xx status. */
  | "render_unreachable";

export type RenderResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: RenderErrorCode; detail?: string; screenshotBase64?: string };

/**
 * Per-exchange timeout. Every call is now short (start a phase, or read its
 * status), so this no longer has to cover the phase itself.
 */
const CALL_TIMEOUT_MS = 30_000;

/**
 * Wall-clock budget for one phase, spent polling. Generous: a Workday wizard
 * walks several pages, each with its own typing and page loads.
 */
const PHASE_BUDGET_MS = 600_000;

/**
 * Poll delay, growing 1.5x to a cap. Deliberately few, slow polls rather than
 * many fast ones: a Worker invocation has a hard subrequest limit, and burning
 * it on status reads would fail the phase for the silliest possible reason.
 */
const POLL_START_MS = 5_000;
const POLL_MAX_MS = 20_000;

/** Split out so tests can run the poll loop without real delays. */
export const timers = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
};

/** Turn a sidecar body into a result, honoring the HTTP-200-error convention. */
function classify<T>(payload: Record<string, unknown> | null): RenderResult<T> {
  if (!payload) return { ok: false, error: "render_unreachable", detail: "unparseable body" };
  if (typeof payload.error === "string") {
    return {
      ok: false,
      error: payload.error as RenderErrorCode,
      ...(typeof payload.detail === "string" ? { detail: payload.detail } : {}),
      // form_not_found carries a shot so the caller can run vision on it.
      ...(typeof payload.screenshotBase64 === "string"
        ? { screenshotBase64: payload.screenshotBase64 }
        : {})
    };
  }
  return { ok: true, data: payload as T };
}

async function call<T>(
  env: Env,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<RenderResult<T>> {
  const base = (env.RENDER_URL ?? "").replace(/\/+$/, "");
  if (!base || !env.RENDER_TOKEN) return { ok: false, error: "render_unconfigured" };

  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.RENDER_TOKEN}`
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
    });

    if (!res.ok) {
      return { ok: false, error: "render_unreachable", detail: `status ${res.status}` };
    }
    return classify<T>((await res.json().catch(() => null)) as Record<string, unknown> | null);
  } catch (err) {
    return { ok: false, error: "render_unreachable", detail: String(err).slice(0, 200) };
  }
}

type JobRead = { status: "running" } | { status: "done"; result: Record<string, unknown> };

/** Start a phase, then poll until it settles or the budget runs out. */
async function runPhase<T>(env: Env, path: string, body: unknown): Promise<RenderResult<T>> {
  const started = await call<{ jobId?: unknown }>(env, "POST", path, body);
  if (!started.ok) return started;
  const jobId = typeof started.data.jobId === "string" ? started.data.jobId : "";
  if (!jobId) return { ok: false, error: "render_unreachable", detail: "no job id" };

  const deadline = Date.now() + PHASE_BUDGET_MS;
  let wait = POLL_START_MS;
  for (;;) {
    await timers.sleep(wait);
    wait = Math.min(POLL_MAX_MS, Math.round(wait * 1.5));

    const read = await call<JobRead>(env, "GET", `/jobs/${encodeURIComponent(jobId)}`);
    if (!read.ok) return read;
    if (read.data.status === "done") return classify<T>(read.data.result);

    // Checked AFTER a read so a phase that finishes right on the boundary is
    // still collected rather than reported as a timeout.
    if (Date.now() >= deadline) {
      return { ok: false, error: "render_unreachable", detail: "phase exceeded its budget" };
    }
  }
}

/** Decode a base64 screenshot from the sidecar into bytes for storage. */
export function decodeScreenshot(base64: string | null | undefined): Uint8Array | null {
  if (!base64) return null;
  try {
    // A non-empty base64 string always decodes to at least one byte, and the
    // guard above already rejected empty input, so there is no zero-length case
    // to handle here.
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export interface EnsureSessionResponse {
  status: "authenticated" | "needs_email_verification" | "login_failed";
  accountRequired: boolean;
  screenshotBase64?: string | null;
}

/** Authenticate (or create) the candidate account on the employer's tenant. */
export function ensureSession(
  env: Env,
  args: {
    userId: string;
    jobUrl: string;
    ats: string;
    account?: { email: string; password: string };
  }
): Promise<RenderResult<EnsureSessionResponse>> {
  return runPhase(env, "/session/ensure", args);
}

export interface ExtractResponse {
  fields: FormField[];
  pages: number;
  scope: string;
  recovery: { source: "playbook" | "vision"; strategy: RecoveryStrategy; domain: string } | null;
  playbookFailed: boolean;
  screenshotBase64?: string | null;
}

/**
 * Reach the form and read its fields. `playbook` is the recovery strategy to try
 * FIRST: either this domain's stored playbook, or (on a retry) the one the vision
 * model just proposed.
 */
export function extractForm(
  env: Env,
  args: {
    userId: string;
    jobUrl: string;
    ats: string;
    playbook?: RecoveryStrategy | null;
  }
): Promise<RenderResult<ExtractResponse>> {
  return runPhase(env, "/extract", args);
}

/** An answer the form does not agree with, read back after filling. */
export interface Mismatch {
  name: string;
  label: string;
  /**
   * Which kind of control disagreed. Carried on the mismatch because a wizard's
   * earlier pages are gone from the DOM by submit time, so it cannot be asked of
   * the live page without silently answering "text" for everything.
   */
  kind: "choice" | "text";
  /** What the user approved. */
  expected: string;
  /** What the form actually holds. */
  actual: string;
}

export interface FillResponse {
  /**
   * verification_failed means the form disagreed with an approved answer on a
   * choice field and the sidecar REFUSED to submit. Filling happened; sending
   * did not.
   */
  outcome: "filled" | "submitted" | "captcha_blocked" | "unconfirmed" | "verification_failed";
  pages: number;
  /**
   * What became of the resume. "failed" means a REQUIRED field is empty on a form
   * we otherwise filled, which the run must say out loud rather than let a user
   * discover after approving.
   */
  resume?: "not_requested" | "attached" | "failed";
  /** Answers the form did not accept. Empty means the read-back agreed. */
  mismatches?: Mismatch[];
  screenshotBase64?: string | null;
}

/** Fill the approved answers, optionally submitting. */
export function fillForm(
  env: Env,
  args: {
    userId: string;
    /** Only used to attribute captcha model spend back to this run. */
    runId: string;
    jobUrl: string;
    ats: string;
    answers: Answer[];
    resume: { contentBase64: string | null; fileName: string; mimeType: string };
    submit: boolean;
    playbook?: RecoveryStrategy | null;
  }
): Promise<RenderResult<FillResponse>> {
  return runPhase(env, "/fill", args);
}

/**
 * Download the resume so its BYTES can be sent to the sidecar.
 *
 * The worker holds the signed Storage URL, so it does the fetching and the
 * sidecar never makes an outbound request. Returns null when there is nothing to
 * attach; a failed download is not fatal (the run proceeds without a resume and
 * the review gate shows what was filled).
 */
export async function fetchResumeBase64(signedUrl: string | null): Promise<string | null> {
  if (!signedUrl) return null;
  try {
    const res = await fetch(signedUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) return null;
    let binary = "";
    // Chunked so a multi-megabyte PDF cannot blow the argument limit of
    // String.fromCharCode via a single spread.
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  } catch {
    return null;
  }
}
