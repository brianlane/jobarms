import { z } from "zod";
import { generateWithRetry, extractJson } from "@/lib/gemini";
import { parsedResumeSchema, type ParsedResume } from "@/lib/resume-parse";

export const tailorResultSchema = z.object({
  resume: parsedResumeSchema,
  keywords: z.object({
    incorporated: z.array(z.string()).default([]),
    missing: z.array(z.string()).default([])
  })
});

export type TailorResult = z.infer<typeof tailorResultSchema>;

/**
 * Tailor the user's profile into a job-specific resume. Rewrites summaries
 * and bullets around the job's language - but NEVER invents employers,
 * titles, dates, or credentials.
 */
export async function tailorResume(
  profile: Record<string, unknown>,
  jobTitle: string,
  jobCompany: string,
  jobDescription: string
): Promise<TailorResult> {
  const text = await generateWithRetry({
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `You are an expert resume writer. Tailor this candidate's resume to the job below.

CANDIDATE PROFILE (JSON):
${JSON.stringify(profile)}

JOB: ${jobTitle} at ${jobCompany}
JOB DESCRIPTION:
${jobDescription.slice(0, 8000)}

Hard rules:
- NEVER invent employers, job titles, dates, degrees, or certifications. Every factual claim must exist in the profile.
- You MAY rewrite the summary, reorder skills, and rewrite work_history bullets to emphasize relevant experience using the job description's own terminology.
- Keep bullets concise and achievement-oriented.
- Never use the em dash character anywhere in your output; use a comma, colon, or hyphen instead.

Return JSON: {"resume": {full_name, email, phone, location, headline, summary, links, work_history:[{company,title,start,end,bullets[]}], education:[{school,degree,field,start,end}], skills[]}, "keywords": {"incorporated": [terms from the JD you worked in], "missing": [important JD terms the candidate genuinely lacks]}}. Return ONLY the JSON.`
          }
        ]
      }
    ],
    config: { responseMimeType: "application/json", temperature: 0.3 }
  });

  return tailorResultSchema.parse(extractJson<unknown>(text));
}

/** First-person cover letter grounded only in real profile facts. */
export async function generateCoverLetter(
  profile: Record<string, unknown>,
  jobTitle: string,
  jobCompany: string,
  jobDescription: string
): Promise<string> {
  const raw = await generateWithRetry({
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Write a cover letter for this candidate applying to ${jobTitle} at ${jobCompany}.

CANDIDATE PROFILE (JSON):
${JSON.stringify(profile)}

JOB DESCRIPTION:
${jobDescription.slice(0, 8000)}

Rules: 250-350 words, first person, specific to this company and role, grounded ONLY in real profile facts (never invent experience), no salutation placeholders like "[Hiring Manager]" - use "Hi ${jobCompany} team,". Never use the em dash character anywhere; use a comma, colon, or hyphen instead. Plain text only.`
          }
        ]
      }
    ],
    config: { temperature: 0.5 }
  });

  const text = raw.trim();
  if (!text) throw new Error("empty cover letter");
  return text;
}

export type { ParsedResume };
