/**
 * Segment-level loading state: renders INSTANTLY inside the dashboard shell
 * on any dashboard navigation while the target page's server render streams
 * in. Without this, the browser sits frozen on the old page for the full
 * server round trip, which reads as "the app is slow".
 */
export default function DashboardLoading() {
  return (
    <div className="mx-auto max-w-5xl animate-pulse">
      <div className="h-8 w-64 rounded-lg bg-slate-200" />
      <div className="mt-3 h-4 w-96 max-w-full rounded bg-slate-200" />
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <div className="h-28 rounded-xl bg-slate-200" />
        <div className="h-28 rounded-xl bg-slate-200" />
        <div className="h-28 rounded-xl bg-slate-200" />
      </div>
      <div className="mt-6 h-64 rounded-xl bg-slate-200" />
    </div>
  );
}
