/**
 * App -> render sidecar calls.
 *
 * Only `/verify` lives here: the app's single reason to touch the browser is
 * finishing an account verification when the mail arrives. Establishing the
 * session, reading the form, and filling it all belong to the apply-arm worker,
 * which owns run orchestration and polls those phases as async jobs (see
 * workers/apply-arm/src/render.ts). `/verify` stays a plain request/response
 * because it is one navigation and this caller is a webhook that wants a prompt
 * answer.
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

/** One navigation plus the tenant's response, well inside Cloudflare's cap. */
const REQUEST_TIMEOUT_MS = 60_000;

async function renderSend<T>(
  method: string,
  path: string,
  body: unknown
): Promise<RenderResult<T>> {
  const base = renderUrl();
  if (!base) return { ok: false, error: "render_unconfigured" };

  try {
    const res = await fetch(`${base}${path}`, {
      method,
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
  return renderSend("POST", "/verify", args);
}

/**
 * Drop the cached browser session and its stored cookies for one user+tenant.
 *
 * Called on disconnect so a signed-in session (LinkedIn especially, since those
 * are the user's real credentials) does not linger on the box after the user
 * asked us to forget it. Best-effort by contract: this never throws, and a
 * sidecar that is unreachable just means the cookies age out on their own TTL.
 */
export function clearRenderSession(args: {
  userId: string;
  tenantHost: string;
}): Promise<RenderResult<{ ok: true }>> {
  return renderSend("DELETE", "/session", args);
}
