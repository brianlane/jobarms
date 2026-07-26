import { auditActionLabel, listAdminAuditLog } from "@/lib/admin/audit";
import { summarizeInboundEmail } from "@/lib/admin/email-health";
import { loadInboundEmails, loadSubscriptions } from "@/lib/admin/reads";
import { probeServices, summarizeEnv, webhookFreshness } from "@/lib/admin/system";
import {
  Badge,
  Card,
  Empty,
  PageHeading,
  SectionTitle,
  Stat,
  Table,
  timeAgo
} from "@/components/admin/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin system", robots: { index: false, follow: false } };

export default async function AdminSystemPage() {
  const now = new Date();
  const env = summarizeEnv();

  // Each read is independent and best effort: a probe timeout or an audit read
  // failure must not blank the configuration matrix, which is the part of this
  // page you reach for when something else is already broken.
  const [probes, subscriptions, audit, inbound] = await Promise.all([
    probeServices(),
    loadSubscriptions().catch(() => []),
    listAdminAuditLog(25).catch(() => []),
    loadInboundEmails(7, now).catch(() => [])
  ]);
  const webhook = webhookFreshness(subscriptions, now);
  const mail = summarizeInboundEmail(inbound, now);

  return (
    <div className="space-y-6">
      <PageHeading
        title="System"
        subtitle="Configuration, dependency reachability, and the operator audit trail."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Env vars set"
          value={
            <>
              {env.configured}
              <span className="text-sm font-normal text-slate-600">/{env.total}</span>
            </>
          }
          tone={env.configured === env.total ? "good" : "warn"}
        />
        <Stat
          label="Dependencies up"
          value={
            <>
              {probes.filter((probe) => probe.reachable).length}
              <span className="text-sm font-normal text-slate-600">/{probes.length}</span>
            </>
          }
          tone={probes.every((probe) => probe.reachable) ? "good" : "bad"}
        />
        <Stat
          label="Last billing event"
          value={webhook.lastEventAt ? timeAgo(webhook.lastEventAt, now) : "never"}
          tone={webhook.quiet ? "warn" : "neutral"}
          hint="newest subscription write"
        />
        <Stat
          label="Forwards failed"
          value={mail.failed24h}
          tone={mail.failed24h > 0 ? "bad" : "good"}
          hint={`last 24h, of ${mail.received24h} received`}
        />
      </div>

      <Card>
        <SectionTitle>Dependencies</SectionTitle>
        <ul className="space-y-2.5">
          {probes.map((probe) => (
            <li key={probe.label} className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={probe.reachable ? "good" : "bad"}>
                {probe.reachable ? "up" : "down"}
              </Badge>
              <span className="text-slate-300">{probe.label}</span>
              <span className="font-mono text-xs text-slate-600">{probe.url ?? "no url"}</span>
              <span className="ml-auto text-xs text-slate-500">{probe.detail}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-slate-600">
          Any HTTP answer counts as up: the worker replies 401 without the shared secret and 404 on
          an unrouted path, and either proves it is deployed and serving. The sidecar is read from
          its /health body instead, because a wedged browser still answers 200 while phases pile up
          unfinished.
        </p>
      </Card>

      <Card>
        <SectionTitle
          right={
            <Badge tone={mail.failed7d > 0 ? "bad" : "good"}>
              {mail.failed7d > 0 ? `${mail.failureRatePct}% failing` : "healthy"}
            </Badge>
          }
        >
          Managed alias mail
        </SectionTitle>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Received 24h" value={mail.received24h} />
          <Stat label="Received 7d" value={mail.received7d} />
          <Stat
            label="Failed 24h"
            value={mail.failed24h}
            tone={mail.failed24h > 0 ? "bad" : "neutral"}
          />
          <Stat
            label="Failed 7d"
            value={mail.failed7d}
            tone={mail.failed7d > 0 ? "warn" : "neutral"}
          />
        </div>

        {mail.recentFailures.length === 0 ? (
          <p className="mt-4 text-xs text-slate-600">
            Every message that reached an alias in the last 7 days was relayed to its owner. A
            failure here means the message is stored but the user never saw it, so one is worth
            reading the function logs over.
          </p>
        ) : (
          <>
            <p className="mt-4 mb-2 text-xs text-slate-500">
              Stored but never relayed, with the reason the provider gave. Only the sender domain is
              shown, never a subject or body.
            </p>
            <ul className="space-y-1.5">
              {mail.recentFailures.map((failure) => (
                <li key={failure.at} className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone="bad">failed</Badge>
                  <span className="font-mono text-xs text-slate-500">{failure.fromDomain}</span>
                  <span className="text-xs text-slate-400">{failure.reason}</span>
                  <span className="ml-auto text-xs text-slate-500">{timeAgo(failure.at, now)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <div className="space-y-4">
        {env.groups.map((group) => (
          <Card key={group.label}>
            <SectionTitle
              right={
                <Badge
                  tone={
                    group.state === "configured"
                      ? "good"
                      : group.state === "missing"
                        ? "bad"
                        : "warn"
                  }
                >
                  {group.state}
                </Badge>
              }
            >
              {group.label}
            </SectionTitle>
            <div className="space-y-2">
              {group.vars.map((spec) => (
                <div key={spec.key} className="flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate text-slate-300">{spec.label}</p>
                    <p className="truncate font-mono text-[10px] text-slate-600">{spec.key}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-xs text-slate-600">{spec.note}</span>
                    <Badge tone={spec.configured ? "good" : "bad"}>
                      {spec.configured ? "set" : "missing"}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        ))}
        <p className="text-xs text-slate-600">
          Values are never displayed, only whether each key is present. Secrets live in the
          repo-root .env, Vercel env, and per-worker wrangler secrets.
        </p>
      </div>

      <Card>
        <SectionTitle>Operator audit log</SectionTitle>
        {audit.length === 0 ? (
          <Empty>No admin actions recorded yet.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <th className="pb-2">Admin</th>
                <th className="pb-2">Action</th>
                <th className="pb-2">Target</th>
                <th className="pb-2 text-right">When</th>
              </tr>
            }
          >
            {audit.map((row) => (
              <tr key={row.id}>
                <td className="py-2 text-slate-300">{row.admin_email}</td>
                <td className="py-2">
                  <Badge tone="info">{auditActionLabel(row.action)}</Badge>
                </td>
                <td className="py-2 font-mono text-[10px] text-slate-500">
                  {row.target_user_id ?? row.target_run_id ?? "-"}
                </td>
                <td className="py-2 text-right text-slate-500">{timeAgo(row.created_at, now)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
