/**
 * One-off: apply the resume normalizers to an EXISTING profile row (for
 * profiles saved before normalization shipped).
 *
 *   set -a && source .env && set +a
 *   npx tsx debug/normalize-profile.ts <email>
 */
import { createClient } from "@supabase/supabase-js";
import {
  fixShoutyField,
  fixShoutyProse,
  normalizePhone
} from "../src/lib/normalize";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
}

const email = process.argv[2];
if (!email?.includes("@")) throw new Error("usage: normalize-profile.ts <email>");

const supabase = createClient(need("NEXT_PUBLIC_SUPABASE_URL"), need("SUPABASE_SECRET_KEY"), {
  auth: { persistSession: false }
});

interface Role {
  company?: string;
  title?: string;
  bullets?: string[];
  [k: string]: unknown;
}
interface Edu {
  school?: string;
  degree?: string;
  field?: string;
  [k: string]: unknown;
}

async function main() {
  const { data } = await supabase.auth.admin.listUsers({ perPage: 200 });
  const user = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!user) throw new Error("user not found");

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("full_name, headline, location, phone, summary, work_history, education, skills")
    .eq("id", user.id)
    .single();
  if (error || !profile) throw error ?? new Error("profile not found");

  const patch = {
    full_name: fixShoutyField(profile.full_name ?? ""),
    headline: fixShoutyField(profile.headline ?? ""),
    location: fixShoutyField(profile.location ?? ""),
    phone: normalizePhone(profile.phone ?? ""),
    summary: fixShoutyProse(profile.summary ?? ""),
    work_history: ((profile.work_history as Role[]) ?? []).map((r) => ({
      ...r,
      company: fixShoutyField(r.company ?? ""),
      title: fixShoutyField(r.title ?? ""),
      bullets: (r.bullets ?? []).map(fixShoutyProse)
    })),
    education: ((profile.education as Edu[]) ?? []).map((e) => ({
      ...e,
      school: fixShoutyField(e.school ?? ""),
      degree: fixShoutyField(e.degree ?? ""),
      field: fixShoutyField(e.field ?? "")
    })),
    skills: ((profile.skills as string[]) ?? []).map(fixShoutyField)
  };

  const { error: updateErr } = await supabase.from("profiles").update(patch).eq("id", user.id);
  if (updateErr) throw updateErr;

  console.log("normalized:", patch.full_name, "|", patch.headline, "|", patch.phone);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
