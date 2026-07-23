import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/supabase/auth";
import { ProfileEditor, type ProfileData } from "@/components/ProfileEditor";

export const metadata = { title: "Profile" };

export default async function ProfilePage() {
  const user = await getAuthUser();
  const supabase = await createSupabaseServerClient();

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, headline, location, phone, summary, links, work_history, education, skills")
    .eq("id", user!.id)
    .single();

  const initial: ProfileData = {
    full_name: profile?.full_name ?? "",
    headline: profile?.headline ?? "",
    location: profile?.location ?? "",
    phone: profile?.phone ?? "",
    summary: profile?.summary ?? "",
    links: profile?.links ?? {},
    work_history: profile?.work_history ?? [],
    education: profile?.education ?? [],
    skills: profile?.skills ?? []
  };

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-2xl font-bold text-slate-900">Profile</h1>
      <p className="mb-8 text-slate-500">
        The single source your arms answer every application question from.
      </p>
      <ProfileEditor initial={initial} />
    </div>
  );
}
