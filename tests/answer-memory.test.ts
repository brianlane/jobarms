import { describe, expect, it } from "vitest";
import {
  isJobSpecificQuestion,
  isSensitiveQuestion,
  lessonsFromStats,
  memoryFromApproval,
  questionKey,
  statsFromApproval
} from "@/lib/answer-memory";

describe("questionKey", () => {
  it("normalizes punctuation and case", () => {
    expect(questionKey("How did you hear about us?")).toBe("how_did_you_hear_about_us");
    expect(questionKey("  How DID you hear about us ")).toBe("how_did_you_hear_about_us");
  });
});

describe("sensitivity gates", () => {
  it("flags sensitive questions", () => {
    expect(isSensitiveQuestion("Will you require visa sponsorship?")).toBe(true);
    expect(isSensitiveQuestion("Desired salary")).toBe(true);
    expect(isSensitiveQuestion("Veteran status")).toBe(true);
    expect(isSensitiveQuestion("How did you hear about us?")).toBe(false);
  });

  it("flags job-specific prose", () => {
    expect(isJobSpecificQuestion("Why do you want to work here?")).toBe(true);
    expect(isJobSpecificQuestion("Cover letter")).toBe(true);
    expect(isJobSpecificQuestion("Years of React experience")).toBe(false);
  });
});

describe("memoryFromApproval", () => {
  const generated = [
    { name: "phone", label: "Phone", value: "(602) 686-6672" },
    { name: "notice", label: "Notice period", value: "Two weeks" },
    { name: "why", label: "Why do you want to work here?", value: "Because..." }
  ];

  it("captures edits as user_edited and unchanged as approved", () => {
    const approved = [
      { name: "phone", label: "Phone", value: "(602) 686-6672" },
      { name: "notice", label: "Notice period", value: "Available immediately" },
      { name: "why", label: "Why do you want to work here?", value: "Because reasons" }
    ];
    const memory = memoryFromApproval(generated, approved);
    const byKey = Object.fromEntries(memory.map((m) => [m.question_key, m]));

    expect(byKey["phone"].source).toBe("approved");
    expect(byKey["notice_period"].source).toBe("user_edited");
    expect(byKey["notice_period"].answer).toBe("Available immediately");
    // job-specific prose is never memorized
    expect(byKey["why_do_you_want_to_work_here"]).toBeUndefined();
  });

  it("drops skipped, empty, and over-long answers", () => {
    const memory = memoryFromApproval(
      [],
      [
        { name: "a", label: "A", value: "", skipped: false },
        { name: "b", label: "B", value: "x", skipped: true },
        { name: "c", label: "C", value: "y".repeat(700) }
      ]
    );
    expect(memory).toEqual([]);
  });

  it("drops a falsy-label answer and treats an empty prior value as an edit", () => {
    const memory = memoryFromApproval(
      [{ name: "notice", label: "Notice period", value: "" }], // empty prior value
      [
        { name: "blank", label: "", value: "ignored" }, // falsy label -> dropped
        { name: "notice", label: "Notice period", value: "Two weeks" }
      ]
    );
    expect(memory).toHaveLength(1);
    expect(memory[0].question_key).toBe("notice_period");
    // prior "" differs from "Two weeks" -> user_edited (exercises `before.value || ""`)
    expect(memory[0].source).toBe("user_edited");
  });
});

describe("statsFromApproval", () => {
  const fields = [
    { name: "src", label: "How did you hear about us?", type: "select", options: ["LinkedIn", "Job board"] },
    { name: "visa", label: "Do you require sponsorship?", type: "radio", options: ["Yes", "No"] },
    { name: "free", label: "Tell us more", type: "textarea" }
  ];

  it("captures option choices only for non-sensitive option fields", () => {
    const stats = statsFromApproval(
      fields,
      [],
      [
        { name: "src", label: "How did you hear about us?", value: "Job board" },
        { name: "visa", label: "Do you require sponsorship?", value: "No" },
        { name: "free", label: "Tell us more", value: "" }
      ]
    );
    const byKey = Object.fromEntries(stats.map((s) => [s.question_key, s]));

    expect(byKey["how_did_you_hear_about_us"].chosen_option).toBe("Job board");
    expect(byKey["do_you_require_sponsorship"].chosen_option).toBeNull(); // sensitive
    expect(byKey["tell_us_more"].skipped).toBe(true);
  });

  it("marks edits", () => {
    const stats = statsFromApproval(
      fields,
      [{ name: "src", label: "How did you hear about us?", value: "LinkedIn" }],
      [{ name: "src", label: "How did you hear about us?", value: "Job board" }]
    );
    expect(stats[0].edited).toBe(true);
  });

  it("drops fields with a blank label and marks missing answers skipped", () => {
    const stats = statsFromApproval(
      [
        { name: "blank", label: "   ", type: "text" },
        { name: "phone", label: "Phone", type: "text" }
      ],
      [],
      [] // no approved answer for phone -> skipped via missing `after`
    );
    expect(stats).toHaveLength(1);
    expect(stats[0].question_key).toBe("phone");
    expect(stats[0].skipped).toBe(true);
  });

  it("does not record an option choice when the value is not a listed option", () => {
    const stats = statsFromApproval(
      [{ name: "src", label: "How did you hear about us?", type: "select", options: ["LinkedIn"] }],
      [],
      [{ name: "src", label: "How did you hear about us?", value: "Carrier pigeon" }]
    );
    expect(stats[0].chosen_option).toBeNull();
  });

  it("handles falsy labels, empty prior values, and option fields with no options list", () => {
    const stats = statsFromApproval(
      [
        { name: "empty", label: "", type: "text" }, // falsy label -> filtered out
        { name: "src", label: "How did you hear about us?", type: "text" },
        { name: "opt", label: "Pick one", type: "radio" } // no options array
      ],
      [{ name: "src", label: "How did you hear about us?", value: "" }], // prior value empty
      [
        { name: "src", label: "How did you hear about us?", value: "Job board" },
        { name: "opt", label: "Pick one", value: "Whatever" }
      ]
    );
    const byKey = Object.fromEntries(stats.map((s) => [s.question_key, s]));
    expect(byKey["empty_"]).toBeUndefined();
    // prior "" differs from "Job board" -> edited true (exercises `before.value || ""`)
    expect(byKey["how_did_you_hear_about_us"].edited).toBe(true);
    // option field with no options list -> no chosen option
    expect(byKey["pick_one"].chosen_option).toBeNull();
  });

  it("treats an explicitly skipped answer as skipped", () => {
    const stats = statsFromApproval(
      [{ name: "q", label: "Q", type: "text" }],
      [],
      [{ name: "q", label: "Q", value: "something", skipped: true }]
    );
    expect(stats[0].skipped).toBe(true);
  });
});

describe("lessonsFromStats", () => {
  it("emits a majority-option lesson at >=60% with >=3 observations", () => {
    const lessons = lessonsFromStats([
      {
        question_key: "how_did_you_hear_about_us",
        label_example: "How did you hear about us?",
        times_seen: 5,
        times_skipped: 0,
        option_counts: { "Job board": 4, LinkedIn: 1 }
      }
    ]);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].guidance).toContain('"Job board"');
  });

  it("emits a skip lesson for often-skipped questions", () => {
    const lessons = lessonsFromStats([
      {
        question_key: "portfolio_url",
        label_example: "Portfolio URL",
        times_seen: 6,
        times_skipped: 4,
        option_counts: {}
      }
    ]);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].guidance).toContain("often left unanswered");
  });

  it("stays quiet on low-signal rows", () => {
    const lessons = lessonsFromStats([
      {
        question_key: "x",
        label_example: "X",
        times_seen: 2,
        times_skipped: 1,
        option_counts: { A: 1, B: 1 }
      }
    ]);
    expect(lessons).toEqual([]);
  });

  it("a strong majority wins and short-circuits the skip lesson (one lesson per row)", () => {
    const lessons = lessonsFromStats([
      {
        question_key: "src",
        label_example: "Source",
        times_seen: 10,
        times_skipped: 9, // also often-skipped, but the majority option wins first
        option_counts: { "Job board": 8, LinkedIn: 1 }
      }
    ]);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].guidance).toContain("most often answer");
  });

  it("emits nothing when there is enough data but no clear majority", () => {
    // totalChoices >= 3 but the top option is under 60%, and skip rate is low:
    // exercises the majority-threshold FALSE branch without a skip lesson.
    const lessons = lessonsFromStats([
      {
        question_key: "src",
        label_example: "Source",
        times_seen: 3,
        times_skipped: 0,
        option_counts: { A: 1, B: 1, C: 1 }
      }
    ]);
    expect(lessons).toEqual([]);
  });

  it("honors the lesson limit", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      question_key: `q${i}`,
      label_example: `Q${i}`,
      times_seen: 6,
      times_skipped: 4,
      option_counts: {}
    }));
    expect(lessonsFromStats(rows, 5)).toHaveLength(5);
  });
});
