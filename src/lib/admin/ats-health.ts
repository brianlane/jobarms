/**
 * Per-ATS arm health, the self-healing playbooks, and what the platform has
 * actually learned. Pure: rows in, numbers out.
 *
 * The field-stat side deliberately reuses `lessonsFromStats`
 * (src/lib/answer-memory.ts), the same function the dispatch path calls, so the
 * admin page shows exactly the guidance the arm is being given rather than a
 * second implementation of the thresholds that could drift from it.
 */

import { classifyRunError, isTerminalRun, type RunErrorCode } from "@/lib/admin/run-stats";

export interface AtsRunRow {
  status: string;
  error: string | null;
  autonomy: string;
  ats: string;
}

export interface AtsHealthRow {
  ats: string;
  runs: number;
  submitted: number;
  failed: number;
  canceled: number;
  finished: number;
  /** Submitted over finished. Null when nothing has finished yet. */
  successRatePct: number | null;
  /** The failure bucket that hurts this ATS most, if any. */
  topFailure: RunErrorCode | null;
  topFailureCount: number;
}

export function summarizeAtsHealth(runs: AtsRunRow[]): AtsHealthRow[] {
  const byAts = new Map<
    string,
    { runs: number; submitted: number; failed: number; canceled: number; finished: number; errors: Map<RunErrorCode, number> }
  >();

  for (const run of runs) {
    const ats = run.ats || "unknown";
    const entry =
      byAts.get(ats) ??
      { runs: 0, submitted: 0, failed: 0, canceled: 0, finished: 0, errors: new Map() };
    entry.runs += 1;
    if (run.status === "submitted") entry.submitted += 1;
    if (run.status === "failed") entry.failed += 1;
    if (run.status === "canceled") entry.canceled += 1;
    if (isTerminalRun(run.status)) entry.finished += 1;
    const code = classifyRunError(run.error);
    if (code !== "none") entry.errors.set(code, (entry.errors.get(code) ?? 0) + 1);
    byAts.set(ats, entry);
  }

  return [...byAts.entries()]
    .map(([ats, entry]) => {
      const ranked = [...entry.errors.entries()].sort((a, b) => b[1] - a[1]);
      return {
        ats,
        runs: entry.runs,
        submitted: entry.submitted,
        failed: entry.failed,
        canceled: entry.canceled,
        finished: entry.finished,
        successRatePct:
          entry.finished > 0 ? Math.round((entry.submitted / entry.finished) * 100) : null,
        topFailure: ranked[0]?.[0] ?? null,
        topFailureCount: ranked[0]?.[1] ?? 0
      };
    })
    .sort((a, b) => b.runs - a.runs);
}

// ─── playbooks ──────────────────────────────────────────────────────────────

export interface PlaybookRow {
  domain: string;
  ats: string;
  strategy: Record<string, unknown> | null;
  success_count: number;
  failure_count: number;
  last_success_at: string;
  updated_at: string;
}

export interface PlaybookView extends PlaybookRow {
  /** Share of applications of this strategy that worked. */
  successRatePct: number;
  /**
   * The stored fix now fails more often than it works, so it is costing runs an
   * extra recovery attempt instead of saving them one. These are the rows worth
   * deleting so the arm rediscovers a working strategy.
   */
  decaying: boolean;
  /** Human summary of the strategy blob. */
  summary: string;
}

export function describeStrategy(strategy: Record<string, unknown> | null): string {
  if (!strategy) return "unknown strategy";
  const action = typeof strategy.action === "string" ? strategy.action : "unknown";
  const clickText = typeof strategy.click_text === "string" ? strategy.click_text : null;
  if (action === "click") return `click "${clickText ?? "an apply control"}"`;
  if (action === "iframe") return "hop into the embedded form iframe";
  if (action === "scroll") return "scroll the lazy-loaded form into view";
  return action;
}

export function viewPlaybooks(rows: PlaybookRow[]): PlaybookView[] {
  return rows
    .map((row) => {
      const attempts = row.success_count + row.failure_count;
      return {
        ...row,
        successRatePct: attempts > 0 ? Math.round((row.success_count / attempts) * 100) : 0,
        decaying: row.failure_count > row.success_count,
        summary: describeStrategy(row.strategy)
      };
    })
    .sort((a, b) => {
      if (a.decaying !== b.decaying) return a.decaying ? -1 : 1;
      return b.success_count - a.success_count;
    });
}

// ─── field stats ────────────────────────────────────────────────────────────

export interface FieldStatRow {
  ats: string;
  question_key: string;
  label_example: string;
  field_type: string;
  times_seen: number;
  times_skipped: number;
  times_edited: number;
  option_counts: Record<string, number>;
  updated_at: string;
}

export interface FieldStatView extends FieldStatRow {
  skipRatePct: number;
  editRatePct: number;
  /** The most-approved option and its share, for select and radio questions. */
  topOption: { value: string; sharePct: number } | null;
  /** True when this row currently clears the bar to become prompt guidance. */
  guiding: boolean;
}

export function viewFieldStats(
  rows: FieldStatRow[],
  guidingKeys: Set<string>
): FieldStatView[] {
  return rows
    .map((row) => {
      const choices = Object.entries(row.option_counts ?? {});
      const totalChoices = choices.reduce((sum, [, count]) => sum + count, 0);
      const top = choices.sort((a, b) => b[1] - a[1])[0] ?? null;
      return {
        ...row,
        skipRatePct: row.times_seen > 0 ? Math.round((row.times_skipped / row.times_seen) * 100) : 0,
        editRatePct: row.times_seen > 0 ? Math.round((row.times_edited / row.times_seen) * 100) : 0,
        topOption:
          top && totalChoices > 0
            ? { value: top[0], sharePct: Math.round((top[1] / totalChoices) * 100) }
            : null,
        guiding: guidingKeys.has(row.question_key)
      };
    })
    .sort((a, b) => b.times_seen - a.times_seen);
}
