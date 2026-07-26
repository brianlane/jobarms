/**
 * Platform configuration and dependency health for /admin/system.
 *
 * The env matrix reports set or unset, NEVER a value: an operator screen that
 * prints secrets is a secret-leak surface, and knowing a key is missing is the
 * whole diagnostic anyway.
 */

import type { AdminSubscriptionRow } from "@/lib/admin/overview";

export interface EnvVarSpec {
  key: string;
  label: string;
  note: string;
}

export interface EnvGroupSpec {
  label: string;
  vars: EnvVarSpec[];
}

export const ENV_GROUPS: EnvGroupSpec[] = [
  {
    label: "App",
    vars: [
      { key: "NEXT_PUBLIC_APP_URL", label: "App URL", note: "public origin" },
      { key: "ADMIN_EMAIL", label: "Admin allowlist", note: "who reaches this console" }
    ]
  },
  {
    label: "Supabase",
    vars: [
      { key: "NEXT_PUBLIC_SUPABASE_URL", label: "Project URL", note: "public" },
      {
        key: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        label: "Publishable key",
        note: "browser client"
      },
      { key: "SUPABASE_SECRET_KEY", label: "Secret key", note: "server only, bypasses RLS" }
    ]
  },
  {
    label: "Stripe",
    vars: [
      { key: "STRIPE_SECRET_KEY", label: "Secret key", note: "API" },
      { key: "STRIPE_WEBHOOK_SECRET", label: "Webhook secret", note: "signature check" },
      { key: "STRIPE_PRICE_PREMIUM_MONTHLY", label: "Premium price", note: "tier mapping" },
      { key: "STRIPE_PRICE_MAX_MONTHLY", label: "Max price", note: "tier mapping" }
    ]
  },
  {
    label: "AI",
    vars: [
      { key: "GEMINI_API_KEY", label: "Model API key", note: "answers, parsing, tailoring" },
      { key: "GEMINI_TEXT_MODEL", label: "Primary model", note: "optional override" },
      { key: "GEMINI_FALLBACK_MODEL", label: "Fallback model", note: "optional override" }
    ]
  },
  {
    label: "Automation edge",
    vars: [
      { key: "ARM_WORKER_URL", label: "Arm worker URL", note: "apply-arm origin" },
      { key: "ARM_WORKER_SHARED_SECRET", label: "Arm shared secret", note: "both directions" },
      { key: "INTERNAL_CRON_SECRET", label: "Cron secret", note: "ingest manual trigger" },
      { key: "RENDER_URL", label: "Render sidecar URL", note: "the browser the arm drives" },
      { key: "RENDER_TOKEN", label: "Render sidecar token", note: "shared bearer" },
      {
        key: "SITE_ACCOUNT_ENC_KEY",
        label: "Account vault key",
        note: "encrypts stored ATS credentials"
      }
    ]
  },
  {
    label: "Email",
    vars: [
      { key: "RESEND_API_KEY", label: "Resend key", note: "outbound + auth mail" },
      { key: "EMAIL_INBOUND_SECRET", label: "Inbound secret", note: "alias mail webhook" }
    ]
  }
];

export function checkEnv(key: string): boolean {
  return Boolean(process.env[key]?.trim());
}

export type EnvGroupState = "configured" | "partial" | "missing";

export interface EnvVarStatus extends EnvVarSpec {
  configured: boolean;
}

export interface EnvGroupStatus {
  label: string;
  state: EnvGroupState;
  vars: EnvVarStatus[];
}

export interface EnvMatrix {
  groups: EnvGroupStatus[];
  configured: number;
  total: number;
}

export function summarizeEnv(groups: EnvGroupSpec[] = ENV_GROUPS): EnvMatrix {
  let configured = 0;
  let total = 0;

  const result: EnvGroupStatus[] = groups.map((group) => {
    const vars = group.vars.map((spec) => ({ ...spec, configured: checkEnv(spec.key) }));
    const setCount = vars.filter((v) => v.configured).length;
    configured += setCount;
    total += vars.length;
    return {
      label: group.label,
      state: setCount === vars.length ? "configured" : setCount === 0 ? "missing" : "partial",
      vars
    };
  });

  return { groups: result, configured, total };
}

// ─── dependency probes ──────────────────────────────────────────────────────

export interface ServiceProbe {
  label: string;
  url: string | null;
  reachable: boolean;
  /** HTTP status when one came back, else null. */
  status: number | null;
  detail: string;
  /** Sidecar only: what /health reported, when it answered with a usable body. */
  health?: RenderHealth | null;
}

export interface RenderHealth {
  /** Cached browser contexts, one per user and tenant. */
  sessions: number;
  /** Phases started and not yet settled. */
  jobs: number;
}

const PROBE_TIMEOUT_MS = 4000;

/**
 * Is the origin answering at all? ANY HTTP status counts as reachable: the
 * apply-arm worker answers 404 on an unrouted path and 401 without the shared
 * secret, and either proves the worker is deployed and serving. Only a network
 * failure or a timeout means down.
 */
export async function probeOrigin(label: string, url: string | null): Promise<ServiceProbe> {
  if (!url) {
    return { label, url: null, reachable: false, status: null, detail: "not configured" };
  }
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    return {
      label,
      url,
      reachable: true,
      status: response.status,
      detail: `HTTP ${response.status}`
    };
  } catch (err) {
    return {
      label,
      url,
      reachable: false,
      status: null,
      detail: err instanceof Error ? err.message : "unreachable"
    };
  }
}

/**
 * The sidecar's own health, not merely whether the origin answers.
 *
 * `/health` is its one unauthenticated route and it reports cached browser
 * contexts and phases in flight. Both matter because the async job protocol
 * introduced a failure a status code cannot show: a wedged Chromium keeps
 * answering 200 while jobs accumulate and never settle. "Up" should mean
 * working, not merely listening.
 */
export async function probeRender(url: string | null): Promise<ServiceProbe> {
  const label = "Render sidecar";
  if (!url) {
    return { label, url: null, reachable: false, status: null, detail: "not configured", health: null };
  }

  const endpoint = `${url.replace(/\/+$/, "")}/health`;
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const sessions = typeof body?.sessions === "number" ? body.sessions : null;
    const jobs = typeof body?.jobs === "number" ? body.jobs : null;
    const readable = sessions !== null && jobs !== null;

    return {
      label,
      url: endpoint,
      reachable: true,
      status: response.status,
      detail: readable
        ? `HTTP ${response.status}, ${sessions} cached, ${jobs} in flight`
        : `HTTP ${response.status}`,
      health: readable ? { sessions, jobs } : null
    };
  } catch (err) {
    return {
      label,
      url: endpoint,
      reachable: false,
      status: null,
      detail: err instanceof Error ? err.message : "unreachable",
      health: null
    };
  }
}

export async function probeServices(): Promise<ServiceProbe[]> {
  const arm = process.env.ARM_WORKER_URL?.trim() || null;
  const render = process.env.RENDER_URL?.trim() || null;
  return Promise.all([probeOrigin("Apply-arm worker", arm), probeRender(render)]);
}

// ─── Stripe webhook freshness ───────────────────────────────────────────────

export interface WebhookFreshness {
  lastEventAt: string | null;
  ageHours: number | null;
  /** No subscription row has changed in a long time. */
  quiet: boolean;
}

export const WEBHOOK_QUIET_DAYS = 30;

/**
 * When did Stripe last tell us anything? The webhook writes `subscriptions`,
 * so the newest `updated_at` across those rows is the closest honest proxy for
 * "the endpoint is still wired up". It goes quiet legitimately when nobody
 * changes plan, hence "quiet" rather than "broken".
 */
export function webhookFreshness(
  subscriptions: AdminSubscriptionRow[],
  now: Date = new Date()
): WebhookFreshness {
  let newest = 0;
  for (const sub of subscriptions) {
    if (!sub.updated_at) continue;
    const at = Date.parse(sub.updated_at);
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  if (newest === 0) return { lastEventAt: null, ageHours: null, quiet: true };
  const ageHours = Math.round((now.getTime() - newest) / (60 * 60 * 1000));
  return {
    lastEventAt: new Date(newest).toISOString(),
    ageHours,
    quiet: ageHours > WEBHOOK_QUIET_DAYS * 24
  };
}
