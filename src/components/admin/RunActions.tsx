"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Operator controls on a single run: cancel one that is wedged, and refund a
 * metered slot the automatic policy did not.
 *
 * Retrying is deliberately absent. A retry has to re-reserve a slot, re-snapshot
 * the profile, and reuse the stored ATS account, and that logic lives in the
 * user-scoped retry route. Duplicating it here would give the platform a second
 * place for metering and account handling to drift. `debug/retry-application.ts`
 * is the operator path for that.
 */
export function RunActions({
  runId,
  cancellable,
  alreadyRefunded
}: {
  runId: string;
  cancellable: boolean;
  alreadyRefunded: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(path: string, describe: (payload: { refunded?: boolean }) => string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/runs/${runId}/${path}`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError((payload as { hint?: string; error?: string }).hint ?? (payload as { error?: string }).error ?? "Request failed");
        return;
      }
      setMessage(describe(payload as { refunded?: boolean }));
      router.refresh();
    } catch {
      setError("Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !cancellable}
          onClick={() =>
            call("cancel", (payload) =>
              payload.refunded
                ? "Run canceled and the slot refunded."
                : "Run canceled. The slot stays consumed."
            )
          }
          className="rounded-lg border border-ink-700 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-slate-300 hover:border-arm-500 hover:text-arm-300 disabled:opacity-40"
        >
          Cancel run
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            call("refund", (payload) =>
              payload.refunded
                ? "Slot refunded."
                : "Already refunded; the counter did not move."
            )
          }
          className="rounded-lg border border-ink-700 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-slate-300 hover:border-arm-500 hover:text-arm-300 disabled:opacity-40"
        >
          {alreadyRefunded ? "Refund again" : "Refund slot"}
        </button>
      </div>
      {!cancellable && (
        <p className="text-xs text-slate-600">
          This run has already finished, so there is nothing to cancel.
        </p>
      )}
      {message && <p className="text-sm text-arm-300">{message}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
