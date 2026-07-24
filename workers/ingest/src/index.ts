/**
 * JobArms ingestion worker - cron-polls the public ATS endpoints of every
 * active row in `companies` and upserts normalized postings into `jobs`
 * (conflict key: url). Runs on the half hour; a manual POST /ingest with the
 * cron secret does the same for testing.
 */
import { fetchAshby, fetchGreenhouse, fetchLever, fetchWorkable, type NormalizedJob } from "./fetchers";

export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  INTERNAL_CRON_SECRET?: string;
}

interface CompanyRow {
  id: string;
  name: string;
  ats: "greenhouse" | "lever" | "ashby" | "workable";
  board_token: string;
}

/** Length-independent, constant-time string compare (no early-exit leak). */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function headers(env: Env): Record<string, string> {
  const key = env.SUPABASE_SECRET_KEY ?? "";
  return { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };
}

async function activeCompanies(env: Env): Promise<CompanyRow[]> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/companies?active=eq.true&select=id,name,ats,board_token`,
    { headers: headers(env) }
  );
  if (!res.ok) throw new Error(`companies fetch failed: ${res.status}`);
  return (await res.json()) as CompanyRow[];
}

async function upsertJobs(env: Env, jobs: NormalizedJob[]): Promise<void> {
  if (jobs.length === 0) return;
  // PostgREST upsert on the jobs.url unique index.
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/jobs?on_conflict=url`, {
    method: "POST",
    headers: { ...headers(env), prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(jobs)
  });
  if (!res.ok) throw new Error(`jobs upsert failed: ${res.status} ${await res.text()}`);
}

async function markIngested(env: Env, companyId: string): Promise<void> {
  await fetch(`${env.SUPABASE_URL}/rest/v1/companies?id=eq.${companyId}`, {
    method: "PATCH",
    headers: headers(env),
    body: JSON.stringify({ last_ingested_at: new Date().toISOString() })
  });
}

async function ingestAll(env: Env): Promise<{ companies: number; jobs: number; errors: string[] }> {
  const companies = await activeCompanies(env);
  let total = 0;
  const errors: string[] = [];

  for (const company of companies) {
    try {
      let jobs: NormalizedJob[] = [];
      if (company.ats === "greenhouse") jobs = await fetchGreenhouse(company.name, company.board_token);
      else if (company.ats === "lever") jobs = await fetchLever(company.name, company.board_token);
      else if (company.ats === "ashby") jobs = await fetchAshby(company.name, company.board_token);
      else if (company.ats === "workable") jobs = await fetchWorkable(company.name, company.board_token);

      await upsertJobs(env, jobs);
      await markIngested(env, company.id);
      total += jobs.length;
    } catch (err) {
      errors.push(`${company.ats}/${company.board_token}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { companies: companies.length, jobs: total, errors };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "jobarms-ingest" });
    }
    if (url.pathname === "/ingest" && request.method === "POST") {
      const header = request.headers.get("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!env.INTERNAL_CRON_SECRET || !timingSafeEqual(token, env.INTERNAL_CRON_SECRET)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json(await ingestAll(env));
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const result = await ingestAll(env);
    console.log(
      `ingest: ${result.jobs} jobs from ${result.companies} companies` +
        (result.errors.length ? `; errors: ${result.errors.join(" | ")}` : "")
    );
  }
} satisfies ExportedHandler<Env>;
