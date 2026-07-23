/** Tracker status display metadata (pure — unit-tested). */

export const APPLICATION_STATUSES = [
  "saved",
  "applying",
  "needs_review",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
  "failed"
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const STATUS_LABELS: Record<ApplicationStatus, string> = {
  saved: "Saved",
  applying: "Arm working",
  needs_review: "Needs your review",
  applied: "Applied",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  failed: "Arm failed"
};

export const STATUS_STYLES: Record<ApplicationStatus, string> = {
  saved: "bg-slate-100 text-slate-700",
  applying: "bg-blue-100 text-blue-700",
  needs_review: "bg-amber-100 text-amber-800",
  applied: "bg-teal-100 text-teal-800",
  interviewing: "bg-indigo-100 text-indigo-700",
  offer: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-700",
  withdrawn: "bg-slate-100 text-slate-500",
  failed: "bg-red-100 text-red-700"
};

/** Statuses a user may set manually from the tracker UI. */
export const MANUAL_STATUSES: ApplicationStatus[] = [
  "saved",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn"
];

export function isApplicationStatus(value: string): value is ApplicationStatus {
  return (APPLICATION_STATUSES as readonly string[]).includes(value);
}
