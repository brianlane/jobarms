/**
 * Run the PRODUCTION resume-parse path (retries + model fallback) against
 * the newest stored resume. Prints the parsed profile or the real error.
 *
 *   set -a && source .env && set +a
 *   npx tsx debug/repro-resume-parse.ts
 */
import { createClient } from "@supabase/supabase-js";
import { parseResume } from "../src/lib/resume-parse";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
}

const supabase = createClient(need("NEXT_PUBLIC_SUPABASE_URL"), need("SUPABASE_SECRET_KEY"), {
  auth: { persistSession: false }
});

async function main() {
  const { data: rows } = await supabase
    .from("resumes")
    .select("id, storage_path, mime_type, parse_status, parse_error, created_at")
    .order("created_at", { ascending: false })
    .limit(5);
  if (!rows?.length) throw new Error("no resumes stored");
  const target = rows.find((r) => r.parse_status === "failed") ?? rows[0];
  console.log("target:", target.id, target.parse_status, target.mime_type);

  const { data: blob, error } = await supabase.storage.from("resumes").download(target.storage_path);
  if (error || !blob) throw error ?? new Error("download failed");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  console.log(`downloaded ${bytes.length} bytes; parsing with production path...`);

  const started = Date.now();
  const parsed = await parseResume(bytes, target.mime_type);
  console.log(`PARSED OK in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(
    JSON.stringify(
      {
        full_name: parsed.full_name,
        headline: parsed.headline,
        location: parsed.location,
        roles: parsed.work_history.length,
        education: parsed.education.length,
        skills: parsed.skills.length
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error("STILL FAILING:", err);
  process.exit(1);
});
