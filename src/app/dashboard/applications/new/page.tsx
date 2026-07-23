import { Suspense } from "react";
import { NewApplicationForm } from "@/components/NewApplicationForm";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/supabase/auth";
import { canTailor, effectivePlan, type SubscriptionRow } from "@/lib/plans";

export const metadata = { title: "Apply to a job" };

export default async function NewApplicationPage() {
  const user = await getAuthUser();
  const supabase = await createSupabaseServerClient();
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("plan, status, current_period_end, cancel_at_period_end")
    .eq("user_id", user!.id)
    .maybeSingle();
  const premium = canTailor(effectivePlan(sub as SubscriptionRow | null));

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-2xl font-bold text-slate-900">Apply to a job</h1>
      <p className="mb-8 text-slate-500">Paste a job link and send an arm after it.</p>
      <Suspense>
        <NewApplicationForm premium={premium} />
      </Suspense>
    </div>
  );
}
