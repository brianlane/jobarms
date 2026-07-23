/**
 * Arm learning: pure logic for capturing lessons from approved runs and
 * building the memory/lesson payloads future runs carry into the prompt.
 *
 * Layer 1 (per user): approved answers, with the user's review-gate EDITS as
 * the strongest signal, keyed by normalized question. Reused only for that
 * user.
 * Layer 2 (platform): anonymous per-question aggregates per ATS. Free text
 * is NEVER aggregated across users; only option-choice counts for
 * non-sensitive select/radio questions, plus skip/edit frequencies.
 */

export interface AnswerLike {
  name: string;
  label: string;
  value: string;
  skipped?: boolean;
}

export interface FieldLike {
  name: string;
  label: string;
  type: string;
  options?: string[];
}

export interface MemoryEntry {
  question_key: string;
  label: string;
  answer: string;
  source: "approved" | "user_edited";
}

export interface PlatformLesson {
  question_key: string;
  label: string;
  guidance: string;
}

/** Normalize a question label into a stable key. */
export function questionKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 12)
    .join("_");
}

/**
 * Questions whose answers must never feed platform-wide aggregation and
 * never be auto-reused across contexts without the profile backing them.
 */
export function isSensitiveQuestion(label: string): boolean {
  return /visa|sponsor|citizen|immigra|gender|race|ethnic|veteran|disab|salary|compensation|pay\b|criminal|convict|clearance|pronoun|sexual|religio|age\b|date of birth|ssn/i.test(
    label
  );
}

/** Questions too job-specific to reuse verbatim (cover-letter style). */
export function isJobSpecificQuestion(label: string): boolean {
  return /why (do you want|are you interested|this role|this company|us\b)|cover letter|anything else|additional information/i.test(
    label
  );
}

/**
 * Diff generated vs approved answers into per-user memory entries.
 * User edits win over plain approvals; job-specific prose is excluded
 * (reusing "why this company" across companies would be a disaster).
 */
export function memoryFromApproval(
  generated: AnswerLike[],
  approved: AnswerLike[]
): MemoryEntry[] {
  const generatedByName = new Map(generated.map((a) => [a.name, a]));
  const entries: MemoryEntry[] = [];

  for (const answer of approved) {
    const label = (answer.label || "").trim();
    const value = (answer.value || "").trim();
    if (!label || !value || answer.skipped) continue;
    if (isJobSpecificQuestion(label)) continue;
    if (value.length > 600) continue; // long prose is context-bound

    const before = generatedByName.get(answer.name);
    const edited = Boolean(before) && (before!.value || "").trim() !== value;

    entries.push({
      question_key: questionKey(label),
      label,
      answer: value,
      source: edited ? "user_edited" : "approved"
    });
  }
  return entries;
}

export interface StatUpdate {
  question_key: string;
  label: string;
  field_type: string;
  skipped: boolean;
  edited: boolean;
  /** Approved option for non-sensitive select/radio questions, else null. */
  chosen_option: string | null;
}

/** Per-field platform stat updates from an approved run. */
export function statsFromApproval(
  fields: FieldLike[],
  generated: AnswerLike[],
  approved: AnswerLike[]
): StatUpdate[] {
  const generatedByName = new Map(generated.map((a) => [a.name, a]));
  const approvedByName = new Map(approved.map((a) => [a.name, a]));

  return fields
    .filter((f) => (f.label || "").trim())
    .map((field) => {
      const before = generatedByName.get(field.name);
      const after = approvedByName.get(field.name);
      const finalValue = (after?.value ?? "").trim();
      const skipped = !after || after.skipped === true || finalValue === "";
      const edited =
        Boolean(before && after) && (before!.value || "").trim() !== finalValue;

      const optionField = field.type === "select" || field.type === "radio";
      const optionMatch =
        optionField && !skipped && (field.options ?? []).includes(finalValue);
      const sensitive = isSensitiveQuestion(field.label);

      return {
        question_key: questionKey(field.label),
        label: field.label.trim().slice(0, 200),
        field_type: field.type,
        skipped,
        edited,
        chosen_option: optionMatch && !sensitive ? finalValue : null
      };
    });
}

interface StatRow {
  question_key: string;
  label_example: string;
  times_seen: number;
  times_skipped: number;
  option_counts: Record<string, number>;
}

/**
 * Turn platform stats into prompt guidance. Only high-signal rows: an
 * option chosen in >=60% of approvals with >=3 observations, or questions
 * skipped >=50% of the time (so the arm knows to try harder / expect them).
 */
export function lessonsFromStats(rows: StatRow[], limit = 25): PlatformLesson[] {
  const lessons: PlatformLesson[] = [];

  for (const row of rows) {
    const totalChoices = Object.values(row.option_counts).reduce((a, b) => a + b, 0);
    if (totalChoices >= 3) {
      const [topOption, count] = Object.entries(row.option_counts).sort(
        (a, b) => b[1] - a[1]
      )[0];
      if (count / totalChoices >= 0.6) {
        lessons.push({
          question_key: row.question_key,
          label: row.label_example,
          guidance: `For "${row.label_example}", approved applications most often answer "${topOption}". Prefer it when the profile gives no better signal.`
        });
        continue;
      }
    }
    if (row.times_seen >= 3 && row.times_skipped / row.times_seen >= 0.5) {
      lessons.push({
        question_key: row.question_key,
        label: row.label_example,
        guidance: `"${row.label_example}" is often left unanswered. Attempt a grounded answer from the profile instead of skipping when possible.`
      });
    }
  }
  return lessons.slice(0, limit);
}
