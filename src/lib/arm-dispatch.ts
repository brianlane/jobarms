import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchRun, type ArmDispatchResult } from "@/lib/arm";
import { lessonsFromStats } from "@/lib/answer-memory";

export interface ResumeRow {
  file_name: string;
  storage_path: string;
  mime_type: string;
}

export interface DispatchArgs {
  runId: string;
  applicationId: string;
  userId: string;
  jobUrl: string;
  ats: "greenhouse" | "lever";
  autonomy: "review_gate" | "full_auto";
  jobTitle: string;
  jobCompany: string;
  jobDescription: string;
  profile: Record<string, unknown>;
  resume: ResumeRow | null;
}

/**
 * Build the full arm payload (learning memory + platform lessons + signed
 * resume URL) and dispatch to the worker. Shared by application-create and
 * run-retry so the two paths can never drift.
 */
export async function buildAndDispatchRun(
  service: SupabaseClient,
  args: DispatchArgs
): Promise<ArmDispatchResult> {
  // Learning payloads: this user's remembered answers + anonymous platform lessons.
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
      .eq("ats", args.ats)
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

  // Signed resume URL (24h: outlives the review gate for most users).
  let signedUrl: string | null = null;
  if (args.resume) {
    const { data: signed } = await service.storage
      .from("resumes")
      .createSignedUrl(args.resume.storage_path, 60 * 60 * 24);
    signedUrl = signed?.signedUrl ?? null;
  }

  return dispatchRun({
    runId: args.runId,
    applicationId: args.applicationId,
    userId: args.userId,
    jobUrl: args.jobUrl,
    ats: args.ats,
    autonomy: args.autonomy,
    jobTitle: args.jobTitle,
    jobCompany: args.jobCompany,
    jobDescription: args.jobDescription,
    profile: args.profile,
    resume: {
      signedUrl,
      fileName: args.resume?.file_name ?? "resume.pdf",
      mimeType: args.resume?.mime_type ?? "application/pdf"
    },
    memory
  });
}
