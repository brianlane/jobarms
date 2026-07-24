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
