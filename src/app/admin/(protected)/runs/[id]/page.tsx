import Link from "next/link";
import { notFound } from "next/navigation";
import { answerCounts, loadRunDetail, SCREENSHOT_TTL_SECONDS } from "@/lib/admin/run-detail";
import { classifyRunError, RUN_ERROR_MEANING } from "@/lib/admin/run-stats";
import { RunActions } from "@/components/admin/RunActions";
import {
  Badge,
  Card,
  Empty,
  PageHeading,
  runStatusTone,
  SectionTitle,
  Stat,
  Table,
  timeAgo,
  UserLink
} from "@/components/admin/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin run", robots: { index: false, follow: false } };

const CANCELLABLE = ["queued", "running", "needs_review", "approved", "submitting"];

export default async function AdminRunDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const now = new Date();

  const run = await loadRunDetail(id);
  if (!run) notFound();

  const answers = answerCounts(run.answers);
  const errorCode = classifyRunError(run.error);

  return (
    <div className="space-y-6">
      <PageHeading
        title={run.application?.title || "Arm run"}
        subtitle={
          run.application
            ? `${run.application.company || "unknown company"} · ${run.application.ats}`
            : "The application behind this run is gone"
        }
        right={
          <Link
            href="/admin/runs"
            className="rounded-lg border border-ink-700 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-slate-400 hover:border-arm-500 hover:text-arm-300"
          >
            All runs
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={runStatusTone(run.status)}>{run.status.replaceAll("_", " ")}</Badge>
        <Badge tone="neutral">{run.autonomy.replaceAll("_", " ")}</Badge>
        <Badge tone={run.slot_refunded ? "info" : "neutral"}>
          {run.slot_refunded ? "slot refunded" : "slot consumed"}
        </Badge>
        {run.canceled_by && <Badge tone="warn">canceled by {run.canceled_by}</Badge>}
        {run.user && <UserLink id={run.user.id} email={run.user.email} />}
      </div>

      {run.error && (
        <Card className="border-red-500/30">
          <SectionTitle right={<Badge tone="bad">{errorCode}</Badge>}>Failure</SectionTitle>
          <p className="text-sm text-red-300">{run.error}</p>
          <p className="mt-1 text-xs text-slate-500">{RUN_ERROR_MEANING[errorCode]}</p>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Fields extracted" value={run.formFieldCount} />
        <Stat label="Answers filled" value={answers.filled} tone={answers.filled > 0 ? "good" : "neutral"} />
        <Stat label="Answers skipped" value={answers.skipped} tone={answers.skipped > 0 ? "warn" : "neutral"} />
        <Stat label="Screenshots" value={run.screenshots.length} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>Run identity</SectionTitle>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-slate-500">Run id</dt>
              <dd className="break-all font-mono text-[10px] text-slate-300">{run.id}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Workflow instance</dt>
              <dd className="break-all font-mono text-[10px] text-slate-300">
                {run.workflow_instance_id ?? "never started"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Metering slot</dt>
              <dd className="font-mono text-[10px] text-slate-300">{run.month_key || "-"}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">ATS tenant</dt>
              <dd className="break-all font-mono text-[10px] text-slate-300">
                {run.tenant_host ?? "not account-gated"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Started</dt>
              <dd className="text-slate-300">{timeAgo(run.created_at, now)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Last update</dt>
              <dd className="text-slate-300">{timeAgo(run.updated_at, now)}</dd>
            </div>
            {run.application && (
              <div className="col-span-2">
                <dt className="text-xs text-slate-500">Posting</dt>
                <dd className="break-all text-[11px] text-slate-400">
                  {run.application.url || "no url"}
                </dd>
              </div>
            )}
          </dl>
        </Card>

        <Card>
          <SectionTitle>Step log</SectionTitle>
          {run.steps.length === 0 ? (
            <Empty>The arm never logged a step.</Empty>
          ) : (
            <ol className="space-y-2">
              {run.steps.map((step, index) => (
                <li key={`${step.step}-${index}`} className="flex gap-3 text-xs">
                  <span className="w-20 shrink-0 text-slate-600">{timeAgo(step.at, now)}</span>
                  <span className="font-mono text-slate-300">{step.step ?? "unnamed"}</span>
                  {step.detail && <span className="truncate text-slate-500">{step.detail}</span>}
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      <Card>
        <SectionTitle
          right={
            <span className="text-xs text-slate-600">
              {answers.filled} filled · {answers.skipped} skipped
            </span>
          }
        >
          Exactly what the arm answered
        </SectionTitle>
        {run.answers.length === 0 ? (
          <Empty>No answers were drafted.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <th className="pb-2">Question</th>
                <th className="pb-2">Type</th>
                <th className="pb-2">Answer</th>
              </tr>
            }
          >
            {run.answers.map((answer, index) => (
              <tr key={`${answer.name ?? answer.label ?? "field"}-${index}`}>
                <td className="max-w-xs py-2 text-slate-300">
                  {answer.label || answer.name || "unlabelled field"}
                  {answer.edited && (
                    <span className="pl-1.5">
                      <Badge tone="info">user edited</Badge>
                    </span>
                  )}
                </td>
                <td className="py-2 text-slate-600">{answer.type ?? "text"}</td>
                <td className="max-w-md py-2 text-slate-400">
                  {answer.skipped || !(answer.value ?? "").trim() ? (
                    <span className="text-slate-600">skipped</span>
                  ) : (
                    <span className="whitespace-pre-wrap">{answer.value}</span>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card>
        <SectionTitle>Screenshots</SectionTitle>
        {run.screenshots.length === 0 ? (
          <Empty>No screenshots were captured.</Empty>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {run.screenshots.map((shot) => (
              <a key={shot.path} href={shot.url} target="_blank" rel="noreferrer" className="block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={shot.url}
                  alt={shot.path}
                  className="w-full rounded-lg border border-ink-800"
                />
                <span className="mt-1 block truncate font-mono text-[10px] text-slate-600">
                  {shot.path}
                </span>
              </a>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-slate-600">
          Links are signed for {SCREENSHOT_TTL_SECONDS / 60} minutes. The bucket itself stays
          private.
        </p>
      </Card>

      <Card>
        <SectionTitle>Operator actions</SectionTitle>
        <RunActions
          runId={run.id}
          cancellable={CANCELLABLE.includes(run.status)}
          alreadyRefunded={Boolean(run.slot_refunded)}
        />
      </Card>
    </div>
  );
}
