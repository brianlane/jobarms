import { envOr, requireEnv } from "@/lib/env";

/**
 * Server-side client for the Cloudflare apply-arm worker. Both directions
 * authenticate with ARM_WORKER_SHARED_SECRET.
 */
export function armWorkerUrl(): string {
  return envOr("ARM_WORKER_URL", "https://jobarms-apply-arm.workers.dev");
}

export async function armWorkerFetch(path: string, body: unknown): Promise<Response> {
  return fetch(`${armWorkerUrl()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${requireEnv("ARM_WORKER_SHARED_SECRET")}`
    },
    body: JSON.stringify(body)
  });
}
