/**
 * App -> render sidecar calls.
 *
 * The sidecar reports application-level failures as HTTP 200 with an
 * `{ error, detail }` body, because Cloudflare replaces the body of an origin
 * 5xx with its own error page (see vps/render/src/app.ts). So "ok" here means a
 * 2xx AND no `error` field; anything else is classified for the caller.
 */
import { envOr, requireEnv } from "@/lib/env";

export function renderUrl(): string {
  return envOr("RENDER_URL", "").replace(/\/+$/, "");
}

/** Errors the sidecar reports deliberately, which callers branch on. */
export type RenderErrorCode =
  | "invalid_or_unsafe_url"
  | "invalid_body"
  | "form_not_found"
  | "needs_email_verification"
  | "login_failed"
  | "render_failed"
  /** Set by this client, not the sidecar: RENDER_URL is not configured. */
  | "render_unconfigured"
  /** Set by this client: transport failure, timeout, or a non-2xx status. */
  | "render_unreachable";

export type RenderResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: RenderErrorCode; detail?: string };

/** Browser phases can be slow (a wizard walk, a resume parse pause). */
const REQUEST_TIMEOUT_MS = 180_000;

async function renderPost<T>(path: string, body: unknown): Promise<RenderResult<T>> {
  const base = renderUrl();
  if (!base) return { ok: false, error: "render_unconfigured" };

  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${requireEnv("RENDER_TOKEN")}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!res.ok) {
      // A genuine non-2xx is a transport problem (tunnel down, bad bearer),
      // which IS worth retrying, unlike the structured errors below.
      return { ok: false, error: "render_unreachable", detail: `status ${res.status}` };
    }

    const payload = (await res.json().catch(() => null)) as
      | (T & { error?: RenderErrorCode; detail?: string })
      | null;
    if (!payload) return { ok: false, error: "render_unreachable", detail: "unparseable body" };
    if (payload.error) {
      return { ok: false, error: payload.error, detail: payload.detail };
    }
    return { ok: true, data: payload as T };
  } catch (err) {
    return { ok: false, error: "render_unreachable", detail: String(err).slice(0, 200) };
  }
}

export interface EnsureSessionResponse {
  status: "authenticated" | "needs_email_verification" | "login_failed";
  accountRequired: boolean;
  screenshotBase64?: string | null;
}

/** Authenticate (or create) the candidate account on this tenant. */
export function ensureRenderSession(args: {
  userId: string;
  jobUrl: string;
  ats: string;
  account?: { email: string; password: string };
}): Promise<RenderResult<EnsureSessionResponse>> {
  return renderPost("/session/ensure", args);
}

export interface VerifyResponse {
  status: "authenticated" | "needs_email_verification" | "login_failed";
  screenshotBase64?: string | null;
}

/** Finish an email verification inside the held session. */
export function completeRenderVerification(args: {
  userId: string;
  tenantHost: string;
  link?: string | null;
  code?: string | null;
}): Promise<RenderResult<VerifyResponse>> {
  return renderPost("/verify", args);
}
