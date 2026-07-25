import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBucket, fakeFrom, type Result } from "./helpers/supabase";

const holder = vi.hoisted(() => ({ from: null as unknown, bucket: null as unknown }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceClient: vi.fn(() => ({
    from: holder.from,
    storage: { from: vi.fn(() => holder.bucket) }
  }))
}));

import { answerCounts, loadRunDetail, SCREENSHOT_TTL_SECONDS } from "@/lib/admin/run-detail";

function tables(map: Record<string, Result[]>) {
  holder.from = fakeFrom(map);
}

beforeEach(() => {
  holder.from = fakeFrom({});
  holder.bucket = fakeBucket();
});

describe("answerCounts", () => {
  it("counts a blank or skipped answer as skipped", () => {
    expect(
      answerCounts([
        { value: "Yes" },
        { value: "   " },
        { value: null },
        { value: "text", skipped: true },
        {}
      ])
    ).toEqual({ filled: 1, skipped: 4 });
  });
});

describe("loadRunDetail", () => {
  it("returns null for an unknown run", async () => {
    tables({ application_runs: [{ data: null }] });
    expect(await loadRunDetail("nope")).toBeNull();
  });

  it("assembles the run, its user, and signed screenshots", async () => {
    tables({
      application_runs: [
        {
          data: {
            id: "r1",
            user_id: "u1",
            application_id: "a1",
            status: "failed",
            autonomy: "full_auto",
            error: "captcha_blocked: blocked",
            created_at: "2026-07-15T10:00:00Z",
            updated_at: "2026-07-15T10:05:00Z",
            slot_refunded: true,
            canceled_by: null,
            steps: [{ step: "navigate", at: "2026-07-15T10:00:00Z" }],
            answers: [{ label: "Name", value: "Bri" }],
            form_fields: [{ name: "name" }, { name: "email" }],
            screenshots: ["u1/r1/one.png", "u1/r1/two.png"],
            month_key: "2026-07",
            tenant_host: "acme.wd1.myworkdayjobs.com",
            workflow_instance_id: "wf-1",
            applications: {
              id: "a1",
              status: "failed",
              jobs: { company: "Acme", title: "Engineer", ats: "workday", url: "https://x" }
            }
          }
        }
      ],
      profiles: [{ data: { id: "u1", email: "one@x.com" } }]
    });

    const detail = await loadRunDetail("r1");
    expect(detail).not.toBeNull();
    expect(detail!.formFieldCount).toBe(2);
    expect(detail!.steps).toHaveLength(1);
    expect(detail!.answers).toHaveLength(1);
    expect(detail!.user).toEqual({ id: "u1", email: "one@x.com" });
    expect(detail!.application).toEqual({
      id: "a1",
      status: "failed",
      company: "Acme",
      title: "Engineer",
      ats: "workday",
      url: "https://x"
    });
    expect(detail!.screenshots).toEqual([
      { path: "u1/r1/one.png", url: "https://signed.example/x" },
      { path: "u1/r1/two.png", url: "https://signed.example/x" }
    ]);

    const bucket = holder.bucket as ReturnType<typeof fakeBucket>;
    expect(bucket.createSignedUrl).toHaveBeenCalledWith("u1/r1/one.png", SCREENSHOT_TTL_SECONDS);
  });

  it("skips a screenshot whose signing failed", async () => {
    holder.bucket = fakeBucket({
      createSignedUrl: vi.fn(async () => ({ data: null, error: { message: "gone" } }))
    });
    tables({
      application_runs: [
        {
          data: {
            id: "r1",
            user_id: "u1",
            application_id: "a1",
            status: "submitted",
            autonomy: "review_gate",
            created_at: "x",
            updated_at: "y",
            screenshots: ["u1/r1/one.png"]
          }
        }
      ]
    });
    expect((await loadRunDetail("r1"))!.screenshots).toEqual([]);
  });

  it("degrades every optional field on a bare row", async () => {
    tables({
      application_runs: [
        {
          data: {
            id: "r1",
            user_id: "u1",
            application_id: "a1",
            status: "queued",
            autonomy: "review_gate",
            created_at: "x",
            updated_at: "y"
          }
        }
      ]
    });

    const detail = await loadRunDetail("r1");
    expect(detail).toMatchObject({
      error: null,
      slot_refunded: false,
      canceled_by: null,
      steps: [],
      answers: [],
      formFieldCount: 0,
      screenshots: [],
      month_key: "",
      tenant_host: null,
      workflow_instance_id: null,
      user: null,
      application: null
    });
  });

  it("handles an application whose job row is gone", async () => {
    tables({
      application_runs: [
        {
          data: {
            id: "r1",
            user_id: "u1",
            application_id: "a1",
            status: "submitted",
            autonomy: "review_gate",
            created_at: "x",
            updated_at: "y",
            applications: { id: "a1", status: "applied", jobs: null }
          }
        }
      ]
    });
    expect((await loadRunDetail("r1"))!.application).toEqual({
      id: "a1",
      status: "applied",
      company: "",
      title: "",
      ats: "unknown",
      url: ""
    });
  });
});
