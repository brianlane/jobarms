import { z } from "zod";
import { generateWithRetry, extractJson } from "@/lib/gemini";

/**
 * Structured resume shape - mirrors the profiles table columns it fills.
 * Every field uses .catch() defaults: a model quirk (null instead of "",
 * a stray type) can NEVER fail a real resume. Parsing only fails when the
 * model call itself fails after retries, or the output is not JSON at all.
 */
const str = z.string().catch("");
const strArr = z.array(z.string().catch("")).catch([]);

export const parsedResumeSchema = z.object({
  full_name: str,
  email: str,
  phone: str,
  location: str,
  headline: str,
  summary: str,
  links: z.record(z.string(), z.string().catch("")).catch({}),
  work_history: z
    .array(
      z
        .object({
          company: str,
          title: str,
          start: str,
          end: str,
          bullets: strArr
        })
        .catch({ company: "", title: "", start: "", end: "", bullets: [] })
    )
    .catch([]),
  education: z
    .array(
      z
        .object({
          school: str,
          degree: str,
          field: str,
          start: str,
          end: str
        })
        .catch({ school: "", degree: "", field: "", start: "", end: "" })
    )
    .catch([]),
  skills: strArr
});

export type ParsedResume = z.infer<typeof parsedResumeSchema>;

const PARSE_PROMPT = `You are a resume parser. Extract the resume in this file into JSON with exactly these keys:
full_name, email, phone, location, headline (their professional title), summary,
links (object mapping label like "linkedin"/"github"/"portfolio" to URL),
work_history (array of {company, title, start, end, bullets[]}; dates as "MMM YYYY" or "" if absent; current roles end="Present"),
education (array of {school, degree, field, start, end}),
skills (array of short skill strings).
Use "" or [] for anything absent (never null). If the document is clearly NOT a resume or CV (e.g. an invoice, essay, or random document), return {"not_a_resume": true} instead.
Never use the em dash character anywhere in your output; use a comma, colon, or hyphen instead. Return ONLY the JSON object.`;

export class NotAResumeError extends Error {
  constructor() {
    super("not_a_resume");
  }
}

/**
 * Parse a resume file (PDF or DOCX bytes) into a structured profile via
 * Gemini, with capacity retries + model fallback. Throws NotAResumeError
 * only when the model says the document is blatantly not a resume;
 * throws the underlying error when the model call fails outright.
 */
export async function parseResume(
  fileBytes: Uint8Array,
  mimeType: string
): Promise<ParsedResume> {
  const text = await generateWithRetry({
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType, data: Buffer.from(fileBytes).toString("base64") } },
          { text: PARSE_PROMPT }
        ]
      }
    ],
    config: { responseMimeType: "application/json", temperature: 0 }
  });

  const raw = extractJson<Record<string, unknown>>(text);
  if (raw && typeof raw === "object" && raw.not_a_resume === true) {
    throw new NotAResumeError();
  }
  return parsedResumeSchema.parse(raw);
}
