import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { NotAResumeError, parseResume } from "@/lib/resume-parse";
import { aiCallQuota, effectivePlan, meterKey, type SubscriptionRow } from "@/lib/plans";

export const maxDuration = 60; // Gemini parse can take a while on long resumes

const ALLOWED_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx"
};
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Upload a resume: stores the file in the private bucket, parses it with
 * Gemini into a structured profile, and merges the result into the user's
 * profile (only filling fields the user hasn't set).
 */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing_file" }, { status: 400 });
  }
  const ext = ALLOWED_TYPES[file.type];
  if (!ext) {
    return NextResponse.json({ error: "unsupported_type", hint: "PDF or DOCX" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "too_large", hint: "8MB max" }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const service = createSupabaseServiceClient();

  // Meter the parse (window-aware: free parses are a LIFETIME allowance of
  // 2, paid plans get monthly caps; see plans.aiCallQuota).
  const { data: sub } = await service
    .from("subscriptions")
    .select("plan, status, current_period_end, cancel_at_period_end")
    .eq("user_id", user.id)
    .maybeSingle();
  const plan = effectivePlan(sub as SubscriptionRow | null);
  const quota = aiCallQuota(plan, "resume_parse");
  const mk = meterKey(quota.window);
  const { data: reserved } = await service.rpc("try_reserve_ai_call", {
    p_user_id: user.id,
    p_month_key: mk,
    p_kind: "resume_parse",
    p_limit: quota.limit
  });
  if (!reserved) {
    return NextResponse.json(
      {
        error: "parse_limit_reached",
        hint:
          plan === "free"
            ? "You've used your 2 free resume parses. Upgrade to Premium for 100 a month; your profile stays fully editable either way."
            : "You've hit this month's fair-use parsing cap. It resets next month."
      },
      { status: 402 }
    );
  }

  const storagePath = `${user.id}/${randomUUID()}.${ext}`;

  const { error: uploadError } = await service.storage
    .from("resumes")
    .upload(storagePath, bytes, { contentType: file.type });
  if (uploadError) {
    return NextResponse.json({ error: "upload_failed" }, { status: 500 });
  }

  const { data: row, error: insertError } = await service
    .from("resumes")
    .insert({
      user_id: user.id,
      file_name: file.name,
      storage_path: storagePath,
      mime_type: file.type
    })
    .select("id")
    .single();
  if (insertError || !row) {
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  try {
    const parsed = await parseResume(bytes, file.type);

    await service
      .from("resumes")
      .update({ parsed, parse_status: "parsed" })
      .eq("id", row.id);

    // Merge into the profile: parsed values fill in, but never wipe existing
    // non-empty user edits.
    const { data: profile } = await service
      .from("profiles")
      .select("full_name, phone, location, headline, summary, links, work_history, education, skills")
      .eq("id", user.id)
      .single();

    const keep = (current: unknown, incoming: unknown) => {
      if (typeof current === "string") return current.trim() ? current : incoming;
      if (Array.isArray(current)) return current.length > 0 ? current : incoming;
      if (current && typeof current === "object")
        return Object.keys(current).length > 0 ? current : incoming;
      return incoming;
    };

    await service
      .from("profiles")
      .update({
        full_name: keep(profile?.full_name, parsed.full_name),
        phone: keep(profile?.phone, parsed.phone),
        location: keep(profile?.location, parsed.location),
        headline: keep(profile?.headline, parsed.headline),
        summary: keep(profile?.summary, parsed.summary),
        links: keep(profile?.links, parsed.links),
        work_history: keep(profile?.work_history, parsed.work_history),
        education: keep(profile?.education, parsed.education),
        skills: keep(profile?.skills, parsed.skills)
      })
      .eq("id", user.id);

    return NextResponse.json({ resume_id: row.id, parsed });
  } catch (err) {
    // Record the REAL error (the earlier constant string made the first
    // production failure, a transient Gemini 503, undiagnosable).
    const message = err instanceof Error ? err.message : String(err);
    const notAResume = err instanceof NotAResumeError;
    await service
      .from("resumes")
      .update({ parse_status: "failed", parse_error: message.slice(0, 500) })
      .eq("id", row.id);

    if (notAResume) {
      // The model call happened (and told us this isn't a resume), so the
      // metered slot stays consumed: junk uploads can't loop for free.
      return NextResponse.json(
        {
          resume_id: row.id,
          error: "not_a_resume",
          hint: "That file doesn't look like a resume. Upload your resume as PDF or DOCX."
        },
        { status: 422 }
      );
    }
    // Transient failure: give the slot back.
    await service.rpc("release_ai_call", {
      p_user_id: user.id,
      p_month_key: mk,
      p_kind: "resume_parse"
    });
    return NextResponse.json(
      {
        resume_id: row.id,
        error: "parse_failed",
        hint: "The AI reader hit a temporary error. Your file is saved; try Parse again in a moment."
      },
      { status: 503 }
    );
  }
}
