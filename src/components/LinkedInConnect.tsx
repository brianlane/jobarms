"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Connect (or disconnect) the user's own LinkedIn account so the arm can drive
 * Easy Apply. The password is sent once to be vaulted server-side and is never
 * read back, so the connected state shows only the email.
 */
export function LinkedInConnect({ initialEmail }: { initialEmail: string | null }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/linkedin/account", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, consent })
    });
    setBusy(false);
    if (res.ok) {
      setPassword("");
      router.refresh();
    } else {
      setError("We couldn't save that. Check your email and password and try again.");
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/linkedin/account", { method: "DELETE" });
    setBusy(false);
    if (res.ok) router.refresh();
    else setError("We couldn't disconnect right now. Try again in a moment.");
  }

  return (
    <section className="mt-8 rounded-xl border border-slate-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-slate-900">LinkedIn Easy Apply</h2>
      <p className="mt-2 text-sm text-slate-500">
        Connect your LinkedIn account and your arm can batch through Easy Apply
        jobs for you. Your password is encrypted and only ever used to sign in on
        your behalf.
      </p>

      {initialEmail ? (
        <div className="mt-4">
          <p className="text-sm text-slate-700">
            Connected as <span className="font-mono">{initialEmail}</span>
          </p>
          <button
            onClick={disconnect}
            disabled={busy}
            className="mt-4 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50"
          >
            Disconnect
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <input
            type="email"
            aria-label="LinkedIn email"
            placeholder="LinkedIn email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            type="password"
            aria-label="LinkedIn password"
            placeholder="LinkedIn password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <label className="flex items-start gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-1"
            />
            <span>
              I authorize JobArms to sign in to my LinkedIn account and submit
              Easy Apply applications on my behalf. I understand LinkedIn may
              restrict accounts it detects as automated, and I accept that risk.
            </span>
          </label>
          <button
            onClick={connect}
            disabled={busy || !email || !password || !consent}
            className="rounded-lg bg-arm-500 px-4 py-2 text-sm font-medium text-white hover:bg-arm-600 disabled:opacity-50"
          >
            Connect LinkedIn
          </button>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </section>
  );
}
