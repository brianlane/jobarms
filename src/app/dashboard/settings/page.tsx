import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { getAuthUser } from "@/lib/supabase/auth";
import { getLinkedInAccount } from "@/lib/linkedin";
import { AutonomyToggle } from "@/components/AutonomyToggle";
import { LinkedInConnect } from "@/components/LinkedInConnect";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await getAuthUser();
  const supabase = await createSupabaseServerClient();

  const { data: profile } = await supabase
    .from("profiles")
    .select("arm_autonomy, applicant_alias")
    .eq("id", user!.id)
    .single();

  // site_accounts is service-role only (deny-all RLS), so the connected LinkedIn
  // email is read through the service client, never the user's scoped one.
  const linkedin = await getLinkedInAccount(createSupabaseServiceClient(), user!.id);

  const alias = (profile?.applicant_alias as string | null) ?? null;

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-2xl font-bold text-slate-900">Settings</h1>
      <p className="mb-8 text-slate-500">Control how autonomous your arms are.</p>
      <AutonomyToggle initial={(profile?.arm_autonomy as "review_gate" | "full_auto") ?? "review_gate"} />

      <LinkedInConnect initialEmail={linkedin?.email ?? null} />

      <section className="mt-8 rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-slate-900">Application inbox</h2>
        <p className="mt-2 text-sm text-slate-500">
          Some employers make you create an account before you can apply. Your arms
          handle that with a managed address, so you never sign up for anything
          yourself. Everything sent there is forwarded to {user!.email}, and
          replying goes straight back to the employer.
        </p>
        {alias ? (
          <p className="mt-4 font-mono text-sm text-slate-700">{alias}</p>
        ) : (
          <p className="mt-4 text-sm text-slate-400">
            Your address is created automatically the first time an arm needs one.
          </p>
        )}
      </section>
    </div>
  );
}
