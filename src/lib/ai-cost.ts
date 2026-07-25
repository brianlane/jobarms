/**
 * What a model call cost. Pure pricing plus the ledger write.
 *
 * Costs are integer MICROS (millionths of a dollar) end to end: token counts are
 * large and prices are small, and money in floats drifts.
 */

import { generateWithUsage, GEMINI_FALLBACK_MODEL, GEMINI_TEXT_MODEL } from "@/lib/gemini";

/**
 * Dollars per million tokens, the unit the model vendor quotes.
 *
 * Only the primary model's numbers are known first-hand (documented against
 * gemini-3.6-flash in src/lib/gemini.ts). Anything else, including the capacity
 * fallback, is priced at the primary rate: it OVERESTIMATES rather than
 * flatters, which is the safe direction for a cost view, and the /admin/ai page
 * says so rather than presenting an estimate as a measurement.
 */
export interface ModelPrice {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export const PRIMARY_MODEL_PRICE: ModelPrice = {
  inputPerMillionUsd: 1.5,
  outputPerMillionUsd: 7.5
};

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "gemini-3.6-flash": PRIMARY_MODEL_PRICE,
  "gemini-3.5-flash": { inputPerMillionUsd: 1.5, outputPerMillionUsd: 9 }
};

export function priceFor(model: string): { price: ModelPrice; exact: boolean } {
  const known = MODEL_PRICES[model];
  if (known) return { price: known, exact: true };
  return { price: PRIMARY_MODEL_PRICE, exact: false };
}

/** True when this model's price is a stand-in rather than a known rate. */
export function isEstimatedPrice(model: string): boolean {
  return !priceFor(model).exact;
}

/**
 * Cost in micros. Dollars per million tokens happens to equal micros per token,
 * so the arithmetic is just tokens times the quoted rate.
 */
export function costMicros(model: string, inputTokens: number, outputTokens: number): number {
  const { price } = priceFor(model);
  return Math.round(
    Math.max(inputTokens, 0) * price.inputPerMillionUsd +
      Math.max(outputTokens, 0) * price.outputPerMillionUsd
  );
}

export function microsToUsd(micros: number): number {
  return micros / 1_000_000;
}

/** Money for display: cents under a dollar, then dollars. */
export function formatMicros(micros: number): string {
  const usd = microsToUsd(micros);
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

/** The AI surfaces we meter cost for. Wider than the quota kinds. */
export const AI_SPEND_KINDS = [
  "resume_parse",
  "tailor_resume",
  "cover_letter",
  "arm_answers",
  "vision_recovery",
  "captcha_vision"
] as const;

export type AiSpendKind = (typeof AI_SPEND_KINDS)[number];

/** Which model the app will try first, and which one it falls back to. */
export const CONFIGURED_MODELS = {
  primary: GEMINI_TEXT_MODEL,
  fallback: GEMINI_FALLBACK_MODEL
};

export interface AiSpendUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  usedFallback: boolean;
}

export interface AiSpendRecord extends AiSpendUsage {
  kind: AiSpendKind | string;
  userId?: string | null;
  runId?: string | null;
}

/**
 * Just enough of a Supabase client to write the ledger. PromiseLike rather than
 * Promise because PostgREST builders are thenables, not promises.
 */
export type SpendClient = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ error?: unknown }>;
};

/**
 * Who to bill a call to. Optional at every call site: the AI helpers stay usable
 * from scripts and tests without a database, and an unmetered call simply does
 * not appear in the ledger.
 */
export interface SpendMeter {
  client: SpendClient;
  userId?: string | null;
  runId?: string | null;
}

/**
 * Append one ledger row. Best effort by design: a model call that already
 * succeeded and produced a result for the user must never fail because the
 * bookkeeping did.
 */
export async function recordAiSpend(client: SpendClient, record: AiSpendRecord): Promise<void> {
  try {
    const { error } = await client.rpc("record_ai_spend", {
      p_user_id: record.userId ?? null,
      p_run_id: record.runId ?? null,
      p_kind: record.kind,
      p_model: record.model,
      p_used_fallback: record.usedFallback,
      p_input_tokens: record.inputTokens,
      p_output_tokens: record.outputTokens,
      p_cost_micros: costMicros(record.model, record.inputTokens, record.outputTokens)
    });
    if (error) throw error;
  } catch (err) {
    console.error("ai spend ledger write failed", record.kind, err instanceof Error ? err.message : err);
  }
}

/**
 * Generate text and bill it. The single seam every app-side model call goes
 * through, so a new AI surface cannot land without its cost showing up.
 */
export async function generateMetered(
  kind: AiSpendKind,
  args: Parameters<typeof generateWithUsage>[0],
  meter?: SpendMeter
): Promise<string> {
  const { text, usage } = await generateWithUsage(args);
  if (meter) {
    await recordAiSpend(meter.client, {
      ...usage,
      kind,
      userId: meter.userId ?? null,
      runId: meter.runId ?? null
    });
  }
  return text;
}
