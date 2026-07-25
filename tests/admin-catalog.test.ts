import { describe, expect, it } from "vitest";
import {
  discoveryAttribution,
  jobsPerDay,
  mixBy,
  sourceFreshness,
  viewCompanies,
  CATALOG_SOURCES,
  type CatalogJobRow,
  type CompanyRow
} from "@/lib/admin/catalog";

const NOW = new Date("2026-07-15T12:00:00Z");

function job(over: Partial<CatalogJobRow> = {}): CatalogJobRow {
  return {
    ats: "lever",
    source: "ingest:lever",
    company: "Acme",
    created_at: "2026-07-15T10:00:00Z",
    ...over
  };
}

function company(over: Partial<CompanyRow> = {}): CompanyRow {
  return {
    id: "c1",
    name: "Acme",
    ats: "lever",
    board_token: "acme",
    active: true,
    last_ingested_at: "2026-07-15T11:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    ...over
  };
}

describe("viewCompanies", () => {
  it("flags stale active boards first and counts their recent jobs", () => {
    const views = viewCompanies(
      [
        company({ id: "fresh", name: "Acme" }),
        company({ id: "stale", name: "Quiet Co", last_ingested_at: "2026-07-10T00:00:00Z" }),
        company({ id: "never", name: "New Co", last_ingested_at: null }),
        // A paused board cannot be stale: nothing is supposed to sweep it.
        company({ id: "paused", name: "Paused Co", active: false, last_ingested_at: null })
      ],
      [job({ company: "Acme" }), job({ company: "acme " }), job({ company: "  " })],
      NOW
    );

    expect(views.filter((view) => view.stale).map((view) => view.id).sort()).toEqual([
      "never",
      "stale"
    ]);
    expect(views.find((view) => view.id === "paused")!.stale).toBe(false);
    // Company matching is case and whitespace insensitive.
    expect(views.find((view) => view.id === "fresh")!.jobsInWindow).toBe(2);
    // Stale boards sort ahead of healthy ones.
    expect(views[0].stale).toBe(true);
  });

  it("treats an unparseable sweep timestamp as stale", () => {
    expect(viewCompanies([company({ last_ingested_at: "nonsense" })], [], NOW)[0].stale).toBe(true);
  });

  it("orders healthy boards by recent output", () => {
    const views = viewCompanies(
      [company({ id: "busy", name: "Busy" }), company({ id: "idle", name: "Idle" })],
      [job({ company: "Busy" })],
      NOW
    );
    expect(views.map((view) => view.id)).toEqual(["busy", "idle"]);
  });
});

describe("jobsPerDay", () => {
  it("returns a dense oldest-first series", () => {
    const series = jobsPerDay(
      [
        job({ created_at: "2026-07-15T01:00:00Z" }),
        job({ created_at: "2026-07-15T02:00:00Z" }),
        job({ created_at: "2026-07-13T02:00:00Z" }),
        job({ created_at: "not-a-date" })
      ],
      3,
      NOW
    );
    expect(series).toEqual([
      { label: "07-13", count: 1 },
      { label: "07-14", count: 0 },
      { label: "07-15", count: 2 }
    ]);
  });
});

describe("mixBy", () => {
  it("counts shares by platform and by source, biggest first", () => {
    const jobs = [
      job({ ats: "lever" }),
      job({ ats: "lever" }),
      job({ ats: "greenhouse", source: "ingest:greenhouse" }),
      job({ ats: "", source: "" })
    ];
    expect(mixBy(jobs, "ats")).toEqual([
      { key: "lever", count: 2, sharePct: 50 },
      { key: "greenhouse", count: 1, sharePct: 25 },
      { key: "unknown", count: 1, sharePct: 25 }
    ]);
    expect(mixBy(jobs, "source")[0].key).toBe("ingest:lever");
  });

  it("is empty with no jobs", () => {
    expect(mixBy([], "ats")).toEqual([]);
  });
});

describe("sourceFreshness", () => {
  it("reports the newest job per source and lists every known source", () => {
    const rows = sourceFreshness(
      [
        job({ source: "ingest:lever", created_at: "2026-07-15T11:00:00Z" }),
        job({ source: "ingest:lever", created_at: "2026-07-15T09:00:00Z" }),
        job({ source: "manual", created_at: "2026-07-01T00:00:00Z" }),
        job({ source: "ingest:brandnew", created_at: "2026-07-15T11:30:00Z" }),
        job({ source: "ingest:lever", created_at: "nope" })
      ],
      NOW
    );

    const bySource = new Map(rows.map((row) => [row.source, row]));
    // Every configured source appears even with nothing in the window.
    for (const source of CATALOG_SOURCES) expect(bySource.has(source)).toBe(true);
    expect(bySource.get("ingest:lever")).toMatchObject({
      newestAt: "2026-07-15T11:00:00.000Z",
      stale: false
    });
    expect(bySource.get("manual")!.stale).toBe(true);
    expect(bySource.get("ingest:ashby")).toMatchObject({ newestAt: null, stale: true });
    // A source we do not have in the constant list still shows up.
    expect(bySource.get("ingest:brandnew")!.stale).toBe(false);
  });
});

describe("discoveryAttribution", () => {
  it("splits applications by whether the job was ingested or pasted", () => {
    expect(
      discoveryAttribution([
        { jobs: { source: "ingest:lever" } },
        { jobs: { source: "ingest:greenhouse" } },
        { jobs: { source: "manual" } },
        // A missing job row reads as pasted rather than crediting the catalog.
        { jobs: null }
      ])
    ).toEqual({ total: 4, fromCatalog: 2, fromPasted: 2, catalogSharePct: 50 });
  });

  it("claims nothing with no applications", () => {
    expect(discoveryAttribution([]).catalogSharePct).toBe(0);
  });
});
