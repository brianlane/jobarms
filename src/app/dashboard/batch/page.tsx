import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { getAuthUser } from "@/lib/supabase/auth";
import { getLinkedInAccount } from "@/lib/linkedin";
import { canFullAuto, effectivePlan, type SubscriptionRow } from "@/lib/plans";
import { BatchPanel } from "@/components/BatchPanel";

export const metadata = { title: "Batch apply" };

export default async function BatchPage() {
  const user = await getAuthUser();
  const service = createSupabaseServiceClient();

  // site_accounts is service-role only (deny-all RLS), so the connected
  // LinkedIn account is read through the service client.
  const linkedin = await getLinkedInAccount(service, user!.id);

  const { data: sub } = await service
    .from("subscriptions")
    .select("plan, status, current_period_end, cancel_at_period_end")
    .eq("user_id", user!.id)
    .maybeSingle();
  const paid = canFullAuto(effectivePlan(sub as SubscriptionRow | null));

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-2xl font-bold text-slate-900">Batch apply</h1>
      <p className="mb-8 text-slate-500">
        Search LinkedIn with your own account and send one arm to apply to every
        Easy Apply match, back to back.
      </p>
      <BatchPanel linkedInConnected={Boolean(linkedin)} paid={paid} />
    </div>
  );
}
