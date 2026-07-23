import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AutonomyToggle } from "@/components/AutonomyToggle";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  const { data: profile } = await supabase
    .from("profiles")
    .select("arm_autonomy")
    .eq("id", user!.id)
    .single();

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-2xl font-bold text-slate-900">Settings</h1>
      <p className="mb-8 text-slate-500">Control how autonomous your arms are.</p>
      <AutonomyToggle initial={(profile?.arm_autonomy as "review_gate" | "full_auto") ?? "review_gate"} />
    </div>
  );
}
