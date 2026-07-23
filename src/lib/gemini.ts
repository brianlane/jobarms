import { GoogleGenAI } from "@google/genai";
import { requireEnv } from "@/lib/env";

/** Default model for structured extraction / generation tasks. */
export const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-3.5-flash";

/** Capacity fallback when the primary model returns 503/429 (seen live:
 *  "This model is currently experiencing high demand"). */
export const GEMINI_FALLBACK_MODEL =
  process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite";

let cached: GoogleGenAI | null = null;

export function geminiClient(): GoogleGenAI {
  if (!cached) {
    cached = new GoogleGenAI({ apiKey: requireEnv("GEMINI_API_KEY") });
  }
  return cached;
}

interface GenerateArgs {
  contents: Parameters<GoogleGenAI["models"]["generateContent"]>[0]["contents"];
  config?: Record<string, unknown>;
}

function isTransient(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429 || status === 500 || status === 503) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /UNAVAILABLE|high demand|overloaded|RESOURCE_EXHAUSTED/i.test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * generateContent with capacity resilience: primary model with two backoff
 * retries on transient errors (429/500/503), then the fallback model with
 * the same policy. Non-transient errors (bad request, auth) throw
 * immediately.
 */
export async function generateWithRetry(args: GenerateArgs): Promise<string> {
  const ai = geminiClient();
  const models = [GEMINI_TEXT_MODEL, GEMINI_FALLBACK_MODEL];
  const delays = [0, 1500, 4000];
  let lastError: unknown = null;

  for (const model of models) {
    for (const delay of delays) {
      if (delay > 0) await sleep(delay);
      try {
        const response = await ai.models.generateContent({
          model,
          contents: args.contents,
          config: args.config
        });
        return response.text ?? "";
      } catch (err) {
        lastError = err;
        if (!isTransient(err)) throw err;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Generate a JSON response and parse it. Strips markdown fences the model
 * sometimes wraps around JSON despite responseMimeType.
 */
export function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")
    : trimmed;
  return JSON.parse(unfenced) as T;
}
