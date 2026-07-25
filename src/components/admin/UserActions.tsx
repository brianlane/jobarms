"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Plan = "free" | "premium" | "max";

interface Props {
  userId: string;
  email: string;
  plan: Plan;
  stripeManaged: boolean;
  impact: {
    applications: number;
    runs: number;
    resumes: number;
    emails: number;
    memory: number;
    siteAccounts: number;
    activeSubscriptionId: string | null;
  };
}

const PLANS: Plan[] = ["free", "premium", "max"];

/**
 * The operator actions on a user: comp or revoke a plan, resend the welcome
 * email, and delete the account.
 *
 * Delete is gated on typing the email address rather than a yes/no confirm. The
 * impact preview is rendered inline so the number of rows about to disappear is
 * visible at the moment of the decision, not one page earlier.
 */
export function UserActions({ userId, email, plan, stripeManaged, impact }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [showDelete, setShowDelete] = useState(false);

  async function call(label: string, url: string, init: RequestInit): Promise<unknown | null> {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(url, init);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const hint = (payload as { hint?: string; error?: string }).hint;
        setError(hint ?? (payload as { error?: string }).error ?? "Request failed");
        return null;
      }
      return payload;
    } catch {
      setError("Request failed");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function setPlan(next: Plan) {
    const result = await call(`plan:${next}`, `/api/admin/users/${userId}/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: next })
    });
    if (!result) return;
    setMessage(next === "free" ? "Plan revoked to free." : `Comped to ${next}.`);
    router.refresh();
  }

  async function resendWelcome() {
    const result = await call("welcome", `/api/admin/users/${userId}/welcome-email`, {
      method: "POST"
    });
    if (!result) return;
    setMessage("Welcome email sent.");
    router.refresh();
  }

  async function deleteUser() {
    const result = await call("delete", `/api/admin/users/${userId}`, { method: "DELETE" });
    if (!result) return;
    router.push("/admin/users");
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">
          Comp a plan (no Stripe)
        </p>
        <div className="flex flex-wrap gap-2">
          {PLANS.map((option) => (
            <button
              key={option}
              type="button"
              disabled={busy !== null || stripeManaged || option === plan}
              onClick={() => setPlan(option)}
              className={`rounded-lg border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] disabled:opacity-40 ${
                option === plan
                  ? "border-arm-500 bg-arm-500/15 text-arm-300"
                  : "border-ink-700 text-slate-300 hover:border-arm-500 hover:text-arm-300"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
        {stripeManaged && (
          <p className="mt-2 text-xs text-amber-300">
            This account is billed through Stripe. Cancel there first; a comp here would be undone
            by the next webhook.
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-ink-800 pt-4">
        <button
          type="button"
          disabled={busy !== null}
          onClick={resendWelcome}
          className="rounded-lg border border-ink-700 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-slate-300 hover:border-arm-500 hover:text-arm-300 disabled:opacity-40"
        >
          Resend welcome email
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => setShowDelete((open) => !open)}
          className="rounded-lg border border-red-500/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-red-300 hover:bg-red-500/10 disabled:opacity-40"
        >
          Delete account
        </button>
      </div>

      {showDelete && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
          <p className="text-sm font-semibold text-red-300">
            This permanently deletes the account and everything it owns.
          </p>
          <ul className="mt-2 space-y-0.5 text-xs text-slate-400">
            <li>{impact.applications} applications</li>
            <li>{impact.runs} arm runs, with their screenshots</li>
            <li>{impact.resumes} resumes, including stored files</li>
            <li>{impact.emails} messages to their managed alias</li>
            <li>{impact.memory} remembered answers</li>
            <li>{impact.siteAccounts} ATS candidate accounts, with their credentials</li>
          </ul>
          {impact.activeSubscriptionId && (
            <p className="mt-2 text-xs text-amber-300">
              A live Stripe subscription ({impact.activeSubscriptionId}) has to be canceled first.
            </p>
          )}
          <label className="mt-3 block text-xs text-slate-400">
            Type <span className="font-mono text-slate-200">{email}</span> to confirm
          </label>
          <input
            value={confirmEmail}
            onChange={(event) => setConfirmEmail(event.target.value)}
            className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-white focus:border-red-400 focus:outline-none"
          />
          <button
            type="button"
            disabled={busy !== null || confirmEmail.trim().toLowerCase() !== email.toLowerCase()}
            onClick={deleteUser}
            className="mt-3 rounded-lg bg-red-500 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.12em] font-bold text-white hover:bg-red-400 disabled:opacity-40"
          >
            Delete permanently
          </button>
        </div>
      )}

      {message && <p className="text-sm text-arm-300">{message}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
