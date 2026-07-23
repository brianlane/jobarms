import { describe, expect, it } from "vitest";
import { parsedResumeSchema } from "@/lib/resume-parse";

describe("parsedResumeSchema resilience", () => {
  it("nulls and missing keys never fail; they become defaults", () => {
    const parsed = parsedResumeSchema.parse({
      full_name: null,
      email: undefined,
      phone: 5551234, // wrong type
      links: null,
      work_history: [
        { company: "Acme", title: null, start: "Jan 2020", end: null, bullets: null },
        "garbage entry"
      ],
      education: null,
      skills: ["TypeScript", null, "React"]
    });

    expect(parsed.full_name).toBe("");
    expect(parsed.email).toBe("");
    expect(parsed.phone).toBe("");
    expect(parsed.links).toEqual({});
    expect(parsed.work_history).toHaveLength(2);
    expect(parsed.work_history[0].company).toBe("Acme");
    expect(parsed.work_history[0].title).toBe("");
    expect(parsed.work_history[0].bullets).toEqual([]);
    expect(parsed.work_history[1]).toEqual({
      company: "",
      title: "",
      start: "",
      end: "",
      bullets: []
    });
    expect(parsed.education).toEqual([]);
    expect(parsed.skills).toEqual(["TypeScript", "", "React"]);
  });

  it("a normal well-formed resume passes through unchanged", () => {
    const input = {
      full_name: "Jane Doe",
      email: "jane@example.com",
      phone: "555-0101",
      location: "Phoenix, AZ",
      headline: "Engineer",
      summary: "Builds things.",
      links: { github: "https://github.com/jane" },
      work_history: [
        { company: "Acme", title: "Engineer", start: "Jan 2020", end: "Present", bullets: ["Shipped"] }
      ],
      education: [{ school: "ASU", degree: "BS", field: "CS", start: "2013", end: "2017" }],
      skills: ["TypeScript"]
    };
    expect(parsedResumeSchema.parse(input)).toEqual(input);
  });
});
