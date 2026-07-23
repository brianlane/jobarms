import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/supabase/auth";
import { effectivePlan, PLAN_COPY, type SubscriptionRow } from "@/lib/plans";
import { BillingActions } from "@/components/BillingActions";

export const metadata = { title: "Billing" };

export default async function BillingPage() {
  const user = await getAuthUser();
  const supabase = await createSupabaseServerClient();

  const { data: sub } = await supabase
    .from("subscriptions")
    .select("plan, status, current_period_end, cancel_at_period_end")
    .eq("user_id", user!.id)
    .maybeSingle();

  const plan = effectivePlan(sub as SubscriptionRow | null);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold text-slate-900">Billing</h1>
      <p className="mt-1 text-slate-500">
        Current plan: <span className="font-semibold capitalize">{plan}</span>
        {sub?.cancel_at_period_end && sub.current_period_end && (
          <>, cancels {new Date(sub.current_period_end).toLocaleDateString()}</>
        )}
      </p>

      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        {(["free", "premium"] as const).map((tier) => (
          <div
            key={tier}
            className={`rounded-2xl border p-6 ${
              plan === tier ? "border-arm-500 bg-teal-50" : "border-slate-200 bg-white"
            }`}
          >
            <h2 className="text-lg font-bold text-slate-900">{PLAN_COPY[tier].name}</h2>
            <p className="mt-1 text-2xl font-bold text-slate-900">{PLAN_COPY[tier].price}</p>
            <ul className="mt-4 space-y-2 text-sm text-slate-600">
              {PLAN_COPY[tier].features.map((f) => (
                <li key={f}>• {f}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <BillingActions plan={plan} />
    </div>
  );
}
