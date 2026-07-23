import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

/** Short-lived signed URLs for a run's screenshots (owner only). */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: run } = await supabase
    .from("application_runs")
    .select("id, screenshots")
    .eq("id", id)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const paths = Array.isArray(run.screenshots) ? (run.screenshots as string[]) : [];
  const service = createSupabaseServiceClient();
  const urls: { path: string; url: string }[] = [];
  for (const path of paths) {
    const { data } = await service.storage.from("run-artifacts").createSignedUrl(path, 600);
    if (data?.signedUrl) urls.push({ path, url: data.signedUrl });
  }

  return NextResponse.json({ screenshots: urls });
}
