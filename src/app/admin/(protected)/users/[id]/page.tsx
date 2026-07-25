import Link from "next/link";
import { notFound } from "next/navigation";
import { loadDeletionImpact, loadUserDetail } from "@/lib/admin/user-detail";
import { classifyEngagement, type EngagementSegment } from "@/lib/admin/users-table";
import { STATUS_LABELS, type ApplicationStatus } from "@/lib/application-status";
import { summarizeRuns } from "@/lib/admin/run-stats";
import { UserActions } from "@/components/admin/UserActions";
import {
  Badge,
  Card,
  Empty,
  PageHeading,
  SectionTitle,
  Table,
  timeAgo,
  type BadgeTone
} from "@/components/admin/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin user", robots: { index: false, follow: false } };

const SEGMENT_TONE: Record<EngagementSegment, BadgeTone> = {
  active: "good",
  new: "info",
  cooling: "warn",
  quiet: "bad"
};

const AI_KIND_LABELS: Record<string, string> = {
  resume_parse: "Resume parses",
  tailor_resume: "Tailored resumes",
  cover_letter: "Cover letters"
};

function count(value: unknown[] | null): number {
  return Array.isArray(value) ? value.length : 0;
}

function runTone(status: string): BadgeTone {
  if (status === "submitted") return "good";
  if (status === "failed") return "bad";
  if (status === "needs_review") return "warn";
  return "neutral";
}

export default async function AdminUserDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const now = new Date();

  const detail = await loadUserDetail(id, now);
  if (!detail) notFound();

  const impact = await loadDeletionImpact(id);
  const runs = summarizeRuns(detail.runs, now);
  const segment = classifyEngagement(
    { createdAt: detail.profile.created_at, lastSignInAt: detail.auth?.lastSignInAt ?? null },
    now
  );
  const applied = detail.applications.filter((app) => app.applied_at).length;

  // The EEO vault holds voluntary self-identification answers. The admin sees
  // only WHETHER it is populated, never the values: nothing about running the
  // platform requires reading a user's protected characteristics.
  const eeoFieldCount = Object.keys(detail.profile.eeo ?? {}).length;

  return (
    <div className="space-y-6">
      <PageHeading
        title={detail.profile.email || id}
        subtitle={detail.profile.full_name || "No name on the profile"}
        right={
          <Link
            href="/admin/users"
            className="rounded-lg border border-ink-700 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-slate-400 hover:border-arm-500 hover:text-arm-300"
          >
            All users
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={detail.plan === "free" ? "info" : "good"}>{detail.plan}</Badge>
        <Badge tone={SEGMENT_TONE[segment]}>{segment}</Badge>
        <Badge tone={detail.profile.onboarding_complete ? "good" : "warn"}>
          {detail.profile.onboarding_complete ? "onboarded" : "onboarding incomplete"}
        </Badge>
        <Badge tone={detail.auth?.emailConfirmedAt ? "good" : "warn"}>
          {detail.auth?.emailConfirmedAt ? "email confirmed" : "email unconfirmed"}
        </Badge>
        <Badge tone="neutral">{detail.profile.arm_autonomy.replaceAll("_", " ")}</Badge>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Account */}
        <Card>
          <SectionTitle>Account</SectionTitle>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-slate-500">User id</dt>
              <dd className="break-all font-mono text-[10px] text-slate-300">{detail.profile.id}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Joined</dt>
              <dd className="text-slate-300">{timeAgo(detail.profile.created_at, now)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Last sign-in</dt>
              <dd className="text-slate-300">{timeAgo(detail.auth?.lastSignInAt, now)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Welcome email</dt>
              <dd className="text-slate-300">
                {detail.profile.welcome_sent ? "sent" : "not sent"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Applies from</dt>
              <dd className="break-all font-mono text-[10px] text-slate-300">
                {detail.profile.applicant_alias ?? "no managed alias yet"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Location</dt>
              <dd className="text-slate-300">{detail.profile.location || "-"}</dd>
            </div>
          </dl>
        </Card>

        {/* Billing */}
        <Card>
          <SectionTitle>Billing</SectionTitle>
          {detail.subscription ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div>
                <dt className="text-xs text-slate-500">Recorded plan</dt>
                <dd className="text-slate-300">
                  {detail.subscription.plan}
                  {detail.subscription.plan !== detail.plan && (
                    <span className="pl-1 text-amber-300">(grants {detail.plan})</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Status</dt>
                <dd className="text-slate-300">
                  {detail.subscription.status.replaceAll("_", " ")}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Renews</dt>
                <dd className="text-slate-300">
                  {detail.subscription.current_period_end
                    ? new Date(detail.subscription.current_period_end).toLocaleDateString()
                    : "-"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Cancel at period end</dt>
                <dd className="text-slate-300">
                  {detail.subscription.cancel_at_period_end ? "yes" : "no"}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs text-slate-500">Stripe</dt>
                <dd className="break-all font-mono text-[10px] text-slate-300">
                  {detail.subscription.stripe_subscription_id ?? "no subscription"}
                </dd>
              </div>
            </dl>
          ) : (
            <Empty>No subscription row.</Empty>
          )}
        </Card>
      </div>

      {/* Quotas */}
      <Card>
        <SectionTitle>Quotas</SectionTitle>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <div>
            <p className="text-xs text-slate-500">Arm runs</p>
            <p
              className={`text-xl font-bold ${
                detail.armQuota.pct >= 80 ? "text-amber-300" : "text-white"
              }`}
            >
              {detail.armQuota.used}
              <span className="text-sm font-normal text-slate-600">/{detail.armQuota.limit}</span>
            </p>
            <p className="text-[10px] text-slate-600">per {detail.armQuota.window}</p>
          </div>
          {detail.aiQuotas.map((quota) => (
            <div key={quota.kind}>
              <p className="text-xs text-slate-500">{AI_KIND_LABELS[quota.kind]}</p>
              <p className="text-xl font-bold text-white">
                {quota.used}
                <span className="text-sm font-normal text-slate-600">/{quota.limit}</span>
              </p>
              <p className="text-[10px] text-slate-600">per {quota.window}</p>
            </div>
          ))}
        </div>
      </Card>

      {/* Profile completeness */}
      <Card>
        <SectionTitle>Profile</SectionTitle>
        <div className="grid grid-cols-2 gap-4 text-sm lg:grid-cols-5">
          <div>
            <p className="text-xs text-slate-500">Work history</p>
            <p className="text-lg font-bold text-white">{count(detail.profile.work_history)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Education</p>
            <p className="text-lg font-bold text-white">{count(detail.profile.education)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Skills</p>
            <p className="text-lg font-bold text-white">{count(detail.profile.skills)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Links</p>
            <p className="text-lg font-bold text-white">
              {Object.keys(detail.profile.links ?? {}).length}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Self-id vault</p>
            <p className="text-lg font-bold text-white">
              {eeoFieldCount > 0 ? "populated" : "empty"}
            </p>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-600">
          Counts only. Self-identification answers are never displayed here: nothing about operating
          the platform requires reading them.
        </p>
      </Card>

      {/* Runs */}
      <Card>
        <SectionTitle
          right={
            <span className="text-xs text-slate-500">
              {runs.submitted} submitted · {runs.failed} failed · {runs.refunded} refunded
            </span>
          }
        >
          Arm runs ({detail.runs.length})
        </SectionTitle>
        {detail.runs.length === 0 ? (
          <Empty>This user has never sent an arm.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <th className="pb-2">Status</th>
                <th className="pb-2">Mode</th>
                <th className="pb-2">Error</th>
                <th className="pb-2 text-right">Slot</th>
                <th className="pb-2 text-right">Started</th>
              </tr>
            }
          >
            {detail.runs.slice(0, 25).map((run) => (
              <tr key={run.id}>
                <td className="py-2">
                  <Badge tone={runTone(run.status)}>{run.status.replaceAll("_", " ")}</Badge>
                </td>
                <td className="py-2 text-slate-500">{run.autonomy.replaceAll("_", " ")}</td>
                <td className="max-w-sm truncate py-2 text-slate-500">{run.error ?? "-"}</td>
                <td className="py-2 text-right text-slate-500">
                  {run.slot_refunded ? "refunded" : "consumed"}
                </td>
                <td className="py-2 text-right text-slate-500">{timeAgo(run.created_at, now)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* Applications */}
      <Card>
        <SectionTitle right={<span className="text-xs text-slate-500">{applied} applied</span>}>
          Applications ({detail.applications.length})
        </SectionTitle>
        {detail.applications.length === 0 ? (
          <Empty>No applications tracked.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <th className="pb-2">Role</th>
                <th className="pb-2">Company</th>
                <th className="pb-2">ATS</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Source</th>
                <th className="pb-2 text-right">Added</th>
              </tr>
            }
          >
            {detail.applications.slice(0, 25).map((app) => (
              <tr key={app.id}>
                <td className="py-2 text-slate-300">{app.jobs?.title || "Untitled role"}</td>
                <td className="py-2 text-slate-500">{app.jobs?.company || "-"}</td>
                <td className="py-2 text-slate-500">{app.jobs?.ats || "-"}</td>
                <td className="py-2 text-slate-500">
                  {STATUS_LABELS[app.status as ApplicationStatus] ?? app.status}
                </td>
                <td className="py-2 text-slate-500">{app.source}</td>
                <td className="py-2 text-right text-slate-500">{timeAgo(app.created_at, now)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Resumes */}
        <Card>
          <SectionTitle>Resumes ({detail.resumes.length})</SectionTitle>
          {detail.resumes.length === 0 ? (
            <Empty>No resume uploaded.</Empty>
          ) : (
            <ul className="divide-y divide-ink-800">
              {detail.resumes.map((resume) => (
                <li key={resume.id} className="flex items-center gap-2 py-2 text-xs">
                  <Badge tone={resume.kind === "tailored" ? "info" : "neutral"}>
                    {resume.kind}
                  </Badge>
                  <span className="truncate text-slate-300">{resume.file_name || "unnamed"}</span>
                  <span className="ml-auto shrink-0 text-slate-600">
                    {timeAgo(resume.created_at, now)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Answer memory */}
        <Card>
          <SectionTitle
            right={
              <span className="text-xs text-slate-500">
                {detail.memory.userEdited} edited · {detail.memory.approved} approved
              </span>
            }
          >
            Remembered answers ({detail.memory.total})
          </SectionTitle>
          {detail.memory.total === 0 ? (
            <Empty>Nothing learned yet. Memory fills on review-gate approvals.</Empty>
          ) : (
            <ul className="divide-y divide-ink-800">
              {detail.memory.topQuestions.map((entry) => (
                <li key={entry.label} className="flex items-center gap-2 py-2 text-xs">
                  <span className="truncate text-slate-300">{entry.label}</span>
                  {entry.source === "user_edited" && <Badge tone="info">edited</Badge>}
                  <span className="ml-auto shrink-0 text-slate-600">
                    used {entry.timesUsed}x
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-600">
            Answer values are stored per user and feed only their own runs. This lists the questions,
            not the answers.
          </p>
        </Card>
      </div>

      {/* ATS candidate accounts the arm created */}
      <Card>
        <SectionTitle>ATS accounts ({detail.siteAccounts.length})</SectionTitle>
        {detail.siteAccounts.length === 0 ? (
          <Empty>No candidate accounts created yet.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <th className="pb-2">Tenant</th>
                <th className="pb-2">Registered as</th>
                <th className="pb-2">Status</th>
                <th className="pb-2 text-right">Last change</th>
              </tr>
            }
          >
            {detail.siteAccounts.map((account) => (
              <tr key={account.tenant_host}>
                <td className="py-2 font-mono text-[11px] text-slate-300">
                  {account.tenant_host}
                </td>
                <td className="py-2 font-mono text-[10px] text-slate-500">
                  {account.alias_email}
                </td>
                <td className="py-2">
                  <Badge
                    tone={
                      account.status === "verified"
                        ? "good"
                        : account.status === "locked"
                          ? "bad"
                          : "warn"
                    }
                  >
                    {account.status.replaceAll("_", " ")}
                  </Badge>
                </td>
                <td className="py-2 text-right text-slate-500">
                  {timeAgo(account.updated_at, now)}
                </td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-slate-600">
          Stored passwords are encrypted at rest and are never read by this console.
        </p>
      </Card>

      {/* Managed alias mail */}
      <Card>
        <SectionTitle>Managed alias mail ({detail.emails.length})</SectionTitle>
        {detail.emails.length === 0 ? (
          <Empty>No mail has arrived at this account&apos;s alias.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <th className="pb-2">From</th>
                <th className="pb-2">Subject</th>
                <th className="pb-2">Verification</th>
                <th className="pb-2">Forwarded</th>
                <th className="pb-2 text-right">Arrived</th>
              </tr>
            }
          >
            {detail.emails.map((mail) => (
              <tr key={mail.id}>
                <td className="max-w-[12rem] truncate py-2 text-slate-300">{mail.from_address}</td>
                <td className="max-w-xs truncate py-2 text-slate-500">{mail.subject}</td>
                <td className="py-2">
                  {mail.verification_link || mail.verification_code ? (
                    <Badge tone="info">
                      {mail.verification_link ? "link" : "code"}
                    </Badge>
                  ) : (
                    <span className="text-slate-600">-</span>
                  )}
                </td>
                <td className="py-2 text-slate-500">{mail.forwarded ? "yes" : "no"}</td>
                <td className="py-2 text-right text-slate-500">{timeAgo(mail.created_at, now)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* Operator actions */}
      <Card>
        <SectionTitle>Operator actions</SectionTitle>
        <UserActions
          userId={id}
          email={detail.profile.email}
          plan={detail.plan}
          stripeManaged={Boolean(detail.subscription?.stripe_subscription_id)}
          impact={impact}
        />
      </Card>
    </div>
  );
}
