import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchAshby,
  fetchGreenhouse,
  fetchLever,
  fetchWorkable,
  fetchWorkday
} from "../src/fetchers";

function jsonOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => "" };
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("fetchGreenhouse", () => {
  it("builds canonical hosted URLs and strips HTML", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk({
      jobs: [
        { id: 42, title: "Eng", location: { name: "Remote" }, content: "<p>Build&nbsp;things &amp; ship</p>" },
        { absolute_url: "https://co/careers/9", title: "PM" }, // no id -> falls back to absolute_url
        { title: "ghost" } // no id/absolute_url -> filtered out
      ]
    })));
    const jobs = await fetchGreenhouse("Acme", "acme");
    expect(jobs).toHaveLength(2);
    expect(jobs[0].url).toBe("https://boards.greenhouse.io/acme/jobs/42");
    expect(jobs[0].description).toBe("Build things & ship");
    expect(jobs[1].url).toBe("https://co/careers/9");
  });

  it("defaults to an empty job list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk({})));
    expect(await fetchGreenhouse("Acme", "acme")).toEqual([]);
  });

  it("defaults every optional field when absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk({ jobs: [{ id: 7 }] })));
    const [job] = await fetchGreenhouse("Acme", "acme");
    expect(job).toMatchObject({ title: "", location: "", description: "" });
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(fetchGreenhouse("Acme", "acme")).rejects.toThrow(/-> 404/);
  });
});

describe("fetchLever", () => {
  it("keeps only hosted postings", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk([
      { hostedUrl: "https://jobs.lever.co/acme/1", text: "Staff", categories: { location: "NYC" }, descriptionPlain: "work" },
      { text: "no url" }
    ])));
    const jobs = await fetchLever("Acme", "acme");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ url: "https://jobs.lever.co/acme/1", title: "Staff", location: "NYC" });
  });

  it("tolerates a non-array body and missing fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk({ not: "array" })));
    expect(await fetchLever("Acme", "acme")).toEqual([]);
  });

  it("defaults optional fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk([{ hostedUrl: "https://jobs.lever.co/acme/1" }])));
    const [job] = await fetchLever("Acme", "acme");
    expect(job).toMatchObject({ title: "", location: "", description: "" });
  });
});

describe("fetchAshby", () => {
  it("normalizes Ashby postings", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk({
      jobs: [{ jobUrl: "https://jobs.ashbyhq.com/acme/1", title: "Eng", location: "Remote", descriptionPlain: "d" }, { title: "no url" }]
    })));
    const jobs = await fetchAshby("Acme", "acme");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].url).toBe("https://jobs.ashbyhq.com/acme/1");
  });

  it("defaults optional fields and an absent jobs array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk({ jobs: [{ jobUrl: "https://ashby/1" }] })));
    const [job] = await fetchAshby("Acme", "acme");
    expect(job).toMatchObject({ title: "", location: "", description: "" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk({})));
    expect(await fetchAshby("Acme", "acme")).toEqual([]);
  });
});

describe("fetchWorkable", () => {
  it("uses url or shortlink and joins city/country", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk({
      jobs: [
        { url: "https://apply.workable.com/acme/j/1", title: "Eng", city: "Austin", country: "USA", description: "<b>hi</b>" },
        { shortlink: "https://wrk.co/2", title: "PM" },
        { title: "no link" }
      ]
    })));
    const jobs = await fetchWorkable("Acme", "acme");
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ url: "https://apply.workable.com/acme/j/1", location: "Austin, USA", description: "hi" });
    expect(jobs[1].url).toBe("https://wrk.co/2");
  });

  it("defaults optional fields and an absent jobs array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk({ jobs: [{ shortlink: "https://wrk.co/9" }] })));
    const [job] = await fetchWorkable("Acme", "acme");
    expect(job).toMatchObject({ title: "", location: "", description: "" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk({})));
    expect(await fetchWorkable("Acme", "acme")).toEqual([]);
  });
});

describe("fetchWorkday", () => {
  it("POSTs the CXS search and builds canonical posting URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonOk({
        jobPostings: [
          {
            title: "Senior Engineer",
            externalPath: "/US-CA-Santa-Clara/Senior-Engineer_JR123",
            locationsText: "Santa Clara, CA"
          },
          { title: "No path" }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await fetchWorkday("Acme", "acme.wd1/Careers");

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      url: "https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/US-CA-Santa-Clara/Senior-Engineer_JR123",
      ats: "workday",
      source: "ingest:workday",
      company: "Acme",
      title: "Senior Engineer",
      location: "Santa Clara, CA",
      // The listing endpoint carries no description; fetchJobMeta fills it in
      // when a user actually tracks the job.
      description: ""
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/jobs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({ limit: 20, offset: 0, searchText: "" });
  });

  it("returns nothing for a board token missing the tenant or site", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchWorkday("Acme", "acme.wd1")).toEqual([]);
    expect(await fetchWorkday("Acme", "")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("defaults optional fields and an absent postings array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonOk({ jobPostings: [{ externalPath: "/x_JR1" }] }))
    );
    const [job] = await fetchWorkday("Acme", "acme.wd1/Careers");
    expect(job).toMatchObject({ title: "", location: "" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk({})));
    expect(await fetchWorkday("Acme", "acme.wd1/Careers")).toEqual([]);
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(fetchWorkday("Acme", "acme.wd1/Careers")).rejects.toThrow(/-> 403/);
  });
});
