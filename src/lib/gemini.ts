import { GoogleGenAI } from "@google/genai";
import { requireEnv } from "@/lib/env";

/** Default model for structured extraction / generation tasks. */
export const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-3.5-flash";

let cached: GoogleGenAI | null = null;

export function geminiClient(): GoogleGenAI {
  if (!cached) {
    cached = new GoogleGenAI({ apiKey: requireEnv("GEMINI_API_KEY") });
  }
  return cached;
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
