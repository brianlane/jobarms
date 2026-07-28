/**
 * Gemini REST calls (plain fetch - no SDK in the worker bundle).
 * Generates application answers from the user's profile + the extracted form.
 */
import { recordAiSpend } from "./db";
import type { Answer, Env, FormField, RunParams } from "./types";

// gemini-3.6-flash: same input price as 3.5-flash, cheaper output, better
// reasoning and computer-use scores (relevant: it answers real application
// forms). Override with the GEMINI_TEXT_MODEL worker secret.
const DEFAULT_MODEL = "gemini-3.6-flash";

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** Who to bill a model call to. Required, so a new AI surface in the worker
 *  cannot land without declaring its cost. The ids are optional: a vision
 *  recovery diagnosis is platform cost rather than one person's. */
interface Bill {
  kind: string;
  userId?: string | null;
  runId?: string | null;
}

type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

async function generateJsonFromParts(env: Env, parts: Part[], bill: Bill): Promise<unknown> {
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
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
      })
    }
  );
  if (!res.ok) {
    throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = (await res.json()) as GeminiResponse;
  await recordAiSpend(env, {
    ...bill,
    model,
    inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0
  });
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const unfenced = text.trim().startsWith("```")
    ? text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")
    : text.trim();
  return JSON.parse(unfenced);
}

async function generateJson(env: Env, prompt: string, bill: Bill): Promise<unknown> {
  return generateJsonFromParts(env, [{ text: prompt }], bill);
}

export interface PageDiagnosis {
  form_visible: boolean;
  action: "click" | "iframe" | "scroll" | "none";
  click_text?: string;
  reason: string;
}

/**
 * The arm's EYES: show Gemini a screenshot of the page and ask what stands
 * between us and the real application form. Used when extraction produced
 * something that fails the application-form sanity check.
 */
export async function diagnosePage(
  env: Env,
  screenshotPng: Uint8Array,
  pageUrl: string,
  problem: string
): Promise<PageDiagnosis> {
  const raw = (await generateJsonFromParts(env, [
    {
      inlineData: {
        mimeType: "image/png",
        // btoa on binary strings chokes on large buffers; chunk it.
        data: base64FromBytes(screenshotPng)
      }
    },
    {
      text: `This is a screenshot of ${pageUrl}. We are trying to reach the JOB APPLICATION FORM (name/email/resume upload fields) to apply for a job, but our extraction found: ${problem}.

Look at the screenshot and answer as JSON:
{"form_visible": <true if a real application form with candidate fields is visible>, "action": <one of "click" (a control must be clicked first: an Apply/Apply Now button, OR the accept/agree/dismiss button of a cookie, privacy, or consent banner or modal that is covering or obscuring the page), "iframe" (the form appears embedded from another provider), "scroll" (the form is likely further down the page), "none" (no path to an application form is visible)>, "click_text": <exact visible text of the button/link to click, only when action is "click">, "reason": <one short sentence>}

If a cookie/privacy/consent banner or modal is blocking or dominating the page, prefer "click" with the exact text of its accept or agree button (for example "Accept", "Accept all", "I agree") so it can be dismissed. Never pick "none" solely because such a banner is present.

Return ONLY the JSON object.`
    }
  ], { kind: "vision_recovery" })) as Partial<PageDiagnosis>;

  const action = ["click", "iframe", "scroll", "none"].includes(raw.action ?? "")
    ? (raw.action as PageDiagnosis["action"])
    : "none";
  return {
    form_visible: Boolean(raw.form_visible),
    action,
    click_text: typeof raw.click_text === "string" ? raw.click_text.slice(0, 80) : undefined,
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 200) : ""
  };
}

/**
 * Parse the model's tile response into validated, in-range, unique indices.
 * Pure: the model returns {"tiles": [0,3,5]} for a gridCount-cell challenge;
 * anything out of range or non-numeric is dropped rather than clicked.
 */
export function parseTileResponse(raw: unknown, gridCount: number): number[] {
  const arr =
    raw && typeof raw === "object" && Array.isArray((raw as { tiles?: unknown }).tiles)
      ? (raw as { tiles: unknown[] }).tiles
      : Array.isArray(raw)
        ? (raw as unknown[])
        : [];
  const seen = new Set<number>();
  for (const v of arr) {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (Number.isInteger(n) && n >= 0 && n < gridCount) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Vision solve for an image-grid captcha (reCAPTCHA v2 / hCaptcha).
 *
 * Called BY THE SIDECAR over HTTP, because solving needs both a live page and a
 * vision model and those deliberately live in different places: the sidecar has
 * the page, this worker has the model and its credentials. Given a screenshot of
 * the grid, the instruction ("select all squares with crosswalks"), and the grid
 * size, return which cells match. Cells are numbered left to right, top to
 * bottom from 0.
 */
export async function solveImageGrid(
  env: Env,
  screenshotPng: Uint8Array,
  instruction: string,
  rows: number,
  cols: number,
  attribution: { userId?: string | null; runId?: string | null } = {}
): Promise<number[]> {
  const gridCount = rows * cols;
  const raw = await generateJsonFromParts(
    env,
    [
      { inlineData: { mimeType: "image/png", data: base64FromBytes(screenshotPng) } },
      {
        text: `This image is a ${rows}x${cols} captcha grid. The instruction is: "${instruction}". Cells are numbered 0 to ${gridCount - 1}, left to right, top to bottom (row 0 is cells 0..${cols - 1}). Return JSON {"tiles": [<indices of every cell that clearly matches the instruction>]}. If a cell only partially contains the object, include it. Return ONLY the JSON.`
      }
    ],
    { kind: "captcha_vision", userId: attribution.userId, runId: attribution.runId }
  );
  return parseTileResponse(raw, gridCount);
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function generateAnswers(
  env: Env,
  params: RunParams,
  fields: FormField[]
): Promise<Answer[]> {
  const memoryAnswers = params.memory?.answers ?? [];
  const lessons = params.memory?.lessons ?? [];

  const memorySection =
    memoryAnswers.length > 0
      ? `\nTHIS CANDIDATE'S PREVIOUSLY APPROVED ANSWERS (their own words from past applications; entries marked user_edited are corrections they made by hand and carry the MOST weight. Reuse these when the same question appears, adapting only if this job's context differs):\n${JSON.stringify(memoryAnswers)}\n`
      : "";
  const lessonsSection =
    lessons.length > 0
      ? `\nPLATFORM GUIDANCE (anonymous aggregates across all applications, no personal data):\n- ${lessons.join("\n- ")}\n`
      : "";

  const prompt = `You are filling out a job application on behalf of a candidate. Answer every field truthfully from their profile. NEVER invent employers, degrees, or credentials.

CANDIDATE PROFILE (JSON):
${JSON.stringify(params.profile)}
${memorySection}${lessonsSection}
JOB: ${params.jobTitle} at ${params.jobCompany}
JOB DESCRIPTION (for tailoring open-ended answers):
${params.jobDescription.slice(0, 6000)}

FORM FIELDS (JSON array of {name, label, type, required, options}):
${JSON.stringify(fields)}

Rules:
- Return a JSON array: [{"name": "<field name>", "label": "<label>", "value": "<answer>", "skipped": false}, ...] covering EVERY field.
- For select/radio/checkbox fields WITH a non-empty options array, the value MUST be copied EXACTLY from that options array (verbatim, including punctuation).
- Checkbox fields with options are "select all that apply" groups: pick the option(s) that truthfully apply and join multiple with "; ". Always choose the explicit "None of the above" / "None of these apply" option when nothing else applies rather than skipping (these are required compliance questions).
- For a select field with an EMPTY options array (a dynamic dropdown whose choices are not listed), infer the correct short value from the label: yes/no questions get "Yes" or "No"; a country dropdown gets the full country name; etc.
- For a lone checkbox consent/acknowledgement field (no options) use "true".
- For file fields return value "" and skipped true (files are attached separately).
- Voluntary self-identification (EEO) fields: use the profile's eeo values if present; otherwise choose the "decline to answer" style option when available, else skip.
- Open-ended questions ("Why do you want to work here?", cover letter): 2-5 sentences, first person, grounded ONLY in real profile facts, tailored to the job description.
- If a field truly cannot be answered from the profile (e.g. asks for information the profile lacks), set skipped true and value "".
- Never use the em dash character anywhere in any answer; use a comma, colon, or hyphen instead.
Return ONLY the JSON array.`;

  const raw = await generateJson(env, prompt, {
    kind: "arm_answers",
    userId: params.userId,
    runId: params.runId
  });
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
