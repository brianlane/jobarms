import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/supabase/auth";
import { armRunQuota, effectivePlan, meterKey, type SubscriptionRow } from "@/lib/plans";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const user = await getAuthUser();
  const supabase = await createSupabaseServerClient();

  const [{ data: profile }, { data: sub }] = await Promise.all([
    supabase.from("profiles").select("full_name, onboarding_complete").eq("id", user!.id).maybeSingle(),
    supabase.from("subscriptions").select("plan, status, current_period_end, cancel_at_period_end").eq("user_id", user!.id).maybeSingle()
  ]);

  const plan = effectivePlan(sub as SubscriptionRow | null);
  const quota = armRunQuota(plan);
  const { data: usage } = await supabase
    .from("arm_run_usage")
    .select("runs_used")
    .eq("user_id", user!.id)
    .eq("month_key", meterKey(quota.window))
    .maybeSingle();
  const used = usage?.runs_used ?? 0;

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-bold text-slate-900">
        Welcome{profile?.full_name ? `, ${profile.full_name.split(" ")[0]}` : ""}
      </h1>
      <p className="mt-1 text-slate-500">Your arms are ready to work.</p>

      {!profile?.onboarding_complete && (
        <div className="mt-6 rounded-xl border border-arm-500 bg-teal-50 p-6">
          <h2 className="font-semibold text-slate-900">Finish setting up your profile</h2>
          <p className="mt-1 text-sm text-slate-600">
            Upload your resume so your arms know how to answer application questions.
          </p>
          <Link
            href="/onboarding"
            className="mt-4 inline-block rounded-lg bg-arm-600 px-4 py-2 text-sm font-semibold text-white hover:bg-arm-500"
          >
            Start onboarding
          </Link>
        </div>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm text-slate-500">Plan</p>
          <p className="mt-1 text-xl font-bold capitalize text-slate-900">{plan}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm text-slate-500">
            {quota.window === "day" ? "Arm runs today" : "Arm runs this month"}
          </p>
          <p className="mt-1 text-xl font-bold text-slate-900">
            {used} / {quota.limit}
          </p>
          <p className="mt-1 text-xs text-slate-400">Only successful runs count</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm text-slate-500">Quick action</p>
          <Link
            href="/dashboard/applications/new"
            className="mt-1 inline-block text-sm font-semibold text-arm-600 hover:underline"
          >
            Apply to a job →
          </Link>
        </div>
      </div>
    </div>
  );
}
