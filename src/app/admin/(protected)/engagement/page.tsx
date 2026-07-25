import {
  loadApplications,
  loadAuthDirectory,
  loadProfiles,
  loadResumeOwners,
  loadSubmittedOwners
} from "@/lib/admin/reads";
import {
  activeUserCounts,
  cohortRetention,
  onboardingFunnel
} from "@/lib/admin/engagement";
import { classifyEngagement, type EngagementSegment } from "@/lib/admin/users-table";
import { summarizeUsers } from "@/lib/admin/overview";
import {
  Badge,
  BarChart,
  Card,
  Empty,
  MeterRow,
  PageHeading,
  SectionTitle,
  Stat,
  Table,
  type BadgeTone
} from "@/components/admin/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin engagement", robots: { index: false, follow: false } };

const SEGMENT_TONE: Record<EngagementSegment, BadgeTone> = {
  active: "good",
  new: "info",
  cooling: "warn",
  quiet: "bad"
};

const SEGMENTS: EngagementSegment[] = ["active", "new", "cooling", "quiet"];

export default async function AdminEngagementPage() {
  const now = new Date();
  const [profiles, directory, applications, resumeOwners, submittedOwners] = await Promise.all([
    loadProfiles(),
    loadAuthDirectory(),
    loadApplications(),
    loadResumeOwners(),
    loadSubmittedOwners()
  ]);

  const users = summarizeUsers(profiles, now);
  const active = activeUserCounts(directory.byId, now);
  const funnel = onboardingFunnel({
    profiles,
    resumeUserIds: resumeOwners,
    applicationUserIds: new Set(applications.map((app) => app.user_id)),
    submittedUserIds: submittedOwners
  });
  const cohorts = cohortRetention(profiles, directory.byId, 8, now);

  const segmentCounts = new Map<EngagementSegment, number>();
  for (const profile of profiles) {
    const segment = classifyEngagement(
      {
        createdAt: profile.created_at,
        lastSignInAt: directory.byId.get(profile.id)?.lastSignInAt ?? null
      },
      now
    );
    segmentCounts.set(segment, (segmentCounts.get(segment) ?? 0) + 1);
  }

  return (
    <div className="space-y-6">
      <PageHeading
        title="Engagement"
        subtitle="Who is actually using the product, and where new accounts stop."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Active today" value={active.daily} hint="signed in within 24h" />
        <Stat label="Active this week" value={active.weekly} />
        <Stat
          label="Active this month"
          value={active.monthly}
          hint={`${active.stickinessPct}% of them came back today`}
        />
        <Stat
          label="Never signed in"
          value={active.neverSignedIn}
          tone={active.neverSignedIn > 0 ? "warn" : "good"}
          hint="account created, never used"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionTitle>Activation funnel</SectionTitle>
          <div className="space-y-3">
            {funnel.map((step) => (
              <div key={step.label}>
                <MeterRow
                  label={step.label}
                  count={step.users}
                  total={users.total}
                  tone={step.label === "Landed an application" ? "good" : "info"}
                />
                {step.lost > 0 && (
                  <p className="pt-0.5 text-[10px] text-slate-600">
                    {step.lost} did not get this far
                  </p>
                )}
              </div>
            ))}
          </div>
          <p className="mt-4 border-t border-ink-800 pt-4 text-xs text-slate-600">
            Each step counts a subset of all signups, not of the step before it, so a user who
            skipped one cannot make a later step read above 100%.
          </p>
        </Card>

        <Card>
          <SectionTitle>Segments</SectionTitle>
          <div className="space-y-2">
            {SEGMENTS.map((segment) => (
              <div key={segment} className="flex items-center justify-between text-xs">
                <Badge tone={SEGMENT_TONE[segment]}>{segment}</Badge>
                <span className="font-medium text-slate-400">
                  {segmentCounts.get(segment) ?? 0}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-4 border-t border-ink-800 pt-4 text-xs text-slate-600">
            Quiet is ambiguous here in a way it is not for most products: the best outcome (they got
            hired) and the worst (they bounced) both look like an account that stopped signing in.
          </p>
        </Card>
      </div>

      <Card>
        <SectionTitle>New signups, last 6 months</SectionTitle>
        <BarChart points={users.signupsByMonth} />
      </Card>

      <Card>
        <SectionTitle>Weekly cohorts</SectionTitle>
        {cohorts.length === 0 ? (
          <Empty>No signups in the last eight weeks.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <th className="pb-2">Week of</th>
                <th className="pb-2 text-right">Signups</th>
                <th className="pb-2 text-right">Still active</th>
                <th className="pb-2 text-right">Retained</th>
              </tr>
            }
          >
            {cohorts.map((cohort) => (
              <tr key={cohort.weekStart}>
                <td className="py-2 text-slate-300">{cohort.weekStart}</td>
                <td className="py-2 text-right text-slate-300">{cohort.signups}</td>
                <td className="py-2 text-right text-slate-400">{cohort.stillActive}</td>
                <td className="py-2 text-right">
                  <span
                    className={cohort.retentionPct >= 50 ? "text-teal-300" : "text-amber-300"}
                  >
                    {cohort.retentionPct}%
                  </span>
                </td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-slate-600">
          Retained means the account has signed in within the last 30 days, not that it survived a
          per-cohort anniversary. At this size an anniversary measure is mostly sampling noise.
        </p>
        {directory.clipped && (
          <p className="mt-2 text-xs text-amber-300">
            The auth directory scan was truncated, so sign-in figures on this page undercount.
          </p>
        )}
      </Card>
    </div>
  );
}
