/**
 * Worker -> render sidecar. One call per browser phase.
 *
 * The sidecar reports application-level failures as HTTP 200 with an
 * `{ error, detail }` body, because Cloudflare replaces the body of an origin 5xx
 * with its own error page. So "ok" here means 2xx AND no `error` field, and a
 * genuine non-2xx is classified separately as a transport problem (which IS
 * worth retrying, unlike a permanent `form_not_found`).
 */
import type { Answer, Env, FormField, RecoveryStrategy } from "./types";

export type RenderErrorCode =
  | "invalid_or_unsafe_url"
  | "invalid_body"
  | "form_not_found"
  | "needs_email_verification"
  | "login_failed"
  | "render_failed"
  /** Set here, not by the sidecar: RENDER_URL / RENDER_TOKEN not configured. */
  | "render_unconfigured"
  /** Set here: transport failure, timeout, or a non-2xx status. */
  | "render_unreachable";

export type RenderResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: RenderErrorCode; detail?: string; screenshotBase64?: string };

/** A wizard walk plus a resume-parse pause is slow; budget generously. */
const TIMEOUT_MS = 180_000;

async function post<T>(env: Env, path: string, body: unknown): Promise<RenderResult<T>> {
  const base = (env.RENDER_URL ?? "").replace(/\/+$/, "");
  if (!base || !env.RENDER_TOKEN) return { ok: false, error: "render_unconfigured" };

  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.RENDER_TOKEN}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });

    if (!res.ok) {
      return { ok: false, error: "render_unreachable", detail: `status ${res.status}` };
    }
    const payload = (await res.json().catch(() => null)) as
      | (T & { error?: RenderErrorCode; detail?: string; screenshotBase64?: string })
      | null;
    if (!payload) return { ok: false, error: "render_unreachable", detail: "unparseable body" };
    if (payload.error) {
      return {
        ok: false,
        error: payload.error,
        detail: payload.detail,
        // form_not_found carries a shot so the caller can run vision on it.
        ...(payload.screenshotBase64 ? { screenshotBase64: payload.screenshotBase64 } : {})
      };
    }
    return { ok: true, data: payload as T };
  } catch (err) {
    return { ok: false, error: "render_unreachable", detail: String(err).slice(0, 200) };
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
  return post(env, "/session/ensure", args);
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
  return post(env, "/extract", args);
}

export interface FillResponse {
  outcome: "filled" | "submitted" | "captcha_blocked" | "unconfirmed";
  pages: number;
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
  return post(env, "/fill", args);
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
