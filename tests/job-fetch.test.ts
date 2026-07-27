import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJobMeta, parseGreenhouseUrl, parseLeverUrl } from "@/lib/job-fetch";

describe("parseGreenhouseUrl", () => {
  it("parses /jobs/<id> paths", () => {
    expect(parseGreenhouseUrl(new URL("https://boards.greenhouse.io/acme/jobs/123"))).toEqual({
      board: "acme",
      jobId: "123"
    });
  });
  it("falls back to gh_jid query param", () => {
    expect(parseGreenhouseUrl(new URL("https://boards.greenhouse.io/acme?gh_jid=999"))).toEqual({
      board: "acme",
      jobId: "999"
    });
  });
  it("returns null when unrecognizable", () => {
    expect(parseGreenhouseUrl(new URL("https://boards.greenhouse.io/"))).toBeNull();
  });
});

describe("parseLeverUrl", () => {
  it("parses /<company>/<id>", () => {
    expect(parseLeverUrl(new URL("https://jobs.lever.co/acme/abc-123/apply"))).toEqual({
      company: "acme",
      postingId: "abc-123"
    });
  });
  it("returns null when too short", () => {
    expect(parseLeverUrl(new URL("https://jobs.lever.co/acme"))).toBeNull();
  });
});

describe("fetchJobMeta", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns empty fallback for an unparseable URL", async () => {
    const meta = await fetchJobMeta("not a url");
    expect(meta).toEqual({ company: "", title: "", location: "", description: "", ats: "unknown" });
  });

  it("returns fallback for an unsupported ATS host", async () => {
    const meta = await fetchJobMeta("https://example.com/jobs/1");
    expect(meta.ats).toBe("unknown");
    expect(meta.title).toBe("");
  });

  it("fetches + strips HTML for Greenhouse", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          title: "Engineer",
          company_name: "Acme",
          location: { name: "Remote" },
          content: "<p>Build&nbsp;things &amp; ship</p>"
        })
      })
    );
    const meta = await fetchJobMeta("https://boards.greenhouse.io/acme/jobs/1");
    expect(meta).toMatchObject({ company: "Acme", title: "Engineer", location: "Remote", ats: "greenhouse" });
    expect(meta.description).toBe("Build things & ship");
  });

  // Decoding entities in sequence let an earlier replacement feed the next:
  // turning "&amp;" into "&" first rewrote the literal text "&amp;lt;" into
  // "<", which is the double-unescaping CodeQL flagged.
  it("decodes each HTML entity exactly once", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          title: "Engineer",
          company_name: "Acme",
          location: { name: "Remote" },
          content: "<p>Escaped: &amp;lt;script&amp;gt; and &lt;b&gt; &quot;q&quot; &#39;a&#39;</p>"
        })
      })
    );
    const meta = await fetchJobMeta("https://boards.greenhouse.io/acme/jobs/1");
    expect(meta.description).toBe(`Escaped: &lt;script&gt; and <b> "q" 'a'`);
    expect(meta.description).not.toContain("<script>");
  });

  it("leaves an unknown entity untouched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ content: "<p>50&deg; &#039;x&#039;</p>" })
      })
    );
    const meta = await fetchJobMeta("https://boards.greenhouse.io/acme/jobs/1");
    expect(meta.description).toBe("50&deg; 'x'");
  });

  it("falls back to defaults when Greenhouse omits title/company/location/content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const meta = await fetchJobMeta("https://boards.greenhouse.io/acme/jobs/1");
    expect(meta.company).toBe("acme"); // board slug fallback
    expect(meta.title).toBe("");
    expect(meta.location).toBe("");
    expect(meta.description).toBe("");
  });

  it("returns fallback when the Greenhouse URL cannot be parsed", async () => {
    const meta = await fetchJobMeta("https://boards.greenhouse.io/");
    expect(meta.title).toBe("");
  });

  it("returns fallback when Greenhouse responds non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const meta = await fetchJobMeta("https://boards.greenhouse.io/acme/jobs/1");
    expect(meta.title).toBe("");
  });

  it("fetches Lever postings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: "Staff Eng", categories: { location: "NYC" }, descriptionPlain: "Do work" })
      })
    );
    const meta = await fetchJobMeta("https://jobs.lever.co/acme/xyz");
    expect(meta).toMatchObject({ company: "acme", title: "Staff Eng", location: "NYC", description: "Do work", ats: "lever" });
  });

  it("returns fallback when the Lever URL cannot be parsed", async () => {
    const meta = await fetchJobMeta("https://jobs.lever.co/acme");
    expect(meta.title).toBe("");
  });

  it("returns fallback when Lever responds non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const meta = await fetchJobMeta("https://jobs.lever.co/acme/xyz");
    expect(meta.title).toBe("");
  });

  it("returns fallback when the fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const meta = await fetchJobMeta("https://jobs.lever.co/acme/xyz");
    expect(meta.title).toBe("");
  });

  it("handles missing optional fields (Lever)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const meta = await fetchJobMeta("https://jobs.lever.co/acme/xyz");
    expect(meta).toMatchObject({ company: "acme", title: "", location: "", description: "" });
  });
});

describe("fetchJobMeta (Workday)", () => {
  const JOB_URL =
    "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Engineer_JR123";

  it("reads jobPostingInfo from the candidate-experience endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jobPostingInfo: {
          title: "Senior Engineer",
          location: "Santa Clara, CA",
          jobDescription: "<p>Build&nbsp;things &amp; ship</p>"
        },
        hiringOrganization: { name: "NVIDIA Corporation" }
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    const meta = await fetchJobMeta(JOB_URL);

    expect(meta).toMatchObject({
      company: "NVIDIA Corporation",
      title: "Senior Engineer",
      location: "Santa Clara, CA",
      description: "Build things & ship",
      ats: "workday"
    });
    // The CXS path is built from the tenant, site, and external path.
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Engineer_JR123"
    );
  });

  it("falls back to the tenant slug when no legal entity is reported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ jobPostingInfo: { title: "Eng" } })
      })
    );
    const meta = await fetchJobMeta(JOB_URL);
    expect(meta).toMatchObject({ company: "nvidia", title: "Eng", location: "" });
  });

  it("falls back to the first additional location", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          jobPostingInfo: { title: "Eng", additionalLocations: ["Remote, US", "Austin"] }
        })
      })
    );
    expect((await fetchJobMeta(JOB_URL)).location).toBe("Remote, US");
  });

  it("tolerates a response with no jobPostingInfo at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const meta = await fetchJobMeta(JOB_URL);
    expect(meta).toMatchObject({ company: "nvidia", title: "", description: "" });
  });

  it("returns fallback for a Workday URL that is not a posting", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const meta = await fetchJobMeta("https://nvidia.wd5.myworkdayjobs.com/en-US/Careers");
    expect(meta).toMatchObject({ title: "", ats: "workday" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns fallback when the endpoint responds non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect((await fetchJobMeta(JOB_URL)).title).toBe("");
  });

  it("caps a pathologically long description", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ jobPostingInfo: { jobDescription: "x".repeat(25_000) } })
      })
    );
    expect((await fetchJobMeta(JOB_URL)).description).toHaveLength(20_000);
  });
});
