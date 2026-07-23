import { z } from "zod";
import { geminiClient, GEMINI_TEXT_MODEL, extractJson } from "@/lib/gemini";

/** Structured resume shape - mirrors the profiles table columns it fills. */
export const parsedResumeSchema = z.object({
  full_name: z.string().default(""),
  email: z.string().default(""),
  phone: z.string().default(""),
  location: z.string().default(""),
  headline: z.string().default(""),
  summary: z.string().default(""),
  links: z.record(z.string(), z.string()).default({}),
  work_history: z
    .array(
      z.object({
        company: z.string().default(""),
        title: z.string().default(""),
        start: z.string().default(""),
        end: z.string().default(""),
        bullets: z.array(z.string()).default([])
      })
    )
    .default([]),
  education: z
    .array(
      z.object({
        school: z.string().default(""),
        degree: z.string().default(""),
        field: z.string().default(""),
        start: z.string().default(""),
        end: z.string().default("")
      })
    )
    .default([]),
  skills: z.array(z.string()).default([])
});

export type ParsedResume = z.infer<typeof parsedResumeSchema>;

const PARSE_PROMPT = `You are a resume parser. Extract the resume in this file into JSON with exactly these keys:
full_name, email, phone, location, headline (their professional title), summary,
links (object mapping label like "linkedin"/"github"/"portfolio" to URL),
work_history (array of {company, title, start, end, bullets[]}; dates as "MMM YYYY" or "" if absent; current roles end="Present"),
education (array of {school, degree, field, start, end}),
skills (array of short skill strings).
Use "" or [] for anything absent. Never use the em dash character anywhere in your output; use a comma, colon, or hyphen instead. Return ONLY the JSON object.`;

/**
 * Parse a resume file (PDF or DOCX bytes) into a structured profile via
 * Gemini. Throws on model/parse failure - callers record parse_status.
 */
export async function parseResume(
  fileBytes: Uint8Array,
  mimeType: string
): Promise<ParsedResume> {
  const ai = geminiClient();
  const response = await ai.models.generateContent({
    model: GEMINI_TEXT_MODEL,
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

  const raw = extractJson<unknown>(response.text ?? "");
  return parsedResumeSchema.parse(raw);
}
