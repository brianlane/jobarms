import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { STATUS_LABELS, STATUS_STYLES, type ApplicationStatus } from "@/lib/application-status";

export const metadata = { title: "Applications" };

interface Row {
  id: string;
  status: ApplicationStatus;
  created_at: string;
  applied_at: string | null;
  jobs: { company: string; title: string; location: string; url: string } | null;
}

export default async function ApplicationsPage() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("applications")
    .select("id, status, created_at, applied_at, jobs(company, title, location, url)")
    .order("created_at", { ascending: false });

  const rows = (data ?? []) as unknown as Row[];

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Applications</h1>
          <p className="mt-1 text-slate-500">Everything your arms (and you) have in flight.</p>
        </div>
        <Link
          href="/dashboard/applications/new"
          className="rounded-lg bg-arm-600 px-5 py-2.5 font-semibold text-white hover:bg-arm-500"
        >
          + Apply to a job
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-12 text-center text-slate-500">
          No applications yet. Paste a job link and send an arm after it.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Company</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Added</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/applications/${row.id}`}
                      className="font-medium text-slate-900 hover:text-arm-600"
                    >
                      {row.jobs?.title || "Untitled role"}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{row.jobs?.company || "-"}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_STYLES[row.status]}`}>
                      {STATUS_LABELS[row.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {new Date(row.created_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
