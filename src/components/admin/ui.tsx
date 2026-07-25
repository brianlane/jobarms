/**
 * Shared primitives for the admin console. The operator surface is deliberately
 * dark where the product dashboard is light: at a glance you can tell whether
 * you are looking at your own account or at the whole platform.
 */

import Link from "next/link";

export function Card({
  children,
  className = ""
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-ink-800 bg-ink-900 p-5 ${className}`}>{children}</div>
  );
}

export function SectionTitle({
  children,
  right
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
        {children}
      </h2>
      {right}
    </div>
  );
}

export type BadgeTone = "good" | "bad" | "warn" | "info" | "neutral";

const BADGE_STYLES: Record<BadgeTone, string> = {
  good: "bg-teal-500/15 text-teal-300 border-teal-500/30",
  bad: "bg-red-500/15 text-red-300 border-red-500/30",
  warn: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  info: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  neutral: "bg-ink-800 text-slate-400 border-ink-700"
};

export function Badge({
  tone = "neutral",
  children
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] ${BADGE_STYLES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "neutral"
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: BadgeTone;
}) {
  const valueColor =
    tone === "good"
      ? "text-teal-300"
      : tone === "bad"
        ? "text-red-300"
        : tone === "warn"
          ? "text-amber-300"
          : "text-white";
  return (
    <Card>
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className={`mt-1.5 text-3xl font-bold ${valueColor}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </Card>
  );
}

/** A labelled proportion bar: the plan mix, status mix, and quota rows use it. */
export function MeterRow({
  label,
  count,
  total,
  tone = "info"
}: {
  label: string;
  count: number;
  total: number;
  tone?: BadgeTone;
}) {
  const percent = total > 0 ? Math.round((count / total) * 100) : 0;
  const fill =
    tone === "good"
      ? "bg-teal-400"
      : tone === "bad"
        ? "bg-red-400"
        : tone === "warn"
          ? "bg-amber-400"
          : "bg-indigo-400";
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="capitalize text-slate-300">{label}</span>
        <span className="text-slate-500">
          {count} · {percent}%
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-ink-800">
        <div className={`h-full rounded-full ${fill}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/** Vertical bar chart for a short month series. */
export function BarChart({ points }: { points: { label: string; count: number }[] }) {
  const max = Math.max(...points.map((p) => p.count), 1);
  return (
    <div className="flex h-28 items-end gap-2">
      {points.map((point) => (
        <div key={point.label} className="flex flex-1 flex-col items-center gap-1.5">
          <span className="text-xs font-medium text-slate-400">{point.count || ""}</span>
          <div className="flex w-full flex-col justify-end" style={{ height: "80px" }}>
            <div
              className="w-full rounded-t-sm bg-arm-500/70"
              style={{
                height: `${Math.max((point.count / max) * 100, point.count > 0 ? 8 : 0)}%`
              }}
            />
          </div>
          <span className="text-xs text-slate-600">{point.label}</span>
        </div>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-slate-500">{children}</p>;
}

export function PageHeading({
  title,
  subtitle,
  right
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-white">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
      </div>
      {right}
    </div>
  );
}

/** Table shell: the admin tables are all the same dense dark grid. */
export function Table({
  head,
  children
}: {
  head: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="font-mono text-[10px] uppercase tracking-[0.12em] text-slate-500">
          {head}
        </thead>
        <tbody className="divide-y divide-ink-800">{children}</tbody>
      </table>
    </div>
  );
}

/** A user reference that goes to their admin detail page. */
export function UserLink({ id, email }: { id: string; email: string }) {
  return (
    <Link
      href={`/admin/users/${id}`}
      className="font-medium text-slate-200 hover:text-arm-300"
      title={id}
    >
      {email || id.slice(0, 8)}
    </Link>
  );
}

/** Compact relative age. Absolute dates are for detail pages, not feeds. */
export function timeAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "unknown";
  const seconds = Math.round((now.getTime() - at) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}
