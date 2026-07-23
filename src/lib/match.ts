/** Job ↔ profile matching (pure scoring, unit-tested). */

export interface MatchableJob {
  title: string;
  location: string;
  description: string;
}

export interface MatchProfile {
  headline: string;
  skills: string[];
  preferences: {
    locations?: string[];
    remote?: boolean;
    [key: string]: unknown;
  };
}

export interface MatchScore {
  score: number; // 0-100
  matchedSkills: string[];
  locationOk: boolean;
}

const norm = (s: string) => s.toLowerCase();

/**
 * Transparent heuristic score:
 *  - up to 70 pts: fraction of the user's skills present in title+description
 *  - 20 pts: title overlaps the user's headline words
 *  - 10 pts: location matches preferences (remote counts when enabled)
 */
export function scoreJob(job: MatchableJob, profile: MatchProfile): MatchScore {
  const haystack = norm(`${job.title} ${job.description}`);

  const matchedSkills = profile.skills.filter(
    (skill) => skill.length > 1 && haystack.includes(norm(skill))
  );
  const skillPts =
    profile.skills.length > 0 ? Math.round((matchedSkills.length / profile.skills.length) * 70) : 0;

  const headlineWords = norm(profile.headline)
    .split(/[^a-z0-9+#.]+/)
    .filter((w) => w.length > 2);
  const titleNorm = norm(job.title);
  const titleHit = headlineWords.some((w) => titleNorm.includes(w));
  const titlePts = titleHit ? 20 : 0;

  const jobLocation = norm(job.location);
  const wantsRemote = profile.preferences.remote === true;
  const remoteJob = jobLocation.includes("remote") || haystack.includes("fully remote");
  const preferredLocations = (profile.preferences.locations ?? []).map(norm);
  const locationOk =
    (wantsRemote && remoteJob) ||
    preferredLocations.length === 0 ||
    preferredLocations.some((loc) => loc && jobLocation.includes(loc));
  const locationPts = locationOk ? 10 : 0;

  return {
    score: Math.min(skillPts + titlePts + locationPts, 100),
    matchedSkills,
    locationOk
  };
}
