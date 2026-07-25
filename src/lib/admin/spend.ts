/**
 * AI spend analytics for /admin/ai. Pure: ledger rows in, numbers out.
 *
 * The ledger records what each call consumed; this file turns that into the two
 * questions that matter commercially: what does an application cost us, and is
 * any user costing more than they pay.
 */

import { isEstimatedPrice } from "@/lib/ai-cost";
import { PLAN_PRICE_CENTS, planOf, subscriptionsByUser, type AdminSubscriptionRow } from "@/lib/admin/overview";
import type { Plan } from "@/lib/plans";

export interface SpendEventRow {
  user_id: string | null;
  run_id: string | null;
  kind: string;
  model: string;
  used_fallback: boolean;
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  day: string;
  created_at: string;
}

export interface SpendTotals {
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  fallbackCalls: number;
  fallbackRatePct: number;
  /** True when any call was priced with a stand-in rate rather than a known one. */
  hasEstimatedPricing: boolean;
}

export function totalSpend(rows: SpendEventRow[]): SpendTotals {
  let costMicros = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let fallbackCalls = 0;
  let hasEstimatedPricing = false;

  for (const row of rows) {
    costMicros += row.cost_micros;
    inputTokens += row.input_tokens;
    outputTokens += row.output_tokens;
    if (row.used_fallback) fallbackCalls += 1;
    if (isEstimatedPrice(row.model)) hasEstimatedPricing = true;
  }

  return {
    costMicros,
    inputTokens,
    outputTokens,
    calls: rows.length,
    fallbackCalls,
    fallbackRatePct: rows.length > 0 ? Math.round((fallbackCalls / rows.length) * 100) : 0,
    hasEstimatedPricing
  };
}

export interface SpendGroup {
  key: string;
  calls: number;
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
}

function groupBy(rows: SpendEventRow[], keyOf: (row: SpendEventRow) => string): SpendGroup[] {
  const groups = new Map<string, SpendGroup>();
  for (const row of rows) {
    const key = keyOf(row);
    const group =
      groups.get(key) ?? { key, calls: 0, costMicros: 0, inputTokens: 0, outputTokens: 0 };
    group.calls += 1;
    group.costMicros += row.cost_micros;
    group.inputTokens += row.input_tokens;
    group.outputTokens += row.output_tokens;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.costMicros - a.costMicros);
}

export function spendByKind(rows: SpendEventRow[]): SpendGroup[] {
  return groupBy(rows, (row) => row.kind);
}

export function spendByModel(rows: SpendEventRow[]): SpendGroup[] {
  return groupBy(rows, (row) => row.model || "unknown");
}

/** Oldest day first, so a chart reads left to right. Empty days are included. */
export function spendByDay(rows: SpendEventRow[], days: number, now: Date = new Date()): SpendGroup[] {
  const byDay = new Map(groupBy(rows, (row) => row.day).map((group) => [group.key, group]));
  const series: SpendGroup[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    const date = new Date(now.getTime() - back * 24 * 60 * 60 * 1000);
    const key = date.toISOString().slice(0, 10);
    series.push(
      byDay.get(key) ?? { key, calls: 0, costMicros: 0, inputTokens: 0, outputTokens: 0 }
    );
  }
  return series;
}

export interface UserSpendRow {
  userId: string;
  email: string;
  plan: Plan;
  costMicros: number;
  calls: number;
  /** What they pay us per month, in micros, for a like-for-like comparison. */
  revenueMicros: number;
  marginMicros: number;
  underwater: boolean;
}

/**
 * Cost against revenue per user. A free user is underwater the moment they cost
 * anything, which is expected and is the point of the free tier being small; a
 * PAYING user underwater is the number that should worry us.
 */
export function spendByUser(params: {
  rows: SpendEventRow[];
  emailById: Map<string, string>;
  subscriptions: AdminSubscriptionRow[];
}): UserSpendRow[] {
  const subs = subscriptionsByUser(params.subscriptions);
  const byUser = new Map<string, { costMicros: number; calls: number }>();

  for (const row of params.rows) {
    if (!row.user_id) continue;
    const entry = byUser.get(row.user_id) ?? { costMicros: 0, calls: 0 };
    entry.costMicros += row.cost_micros;
    entry.calls += 1;
    byUser.set(row.user_id, entry);
  }

  return [...byUser.entries()]
    .map(([userId, entry]) => {
      const plan = planOf(subs.get(userId) ?? null);
      // Cents to micros: both are money, and the ledger speaks micros.
      const revenueMicros = PLAN_PRICE_CENTS[plan] * 10_000;
      return {
        userId,
        email: params.emailById.get(userId) ?? "",
        plan,
        costMicros: entry.costMicros,
        calls: entry.calls,
        revenueMicros,
        marginMicros: revenueMicros - entry.costMicros,
        underwater: revenueMicros - entry.costMicros < 0
      };
    })
    .sort((a, b) => b.costMicros - a.costMicros);
}

export interface UnitEconomics {
  /** Every dollar of model spend in the window. */
  totalCostMicros: number;
  submittedRuns: number;
  /** Model cost per application that actually landed. */
  costPerSubmittedMicros: number | null;
  activeUsers: number;
  costPerActiveUserMicros: number | null;
}

/**
 * The number that decides whether the pricing works: what one successful
 * application costs in model spend. Null rather than zero when nothing has been
 * submitted, because dividing by no successes is not a cheap application.
 */
export function unitEconomics(params: {
  rows: SpendEventRow[];
  submittedRuns: number;
}): UnitEconomics {
  const totalCostMicros = params.rows.reduce((sum, row) => sum + row.cost_micros, 0);
  const users = new Set(params.rows.filter((row) => row.user_id).map((row) => row.user_id));
  return {
    totalCostMicros,
    submittedRuns: params.submittedRuns,
    costPerSubmittedMicros:
      params.submittedRuns > 0 ? Math.round(totalCostMicros / params.submittedRuns) : null,
    activeUsers: users.size,
    costPerActiveUserMicros:
      users.size > 0 ? Math.round(totalCostMicros / users.size) : null
  };
}
