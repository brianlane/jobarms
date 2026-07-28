/**
 * Search-driven LinkedIn Easy Apply batches.
 *
 * A batch asks the arm to search LinkedIn for matching jobs and apply to up to N
 * of them in one held session. It reuses the same per-application machinery
 * (extract, answer with memory, fill, read-back verify, submit); this module is
 * the app-side record and dispatch, mirroring `arm-dispatch.ts` for single runs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchBatch, type ArmDispatchResult } from "@/lib/arm";
import { lessonsFromStats } from "@/lib/answer-memory";

export interface BatchRow {
  id: string;
  status: string;
  keywords: string;
  location: string;
  remote: boolean;
  requested: number;
  reserved: number;
  processed: number;
  applied: number;
  failed: number;
  error: string | null;
  created_at: string;
}

/** Insert a batch row, returning its id (service-role; apply_batches is deny-all). */
export async function createBatch(
  service: SupabaseClient,
  userId: string,
  args: {
    keywords: string;
    location: string;
    remote: boolean;
    requested: number;
    reserved: number;
    monthKey: string;
  }
): Promise<string | null> {
  const { data } = await service
    .from("apply_batches")
    .insert({
      user_id: userId,
      keywords: args.keywords,
      location: args.location,
      remote: args.remote,
      requested: args.requested,
      reserved: args.reserved,
      month_key: args.monthKey
    })
    .select("id")
    .single();
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Build the batch payload (learning memory + signed resume) and dispatch it,
 * exactly as a single run does so the two share the arm's grounding.
 */
export async function buildAndDispatchBatch(
  service: SupabaseClient,
  args: {
    batchId: string;
    userId: string;
    keywords: string;
    location: string;
    remote: boolean;
    reserved: number;
    monthKey: string;
    profile: Record<string, unknown>;
    resume: { file_name: string; storage_path: string; mime_type: string } | null;
    account: { email: string; password: string };
  }
): Promise<ArmDispatchResult> {
  const [{ data: memoryRows }, { data: statRows }] = await Promise.all([
    service
      .from("user_answer_memory")
      .select("label, answer, source")
      .eq("user_id", args.userId)
      .order("times_used", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(80),
    service
      .from("platform_field_stats")
      .select("question_key, label_example, times_seen, times_skipped, option_counts")
      .eq("ats", "linkedin")
      .order("times_seen", { ascending: false })
      .limit(60)
  ]);

  const memory = {
    answers: (memoryRows ?? []).map((m) => ({
      label: m.label as string,
      answer: m.answer as string,
      source: m.source as string
    })),
    lessons: lessonsFromStats(
      (statRows ?? []).map((r) => ({
        question_key: r.question_key as string,
        label_example: r.label_example as string,
        times_seen: r.times_seen as number,
        times_skipped: r.times_skipped as number,
        option_counts: (r.option_counts ?? {}) as Record<string, number>
      }))
    ).map((l) => l.guidance)
  };

  let signedUrl: string | null = null;
  if (args.resume) {
    const { data: signed } = await service.storage
      .from("resumes")
      .createSignedUrl(args.resume.storage_path, 60 * 60 * 24);
    signedUrl = signed?.signedUrl ?? null;
  }

  return dispatchBatch({
    batchId: args.batchId,
    userId: args.userId,
    keywords: args.keywords,
    location: args.location,
    remote: args.remote,
    reserved: args.reserved,
    monthKey: args.monthKey,
    profile: args.profile,
    resume: {
      signedUrl,
      fileName: args.resume?.file_name ?? "resume.pdf",
      mimeType: args.resume?.mime_type ?? "application/pdf"
    },
    memory,
    account: { email: args.account.email, password: args.account.password }
  });
}
