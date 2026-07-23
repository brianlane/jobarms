/**
 * Live smoke test of the apply arm (NEVER submits):
 *   1. Ensures the internal smoke user + profile (review_gate autonomy).
 *   2. Picks a real Greenhouse posting from the ingested jobs catalog.
 *   3. Creates application + run rows and dispatches the arm worker.
 *   4. Polls the run until it parks at needs_review (or fails), prints the
 *      step log / generated answers / screenshots.
 *   5. Cancels the run - review_gate guarantees zero risk of a real
 *      submission to a real employer.
 *
 *   set -a && source .env && set +a
 *   npx tsx debug/smoke-arm-run.ts [job-url]
 */
import { createClient } from "@supabase/supabase-js";

const SMOKE_EMAIL = "smoke@jobarms.com";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set (source .env first)`);
  return v;
}

const supabase = createClient(need("NEXT_PUBLIC_SUPABASE_URL"), need("SUPABASE_SECRET_KEY"), {
  auth: { persistSession: false }
});
const ARM_URL = need("ARM_WORKER_URL");
const ARM_SECRET = need("ARM_WORKER_SHARED_SECRET");

const SMOKE_PROFILE = {
  full_name: "Jordan Smoke",
  email: SMOKE_EMAIL,
  phone: "+1 602 555 0142",
  location: "Phoenix, AZ",
  headline: "Senior Software Engineer",
  summary:
    "Full-stack engineer with 8 years across TypeScript, React, Node, and Postgres. Led migration of a monolith to edge-deployed services.",
  links: { linkedin: "https://linkedin.com/in/jordansmoke", github: "https://github.com/jordansmoke" },
  work_history: [
    {
      company: "Acme Cloud",
      title: "Senior Software Engineer",
      start: "Mar 2021",
      end: "Present",
      bullets: [
        "Own the customer-facing dashboard (React/Next.js, 40k MAU)",
        "Cut p95 API latency 60% by moving hot paths to edge workers"
      ]
    },
    {
      company: "DataPine",
      title: "Software Engineer",
      start: "Jun 2017",
      end: "Feb 2021",
      bullets: ["Built ingestion pipelines processing 2B events/day (Node, Postgres, Kafka)"]
    }
  ],
  education: [
    { school: "Arizona State University", degree: "B.S.", field: "Computer Science", start: "2013", end: "2017" }
  ],
  skills: ["TypeScript", "React", "Node.js", "Postgres", "Cloudflare Workers", "CI/CD"],
  eeo: {},
  preferences: { remote: true },
  arm_autonomy: "review_gate",
  onboarding_complete: true
};

async function ensureSmokeUser(): Promise<string> {
  const { data: list } = await supabase.auth.admin.listUsers({ perPage: 200 });
  const existing = list?.users.find((u) => u.email === SMOKE_EMAIL);
  const userId =
    existing?.id ??
    (
      await supabase.auth.admin.createUser({
        email: SMOKE_EMAIL,
        email_confirm: true,
        password: crypto.randomUUID() + "A1!"
      })
    ).data.user?.id;
  if (!userId) throw new Error("could not create smoke user");
  const { error } = await supabase.from("profiles").upsert({ id: userId, ...SMOKE_PROFILE });
  if (error) throw error;
  return userId;
}

function atsOf(url: string): "greenhouse" | "lever" {
  return new URL(url).hostname.endsWith("lever.co") ? "lever" : "greenhouse";
}

async function pickJob(argUrl?: string) {
  if (argUrl) {
    const { data, error } = await supabase
      .from("jobs")
      .upsert({ url: argUrl, ats: atsOf(argUrl), source: "manual" }, { onConflict: "url" })
      .select("id, url, title, company, description")
      .single();
    if (error || !data) throw error ?? new Error("job upsert failed");
    return data;
  }
  const { data } = await supabase
    .from("jobs")
    .select("id, url, title, company, description")
    .eq("ats", "greenhouse")
    .not("description", "eq", "")
    .order("created_at", { ascending: false })
    .limit(1);
  if (!data?.[0]) throw new Error("no greenhouse job in catalog - pass a URL");
  return data[0];
}

async function main() {
  const userId = await ensureSmokeUser();
  console.log(`smoke user: ${userId}`);

  const job = await pickJob(process.argv[2]);
  console.log(`job: ${job.title || "?"} @ ${job.company || "?"} - ${job.url}`);

  // application + run rows (idempotent per run: always a fresh run)
  const { data: app, error: appErr } = await supabase
    .from("applications")
    .upsert({ user_id: userId, job_id: job.id, source: "arm" }, { onConflict: "user_id,job_id" })
    .select("id")
    .single();
  if (appErr || !app) throw appErr ?? new Error("application upsert failed");

  const monthKey = new Date().toISOString().slice(0, 7);
  const { data: run, error: runErr } = await supabase
    .from("application_runs")
    .insert({
      application_id: app.id,
      user_id: userId,
      autonomy: "review_gate",
      month_key: monthKey
    })
    .select("id")
    .single();
  if (runErr || !run) throw runErr ?? new Error("run insert failed");
  console.log(`run: ${run.id}`);

  // dispatch
  const dispatch = await fetch(`${ARM_URL}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ARM_SECRET}` },
    body: JSON.stringify({
      runId: run.id,
      applicationId: app.id,
      userId,
      jobUrl: job.url,
      ats: atsOf(job.url),
      autonomy: "review_gate",
      jobTitle: job.title ?? "",
      jobCompany: job.company ?? "",
      jobDescription: job.description ?? "",
      profile: SMOKE_PROFILE,
      resume: { signedUrl: null, fileName: "resume.pdf", mimeType: "application/pdf" }
    })
  });
  console.log(`dispatch: ${dispatch.status} ${await dispatch.text()}`);
  if (!dispatch.ok) process.exit(1);

  // poll
  const deadline = Date.now() + 5 * 60_000;
  let final: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    const { data } = await supabase
      .from("application_runs")
      .select("status, steps, answers, screenshots, error")
      .eq("id", run.id)
      .single();
    if (!data) continue;
    console.log(`  status: ${data.status} (${(data.steps as unknown[])?.length ?? 0} steps)`);
    if (["needs_review", "failed", "submitted", "canceled"].includes(data.status)) {
      final = data;
      break;
    }
  }

  if (!final) {
    console.log("TIMEOUT - run still in flight; inspect application_runs manually.");
  } else {
    console.log("\n=== FINAL ===");
    console.log(`status: ${final.status}`);
    console.log(`error: ${final.error ?? "none"}`);
    console.log(`steps: ${JSON.stringify(final.steps, null, 2)}`);
    const answers = (final.answers as unknown[]) ?? [];
    console.log(`answers (${answers.length}): ${JSON.stringify(answers, null, 2).slice(0, 3000)}`);
    console.log(`screenshots: ${JSON.stringify(final.screenshots)}`);
  }

  // Always cancel - the smoke must never submit.
  const cancel = await fetch(`${ARM_URL}/runs/${run.id}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ARM_SECRET}` }
  });
  console.log(`cancel: ${cancel.status}`);
  await supabase.from("application_runs").update({ status: "canceled" }).eq("id", run.id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
