/**
 * Gemini REST calls (plain fetch - no SDK in the worker bundle).
 * Generates application answers from the user's profile + the extracted form.
 */
import type { Answer, Env, FormField, RunParams } from "./types";

const DEFAULT_MODEL = "gemini-3.5-flash";

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

async function generateJson(env: Env, prompt: string): Promise<unknown> {
  const model = env.GEMINI_TEXT_MODEL || DEFAULT_MODEL;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY ?? ""
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
      })
    }
  );
  if (!res.ok) {
    throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = (await res.json()) as GeminiResponse;
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const unfenced = text.trim().startsWith("```")
    ? text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")
    : text.trim();
  return JSON.parse(unfenced);
}

export async function generateAnswers(
  env: Env,
  params: RunParams,
  fields: FormField[]
): Promise<Answer[]> {
  const prompt = `You are filling out a job application on behalf of a candidate. Answer every field truthfully from their profile. NEVER invent employers, degrees, or credentials.

CANDIDATE PROFILE (JSON):
${JSON.stringify(params.profile)}

JOB: ${params.jobTitle} at ${params.jobCompany}
JOB DESCRIPTION (for tailoring open-ended answers):
${params.jobDescription.slice(0, 6000)}

FORM FIELDS (JSON array of {name, label, type, required, options}):
${JSON.stringify(fields)}

Rules:
- Return a JSON array: [{"name": "<field name>", "label": "<label>", "value": "<answer>", "skipped": false}, ...] covering EVERY field.
- For select/radio/checkbox fields the value MUST be copied EXACTLY from the field's options array.
- For checkbox consent/acknowledgement fields use "true".
- For file fields return value "" and skipped true (files are attached separately).
- Voluntary self-identification (EEO) fields: use the profile's eeo values if present; otherwise choose the "decline to answer" style option when available, else skip.
- Open-ended questions ("Why do you want to work here?", cover letter): 2-5 sentences, first person, grounded ONLY in real profile facts, tailored to the job description.
- If a field truly cannot be answered from the profile (e.g. asks for information the profile lacks), set skipped true and value "".
- Never use the em dash character anywhere in any answer; use a comma, colon, or hyphen instead.
Return ONLY the JSON array.`;

  const raw = await generateJson(env, prompt);
  if (!Array.isArray(raw)) throw new Error("gemini answers: not an array");

  const byName = new Map(fields.map((f) => [f.name, f]));
  return raw
    .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object")
    .filter((a) => typeof a.name === "string" && byName.has(a.name as string))
    .map((a) => ({
      name: a.name as string,
      label: typeof a.label === "string" ? a.label : (byName.get(a.name as string)?.label ?? ""),
      value: typeof a.value === "string" ? a.value : String(a.value ?? ""),
      skipped: Boolean(a.skipped)
    }));
}
