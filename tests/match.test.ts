import { describe, expect, it } from "vitest";
import { scoreJob, type MatchProfile } from "@/lib/match";

const profile: MatchProfile = {
  headline: "Senior TypeScript Engineer",
  skills: ["TypeScript", "React", "Postgres", "Kubernetes"],
  preferences: { remote: true, locations: ["Phoenix"] }
};

describe("scoreJob", () => {
  it("scores skill overlap + title + location", () => {
    const result = scoreJob(
      {
        title: "Senior TypeScript Engineer",
        location: "Remote — US",
        description: "You will build React frontends backed by Postgres."
      },
      profile
    );
    expect(result.matchedSkills).toEqual(["TypeScript", "React", "Postgres"]);
    expect(result.locationOk).toBe(true);
    // 3/4 skills ≈ 53 + 20 title + 10 location
    expect(result.score).toBe(83);
  });

  it("zero-skill job still gets title/location points", () => {
    const result = scoreJob(
      { title: "Engineer, TypeScript platform", location: "Phoenix, AZ", description: "" },
      profile
    );
    expect(result.matchedSkills).toEqual(["TypeScript"]);
    expect(result.score).toBeGreaterThanOrEqual(30);
  });

  it("location fails when neither remote nor preferred city match", () => {
    const result = scoreJob(
      { title: "Barista", location: "Boston, MA", description: "espresso" },
      profile
    );
    expect(result.locationOk).toBe(false);
    expect(result.score).toBe(0);
  });

  it("no preferences = location always ok", () => {
    const result = scoreJob(
      { title: "Chef", location: "Anywhere", description: "" },
      { headline: "", skills: [], preferences: {} }
    );
    expect(result.locationOk).toBe(true);
    expect(result.score).toBe(10);
  });
});
