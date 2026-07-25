import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkEnv,
  ENV_GROUPS,
  probeOrigin,
  probeServices,
  summarizeEnv,
  webhookFreshness
} from "@/lib/admin/system";

const NOW = new Date("2026-07-15T12:00:00Z");

function sub(updated_at: string | null) {
  return {
    user_id: "u1",
    plan: "premium",
    status: "active",
    current_period_end: null,
    cancel_at_period_end: false,
    updated_at
  };
}

beforeEach(() => {
  delete process.env.ARM_WORKER_URL;
  delete process.env.RENDER_URL;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ARM_WORKER_URL;
  delete process.env.RENDER_URL;
  delete process.env.ADMIN_EMAIL;
});

describe("checkEnv", () => {
  it("treats unset and whitespace-only as missing", () => {
    expect(checkEnv("ADMIN_EMAIL")).toBe(false);
    process.env.ADMIN_EMAIL = "   ";
    expect(checkEnv("ADMIN_EMAIL")).toBe(false);
    process.env.ADMIN_EMAIL = "ops@jobarms.com";
    expect(checkEnv("ADMIN_EMAIL")).toBe(true);
  });
});

describe("summarizeEnv", () => {
  it("labels a group configured, partial, or missing", () => {
    process.env.ADMIN_EMAIL = "ops@jobarms.com";
    const matrix = summarizeEnv([
      { label: "All set", vars: [{ key: "ADMIN_EMAIL", label: "Admin", note: "" }] },
      {
        label: "Half",
        vars: [
          { key: "ADMIN_EMAIL", label: "Admin", note: "" },
          { key: "DEFINITELY_UNSET_KEY", label: "Nope", note: "" }
        ]
      },
      { label: "None", vars: [{ key: "DEFINITELY_UNSET_KEY", label: "Nope", note: "" }] }
    ]);

    expect(matrix.groups.map((g) => g.state)).toEqual(["configured", "partial", "missing"]);
    expect(matrix.configured).toBe(2);
    expect(matrix.total).toBe(4);
    expect(matrix.groups[0].vars[0].configured).toBe(true);
  });

  it("defaults to the real group list and never exposes a value", () => {
    const matrix = summarizeEnv();
    expect(matrix.total).toBe(ENV_GROUPS.flatMap((g) => g.vars).length);
    const serialized = JSON.stringify(matrix);
    expect(serialized).not.toContain("sb_secret");
    expect(serialized).toContain("configured");
  });
});

describe("probeOrigin", () => {
  it("reports not configured without a url", async () => {
    const probe = await probeOrigin("Arm", null);
    expect(probe).toMatchObject({ reachable: false, status: null, detail: "not configured" });
  });

  it("counts any HTTP answer as reachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 401 })));
    const probe = await probeOrigin("Arm", "https://arm.jobarms.com");
    expect(probe).toMatchObject({ reachable: true, status: 401, detail: "HTTP 401" });
  });

  it("reports the error message when the origin is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("timed out");
    }));
    const probe = await probeOrigin("Arm", "https://arm.jobarms.com");
    expect(probe).toMatchObject({ reachable: false, detail: "timed out" });
  });

  it("handles a non-Error rejection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw "socket hang up";
    }));
    const probe = await probeOrigin("Arm", "https://arm.jobarms.com");
    expect(probe.detail).toBe("unreachable");
  });
});

describe("probeServices", () => {
  it("probes the arm worker and the render sidecar", async () => {
    process.env.ARM_WORKER_URL = "https://arm.jobarms.com";
    process.env.RENDER_URL = "https://browser.jobarms.com";
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 404 })));
    const probes = await probeServices();
    expect(probes.map((probe) => probe.label)).toEqual(["Apply-arm worker", "Render sidecar"]);
    expect(probes.every((probe) => probe.reachable)).toBe(true);
  });

  it("reports a blank url as unconfigured", async () => {
    process.env.ARM_WORKER_URL = "  ";
    const probes = await probeServices();
    expect(probes[0]).toMatchObject({ url: null, reachable: false });
    expect(probes[1]).toMatchObject({ url: null, reachable: false });
  });
});

describe("webhookFreshness", () => {
  it("is quiet with no subscription rows at all", () => {
    expect(webhookFreshness([], NOW)).toEqual({ lastEventAt: null, ageHours: null, quiet: true });
  });

  it("ignores rows with no or unparseable timestamps", () => {
    expect(webhookFreshness([sub(null), sub("nonsense")], NOW).lastEventAt).toBeNull();
  });

  it("takes the newest write and reports its age", () => {
    const fresh = webhookFreshness([sub("2026-07-01T12:00:00Z"), sub("2026-07-15T06:00:00Z")], NOW);
    expect(fresh.lastEventAt).toBe("2026-07-15T06:00:00.000Z");
    expect(fresh.ageHours).toBe(6);
    expect(fresh.quiet).toBe(false);
  });

  it("flags a long silence as quiet", () => {
    expect(webhookFreshness([sub("2026-01-01T12:00:00Z")], NOW).quiet).toBe(true);
  });
});
