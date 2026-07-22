/**
 * JobArms ingestion worker — Phase 0 skeleton.
 *
 * Phase 6 turns this into cron-triggered polling of public ATS JSON endpoints
 * (Greenhouse, Lever, Ashby, Workable) and aggregator APIs, normalizing
 * postings into the Supabase `jobs` table.
 */
export interface Env {
  SUPABASE_URL?: string;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "jobarms-ingest" });
    }
    return Response.json({ error: "not_implemented", hint: "ingestion lands in Phase 6" }, { status: 501 });
  },

  async scheduled(): Promise<void> {
    // Phase 6: poll tracked ATS boards and upsert normalized jobs.
  }
} satisfies ExportedHandler<Env>;
